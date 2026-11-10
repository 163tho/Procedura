import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeCalls, recoverAccounting } from "../src/tracking/accounting.ts";
import { recordRun, RunRecorder } from "../src/tracking/run-record.ts";
import { inPhase, inStage, recordReferenceInputs } from "../src/tracking/context.ts";
import { trackedFetch } from "../src/tracking/fetch.ts";
import { UsageReader, normalizeUsage } from "../src/tracking/usage.ts";
import { estimateCost, loadPricing } from "../src/tracking/pricing.ts";
import { sourceRelativePath } from "../src/tracking/metadata.ts";
import { InputTracker, type ReferenceInput } from "../src/tracking/inputs.ts";
import { timeStage } from "../src/pipeline/stage-timer.ts";
import { beginStaging } from "../src/pipeline/local-staging.ts";

const originalFetch = globalThis.fetch;
const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "procedura-tracking-"));
  temporary.push(path);
  return path;
}
const summary = (path: string) => JSON.parse(readFileSync(join(path, "run.json"), "utf8"));
const latest = (path: string) => summary(path).attempts[0];
const entries = (path: string) => readFileSync(join(path, "api_calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
function mockFetch(fn: (...args: any[]) => Promise<Response>) {
  globalThis.fetch = Object.assign(fn, { preconnect() {} }) as typeof fetch;
}
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const next = Math.min(offset + 13, bytes.length);
      controller.enqueue(bytes.slice(offset, next)); offset = next;
    },
  }), { headers: { "content-type": "text/event-stream", "request-id": "req_fixture" } });
}
function nativeStream() {
  return [
    'data: {"type":"message_start","message":{"id":"msg_fixture","model":"claude-sonnet-5-5","usage":{"input_tokens":100,"cache_read_input_tokens":200,"cache_creation_input_tokens":30,"cache_creation":{"ephemeral_5m_input_tokens":20,"ephemeral_1h_input_tokens":10},"output_tokens":1}}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a unicode answer"}}',
    'data: {"type":"message_delta","usage":{"output_tokens":5}}',
    'data: {"type":"message_delta","usage":{"output_tokens":10}}',
    'data: {"type":"message_stop"}',
  ].join("\n\n") + "\n\n";
}
const request = { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true,
  messages: [{ role: "user", content: "private prompt" }] }) };
const success = () => ({ status: "completed", outcome: { ok: true } });

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

test("native usage merges start metadata and cumulative output exactly once", async () => {
  const path = directory();
  mockFetch(async () => response(nativeStream()));
  await recordRun(path, { text: "A box", experimentName: "baseline", datasetId: "box", repetition: 2 }, async () =>
    inPhase("draft", () => inStage("draft.plan", async () => {
      const result = await trackedFetch("https://api.anthropic.com/v1/messages?secret=never-save", request);
      expect(await result.text()).toContain("unicode");
    })), success);
  const saved = summary(path), attempt = saved.attempts[0];
  expect(saved.attempts[0].status).toBe("completed");
  expect(attempt.experiment).toEqual({ name: "baseline", dataset_id: "box", repetition: 2 });
  expect(saved.attempts[0].api.requests).toBe(1);
  expect(saved.attempts[0].api.input_tokens).toBe(330);
  expect(saved.attempts[0].api.output_tokens).toBe(10);
  expect(saved.attempts[0].api.estimated_cost_usd).toBeCloseTo((100 * 2 + 200 * .1 + 20 * 2.5 + 10 * 4 + 10 * 10) / 1e6, 12);
  expect(attempt.source.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(attempt.source.fingerprint_sha256).toHaveLength(64);
  expect(attempt.phases.draft.duration_ms).toBeGreaterThanOrEqual(0);
  const calls = entries(path);
  expect(calls.map(call => call.event)).toEqual(["started", "finished"]);
  expect(calls[1].stage).toBe("draft.plan");
  expect(calls[1].request_id).toBe("req_fixture");
  expect(calls[1].message_id).toBe("msg_fixture");
  expect(JSON.stringify(calls)).not.toContain("private prompt");
  expect(JSON.stringify(calls)).not.toContain("never-save");
});

test("OpenAI compatibility cache and reasoning are subsets of input and output", () => {
  const usage = normalizeUsage({
    prompt_tokens: 100, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 12 },
  }, "openai");
  expect(usage.input_tokens).toBe(100);
  expect(usage.uncached_input_tokens).toBe(20);
  expect(usage.output_tokens).toBe(20);
  expect(usage.reasoning_tokens).toBe(12);
  expect(estimateCost(loadPricing(), "claude-sonnet-5-5", "https://api.anthropic.com/v1/chat/completions", usage, true, {}, {}).estimated_usd)
    .toBeCloseTo((20 * 2 + 80 * .1 + 20 * 10) / 1e6, 12);
});

test("Gemini counts reasoning once and retains cached input", () => {
  const usage = normalizeUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 12, cachedContentTokenCount: 80 }, "gemini");
  expect(usage.input_tokens).toBe(100);
  expect(usage.output_tokens).toBe(32);
  expect(usage.uncached_input_tokens).toBe(20);
});

