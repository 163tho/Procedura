/** Isolated offline stage-wiring test. Geometry tools and the LLM are fixtures. */
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triangleGlb } from "./guidance-glb.ts";
import type { GenerateResult } from "../../src/llm/generate.ts";
const calls: { label: string; tools: boolean; text: string }[] = [];
let compileCalls = 0;
let nextCalls = 0;
const plan = [{ name: "body", description: "A solid body", level: "L1" }];
const code = "// PARAMS\nsize=1;\n// PART\nmodule body() { cube(size); }\n// PLACE\nbody();";
function generation(args: any, tools: boolean): Promise<GenerateResult> {
  const text = args.system + "\n" + args.parts.filter((part: any) => part.kind === "text").map((part: any) => part.text).join("\n");
  calls.push({ label: args.label, tools, text });
  if (!args.label.startsWith("draft.part.")) {
    assert(!tools);
    assert(!text.includes("render_mesh_guidance"));
    assert(!text.includes("Hunyuan3D"));
  }
  if (tools) assert.equal(args.tool.definition.name, "render_mesh_guidance");
  let result = code;
  if (args.label === "draft.plan") result = JSON.stringify(plan);
  if (args.label === "draft.plan_review") result = JSON.stringify({ ok: true, notes: "ready", plan });
  if (args.label === "draft.next_part") result = JSON.stringify(++nextCalls === 1 ? { done: false, part: plan[0] } : { done: true });
  return Promise.resolve({ text: result, reasoning: "" });
}
mock.module("../../src/llm/generate.ts", () => ({
  generateOnce: (args: any) => generation(args, false),
  generateWithTools: (args: any) => generation(args, true),
}));
mock.module("../../src/scad/compile.ts", () => ({
  async compileScad(_code: string, opts: { outputDir: string }) {
    // Force the ordinary compile-fix path to verify that retries retain tools.
    if (++compileCalls === 1) throw new Error("fixture compile error");
    mkdirSync(opts.outputDir, { recursive: true });
    const stlPath = join(opts.outputDir, "output.stl"), objPath = join(opts.outputDir, "output.obj");
    writeFileSync(stlPath, Buffer.alloc(84)); writeFileSync(objPath, "fixture obj");
    return { stlPath, objPath, summary: {}, stdout: "", stderr: "", durationMs: 0, exitCode: 0, empty: false };
  },
}));
mock.module("../../src/mesh/normalize.ts", () => ({ publishMesh(args: any) { writeFileSync(args.objOut, "fixture obj"); } }));
const { runIncrementalDraft } = await import("../../src/pipeline/draft-incremental.ts");
process.env.PROCEDURA_INCREMENTAL_CONN_GATE = "0";
process.env.PROCEDURA_CONTEXT_VIEWS = "";
process.env.PROCEDURA_NO_PLAN = "0";
const directory = mkdtempSync(join(tmpdir(), "procedura-guidance-stages-"));
try {
  const source = join(directory, "reference.glb"), image = join(directory, "reference.png");
  triangleGlb(source);
  writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUz8AAAAASUVORK5CYII=", "base64"));
  for (const mode of ["planned", "no-plan", "baseline"]) {
    compileCalls = 0; nextCalls = 0; calls.length = 0;
    const out = join(directory, mode);
    const result = await runIncrementalDraft({ text: "A solid cube", outputDir: out,
      inputImage: image, guidanceMesh: mode === "baseline" ? undefined : source,
      noPlan: mode === "no-plan", planReviewIters: 1, log: () => {} });
    assert(result.ok);
    const generationCalls = calls.filter(call => call.label.startsWith("draft.part."));
    assert.equal(generationCalls.length, 2);
    assert(generationCalls.every(call => call.tools === (mode !== "baseline")));
    assert(generationCalls[1]!.text.includes("PRIOR ATTEMPT FAILED TO COMPILE"));
    assert(!readFileSync(join(out, "draft.scad"), "utf8").includes(".glb"));
    assert(!readFileSync(join(out, "draft.scad"), "utf8").includes("import("));
    assert(calls.some(call => call.label === (mode === "no-plan" ? "draft.next_part" : "draft.plan")));
    if (mode !== "no-plan") assert(calls.some(call => call.label === "draft.plan_review"));
  }
  console.log("Stage isolation passed: planning, review, next-part selection, per-part generation, compile-fix retry, baseline seed.");
} finally { rmSync(directory, { recursive: true, force: true }); }
