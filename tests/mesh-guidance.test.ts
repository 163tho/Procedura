import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeshGuidanceTool, guidanceCamera, snapshotMeshGuidance, validateGuidanceGlb } from "../src/pipeline/mesh-guidance.ts";
import { generateWithTools } from "../src/llm/generate.ts";
import type { CanonicalRequest, LLMEvent } from "@harness/template/llm/protocol";
import { openaiRoute } from "../src/llm/openai-route.ts";
import { GoogleGenAI } from "../src/llm/google-genai.ts";
import { recordRun } from "../src/tracking/run-record.ts";
import { inPhase, recordReferenceInputs, trackingContext } from "../src/tracking/context.ts";
import { triangleGlb } from "./fixtures/guidance-glb.ts";
import { Auth } from "@harness/template";
import { runProcedura } from "../src/pipeline/procedura.ts";

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "procedura-guidance-"));
  temporary.push(path);
  return path;
}
const camera = { camera_position: [3, -4, 3], target: [0, 0, 0], reason: "Uncertain about rear depth" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUz8AAAAASUVORK5CYII=", "base64");
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("incremental pipeline exposes guidance only to part generation and its compile-fix retries", async () => {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures/mesh-guidance-pipeline.ts")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("Stage isolation passed");
});

test("snapshots GLB bytes and provenance; resume freezes the input and never initializes geometry", () => {
  const out = directory(), source = join(directory(), "source.glb");
  triangleGlb(source);
  const saved = snapshotMeshGuidance(out, source, false)!;
  expect(saved.initialization).toBe(false);
  expect(saved.stages).toEqual(["incremental_part_generation", "incremental_part_retry"]);
  expect(readFileSync(join(out, saved.path))).toEqual(readFileSync(source));
  expect(snapshotMeshGuidance(out, undefined, true)).toEqual(saved);
  expect(() => snapshotMeshGuidance(directory(), source, true)).toThrow("Cannot add");
  const changed = readFileSync(source); changed[changed.length - 1] = 1; writeFileSync(source, changed);
  expect(() => snapshotMeshGuidance(out, source, true)).toThrow("Cannot change");
  writeFileSync(join(out, saved.path), changed);
  expect(() => snapshotMeshGuidance(out, undefined, true)).toThrow("Saved guidance GLB changed");
});

test("completed draft reuse does not require GLB access or incremental options", async () => {
  const output = directory(), source = join(directory(), "source.glb"); triangleGlb(source);
  const snapshot = snapshotMeshGuidance(output, source, false)!;
  writeFileSync(join(output, "image.png"), png);
  writeFileSync(join(output, "prompt.txt"), "A solid body");
  writeFileSync(join(output, "draft.scad"), "module body() { cube(1); } body();");
  writeFileSync(join(output, "draft.obj"), "fixture");
  rmSync(join(output, snapshot.path)); // Guidance is unavailable; a completed draft still works.
  await runProcedura({ outputDir: output, refine: false });
  const attempt = JSON.parse(readFileSync(join(output, "run.json"), "utf8")).attempts.at(-1);
  expect(attempt.status).toBe("completed");
  expect(attempt.phases.draft.status).toBe("skipped");
  expect(attempt.input_summary.reference_mesh_used).toBe(false);
  expect(attempt.usage.calls).toBe(0);
});

test("guidance is rejected for text-only, one-shot and motion-only invocations before generation", async () => {
  for (const options of [{ incremental: true, textOnly: true }, { incremental: false }, { incremental: true, motionOnly: true }]) {
    const output = directory();
    await expect(runProcedura({ outputDir: output, guidanceMesh: "unused.glb", ...options })).rejects.toThrow("GLB guidance");
    expect(JSON.parse(readFileSync(join(output, "run.json"), "utf8")).totals.calls).toBe(0);
  }
});

test("rejects malformed GLBs and invalid camera parameters", () => {
  const source = join(directory(), "broken.glb"); writeFileSync(source, "not a GLB");
  expect(() => validateGuidanceGlb(source)).toThrow("valid glTF");
  expect(() => guidanceCamera({ ...camera, camera_position: [0, 0, 0] })).toThrow("differ");
  expect(() => guidanceCamera({ ...camera, target: [5, 0, 0] })).toThrow("target");
  expect(() => guidanceCamera({ ...camera, ortho_scale: 0 })).toThrow("out of range");
  expect(() => guidanceCamera({ ...camera, reason: "" })).toThrow("uncertainty");
  expect(guidanceCamera(camera).projection).toBe("perspective");
});

test("a custom view is returned as an image; failed requests remain recoverable and tracked", async () => {
  const output = directory(), source = join(directory(), "source.glb"); triangleGlb(source);
  const snapshot = snapshotMeshGuidance(output, source, false)!;
  const events: Record<string, unknown>[] = [];
  const tool = createMeshGuidanceTool({ output, snapshot, part: "body", attempt: 2,
    emit: (_type, data) => events.push(data), renderer: async (_mesh, request, dir) => {
      expect(request.camera_position).toEqual(camera.camera_position);
      const image = join(dir, "view.png"); writeFileSync(image, png);
      return { image, metadata: { textures_used: false } };
    } });
  const good = await tool.execute(camera, "view-1");
  expect(good.attachments?.[0]?.data).toBe(png.toString("base64"));
  expect(events.at(-1)?.status).toBe("completed");
  expect(events.at(-1)?.generation_attempt).toBe(2);
  const bad = await tool.execute({ reason: "unknown depth" }, "view-2");
  expect(bad.isError).toBe(true);
  expect(events.at(-1)?.status).toBe("failed");
});

test("tool loop retains original references, bounds images, and keeps the tool available on every continuation", async () => {
  const seen: CanonicalRequest[] = [];
  const model = { providerId: "openai", modelId: "offline-fixture" };
  const attached: string[][] = [];
  const result = await generateWithTools({ route: openaiRoute, model, system: "part system",
    parts: Array.from({ length: 15 }, () => ({ kind: "image" as const, data: png.toString("base64"), mimeType: "image/png" })),
    label: "draft.part.body", onImagesAttached: ids => attached.push(ids),
    tool: { definition: { name: "render_mesh_guidance", description: "test", inputSchema: {} },
      async execute(_input, toolCallId) { return { kind: "tool-result", toolCallId, toolName: "render_mesh_guidance", output: "approximate",
        attachments: [{ kind: "image", data: png.toString("base64"), mimeType: "image/png" }] }; } },
    generate: async request => {
      seen.push(structuredClone(request));
      const images = request.messages.flatMap(message => message.content).reduce((n, part) =>
        n + (part.kind === "image" ? 1 : part.kind === "tool-result" ? part.attachments?.length ?? 0 : 0), 0);
      expect(images).toBeLessThanOrEqual(16);
      expect(request.tools?.[0]?.name).toBe("render_mesh_guidance");
      if (seen.length === 3) return [{ kind: "text-delta", text: "// PART\nmodule body() { cube(1); }" }];
      return [{ kind: "tool-call-start", toolCallId: "call-" + seen.length, toolName: "render_mesh_guidance" },
        { kind: "tool-call-delta", toolCallId: "call-" + seen.length, argDelta: JSON.stringify(camera) }] satisfies LLMEvent[];
    } });
  expect(result.text).toContain("module body");
  expect(seen.length).toBe(3);
  expect(attached).toEqual([["call-1"], ["call-2"]]);
  const openai = openaiRoute.protocol.buildBody(seen[1]!);
  const gemini = GoogleGenAI.buildBody(seen[1]!);
  expect(JSON.stringify(openai)).toContain("data:image/png;base64");
  expect(JSON.stringify(gemini)).toContain("inlineData");
});

test("tool conversations record every HTTP continuation under the part stage without counting local renders as API calls", async () => {
  const originalFetch = globalThis.fetch;
  const output = directory();
  let requests = 0;
  let renders = 0;
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests++;
    expect(body.tools[0].function.name).toBe("render_mesh_guidance");
    if (requests === 2) expect(JSON.stringify(body.messages)).toContain("data:image/png;base64");
    const delta = requests === 1
      ? { tool_calls: [{ index: 0, id: "render-request", type: "function", function: { name: "render_mesh_guidance", arguments: JSON.stringify(camera) } }] }
      : { content: "// PART\nmodule body() { cube(1); }" };
    const stream = "data: " + JSON.stringify({ choices: [{ delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }] }) + "\n\n"
      + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n';
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }, { preconnect() {} }) as typeof fetch;
  try {
    const result = await recordRun(output, {}, () => generateWithTools({
      route: { ...openaiRoute, auth: Auth.passthrough }, model: { providerId: "openai", modelId: "fixture" },
      system: "part generation", parts: [{ kind: "text", text: "Build body" }], label: "draft.part.body",
      tool: { definition: { name: "render_mesh_guidance", description: "fixture", inputSchema: {} }, async execute(_input, toolCallId) {
        renders++;
        return { kind: "tool-result", toolCallId, toolName: "render_mesh_guidance", output: "approximate",
          attachments: [{ kind: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      } },
    }), () => ({ status: "completed", outcome: {} }));
    expect(result.text).toContain("module body");
    expect(renders).toBe(1);
    const saved = JSON.parse(readFileSync(join(output, "run.json"), "utf8"));
    expect(saved.totals.calls).toBe(2);
    expect(saved.totals.by_stage["draft.part.body"].calls).toBe(2);
    expect(saved.totals.tokens.reported_output_tokens).toBe(40);
  } finally { globalThis.fetch = originalFetch; }
});

test("tool budget and cancellation stop inspection explicitly", async () => {
  let renders = 0;
  const args = { route: openaiRoute, model: { providerId: "openai", modelId: "fixture" }, system: "part",
    parts: [], label: "draft.part.body", maxToolCalls: 1,
    tool: { definition: { name: "render_mesh_guidance", description: "fixture", inputSchema: {} },
      async execute(_input: unknown, toolCallId: string) { renders++; return { kind: "tool-result" as const, toolCallId, output: "fixture" }; } },
    generate: async () => [{ kind: "tool-call-start", toolCallId: "repeat", toolName: "render_mesh_guidance" }] as LLMEvent[],
  };
  await expect(generateWithTools(args)).rejects.toThrow("budget exhausted");
  expect(renders).toBe(1);
  const signal = AbortSignal.abort(new Error("fixture cancelled"));
  await expect(generateWithTools({ ...args, signal })).rejects.toThrow("fixture cancelled");
  expect(renders).toBe(1);
});

test("native Gemini preserves function-call thought signatures through the view continuation", async () => {
  let turns = 0;
  await generateWithTools({ route: { ...openaiRoute, protocol: GoogleGenAI },
    model: { providerId: "gemini", modelId: "fixture" }, system: "part", parts: [], label: "draft.part.body",
    tool: { definition: { name: "render_mesh_guidance", description: "fixture", inputSchema: {} },
      async execute(_input, toolCallId) { return { kind: "tool-result", toolCallId, toolName: "render_mesh_guidance", output: "fixture" }; } },
    generate: async request => {
      if (++turns === 1) return GoogleGenAI.parseEvent({ event: "data", data: JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: "render_mesh_guidance", args: camera }, thoughtSignature: "opaque-signature" }] }, finishReason: "STOP" }],
      }) });
      const body = GoogleGenAI.buildBody(request);
      expect(JSON.stringify(body)).toContain('"thoughtSignature":"opaque-signature"');
      return [{ kind: "text-delta", text: "complete part code" }];
    } });
  expect(turns).toBe(2);
});

