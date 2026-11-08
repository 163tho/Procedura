import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRun, RunRecorder } from "../src/tracking/run-record.ts";
import { inPhase, inStage } from "../src/tracking/context.ts";
import { trackedFetch } from "../src/tracking/fetch.ts";
import { UsageReader, normalizeUsage } from "../src/tracking/usage.ts";
import { estimateCost, loadPricing } from "../src/tracking/pricing.ts";
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
  expect(saved.status).toBe("completed");
  expect(attempt.experiment).toEqual({ name: "baseline", dataset_id: "box", repetition: 2 });
  expect(saved.totals.calls).toBe(1);
  expect(saved.totals.tokens.reported_input_tokens).toBe(330);
  expect(saved.totals.tokens.reported_output_tokens).toBe(10);
  expect(saved.totals.cost.estimated_usd).toBeCloseTo((100 * 2 + 200 * .1 + 20 * 2.5 + 10 * 4 + 10 * 10) / 1e6, 12);
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
  expect(summary(path).totals.cost.estimated_usd).toBeNull();
  expect(summary(path).totals.usage_incomplete_calls).toBe(4);
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
  expect(saved.attempts[1].previous_attempt_id).toBe(saved.attempts[0].attempt_id);
  expect(saved.attempts[0].usage.calls).toBe(1);
  expect(saved.attempts[1].usage.calls).toBe(1);
  expect(saved.totals.calls).toBe(2);
  expect(saved.totals.tokens.reported_output_tokens).toBe(20);
});

test("failed runs preserve usage and sanitized failure information", async () => {
  const path = directory();
  mockFetch(async () => response(nativeStream()));
  await expect(recordRun(path, {}, async () => {
    await (await trackedFetch("https://api.anthropic.com/v1/messages", request)).text();
    throw new Error("fixture failure sk-do-not-record-secret");
  }, success)).rejects.toThrow("fixture failure");
  expect(summary(path).status).toBe("failed");
  expect(summary(path).attempts[0].error).not.toContain("sk-do");
  expect(summary(path).totals.calls).toBe(1);
  expect(existsSync(join(path, ".run.lock"))).toBe(false);
});

test("concurrent output directories isolate calls and timers", async () => {
  const first = directory(), second = directory();
  mockFetch(async () => response(nativeStream()));
  await Promise.all([first, second].map((path, index) =>
    recordRun(path, {}, () => inPhase(index ? "refine" : "draft", () => timeStage("fixture", async () => {
      await (await trackedFetch("https://api.anthropic.com/v1/messages", request)).text();
    })), success)));
  expect(summary(first).totals.calls).toBe(1);
  expect(summary(second).totals.calls).toBe(1);
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
  expect(summary(path).status).toBe("completed");
  expect(summary(path).attempts[0].phases.draft.status).toBe("skipped");
  expect(summary(path).attempts[0].phases.refine.status).toBe("skipped");
  expect(summary(path).totals.calls).toBe(0);
  const failed = directory();
  await expect(runProcedura({ outputDir: failed })).rejects.toThrow("text");
  expect(summary(failed).status).toBe("failed");
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
  expect(summary(path).totals.calls).toBe(3);
  expect(summary(path).totals.tokens.reported_output_tokens).toBe(40);
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
  expect(summary(path).totals.calls).toBe(3);
  expect(summary(path).totals.tokens.reported_output_tokens).toBe(60);
  expect(summary(path).totals.by_stage["draft.plan"].calls).toBe(3);
  expect(summary(path).totals.by_model["claude-sonnet-5-5"].calls).toBe(3);
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
        expect(summary(path).status).toBe("aborted");
        expect(existsSync(join(path, ".run.lock"))).toBe(false);
      } else {
        expect(summary(path).status).toBe("running");
        // Simulate a torn append after a power loss; never delete the evidence.
        const { appendFileSync } = await import("node:fs");
        appendFileSync(join(path, "api_calls.jsonl"), '{"event":');
        const recovered = new RunRecorder(path, {});
        recovered.finish("completed", null);
        const saved = summary(path);
        expect(saved.attempts[0].status).toBe("interrupted");
        expect(saved.attempts).toHaveLength(2);
        expect(saved.attempts[0].usage.calls).toBe(1);
        expect(saved.totals.calls).toBe(1);
        expect(saved.totals.usage_incomplete_calls).toBe(1);
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
    expect(summary(path).totals.calls).toBe(1);
    expect(summary(path).totals.cost.estimated_usd).toBeNull();
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
  expect(saved.attempts[1].experiment.repetition).toBe(2);
  expect(saved.output_directory).toBe(path);
  expect(saved.attempts[1].output_artifacts["final.scad"].path).toBe(join(path, "final.scad"));
  expect(saved.totals.calls).toBe(0);
  expect(saved.prior_untracked_work).toBe(true);
});