test("missing, partial, malformed, cancelled and zero usage are distinguishable", async () => {
  const path = directory();
  let count = 0;
  mockFetch(async () => {
    count++;
    if (count === 1) return response('data: {"choices":[{"delta":{"content":"text"}}]}\n\ndata: [DONE]\n\n');
    if (count === 2) return response('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n');
    if (count === 3) return response('data: broken JSON\n\ndata: [DONE]\n\n');
    if (count === 4) return new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode("data: {}\n\n")); } }),
      { headers: { "content-type": "text/event-stream" } });
    return response('data: {"usage":{"prompt_tokens":0,"completion_tokens":0},"choices":[]}\n\ndata: [DONE]\n\n');
  });
  await recordRun(path, {}, async () => {
    for (let i = 0; i < 3; i++) await (await trackedFetch("https://api.anthropic.com/v1/chat/completions", request)).text();
    await (await trackedFetch("https://api.anthropic.com/v1/chat/completions", request)).body!.cancel();
    await (await trackedFetch("https://api.anthropic.com/v1/chat/completions", request)).text();
  }, success);
  const finished = entries(path).filter(e => e.event === "finished");
  expect(finished.map(e => e.usage_status)).toEqual(["unknown", "partial", "unknown", "unknown", "complete"]);
  expect(finished[3].status).toBe("cancelled");
  expect(summary(path).attempts[0].api.estimated_cost_usd).toBeNull();
  expect(summary(path).attempts[0].api.usage_incomplete_requests).toBe(4);
});

test("resumes retain history without duplicating earlier totals", async () => {
  const path = directory();
  mockFetch(async () => response(nativeStream()));
  const perform = () => trackedFetch("https://api.anthropic.com/v1/messages", request).then(r => r.text());
  await recordRun(path, { text: "first" }, perform, success);
  const runId = summary(path).run_id;
  await recordRun(path, { text: "second", redo: true }, perform, success);
  const saved = summary(path);
  expect(saved.run_id).toBe(runId);
  expect(saved.attempts).toHaveLength(2);
  expect(saved.attempts[0].previous_attempt_id).toBe(saved.attempts[1].attempt_id);
  expect(saved.attempts[0].api.requests).toBe(1);
  expect(saved.attempts[1].api.requests).toBe(1);
  expect(saved.attempts.reduce((n: number, a: any) => n + a.api.requests, 0)).toBe(2);
  expect(saved.attempts.reduce((n: number, a: any) => n + a.api.output_tokens, 0)).toBe(20);
});

test("failed runs preserve usage and sanitized failure information", async () => {
  const path = directory();
  mockFetch(async () => response(nativeStream()));
  await expect(recordRun(path, {}, async () => {
    await (await trackedFetch("https://api.anthropic.com/v1/messages", request)).text();
    throw new Error("fixture failure sk-do-not-record-secret");
  }, success)).rejects.toThrow("fixture failure");
  expect(summary(path).attempts[0].status).toBe("failed");
  expect(summary(path).attempts[0].error).not.toContain("sk-do");
  expect(summary(path).attempts[0].api.requests).toBe(1);
  expect(existsSync(join(path, ".run.lock"))).toBe(false);
});

test("concurrent output directories isolate calls and timers", async () => {
  const first = directory(), second = directory();
  mockFetch(async () => response(nativeStream()));
  await Promise.all([first, second].map((path, index) =>
    recordRun(path, {}, () => inPhase(index ? "refine" : "draft", () => timeStage("fixture", async () => {
      await (await trackedFetch("https://api.anthropic.com/v1/messages", request)).text();
    })), success)));
  expect(summary(first).attempts[0].api.requests).toBe(1);
  expect(summary(second).attempts[0].api.requests).toBe(1);
  expect(entries(first)[0].phase).toBe("draft");
  expect(entries(second)[0].phase).toBe("refine");
  expect(summary(first).attempts[0].timings.stages.fixture.calls).toBe(1);
  expect(summary(second).attempts[0].timings.stages.fixture.calls).toBe(1);
});

test("a second live invocation cannot overwrite the same run history", () => {
  const path = directory(), recorder = new RunRecorder(path, {});
  try { expect(() => new RunRecorder(path, {})).toThrow("Another invocation"); }
  finally { recorder.finish("completed", null); }
});

test("custom rates are snapshotted and invalid rates fail before generation", () => {
  const path = directory(), pricingPath = join(path, "prices.json");
  const pricing = loadPricing();
  pricing.models["other-model"] = { input: 1, output: 2, cache_read: .1, cache_write_5m: 1.25, cache_write_1h: 2 };
  writeFileSync(pricingPath, JSON.stringify(pricing));
  const recorder = new RunRecorder(path, { pricingFile: pricingPath });
  recorder.finish("completed", null);
  expect(summary(path).attempts[0].pricing.models["other-model"].output).toBe(2);
  pricing.models["other-model"]!.output = -1;
  writeFileSync(pricingPath, JSON.stringify(pricing));
  expect(() => new RunRecorder(directory(), { pricingFile: pricingPath })).toThrow("nonnegative");
});