test("run.json separates available guidance from actual inspected views and preserves stage restrictions", async () => {
  const output = directory(), source = join(directory(), "source.glb"); triangleGlb(source);
  const snapshot = snapshotMeshGuidance(output, source, false)!;
  const image = join(output, "image.png"); writeFileSync(image, png);
  await recordRun(output, { outputDir: output, text: "body", incremental: true, inputImage: image, guidanceMesh: source }, async () => {
    recordReferenceInputs("planning", [{ path: image, role: "primary_image" }]);
    await inPhase("draft", async () => {
      const recorder = trackingContext()!.recorder;
      recorder.recordMeshGuidance({ status: "available", stage: "part_generation", mesh: snapshot, path: join(output, snapshot.path) });
      const live = JSON.parse(readFileSync(join(output, "run.json"), "utf8")).attempts.at(-1);
      expect(live.input_summary.reference_mesh_used).toBe(false);
      const tool = createMeshGuidanceTool({ output, snapshot, part: "body", attempt: 1,
        renderer: async (_mesh, _camera, dir) => { const path = join(dir, "view.png"); writeFileSync(path, png); return { image: path, metadata: {} }; } });
      await tool.execute(camera, "inspect");
      recorder.recordMeshGuidance({ status: "images_attached", tool_call_ids: ["inspect"] });
      recordReferenceInputs("part_generation", [{ path: image, role: "primary_image" }, { path: join(output, snapshot.path), role: "reference_mesh" }]);
      // A later part not requesting the GLB must not erase earlier inspection.
      recordReferenceInputs("part_generation", [{ path: image, role: "primary_image" }]);
    });
    recordReferenceInputs("refinement", [{ path: image, role: "primary_image" }]);
    return {};
  }, () => ({ status: "completed", outcome: {} }));
  const run = JSON.parse(readFileSync(join(output, "run.json"), "utf8"));
  const attempt = run.attempts.at(-1);
  expect(attempt.inputs.reference_meshes[0].sha256).toBe(snapshot.sha256);
  expect(attempt.input_summary.reference_mesh_used).toBe(true);
  expect(attempt.input_summary.used_by_stage).toMatchObject({ planning: "single_image", part_generation: "images_and_mesh", refinement: "single_image" });
  expect(attempt.mesh_guidance.successful_renders).toBe(1);
  expect(attempt.mesh_guidance.requests[0].image.sha256.length).toBe(64);
  expect(attempt.mesh_guidance.reference_mesh_used).toBe(true);
  expect(attempt.usage.calls).toBe(0); // Local rendering is not billed as a model request.
  expect(existsSync(join(output, "api_calls.jsonl"))).toBe(true);
});
