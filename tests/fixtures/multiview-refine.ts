// Exercise actual refinement request construction with geometry and generation stubbed.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalPart } from "@harness/template/llm/protocol";
import { snapshotAuxiliaryReferences } from "../../src/pipeline/auxiliary-references.ts";

const root = mkdtempSync(join(tmpdir(), "procedura-multiview-refine-"));
const primary = join(root, "image.png");
const build = join(root, "current.png");
const mesh = join(root, "mesh.png");
const stl = join(root, "draft.stl");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
writeFileSync(primary, Buffer.concat([png, Buffer.from([99])]));
writeFileSync(build, Buffer.concat([png, Buffer.from([98])]));
writeFileSync(mesh, Buffer.concat([png, Buffer.from([1])]));
writeFileSync(stl, Buffer.alloc(84));
writeFileSync(join(root, "draft.scad"), "module base() { cube(10); } base();");
writeFileSync(join(root, "prompt.txt"), "A detailed box");
snapshotAuxiliaryReferences(root, [{ path: mesh, label: "front" }], false);

const requests: { system: string; parts: CanonicalPart[] }[] = [];
mock.module("../../src/llm/generate.ts", () => ({
  async generateWithRetry(request: { system: string; parts: CanonicalPart[] }) {
    requests.push(request);
    if (requests.length === 1) return { text: "summary: shape mismatch\n1. [HIGH] Proportions differ. FIX: adjust shape.", reasoning: "" };
    throw new Error("STOP_PATCH");
  },
}));
mock.module("../../src/scad/compile.ts", () => ({
  async compileScad() { return { stlPath: stl }; },
}));
mock.module("../../src/render/parts_color.ts", () => ({
  async renderPartsColorViews() { return { ok: true, views: [{ view: "front", path: build }], legend: "" }; },
}));
mock.module("../../src/tools/connectivity-cache.ts", () => ({
  async ensureConnectivity() { return null; },
  cachedConnectivity() { return null; },
}));
mock.module("../../src/pipeline/refine.ts", () => ({
  DEFAULT_REFINE_STEPS: 6,
  async writeFinalOutputs() { throw new Error("STOP_BEFORE_FINAL_GEOMETRY"); },
}));
globalThis.fetch = Object.assign(async () => { throw new Error("Network is forbidden in this fixture"); }, {
  preconnect: () => { throw new Error("Network is forbidden in this fixture"); },
}) as typeof fetch;

try {
  const { runDirectRefine } = await import("../../src/pipeline/refine-direct.ts");
  await assert.rejects(runDirectRefine({ outputDir: root, maxSteps: 1 }), /STOP_BEFORE_FINAL_GEOMETRY/);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const images = request.parts.filter(part => part.kind === "image");
    assert.equal(images.length, 2, "only the original target and current build may be attached");
    assert.equal(images[0]!.kind === "image" && images[0]!.data, readFileSync(primary).toString("base64"));
    assert.equal(images[1]!.kind === "image" && images[1]!.data, readFileSync(build).toString("base64"));
    assert(!images.some(part => part.kind === "image" && part.data === readFileSync(mesh).toString("base64")));
    const text = request.parts.filter(part => part.kind === "text").map(part => part.text).join("\n");
    assert.doesNotMatch(text + request.system, /auxiliary mesh|Hunyuan|SOURCE MESH/);
  }
  console.log("2 refinement requests verified; no model, network, or geometry execution");
} finally {
  mock.restore();
  rmSync(root, { recursive: true, force: true });
}