test("unknown models, gateways and unsupported modifiers have no invented cost", () => {
  const pricing = loadPricing(), usage = normalizeUsage({ input_tokens: 5, output_tokens: 2 }, "anthropic");
  for (const [model, endpoint, params] of [
    ["unknown", "https://api.anthropic.com/v1/messages", {}],
    ["claude-sonnet-5-5", "https://gateway.invalid/v1/messages", {}],
    ["claude-sonnet-5-5", "https://api.anthropic.com/v1/messages", { speed: "fast" }],
  ] as const) expect(estimateCost(pricing, model, endpoint, usage, true, {}, params).estimated_usd).toBeNull();
});

test("staging seeds artifacts and never replaces live accounting", () => {
  const path = directory();
  writeFileSync(join(path, "draft.scad"), "old model");
  writeFileSync(join(path, "run.json"), "live accounting");
  writeFileSync(join(path, "api_calls.jsonl"), "live ledger");
  const staged = beginStaging(path, "always", () => {});
  temporary.push(staged.workDir);
  expect(readFileSync(join(staged.workDir, "draft.scad"), "utf8")).toBe("old model");
  expect(existsSync(join(staged.workDir, "run.json"))).toBe(false);
  writeFileSync(join(staged.workDir, "final.scad"), "new model");
  writeFileSync(join(staged.workDir, "run.json"), "stale copy");
  staged.finish("fixture");
  expect(readFileSync(join(path, "run.json"), "utf8")).toBe("live accounting");
  expect(readFileSync(join(path, "final.scad"), "utf8")).toBe("new model");
});

test("pipeline records skipped stages and missing-input failures without a model", async () => {
  const { runProcedura } = await import("../src/pipeline/procedura.ts");
  const path = directory();
  writeFileSync(join(path, "prompt.txt"), "A box");
  writeFileSync(join(path, "draft.scad"), "module box() { cube(1); } box();");
  writeFileSync(join(path, "draft.obj"), "o box\nv 0 0 0\n");
  await runProcedura({ outputDir: path, refine: false });
  expect(summary(path).attempts[0].status).toBe("completed");
  expect(summary(path).attempts[0].phases.draft.status).toBe("skipped");
  expect(summary(path).attempts[0].phases.refine.status).toBe("skipped");
  expect(summary(path).attempts[0].api.requests).toBe(0);
  const failed = directory();
  await expect(runProcedura({ outputDir: failed })).rejects.toThrow("text");
  expect(summary(failed).attempts[0].status).toBe("failed");
});

test("HTTP retries and reasoning-only replies are distinct ledger attempts", async () => {
  const path = directory();
  let count = 0;
  mockFetch(async () => {
    if (++count === 1) return new Response("busy", { status: 500 });
    return response('data: {"id":"fixture","model":"claude-sonnet-5-5","choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n');
  });
  const { longTimeoutFetch } = await import("../src/llm/long-timeout-fetch.ts");
  await recordRun(path, {}, async () => {
    await (await longTimeoutFetch("https://api.anthropic.com/v1/chat/completions", request)).text();
    await (await longTimeoutFetch("https://api.anthropic.com/v1/chat/completions", request)).text();
  }, success);
  expect(summary(path).attempts[0].api.requests).toBe(3);
  expect(summary(path).attempts[0].api.output_tokens).toBe(40);
  expect(summary(path).attempts[0].timings.retry_wait_ms).toBeGreaterThan(0);
});

test("parser retains input counts when final usage omits them", () => {
  const parser = new UsageReader(true);
  parser.push(new TextEncoder().encode(nativeStream()));
  parser.end();
  expect(parser.usage?.input_tokens).toBe(330);
  expect(parser.usage?.output_tokens).toBe(10);
  expect(parser.terminal).toBe(true);
});

