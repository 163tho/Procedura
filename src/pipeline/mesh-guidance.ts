import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@harness/template/types";
import type { GenerationTool } from "../llm/generate.ts";
import { BLENDER_BIN } from "../render/ao.ts";
import { trackingContext } from "../tracking/context.ts";
import { addStage } from "./stage-timer.ts";

export const MESH_GUIDANCE_MANIFEST = "mesh_guidance.json";
export const MESH_GUIDANCE_POLICY =
  "An optional render_mesh_guidance tool is available for this part and every retry. " +
  "Its untextured GLB is a Hunyuan3D inference from the original reference image, " +
  "not ground truth. Use it only when uncertain about dimensions, proportions, " +
  "depth, placement or occluded areas. State that uncertainty in reason. " +
  "The original image and brief remain authoritative; never override visible evidence, " +
  "copy mesh artifacts, or treat normalized mesh coordinates as physical dimensions. " +
  "The procedural model starts from its normal empty scaffold. Request a view only " +
  "if useful, then return the normal complete part code. Tool access does not require using it. " +
  "At most 8 view requests are allowed per generation attempt.";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function validateGuidanceGlb(path: string): void {
  if (extname(path).toLowerCase() !== ".glb" || !existsSync(path) || !statSync(path).isFile())
    throw new Error("Mesh guidance requires an existing .glb file: " + path);
  const bytes = readFileSync(path);
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2
      || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a)
    throw new Error("Mesh guidance requires a valid glTF 2 binary GLB.");
  const end = 20 + bytes.readUInt32LE(12);
  if (end > bytes.length) throw new Error("Truncated GLB JSON chunk.");
  const json = JSON.parse(bytes.toString("utf8", 20, end));
  if (!Array.isArray(json.meshes) || !json.meshes.some((mesh: any) => mesh.primitives?.length))
    throw new Error("Guidance GLB contains no mesh primitives.");
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])])
    if (resource.uri && !resource.uri.startsWith("data:"))
      throw new Error("Guidance GLB must be self-contained; external resources are not supported.");
}

export interface GuidanceSnapshot {
  schema: 1; path: string; source_path: string; sha256: string; bytes: number;
  provenance: "hunyuan3d_from_primary_image"; usage: "uncertainty_only";
  stages: string[]; initialization: false;
}

export function snapshotMeshGuidance(output: string, requested: string | undefined, resume: boolean): GuidanceSnapshot | undefined {
  const manifest = join(output, MESH_GUIDANCE_MANIFEST);
  if (resume && existsSync(manifest)) {
    const saved = JSON.parse(readFileSync(manifest, "utf8")) as GuidanceSnapshot;
    if (saved.schema !== 1 || saved.path !== "_mesh_guidance/reference.glb" || saved.initialization !== false
        || saved.provenance !== "hunyuan3d_from_primary_image" || saved.usage !== "uncertainty_only"
        || typeof saved.source_path !== "string"
        || JSON.stringify(saved.stages) !== JSON.stringify(["incremental_part_generation", "incremental_part_retry"]))
      throw new Error("Invalid mesh guidance snapshot.");
    const path = join(output, saved.path);
    validateGuidanceGlb(path);
    if (sha(path) !== saved.sha256 || statSync(path).size !== saved.bytes)
      throw new Error("Saved guidance GLB changed; restore it before resuming.");
    if (requested !== undefined) {
      validateGuidanceGlb(resolve(requested));
      if (sha(resolve(requested)) !== saved.sha256)
        throw new Error("Cannot change guidance GLB on resume. Use a new output directory or --redo.");
    }
    return saved;
  }
  if (resume && requested !== undefined)
    throw new Error("Cannot add mesh guidance to an existing draft. Use a new output directory or --redo.");
  if (requested === undefined) {
    if (!resume) {
      rmSync(manifest, { force: true });
      rmSync(join(output, "_mesh_guidance"), { recursive: true, force: true });
    }
    return undefined;
  }
  const source = resolve(requested);
  validateGuidanceGlb(source);
  const path = "_mesh_guidance/reference.glb";
  mkdirSync(join(output, "_mesh_guidance"), { recursive: true });
  if (source !== resolve(output, path)) copyFileSync(source, join(output, path));
  const saved: GuidanceSnapshot = {
    schema: 1, path, source_path: source, sha256: sha(join(output, path)), bytes: statSync(join(output, path)).size,
    provenance: "hunyuan3d_from_primary_image", usage: "uncertainty_only",
    stages: ["incremental_part_generation", "incremental_part_retry"], initialization: false,
  };
  writeFileSync(manifest, JSON.stringify(saved, null, 2) + "\n");
  return saved;
}

export function guidanceCamera(input: JsonObject) {
  const vector = (value: unknown, name: string, bound: number): number[] => {
    if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > bound))
      throw new Error(name + " must contain 3 finite coordinates within ±" + bound);
    return value as number[];
  };
  const camera_position = vector(input.camera_position, "camera_position", 10);
  const target = vector(input.target ?? [0, 0, 0], "target", 1);
  if (Math.hypot(...camera_position.map((v, index) => v - target[index]!)) < 0.05)
    throw new Error("Camera position must differ from its target by at least 0.05.");
  const projection = input.projection ?? "perspective";
  if (projection !== "perspective" && projection !== "orthographic") throw new Error("Invalid projection.");
  const numeric = (value: unknown, fallback: number, low: number, high: number) => {
    const n = value ?? fallback;
    if (typeof n !== "number" || !Number.isFinite(n) || n < low || n > high) throw new Error("Camera scale/FOV is out of range.");
    return n;
  };
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000)
    throw new Error("reason must state the uncertainty being inspected (1–1000 characters).");
  return { camera_position, target, projection, ortho_scale: numeric(input.ortho_scale, 2.5, 0.05, 8),
    fov_degrees: numeric(input.fov_degrees, 45, 15, 100), reason: input.reason };
}

