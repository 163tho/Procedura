/** Optional real Blender smoke test, without LLM requests. Leaves images for visual QA. */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triangleGlb } from "./guidance-glb.ts";
import { guidanceCamera, renderGuidance } from "../../src/pipeline/mesh-guidance.ts";
const directory = mkdtempSync(join(tmpdir(), "procedura-guidance-smoke-"));
const source = join(directory, "triangle.glb");
triangleGlb(source);
for (const projection of ["perspective", "orthographic"]) {
  const out = join(directory, projection);
  mkdirSync(out);
  const result = await renderGuidance(source, guidanceCamera({
    camera_position: [3, -4, 3], target: [0, 0, 0], projection,
    reason: "Smoke test: triangle orientation", ortho_scale: 2.5,
  }), out);
  if (result.metadata.textures_used !== false) throw new Error("Expected untextured render");
  console.log(JSON.stringify(result));
}