test("content retries retain the cost of empty reasoning-only replies", async () => {
  const { Route, Endpoint, Auth, Framing, OpenAIChat } = await import("@harness/template");
  const { generateWithRetry } = await import("../src/llm/generate.ts");
  const route = Route.make({ id: "tracking-fixture", protocol: OpenAIChat, endpoint: Endpoint.path("/v1/chat/completions"),
    auth: Auth.passthrough, framing: Framing.sse, baseUrl: "https://api.anthropic.com" });
  let count = 0;
  mockFetch(async () => response('data: {"choices":[{"delta":' + (++count < 3
    ? '{"reasoning_content":"reasoning only"}' : '{"content":"usable answer"}') + '}]}\n\n'
    + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n'));
  const path = directory();
  await recordRun(path, {}, () => generateWithRetry({
    route, model: { providerId: "openai", modelId: "claude-sonnet-5-5" },
    system: "Fixture instructions", parts: [{ kind: "text", text: "Fixture request" }], label: "draft.plan", log: () => {},
  }), success);
  expect(summary(path).attempts[0].api.requests).toBe(3);
  expect(summary(path).attempts[0].api.output_tokens).toBe(60);
  expect(latest(path).api.by_stage["draft.plan"].requests).toBe(3);
  expect(latest(path).api.models).toEqual(["claude-sonnet-5-5"]);
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(signal + " preserves or recovers an unfinished invocation", async () => {
    const path = directory();
    const childFile = join(path, "child.ts");
    const recorderPath = new URL("../src/tracking/run-record.ts", import.meta.url).pathname;
    const contextPath = new URL("../src/tracking/context.ts", import.meta.url).pathname;
    const childCode = [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { recordRun } from ' + JSON.stringify(recorderPath) + ';',
      'import { trackingContext } from ' + JSON.stringify(contextPath) + ';',
      'await recordRun(process.argv[2], {}, async () => {',
      'trackingContext().recorder.startCall({ transport: "fixture", requested_model: "fixture" });',
      'writeFileSync(join(process.argv[2], "ready"), "ready");',
      'await new Promise(() => { setInterval(() => {}, 1000); });',
      '}, () => ({ status: "completed", outcome: null }));',
    ].join("\n");
    writeFileSync(childFile, childCode);
    const processChild = Bun.spawn([process.execPath, "--no-env-file", childFile, path], { stdout: "pipe", stderr: "pipe" });
    try {
      for (let i = 0; i < 200 && !existsSync(join(path, "ready")); i++) await Bun.sleep(10);
      expect(existsSync(join(path, "ready"))).toBe(true);
      processChild.kill(signal);
      await processChild.exited;
      if (signal === "SIGTERM") {
        expect(summary(path).attempts[0].status).toBe("aborted");
        expect(existsSync(join(path, ".run.lock"))).toBe(false);
      } else {
        expect(summary(path).attempts[0].status).toBe("running");
        // Simulate a torn append after a power loss; never delete the evidence.
        const { appendFileSync } = await import("node:fs");
        appendFileSync(join(path, "api_calls.jsonl"), '{"event":');
        const recovered = new RunRecorder(path, {});
        recovered.finish("completed", null);
        const saved = summary(path);
        expect(saved.attempts[1].status).toBe("interrupted");
        expect(saved.attempts).toHaveLength(2);
        expect(saved.attempts[0].api.requests).toBe(0);
        expect(saved.attempts[1].api.requests).toBe(1);
        expect(saved.attempts[1].api.usage_incomplete_requests).toBe(1);
        expect(saved.ledger_malformed_lines).toBe(1);
      }
    } finally {
      if (processChild.exitCode === null) processChild.kill("SIGKILL");
      await processChild.exited;
    }
  }, 10000);
}

test("image-generation attempts are logged even if no provider usage is supplied", async () => {
  const { generateImage } = await import("../src/imagegen/images.ts");
  const path = directory(), prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-only";
  try {
    mockFetch(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([137, 80, 78, 71]).toString("base64") }] }),
      { headers: { "content-type": "application/json" } }));
    await recordRun(path, {}, () => inStage("draft.image", () => generateImage({
      prompt: "A fixture image", outputPath: join(path, "image.png"), model: "image-fixture",
    })), success);
    expect(summary(path).attempts[0].api.requests).toBe(1);
    expect(summary(path).attempts[0].api.estimated_cost_usd).toBeNull();
    expect(entries(path)[1].stage).toBe("draft.image");
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  }
});

test("CLI labels and forced staging preserve history in the final output folder", () => {
  const path = directory();
  writeFileSync(join(path, "prompt.txt"), "A fixture box");
  writeFileSync(join(path, "draft.scad"), "module box() { cube(1); } box();");
  writeFileSync(join(path, "draft.obj"), "o box\nv 0 0 0\n");
  const script = new URL("../scripts/procedura.ts", import.meta.url).pathname;
  for (let repetition = 1; repetition <= 2; repetition++) {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", script,
      "-o", path, "--no-image", "--no-refine", "--local-staging",
      "--experiment", "baseline", "--dataset-id", "box", "--repetition", String(repetition),
    ], { timeout: 10000, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
  }
  const saved = summary(path);
  expect(saved.attempts).toHaveLength(2);
  expect(saved.attempts[0].experiment.repetition).toBe(2);
  expect(saved.output_directory).toBe(sourceRelativePath(path));
  expect(saved.attempts[0].output_artifacts["final.scad"].path).toBe("final.scad");
  expect(saved.attempts[0].api.requests).toBe(0);
  expect(saved.prior_untracked_work).toBe(true);
});


