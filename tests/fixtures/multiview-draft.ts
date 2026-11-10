import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as harness from "@harness/template";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMClient } from "@harness/template/llm";
import type { CanonicalRequest } from "@harness/template/llm/protocol";
import { recordRun } from "../../src/tracking/run-record.ts";
import { sourceRelativePath } from "../../src/tracking/metadata.ts";
import { resolveAuxiliaryReferences } from "../../src/pipeline/auxiliary-references.ts";

const root = mkdtempSync(join(tmpdir(), "procedura-multiview-draft-"));
const primary = join(root, "original.png");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
writeFileSync(primary, Buffer.concat([png, Buffer.from([99])]));
const paths = Array.from({ length: 12 }, (_, index) => {
  const path = join(root, String(index) + ".png");
  writeFileSync(path, Buffer.concat([png, Buffer.from([index])]));
  return path;
});
const plan = [{ name: "base", level: "L0", description: "A detailed primary box." }];
const noPlan = process.argv.includes("--no-plan");
const retry = process.argv.includes("--retry");
const noAux = process.argv.includes("--no-aux");
const planningRequests = noPlan ? 1 : 2;
const expectedRequests = planningRequests + (retry ? 2 : 1);
const requests: CanonicalRequest[] = [];
const client: LLMClient = {
  async prepare() { throw new Error("Network preparation is forbidden in this fixture"); },
  async *stream() { throw new Error("Network streaming is forbidden in this fixture"); },
  async generate(_route, request) {
    requests.push(request);
    if (requests.length === expectedRequests) throw new Error("STOP_BEFORE_GEOMETRY");
    return [{
      kind: "text-delta",
      text: requests.length > planningRequests ? "Invalid part response; retry generation."
        : JSON.stringify(noPlan ? { done: false, part: plan[0] }
          : requests.length === 1 ? plan : { ok: true, notes: "Complete", plan }),
    }];
  },
};
process.env.PROCEDURA_REF_IMAGE_SIZE = "0";
mock.module("@harness/template", () => ({ ...harness, createLLMClient: () => client }));
globalThis.fetch = Object.assign(async () => { throw new Error("Network is forbidden in this fixture"); }, {
  preconnect: () => { throw new Error("Network is forbidden in this fixture"); },
}) as typeof fetch;

try {
  mock.module("../../src/scad/compile.ts", () => ({
    OPENSCAD_PATH: "unused-in-multiview-fixture",
    async compileScad() { throw new Error("Geometry execution is forbidden in this fixture"); },
  }));
  const { runIncrementalDraft } = await import("../../src/pipeline/draft-incremental.ts");
  const options = {
    text: "A detailed box", inputImage: primary, outputDir: join(root, "output"),
    auxiliaryReferences: resolveAuxiliaryReferences({ images: noAux ? [] : paths }).map(reference => ({
      ...reference, camera: { up_axis: "y", front_axis: "+x" },
    })),
    noPlan, planReviewIters: 1, log: () => {},
  };
  await assert.rejects(recordRun(options.outputDir, { ...options, incremental: true },
    () => runIncrementalDraft(options), () => ({ status: "completed", outcome: null })),
    /STOP_BEFORE_GEOMETRY/);
  const tracked = JSON.parse(readFileSync(join(options.outputDir, "run.json"), "utf8")).attempts[0];
  const summary = tracked.input_summary;
  assert.equal(summary.auxiliary_image_count, noAux ? 0 : 12);
  assert.equal(summary.total_reference_image_count, noAux ? 1 : 13);
  assert.equal(summary.used_by_stage[noPlan ? "next_part_selection" : "planning"], "single_image");
  assert.equal(summary.used_by_stage.part_generation, noAux ? "single_image" : "multi_view_images");
  assert.equal(summary.reference_counts_by_stage.part_generation.auxiliary_image_count, noAux ? 0 : 12);
  assert.equal(summary.reference_mesh_used, false);
  assert.equal(tracked.inputs.auxiliary_images.length, noAux ? 0 : 12);
  for (const [index, reference] of tracked.inputs.auxiliary_images.entries()) {
    assert.equal(reference.source_path, sourceRelativePath(paths[index]!));
    assert.equal(reference.run_copy, "_aux_refs/" + String(index + 1).padStart(2, "0") + ".png");
    assert.equal(reference.provenance, "hunyuan_mesh_render");
  }
  assert.equal(requests.length, expectedRequests);
  for (const [index, request] of requests.entries()) {
    const isGeneration = index >= planningRequests;
    const expectsAuxiliary = isGeneration && !noAux;
    const content = request.messages.flatMap(message => message.content);
    const images = content.filter(part => part.kind === "image");
    assert.equal(images.length, expectsAuxiliary ? 13 : 1);
    assert.equal(images[0]!.kind === "image" && images[0]!.data, readFileSync(primary).toString("base64"));
    const text = content.filter(part => part.kind === "text").map(part => part.text).join("\n");
    if (expectsAuxiliary) {
      assert.match(text, /authoritative reference/);
      assert.match(text, /Hunyuan mesh generated from the original reference image/);
      assert.match(text, /Always follow the original reference image for visible areas/);
      assert.match(text, /only for uncertain or occluded areas/);
      assert.match(text, /auxiliary mesh view/);
      assert.match(text, /SOURCE MESH frame/);
      assert.match(text, /"front_axis":"\+x"/);
      assert.match(JSON.stringify(request.system), /Hunyuan mesh generated from the original reference image/);
      for (const [offset, path] of paths.entries()) {
        assert.equal(images[offset + 1]!.kind === "image" && images[offset + 1]!.data,
          readFileSync(path).toString("base64"), "auxiliary order must match the configured views");
      }
    } else {
      assert.doesNotMatch(text, /auxiliary mesh|Hunyuan|SOURCE MESH/);
      for (const path of paths) {
        assert(!images.some(part => part.kind === "image" && part.data === readFileSync(path).toString("base64")));
      }
    }
    if (!isGeneration) assert.doesNotMatch(JSON.stringify(request.system), /auxiliary|Hunyuan/);
    if (!noPlan && index === 1) {
      assert.match(text, /ADD-AND-SHARPEN ONLY/);
      assert.doesNotMatch(text, /NaN/);
    }
  }
  console.log(String(expectedRequests) + " drafting requests verified; no model, network, or geometry execution");
} finally {
  mock.restore();
  rmSync(root, { recursive: true, force: true });
}
