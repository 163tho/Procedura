import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, resolveModel } from "../config/models.ts";

export const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export function fileRecord(path: string) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return { path: resolve(path), bytes: statSync(path).size, sha256: hash(readFileSync(path)) };
}
function command(argv: string[], cwd = SOURCE_ROOT, trim = true): string | null {
  try {
    const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: 2000 });
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString() || result.stderr.toString();
    return trim ? output.trim() : output;
  } catch { return null; }
}
export function sourceMetadata() {
  const scopes = ["src", "prompts", "lib", "scripts", "vendor/harness", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"];
  const paths = command(["git", "ls-files", "-z", "-c", "-o", "--exclude-standard", "--", ...scopes])?.split("\0").filter(Boolean) ?? [];
  const files: Record<string, string> = {};
  for (const rel of [...new Set(paths)].sort()) {
    const path = join(SOURCE_ROOT, rel);
    if (existsSync(path) && statSync(path).isFile()) files[rel] = hash(readFileSync(path));
  }
  const untracked: Record<string, string> = {};
  for (const rel of command(["git", "ls-files", "-z", "--others", "--exclude-standard", "--", ...scopes])?.split("\0").filter(Boolean) ?? []) {
    const path = join(SOURCE_ROOT, rel);
    if (existsSync(path) && statSync(path).isFile()) untracked[rel] = readFileSync(path, "utf8");
  }
  const status = command(["git", "status", "--porcelain"]);
  return {
    commit: command(["git", "rev-parse", "HEAD"]),
    branch: command(["git", "symbolic-ref", "--short", "-q", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    status, fingerprint_sha256: hash(JSON.stringify(files)), files,
    tracked_source_patch: command(["git", "diff", "--binary", "HEAD", "--", ...scopes], SOURCE_ROOT, false),
    untracked_sources: untracked,
  };
}
export function safeEndpoint(value: string): string | null {
  try { const url = new URL(value); return url.origin + url.pathname; } catch { return null; }
}
const allowedOptions = [
  "text", "inputImage", "incremental", "textOnly", "redo", "maxSteps", "scadModel", "agentModel", "imageModel",
  "contextRenders", "assembly", "extraRefs", "noPlan", "refine", "exportStl", "paint", "paintModel", "motion",
  "motionModel", "motionPlanPath", "motionAware", "incrementalMotion", "motionOnly", "motionUseLlm", "motionRefine",
  "motionAuthor", "motionFixedBase", "motionCollision", "motionUrdf", "motionValidate", "motionSimRefine",
  "experimentName", "datasetId", "repetition", "pricingFile",
];
const allowedEnvironment = [
  "PROCEDURA_PROVIDER", "PROCEDURA_MODEL", "PROCEDURA_IMAGE_MODEL", "PROCEDURA_REASONING_EFFORT", "PROCEDURA_REFINE_MODE",
  "PROCEDURA_PLAN_REVIEW_ITERS", "PROCEDURA_MAX_PARTS", "PROCEDURA_NO_PLAN", "PROCEDURA_NOPLAN_HARD_CAP",
  "PROCEDURA_INCREMENTAL_CONN_GATE", "PROCEDURA_INCREMENTAL_MOTION", "PROCEDURA_INCREMENTAL_ASSEMBLY",
  "PROCEDURA_INCREMENTAL_MOTION_GATE", "PROCEDURA_INCREMENTAL_ASSEMBLY_GATE", "PROCEDURA_SKIP_MATE_CHECK",
  "PROCEDURA_SKIP_PART_COMPILE", "PROCEDURA_REF_IMAGE_SIZE", "PROCEDURA_FEEDBACK_RENDER_SIZE", "PROCEDURA_CONTEXT_VIEWS",
  "PROCEDURA_CONTEXT_RENDER_FN", "PROCEDURA_REFINE_MIN_FACET_RATIO", "PROCEDURA_REFINE_REMOVAL_FACET_RATIO",
  "PROCEDURA_REFINE_MAX_BARREN", "PROCEDURA_PAINT_SUBPART_CONCURRENCY", "PROCEDURA_PAINT_CRITIC_SIZE",
  "PROCEDURA_PAINT_CRITIC_SAMPLES", "PROCEDURA_LLM_TIMEOUT_MS", "PROCEDURA_LLM_DEADLINE_MS", "PROCEDURA_LLM_MAX_ATTEMPTS",
  "PROCEDURA_LLM_STREAM_IDLE_MS", "PROCEDURA_IMAGEGEN_ATTEMPTS", "LLM_NO_STREAM_USAGE",
];
export function inputMetadata(output: string, opts: Record<string, any>) {
  const prompt = opts.text ?? ["effective_text.txt", "prompt.txt", "brief.md"]
    .map(name => join(output, name)).filter(existsSync).map(path => readFileSync(path, "utf8"))[0] ?? null;
  return {
    prompt, prompt_sha256: prompt === null ? null : hash(prompt),
    image: opts.textOnly ? null : fileRecord(opts.inputImage ?? join(output, "image.png")),
    motion_plan: opts.motionPlanPath ? fileRecord(opts.motionPlanPath) : null,
  };
}
export function configuration(opts: Record<string, any>) {
  return {
    requested: Object.fromEntries(allowedOptions.filter(key => opts[key] !== undefined).map(key => [key, opts[key]])),
    environment_overrides: Object.fromEntries(allowedEnvironment.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    effective: {
      incremental: opts.incremental ?? false, text_only: opts.textOnly ?? false, refine: opts.refine !== false,
      refine_mode: process.env.PROCEDURA_REFINE_MODE === "agent" ? "agent" : "direct",
      refine_max_steps: opts.maxSteps ?? 6, paint: opts.paint ?? false, motion: opts.motion ?? false,
      no_plan: Boolean(opts.noPlan) || process.env.PROCEDURA_NO_PLAN === "1",
      context_renders: opts.contextRenders ?? false,
      assembly_aware: Boolean(opts.incremental && opts.assembly) && process.env.PROCEDURA_INCREMENTAL_ASSEMBLY !== "0",
      motion_aware: (opts.motionAware ?? Boolean(opts.incremental && opts.motion && opts.incrementalMotion !== false))
        && process.env.PROCEDURA_INCREMENTAL_MOTION !== "0",
      connectivity_gate: process.env.PROCEDURA_INCREMENTAL_CONN_GATE !== "0",
      motion_gate: process.env.PROCEDURA_INCREMENTAL_MOTION_GATE === "1",
      assembly_gate: process.env.PROCEDURA_INCREMENTAL_ASSEMBLY_GATE === "1",
      export_stl: opts.exportStl ?? false,
      plan_review_iters: Number(process.env.PROCEDURA_PLAN_REVIEW_ITERS ?? 1),
      max_parts: Number(process.env.PROCEDURA_MAX_PARTS ?? 0),
      reference_image_size: Number(process.env.PROCEDURA_REF_IMAGE_SIZE ?? 1024),
      feedback_image_size: Number(process.env.PROCEDURA_FEEDBACK_RENDER_SIZE ?? 1024),
      models: Object.fromEntries(["scad", "agent", "paint", "motion"].map(stage => [stage, resolveModel(opts[stage + "Model"] ?? DEFAULT_MODEL)])),
      image_model: opts.imageModel ?? process.env.PROCEDURA_IMAGE_MODEL ?? null,
    },
    endpoints: Object.fromEntries(["OPENAI_BASE_URL", "GEMINI_BASE_URL"].filter(key => process.env[key]).map(key => [key, safeEndpoint(process.env[key]!)])),
  };
}
export function environmentMetadata() {
  return {
    os: process.platform, architecture: process.arch, os_release: command(["uname", "-r"]),
    runtime_versions: { ...process.versions }, cpu: cpus()[0]?.model ?? null,
    logical_cpu_count: cpus().length, total_memory_bytes: totalmem(),
    tools: {
      python: command(["python3", "--version"]),
      openscad: command([process.env.OPENSCAD_PATH || "openscad", "--version"]),
      blender: command([process.env.PROCEDURA_BLENDER_PATH || "blender", "--version"])?.split("\n")[0] ?? null,
      gpu: command(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"]),
    },
  };
}
export function outputMetadata(output: string) {
  const names = ["image.png", "prompt.txt", "effective_text.txt", "draft.scad", "draft.obj", "final.scad", "final.obj", "final.stl", "final_summary.txt",
    "plan.json", "parts_summary.json", "final_materials.json", "final_painted.obj", "motion/motion_plan.json"];
  return Object.fromEntries(names.filter(name => existsSync(join(output, name))).map(name => [name, fileRecord(join(output, name))]));
}