for (const count of [0, 1, 7]) {
  test("input summary counts " + count + " actual auxiliary references separately from feedback", () => {
    const path = directory(), inputs = directory();
    const original = join(inputs, "reference.png"), copy = join(path, "image.png");
    writeFileSync(original, "primary image bytes");
    writeFileSync(copy, "primary image bytes");
    // An unrelated render in the output directory must never become a reference.
    writeFileSync(join(path, "feedback.png"), "render of current build");
    const tracker = new InputTracker(path, { inputImage: original, text: "A rover", incremental: true, contextRenders: true });
    const primary: ReferenceInput = { path: copy, role: "primary_image", sourcePath: original };
    const auxiliary: ReferenceInput[] = Array.from({ length: count }, (_, index) => {
      const image = join(inputs, "view" + index + ".png");
      writeFileSync(image, "view " + index);
      return { path: image, role: "auxiliary_image", provenance: "mesh_render" };
    });
    tracker.record("planning", [primary]);
    tracker.record("part_generation", [primary, ...auxiliary]);
    tracker.record("refinement", [primary]);
    expect(tracker.summary.mode).toBe(count ? "multi_view_images" : "single_image");
    expect(tracker.summary.auxiliary_image_count).toBe(count);
    expect(tracker.summary.total_reference_image_count).toBe(count + 1);
    expect(tracker.summary.used_by_stage).toEqual({
      planning: "single_image", part_generation: count ? "multi_view_images" : "single_image", refinement: "single_image",
    });
    expect(tracker.summary.reference_mesh_used).toBe(false);
    expect(tracker.summary.current_build_feedback_enabled).toBe(true);
    expect(tracker.inputs.primary_image!.source_path).toBe(sourceRelativePath(original));
    expect(tracker.inputs.primary_image!.run_copy).toBe("image.png");
    expect(tracker.inputs.primary_image!.sha256).toHaveLength(64);
    expect(tracker.inputs.auxiliary_images).toHaveLength(count);
    expect(JSON.stringify(tracker.inputs)).not.toContain("feedback.png");
  });
}

test("run summary exposes latest measurements and retains portable input provenance on resume", async () => {
  const path = directory(), external = directory();
  const source = join(external, "reference.png"), copy = join(path, "image.png");
  writeFileSync(source, "primary image");
  writeFileSync(copy, "primary image");
  mockFetch(async () => response(nativeStream()));
  await recordRun(path, { inputImage: source, text: "A rover" }, async () => {
    recordReferenceInputs("planning", [{ path: copy, role: "primary_image", sourcePath: source }]);
    await (await trackedFetch("https://api.anthropic.com/v1/messages", request)).text();
  }, success);
  await recordRun(path, {}, async () => {
    recordReferenceInputs("refinement", [{ path: copy, role: "primary_image" }]);
    await (await trackedFetch("https://api.anthropic.com/v1/messages", request)).text();
  }, success);
  const saved = summary(path), latest = saved.attempts[0];
  expect(saved.schema_version).toBe(3);
  expect(saved.input_paths_relative_to).toBe("procedura_repository_root");
  expect(saved.latest_attempt_id).toBe(latest.attempt_id);
  expect(saved.api_calls_file).toBe("api_calls.jsonl");
  expect(saved).not.toHaveProperty("summary");
  expect(saved).not.toHaveProperty("totals");
  expect(saved).not.toHaveProperty("status");
  expect(latest).not.toHaveProperty("usage");
  expect(latest).not.toHaveProperty("schema_version");
  expect(latest.input_summary.mode).toBe("single_image");
  expect(latest.api.input_tokens).toBe(330);
  expect(latest.api.output_tokens).toBe(10);
  expect(latest.api.cost_complete).toBe(true);
  expect(latest.duration_ms).toBeGreaterThanOrEqual(0);
  expect(saved.attempts.reduce((n: number, a: any) => n + a.api.input_tokens, 0)).toBe(660);
  expect(latest.inputs.primary_image.source_path).toBe(sourceRelativePath(source));
  expect(latest.inputs.primary_image.run_copy).toBe("image.png");
});

test("generated-image origin and null source survive later stages and resumed invocations", () => {
  const path = directory(), image = join(path, "image.png");
  writeFileSync(image, "generated image");
  const first = new InputTracker(path, {});
  first.record("part_generation", [{ path: image, role: "primary_image", sourcePath: null, origin: "generated" }]);
  first.record("refinement", [{ path: image, role: "primary_image" }]);
  expect(first.inputs.primary_image!.source_path).toBeNull();
  expect(first.inputs.primary_image!.origin).toBe("generated");
  const resumed = new InputTracker(path, {}, { inputs: first.inputs });
  resumed.record("refinement", [{ path: image, role: "primary_image" }]);
  expect(resumed.inputs.primary_image!.source_path).toBeNull();
  expect(resumed.summary.used_by_stage.planning).toBe("not_run");
});