export const guidanceToolDefinition: GenerationTool["definition"] = {
  name: "render_mesh_guidance",
  description: "Run the GLB rendering script for an uncertain area. Returns one untextured image. " +
    "Choose arbitrary camera_position and target in the normalized imported mesh frame: Z up, " +
    "bbox centered at origin, longest side 2 (bounds within [-1,1]); glTF Y-up is converted to Blender Z-up. " +
    "Front alignment is unknown: inspect and map to the original image before using proportions. " +
    "Example whole view: position [3,-4,3], target [0,0,0]. For close-ups aim at a region and " +
    "move closer or lower ortho_scale. These are approximate Hunyuan3D inferences, never ground truth.",
  inputSchema: { type: "object", required: ["camera_position", "reason"], additionalProperties: false, properties: {
    camera_position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
    target: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
    projection: { type: "string", enum: ["perspective", "orthographic"] },
    ortho_scale: { type: "number", minimum: 0.05, maximum: 8 },
    fov_degrees: { type: "number", minimum: 15, maximum: 100 },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  } },
};

export type GuidanceRenderer = (mesh: string, input: ReturnType<typeof guidanceCamera>, directory: string, signal?: AbortSignal) => Promise<{ image: string; metadata: JsonObject }>;
export const renderGuidance: GuidanceRenderer = async (mesh, input, directory, signal) => {
  signal?.throwIfAborted();
  const request = join(directory, "request.json");
  const image = join(directory, "view.png");
  const metadata = join(directory, "camera.json");
  writeFileSync(request, JSON.stringify(input, null, 2) + "\n");
  const script = fileURLToPath(new URL("../../scripts/_render_mesh_guidance_blender.py", import.meta.url));
  const proc = Bun.spawn([BLENDER_BIN, "--background", "--python", script, "--", "--mesh", mesh,
    "--request", request, "--out", image, "--metadata", metadata], { stdout: "pipe", stderr: "pipe" });
  const abort = () => proc.kill();
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort(); }, 180_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    writeFileSync(join(directory, "blender.log"), stdout + "\n" + stderr);
    signal?.throwIfAborted();
    if (timedOut) throw new Error("GLB guidance render timed out after 180 seconds; see blender.log.");
    if (code !== 0 || !existsSync(image) || !existsSync(metadata)) throw new Error("GLB guidance render failed; see blender.log (exit " + code + ").");
    if (statSync(image).size < 1024) throw new Error("GLB guidance render produced an invalid image.");
    return { image, metadata: JSON.parse(readFileSync(metadata, "utf8")) };
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
};

export function createMeshGuidanceTool(args: {
  output: string; snapshot: GuidanceSnapshot; part: string; attempt: number; signal?: AbortSignal;
  emit?: (type: string, payload: Record<string, unknown>) => void; renderer?: GuidanceRenderer;
}): GenerationTool {
  return { definition: guidanceToolDefinition, async execute(input, toolCallId) {
    const requestId = randomUUID();
    const local = join("_mesh_guidance", "views", requestId);
    const directory = join(args.output, local);
    mkdirSync(directory, { recursive: true });
    const started = performance.now();
    const details = { request_id: requestId, tool_call_id: toolCallId, part: args.part, generation_attempt: args.attempt,
      mesh_sha256: args.snapshot.sha256, requested_camera: input, started_at: new Date().toISOString() };
    const record = (data: Record<string, unknown>) => {
      trackingContext()?.recorder.recordMeshGuidance(data);
      args.emit?.("draft.mesh_guidance", data);
    };
    record({ ...details, status: "started" });
    try {
      args.signal?.throwIfAborted();
      const camera = guidanceCamera(input);
      const result = await (args.renderer ?? renderGuidance)(join(args.output, args.snapshot.path), camera, directory, args.signal);
      const image = readFileSync(result.image);
      const completed = { ...details, camera, status: "completed", duration_ms: performance.now() - started,
        ended_at: new Date().toISOString(),
        image: { run_copy: join(local, "view.png").replaceAll("\\", "/"), sha256: sha(result.image), bytes: image.length },
        metadata: result.metadata };
      writeFileSync(join(directory, "result.json"), JSON.stringify(completed, null, 2) + "\n");
      record(completed);
      return { kind: "tool-result", toolCallId, toolName: guidanceToolDefinition.name,
        output: JSON.stringify({ ...result.metadata, camera, warning: "Approximate Hunyuan3D mesh guidance only. Original image and text take precedence." }),
        attachments: [{ kind: "image", data: image.toString("base64"), mimeType: "image/png", label: "Approximate Hunyuan3D guidance: " + camera.reason }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = { ...details, status: args.signal?.aborted ? "aborted" : "failed", error: message,
        ended_at: new Date().toISOString(), duration_ms: performance.now() - started };
      writeFileSync(join(directory, "result.json"), JSON.stringify(failure, null, 2) + "\n");
      record(failure);
      if (args.signal?.aborted) throw error;
      return { kind: "tool-result", toolCallId, toolName: guidanceToolDefinition.name, isError: true,
        output: "Guidance unavailable for this request: " + message + " Correct the camera or continue from the original image and brief." };
    } finally { addStage("mesh_guidance.render", performance.now() - started); }
  } };
}