test("text-only, pending and duplicate references remain distinguishable", () => {
  const path = directory();
  const tracker = new InputTracker(path, { textOnly: true, text: "A box" });
  tracker.record("part_generation", []);
  expect(tracker.summary.mode).toBe("text_only");
  expect(tracker.summary.total_reference_image_count).toBe(0);
  expect(tracker.summary.text_prompt_used).toBe(true);
  expect(new InputTracker(path, {}).summary.mode).toBe("pending");
  const image = join(path, "image.png");
  writeFileSync(image, "image");
  const primary: ReferenceInput = { path: image, role: "primary_image" };
  tracker.record("refinement", [primary, primary]);
  expect(tracker.summary.reference_counts_by_stage.refinement!.primary_image_count).toBe(1);
  expect(tracker.summary.total_reference_image_count).toBe(1);
});

test("schema 1 metadata is retained while unrecorded accounting stays unknown", async () => {
  const path = directory();
  const legacy = { attempt_id: "legacy", status: "completed", inputs: { image: { path: join(path, "image.png"), sha256: "old" } },
    source: { commit: "legacy-commit", dirty: true } };
  writeFileSync(join(path, "run.json"), JSON.stringify({
    schema_version: 1, run_id: "old-run", attempts: [legacy], latest_attempt_id: "legacy",
  }));
  await recordRun(path, { text: "New invocation", textOnly: true }, async () => {}, success);
  const saved = summary(path);
  expect(saved.run_id).toBe("old-run");
  expect(saved.schema_version).toBe(3);
  expect(saved.attempts).toHaveLength(2);
  expect(saved.attempts[1].inputs).toEqual(legacy.inputs);
  expect(saved.attempts[1].source).toEqual(legacy.source);
  expect(saved.attempts[1].input_summary).toBeUndefined();
  expect(saved.attempts[1].recorded_schema_version).toBe(1);
  expect(saved.attempts[1].api.estimated_cost_usd).toBeNull();
  expect(saved.attempts[1].api.requests).toBeNull();
  expect(saved.attempts[0].previous_attempt_id).toBe("legacy");
});

test("incremental pipeline reports only successfully loaded extra views", () => {
  const path = directory(), original = join(path, "original.png");
  writeFileSync(original, "fixture image");
  const child = join(path, "fixture.ts");
  const generate = new URL("../src/llm/generate.ts", import.meta.url).pathname;
  const images = new URL("../src/imagegen/images.ts", import.meta.url).pathname;
  const pipeline = new URL("../src/pipeline/procedura.ts", import.meta.url).pathname;
  const code = [
    'import { mock } from "bun:test";',
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const output = process.argv[2], original = process.argv[3];',
    'globalThis.fetch = () => { throw new Error("Network prohibited in fixture"); };',
    'const stop = async args => { writeFileSync(join(output, "attached.json"), JSON.stringify({ images: args.parts.filter(p => p.kind === "image").length })); throw new Error("fixture stop after references"); };',
    'mock.module(' + JSON.stringify(generate) + ', () => ({ generateOnce: stop, generateWithRetry: stop }));',
    'let extras = 0;',
    'mock.module(' + JSON.stringify(images) + ', () => ({',
    ' resolveImageModel: () => "fixture", imageGenAvailable: () => true, imageGenDisabledReason: () => "",',
    ' generateImage: async opts => { if (++extras === 2) throw new Error("fixture image failure"); writeFileSync(opts.outputPath, "generated view " + extras); return opts.outputPath; }',
    '}));',
    'const { runProcedura } = await import(' + JSON.stringify(pipeline) + ');',
    'try { await runProcedura({ outputDir: output, text: "A fixture rover", inputImage: original, incremental: true, extraRefs: 4, refine: false }); throw new Error("Expected fixture stop"); }',
    'catch (error) { if (!String(error).includes("fixture stop after references")) throw error; }',
  ].join("\n");
  writeFileSync(child, code);
  const result = Bun.spawnSync([process.execPath, "--no-env-file", child, path, original], {
    env: { ...process.env, PROCEDURA_REF_IMAGE_SIZE: "0" }, timeout: 15000, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const saved = summary(path);
  expect(saved.attempts[0].input_summary.auxiliary_image_count).toBe(3);
  expect(saved.attempts[0].input_summary.total_reference_image_count).toBe(4);
  expect(saved.attempts[0].input_summary.used_by_stage.planning).toBe("multi_view_images");
  expect(saved.attempts[0].inputs.auxiliary_images).toHaveLength(3);
  expect(JSON.parse(readFileSync(join(path, "attached.json"), "utf8")).images).toBe(4);
  expect(saved.attempts[0].api.requests).toBe(0);
}, 20000);


test("detailed stage accounting preserves all 22 groups and arbitrary later groups", () => {
  const calls: any[] = [];
  const add = (phase: string, stage: string, count: number) => {
    for (let n = 0; n < count; n++) calls.push({
      phase, stage, status: "completed", model: "fixture", duration_ms: 10,
      usage_status: "complete", usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cache_read_input_tokens: 10 },
      cost: { estimated_usd: 0.01, assumptions: ["Shared pricing assumption"] },
    });
  };
  add("draft", "draft.plan", 1);
  add("draft", "draft.plan_review", 1);
  for (let n = 0; n < 18; n++) add("draft", "draft.part.part_" + n, n === 1 ? 2 : n === 12 || n === 13 ? 3 : 1);
  add("refine", "llm.critic", 6);
  add("refine", "llm.patch", 6);
  const api = summarizeCalls(calls);
  expect(api.requests).toBe(37);
  expect(Object.keys(api.by_stage)).toHaveLength(22);
  expect(api.by_stage["draft.part.part_12"].requests).toBe(3);
  expect(api.by_stage["llm.critic"].requests).toBe(6);
  expect(api.by_phase.draft.requests).toBe(25);
  expect(api.by_phase.refine.requests).toBe(12);
  expect(api.estimated_cost_usd).toBe(0.37);
  expect(api.by_phase.draft.estimated_cost_usd).toBe(0.25);
  expect(api.by_phase.refine.estimated_cost_usd).toBe(0.12);
  expect(api.request_time_seconds_sum).toBe(0.37);
  expect(api.input_tokens).toBe(3700);
  expect(api.output_tokens).toBe(740);
  expect(api.reported_reasoning_tokens).toBe(185);
  expect(api.reported_cache_read_tokens).toBe(370);
  expect(api.usage_complete_requests).toBe(37);
  expect(api.usage_incomplete_requests).toBe(0);
  expect(api.priced_requests).toBe(37);
  expect(api.unpriced_requests).toBe(0);
  expect(api).not.toHaveProperty("known_estimated_cost_usd");
  expect(api).not.toHaveProperty("by_model");
  expect(api.pricing_assumptions).toEqual(["Shared pricing assumption"]);
  add("draft", "draft.part.another_part", 1);
  expect(Object.keys(summarizeCalls(calls).by_stage)).toHaveLength(23);
});

test("unknown usage and unpriced calls retain coverage counts and only a known subtotal", () => {
  const api = summarizeCalls([
    { phase: "draft", stage: "draft.plan", status: "completed", duration_ms: 100,
      usage_status: "complete", usage: { input_tokens: 10, output_tokens: 5 }, cost: { estimated_usd: 0.25 } },
    { phase: "draft", stage: "draft.part.one", status: "completed", duration_ms: 200,
      usage_status: "complete", usage: { input_tokens: 20, output_tokens: 10 }, cost: { estimated_usd: null } },
    { phase: "refine", stage: "llm.critic", status: "failed", duration_ms: 300,
      usage_status: "partial", usage: { input_tokens: 99 }, cost: null },
  ]);
  expect(api.requests).toBe(3);
  expect(api.completed_requests).toBe(2);
  expect(api.failed_requests).toBe(1);
  expect(api.input_tokens).toBe(30);
  expect(api.output_tokens).toBe(15);
  expect(api.usage_complete).toBe(false);
  expect(api.usage_complete_requests).toBe(2);
  expect(api.usage_incomplete_requests).toBe(1);
  expect(api.cost_complete).toBe(false);
  expect(api.priced_requests).toBe(1);
  expect(api.unpriced_requests).toBe(2);
  expect(api.estimated_cost_usd).toBeNull();
  expect(api.known_estimated_cost_usd).toBe(0.25);
  expect(api.by_stage["draft.plan"].estimated_cost_usd).toBe(0.25);
  expect(api.by_stage["draft.part.one"].estimated_cost_usd).toBeNull();
  expect(api.by_phase.draft.estimated_cost_usd).toBeNull();
  expect(api.by_phase.draft.known_estimated_cost_usd).toBe(0.25);
  expect(api.by_phase.refine.usage_complete).toBe(false);
});

function legacyUsage() {
  const group = { calls: 1, input_tokens: 10, output_tokens: 5, usage_complete: true,
    estimated_usd: 0.25, known_estimated_usd: 0.25 };
  return {
    calls: 1, completed_calls: 1, failed_calls: 0, usage_complete_calls: 1, usage_incomplete_calls: 0,
    tokens: { reported_input_tokens: 10, reported_output_tokens: 5, reported_total_tokens: 15,
      reported_reasoning_tokens: 0, reported_cache_read_tokens: 0, complete: true },
    cost: { currency: "USD", estimated_usd: 0.25, known_estimated_usd: 0.25,
      priced_calls: 1, unpriced_calls: 0, billed_usd: null },
    api_request_duration_ms_sum: 1234.567,
    by_stage: { "draft.plan": group }, by_model: { "fixture-model": group },
  };
}

test("schema 2 migration uses the journal while preserving original invocation metadata", async () => {
  const path = directory();
  const old = { schema_version: 2, attempt_id: "old", status: "completed", started_at: "2026-01-01T00:00:00Z",
    source: { commit: "old-commit", branch: "old-branch" }, inputs: { prompt: "Old prompt" },
    input_summary: { mode: "text_only" }, configuration: { custom: "keep" }, outcome: { ok: true },
    usage: legacyUsage() };
  writeFileSync(join(path, "run.json"), JSON.stringify({
    schema_version: 2, run_id: "existing-run", attempts: [old], latest_attempt_id: "old",
    summary: { estimated_cost_usd: 0.25 }, totals: old.usage, status: "completed",
  }));
  const call = { call_id: "old-call", attempt_id: "old", phase: "draft", stage: "draft.plan",
    status: "completed", duration_ms: 1234.567, model: "fixture-model", usage_status: "complete",
    usage: { input_tokens: 10, output_tokens: 5 }, cost: { estimated_usd: 0.25 } };
  const journal = JSON.stringify({ event: "started", call_id: "old-call", attempt_id: "old", status: "started" }) + "\n"
    + JSON.stringify({ ...call, event: "finished" }) + "\n";
  writeFileSync(join(path, "api_calls.jsonl"), journal);
  await recordRun(path, { textOnly: true }, async () => {}, success);
  const saved = summary(path), migrated = saved.attempts[1];
  expect(saved.schema_version).toBe(3);
  expect(saved.run_id).toBe("existing-run");
  expect(saved.latest_attempt_id).toBe(saved.attempts[0].attempt_id);
  expect(saved.attempts[0].previous_attempt_id).toBe("old");
  expect(migrated.recorded_schema_version).toBe(2);
  expect(migrated.source).toEqual(old.source);
  expect(migrated.inputs).toEqual(old.inputs);
  expect(migrated.configuration).toEqual(old.configuration);
  expect(migrated.outcome).toEqual(old.outcome);
  expect(migrated.api.requests).toBe(1);
  expect(migrated.api.estimated_cost_usd).toBe(0.25);
  expect(migrated.api.by_phase.draft.requests).toBe(1);
  expect(migrated.api.by_stage["draft.plan"].requests).toBe(1);
  expect(migrated.api.request_time_seconds_sum).toBeCloseTo(1.234567, 12);
  expect(migrated).not.toHaveProperty("usage");
  expect(migrated).not.toHaveProperty("schema_version");
  expect(saved).not.toHaveProperty("summary");
  expect(saved).not.toHaveProperty("totals");
  expect(saved).not.toHaveProperty("status");
  expect(readFileSync(join(path, "api_calls.jsonl"), "utf8")).toBe(journal);
});

test("missing or torn historical journals never erase previously saved costs", async () => {
  const legacy = { attempt_id: "old", usage: legacyUsage() };
  for (const calls of [[], [
    { call_id: "old-call", status: "started", usage_status: "unknown", cost: null },
  ]]) {
    const recovered = recoverAccounting(legacy, calls);
    expect(recovered.requests).toBe(1);
    expect(recovered.estimated_cost_usd).toBe(0.25);
    expect(recovered.input_tokens).toBe(10);
    expect(recovered.priced_requests).toBe(1);
    expect(recovered.ledger_complete).toBe(false);
    expect(recovered.ledger_requests).toBe(calls.length);
    expect(recovered.by_phase).toBeNull();
    expect(recovered.by_stage["draft.plan"].estimated_cost_usd).toBe(0.25);
    expect(recovered.by_stage["draft.plan"].request_time_seconds_sum).toBeNull();
    expect(recovered.by_model["fixture-model"].estimated_cost_usd).toBe(0.25);
  }
  const path = directory();
  mockFetch(async () => response(nativeStream()));
  await recordRun(path, {}, async () => {
    await (await trackedFetch("https://api.anthropic.com/v1/messages", request)).text();
  }, success);
  const before = latest(path).api;
  rmSync(join(path, "api_calls.jsonl"));
  await recordRun(path, {}, async () => {}, success);
  const after = summary(path).attempts[1].api;
  expect(after.requests).toBe(before.requests);
  expect(after.input_tokens).toBe(before.input_tokens);
  expect(after.estimated_cost_usd).toBe(before.estimated_cost_usd);
  expect(after.by_stage).toEqual(before.by_stage);
  expect(after.by_phase).toEqual(before.by_phase);
  expect(after.ledger_complete).toBe(false);
});

test("input provenance and newest-first order survive three schema 3 invocations", async () => {
  const path = directory(), external = directory();
  const source = join(external, "reference.png"), copy = join(path, "image.png");
  writeFileSync(source, "primary");
  writeFileSync(copy, "primary");
  const ids: string[] = [];
  for (let n = 0; n < 3; n++) {
    await recordRun(path, n === 0 ? { inputImage: source } : {}, async () => {
      recordReferenceInputs(n === 0 ? "planning" : "refinement", [{ path: copy, role: "primary_image" }]);
    }, success);
    ids.push(latest(path).attempt_id);
    expect(latest(path).inputs.primary_image.source_path).toBe(sourceRelativePath(source));
  }
  const saved = summary(path);
  expect(saved.attempts.map((a: any) => a.attempt_id)).toEqual(ids.toReversed());
  expect(saved.attempts[0].previous_attempt_id).toBe(ids[1]);
  expect(saved.attempts[1].previous_attempt_id).toBe(ids[0]);
  expect(saved.latest_attempt_id).toBe(ids[2]);
});
