#!/usr/bin/env bun
/**
 * Procedura — unified text → param3d pipeline.
 *
 *   bun run scripts/procedura.ts -o <output_dir> --prompt "text..."           # full pipeline
 *   bun run scripts/procedura.ts -o <output_dir> --prompt-file <path>          # prompt from file
 *   bun run scripts/procedura.ts -o <output_dir>                               # resume on existing draft dir
 *   bun run scripts/procedura.ts -o <output_dir> --prompt "..." --redo         # force re-draft
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { beginRun, report } from "../src/pipeline/stage-timer.ts";
import { beginStaging, rebaseStagedPaths } from "../src/pipeline/local-staging.ts";
import { runProcedura } from "../src/pipeline/procedura.ts";
import { imageGenAvailable, imageGenDisabledReason } from "../src/imagegen/images.ts";
import type { MotionCollisionApproximation } from "../src/motion/types.ts";

interface Args {
  outputDir: string;
  prompt?: string;
  promptFile?: string;
  maxSteps?: number;
  agentModel?: string;
  scadModel?: string;
  imageModel?: string;
  image?: string;
  experimentName?: string;
  datasetId?: string;
  repetition?: number;
  pricingFile?: string;
  noImage: boolean;
  redo: boolean;
  oneShot: boolean;
  incremental: boolean;
  contextRenders: boolean;
  assembly: boolean;
  noPlan?: boolean;
  incrementalMotion?: boolean;
  motionAware?: boolean;
  motionOnly?: boolean;
  noRefine: boolean;
  exportStl: boolean;
  paint: boolean;
  paintModel?: string;
  motion: boolean;
  motionPlanPath?: string;
  motionModel?: string;
  motionUseLlm?: boolean;
  motionRefine?: boolean;
  motionAuthor?: boolean;
  motionFixedBase?: boolean;
  motionCollision?: MotionCollisionApproximation;
  motionUrdf?: boolean;
  motionValidate?: boolean;
  motionSimRefine?: boolean;
  /** Run on local disk and sync at the end. Default "auto": on for a network output dir. */
  staging?: "auto" | "always" | "off";
}

function parseArgs(argv: string[]): Args {
  // incremental is the DEFAULT draft mode — --one-shot opts out. The one-shot
  // path emits the whole model in a single call and has no plan stage.
  const args: Args = { outputDir: "", noImage: false, redo: false, oneShot: false,
    incremental: true, contextRenders: false, assembly: false, noRefine: false,
    exportStl: false, paint: false, motion: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (["--experiment", "--dataset-id", "--repetition", "--pricing-file"].includes(a)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) { console.error(a + " requires a value"); process.exit(2); }
      if (a === "--experiment") args.experimentName = value;
      if (a === "--dataset-id") args.datasetId = value;
      if (a === "--pricing-file") args.pricingFile = value;
      if (a === "--repetition") {
        args.repetition = Number(value);
        if (!Number.isInteger(args.repetition) || args.repetition < 1) {
          console.error("--repetition must be a positive integer"); process.exit(2);
        }
      }
      continue;
    }
    if (a === "-o" || a === "--output")       { args.outputDir = argv[++i]!; continue; }
    if (a === "--prompt")                     { args.prompt = argv[++i]!; continue; }
    if (a === "--prompt-file")                { args.promptFile = argv[++i]!; continue; }
    if (a === "--max-steps")                  { args.maxSteps = Number(argv[++i]!); continue; }
    if (a === "--agent-model")                { args.agentModel = argv[++i]!; continue; }
    if (a === "--scad-model")                 { args.scadModel = argv[++i]!; continue; }
    if (a === "--image-model")                { args.imageModel = argv[++i]!; continue; }
    if (a === "--image")                      { args.image = argv[++i]!; continue; }
    if (a === "--no-image")                   { args.noImage = true; continue; }
    if (a === "--redo")                       { args.redo = true; continue; }
    if (a === "--local-staging")              { args.staging = "always"; continue; }
    if (a === "--no-local-staging")           { args.staging = "off"; continue; }
    if (a === "--incremental")                { args.incremental = true; continue; }
    if (a === "--one-shot")                   { args.oneShot = true; args.incremental = false; continue; }
    if (a === "--3d-feedback")                { args.contextRenders = true; continue; }
    if (a === "--assembly")                   { args.incremental = true; args.assembly = true; continue; }
    // Ablation: the incremental build WITHOUT its plan stage.
    if (a === "--no-plan")                    { args.incremental = true; args.noPlan = true; continue; }
    if (a === "--no-incremental-motion")      { args.incrementalMotion = false; continue; }
    // Draft-side articulation WITHOUT phase 4. The awareness has to happen
    // during the build (it measures each part as it is committed); phase 4 can
    // be done any time afterwards from final.scad + the sidecar.
    if (a === "--motion-aware")               { args.incremental = true; args.motionAware = true; continue; }
    // Phase 4 over an existing final.scad. Not --motion plus skips: --no-refine
    // would promote the draft over final.scad and silently discard the refine.
    if (a === "--motion-only")                { args.motionOnly = true; args.motion = true; continue; }
    if (a === "--no-refine")                  { args.noRefine = true; continue; }
    if (a === "--export-stl")                 { args.exportStl = true; continue; }
    if (a === "--paint")                      { args.paint = true; continue; }
    if (a === "--paint-model")                { args.paintModel = argv[++i]!; continue; }
    if (a === "--motion")                     { args.motion = true; continue; }
    if (a === "--motion-plan")                { args.motion = true; args.motionPlanPath = argv[++i]!; continue; }
    if (a === "--motion-model")               { args.motion = true; args.motionModel = argv[++i]!; continue; }
    if (a === "--motion-no-llm")              { args.motion = true; args.motionUseLlm = false; continue; }
    if (a === "--motion-refine")              { args.motion = true; args.motionRefine = true; continue; }
    if (a === "--motion-no-refine")           { args.motion = true; args.motionRefine = false; continue; }
    if (a === "--motion-no-author")           { args.motion = true; args.motionAuthor = false; continue; }
    if (a === "--motion-fixed-base")          { args.motion = true; args.motionFixedBase = true; continue; }
    if (a === "--motion-floating-base")       { args.motion = true; args.motionFixedBase = false; continue; }
    if (a === "--motion-collision")           { args.motion = true; args.motionCollision = parseCollision(argv[++i]!); continue; }
    if (a === "--motion-urdf")                { args.motion = true; args.motionUrdf = true; continue; }
    if (a === "--motion-no-validate")         { args.motion = true; args.motionValidate = false; continue; }
    if (a === "--motion-no-sim-refine")       { args.motion = true; args.motionSimRefine = false; continue; }
    if (a === "-h" || a === "--help")         { printHelpAndExit(); }
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
  if (!args.outputDir) {
    console.error(`usage: procedura.ts -o <output_dir> [--prompt "..." | --prompt-file <path>] [options]`);
    process.exit(2);
  }
  // Both of these would otherwise fail deep inside a stage, minutes in, with a
  // message about something else.
  if (args.noImage && args.image !== undefined) {
    console.error(`--no-image and --image PATH are contradictory: one says use no reference, the other supplies one`);
    process.exit(2);
  }
  if (args.oneShot && args.incremental) {
    console.error(`--one-shot conflicts with a flag that requires the part-by-part draft (--incremental / --assembly / --no-plan / --motion-aware)`);
    process.exit(2);
  }
  if (args.noImage && !args.incremental) {
    console.error(`--no-image requires the part-by-part draft: the one-shot path always renders a reference first`);
    process.exit(2);
  }
  if (args.contextRenders && !args.incremental) {
    console.error(`--3d-feedback requires the part-by-part draft: there are no intermediate builds to render in a one-shot draft`);
    process.exit(2);
  }
  // No reference, and no way to make one. Rather than refuse, run text-only —
  // that is the default configuration, and it is a real mode, not a degraded
  // one. Say so out loud, because a reference changes what the run is doing.
  const haveImage = args.image !== undefined
    || (!args.redo && existsSync(join(resolvePath(args.outputDir), "image.png")));
  if (!args.noImage && !haveImage && !imageGenAvailable(args.imageModel)) {
    if (args.incremental) {
      console.log(
        `  no reference image and image generation is off — running TEXT-ONLY.\n` +
        `  (pass --image <path> to reconstruct one, or set PROCEDURA_IMAGE_MODEL to generate it)`,
      );
      args.noImage = true;
    } else {
      // The one-shot draft cannot run without a reference at all.
      console.error(imageGenDisabledReason(args.imageModel));
      process.exit(2);
    }
  }
  return args;
}

function printHelpAndExit(): never {
  console.log(`
Procedura — unified text → param3d pipeline.

Usage:
  bun run scripts/procedura.ts -o <output_dir> --prompt "..."
  bun run scripts/procedura.ts -o <output_dir> --prompt-file <path>
  bun run scripts/procedura.ts -o <output_dir>                    # resume on existing draft dir

Options:
  --experiment NAME     optional experiment label saved in run.json
  --dataset-id ID       optional dataset/object identifier
  --repetition N        optional positive repetition index
  --pricing-file PATH   JSON rates in USD per million tokens; see docs/run-tracking.md.
                         run.json and api_calls.jsonl are always saved beside outputs.
  --prompt TEXT          free-text prompt (alternative: --prompt-file)
  --prompt-file PATH     read prompt from a UTF-8 file
  --image PATH           reconstruct THIS image. Raises fidelity a lot — the
                         best-quality runs all supply one.
  --no-image             TEXT ONLY: no reference image anywhere in the run. This
                         is the DEFAULT when none is supplied and image
                         generation is off; the flag states it explicitly.
                         Reconstructing a reference is a different task, not a
                         more expensive version of this one.
  --redo                 force re-draft even if image/scad/stl exist
  --incremental          build the draft part-by-part: plan the parts, then
                         generate one module per part, splicing and gating each
                         into the growing model. ON BY DEFAULT — the flag is
                         kept so scripts that pass it keep working.
  --one-shot             opt OUT of the above: emit the whole model in a single
                         SCAD-gen call, with no plan stage. Faster and much
                         weaker on anything with more than a few parts.
  --3d-feedback          before authoring each part, render the build-so-far and
                         show it to the generator. Off by default: it costs a
                         Blender pass per part, and the plan text plus the
                         SCAD-so-far buffer already say what exists. Turn it on
                         for the best-quality run — the generator then works
                         from the geometry rather than a description of it.
  --assembly             assembly-aware incremental generation (implies
                         --incremental): inline the mating-feature helper library
                         (lib/assembly.scad) into the build seed and add a mating
                         prompt so parts join through real interfaces
                         (shared-nominal pegs/sockets, bolt patterns, snaps, tabs)
                         instead of bare overlap. No extra LLM calls. Env kill
                         switch: PROCEDURA_INCREMENTAL_ASSEMBLY=0.
  --no-plan              ABLATION (implies --incremental): build part-by-part with
                         NO plan stage — no upfront decomposition and no plan
                         review. Before each part the model is shown the
                         reference, the build so far and the parts already built,
                         and returns either the next part or "done". Everything
                         else (per-part gen, gates, sidecars, refine) is
                         unchanged, so the run isolates what the plan is worth.
                         Env form: PROCEDURA_NO_PLAN=1.
  --motion-aware         (implies --incremental) run the motion-AWARE draft but
                         NOT phase 4: the plan declares per-part joint intent and
                         each moving part is mesh-measured into
                         motion_incremental.json, at no extra LLM cost. Articulate
                         it later with --motion-only. Use this when you want the
                         articulation data captured now and the USD/Isaac export
                         decided later — the draft-side half cannot be recovered
                         afterwards, the phase-4 half can.
  --motion-only          run ONLY phase 4 over an output dir that already has
                         final.scad. No draft, no refine, nothing overwritten.
                         (Do NOT use '--motion --no-refine' for this: --no-refine
                         promotes the draft over final.scad and discards the
                         refine you already paid for.)
  --no-incremental-motion disable motion-aware incremental generation (per-part
                         articulation declare + mesh measure → motion_incremental
                         .json for the Phase 4 planner); it is on by default
                         when --incremental and --motion are both set. Env kill
                         switch: PROCEDURA_INCREMENTAL_MOTION=0.
  --no-refine            skip the whole-model Phase 2 refine; the draft is
                         promoted to final.* (draft-only output)
  --export-stl           also write the binary STL (draft.stl / final.stl);
                         off by default — only the normalized OBJ (+ SCAD) ships
  --paint                run the Phase 3 material pass: a vision LLM assigns a
                         per-part PBR material (colour + metal/rough) from the
                         reference image. Off by default. Writes final_materials
                         .json, final_painted.scad, final_painted.obj/.mtl, and
                         preview_painted/. Works on incremental OR one-shot shapes.
  --paint-model M        vision model for the paint pass (default $PROCEDURA_MODEL)
  --motion               run Phase 4 OpenUSD/Isaac motion export after final.scad.
                         Without --motion-plan, a two-call vision LLM pass scans
                         final.scad plus per-part render feedback to plan and
                         author the articulation before USDA export.
  --motion-plan PATH     JSON sidecar defining links, joints, limits and drives
                         for USD Physics export. Bypasses the LLM planner.
  --motion-model M       vision/reasoning model for the motion planner
                         (default $PROCEDURA_MODEL)
  --motion-no-llm        disable LLM planning when no sidecar is supplied; use
                         the legacy fixed-joint default plan
  --motion-no-refine     disable the default one-step LLM repair pass after the
                         motion author call
  --motion-fixed-base    attach the root link to world with a fixed joint
                         (default for generated plans)
  --motion-floating-base do not attach the root link to world
  --motion-collision T   default collision approximation for link meshes:
                         convexHull, convexDecomposition, meshSimplification,
                         boundingCube, boundingSphere, sdf, or none
  --motion-urdf          also export URDF (motion/urdf/robot.urdf + meshes/)
  --motion-no-validate   skip the headless Isaac Sim validation of the exported
                         asset (schema audit + asset rules + N-frame sim test)
  --motion-no-sim-refine skip the extra LLM refine round that runs when Isaac
                         validation flags issues
  --max-steps N          (final) refine loop budget in EDIT CYCLES (default 6).
                         Each cycle is render → critic → measure → patch →
                         compile → gate, costing 2 LLM calls. Override with
                         PROCEDURA_REFINE_STEPS.
  --agent-model M        refine LLM (default $PROCEDURA_MODEL)
  --scad-model M         draft SCAD-gen / plan LLM (default $PROCEDURA_MODEL)
  --image-model M        generate the reference with this image model, for this
                         run only. Image generation is OFF unless this or
                         $PROCEDURA_IMAGE_MODEL is set.

Writes into <output_dir>:
  Phase 1 (draft):   image.png, draft.scad, draft.stl, draft.obj,
                     effective_text.txt, prompt.txt, response.txt
  Phase 2 (refine):  final.scad / .stl / .obj,
                     preview_final/, final_summary.txt
  Phase 4 (motion):  motion/final_motion.usda, motion/motion_plan.*.json,
                     motion/links/<link>/<link>.obj/.stl
  Both:              _trajectory/procedura-<id>.jsonl,
                     _agent_renders/step_NN/, _agent_compiles/step_NN_<tag>/
`);
  process.exit(0);
}

function parseCollision(value: string): MotionCollisionApproximation {
  const allowed = new Set<MotionCollisionApproximation>([
    "none",
    "convexHull",
    "convexDecomposition",
    "boundingCube",
    "boundingSphere",
    "meshSimplification",
    "sdf",
  ]);
  if (allowed.has(value as MotionCollisionApproximation)) return value as MotionCollisionApproximation;
  console.error(`invalid --motion-collision: ${value}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));

let prompt: string | undefined;
if (args.prompt) {
  prompt = args.prompt;
} else if (args.promptFile) {
  prompt = readFileSync(args.promptFile, "utf8").trim();
}

beginRun();
// Write locally and sync once at the end when the output dir is a network mount
// (measured here: 4.61 MB/s write, 383 ms per small file, vs 1158 MB/s and
// 0.6 ms locally). --no-local-staging opts out.
const staging = beginStaging(args.outputDir, args.staging ?? "auto");
let result;
try {
  result = await runProcedura({
    outputDir: staging.workDir,
    trackingOutputDir: args.outputDir,
    ...(args.experimentName !== undefined ? { experimentName: args.experimentName } : {}),
    ...(args.datasetId !== undefined ? { datasetId: args.datasetId } : {}),
    ...(args.repetition !== undefined ? { repetition: args.repetition } : {}),
    ...(args.pricingFile !== undefined ? { pricingFile: args.pricingFile } : {}),
  ...(prompt !== undefined ? { text: prompt } : {}),
  ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
  ...(args.image !== undefined ? { inputImage: args.image } : {}),
  ...(args.noImage ? { textOnly: true } : {}),
  ...(args.agentModel !== undefined ? { agentModel: args.agentModel } : {}),
  ...(args.scadModel !== undefined ? { scadModel: args.scadModel } : {}),
  ...(args.imageModel !== undefined ? { imageModel: args.imageModel } : {}),
  ...(args.paintModel !== undefined ? { paintModel: args.paintModel } : {}),
  ...(args.motionPlanPath !== undefined ? { motionPlanPath: args.motionPlanPath } : {}),
  ...(args.motionModel !== undefined ? { motionModel: args.motionModel } : {}),
  ...(args.motionUseLlm !== undefined ? { motionUseLlm: args.motionUseLlm } : {}),
  ...(args.motionRefine !== undefined ? { motionRefine: args.motionRefine } : {}),
  ...(args.motionAuthor !== undefined ? { motionAuthor: args.motionAuthor } : {}),
  ...(args.motionFixedBase !== undefined ? { motionFixedBase: args.motionFixedBase } : {}),
  ...(args.motionCollision !== undefined ? { motionCollision: args.motionCollision } : {}),
  ...(args.motionUrdf !== undefined ? { motionUrdf: args.motionUrdf } : {}),
  ...(args.motionValidate !== undefined ? { motionValidate: args.motionValidate } : {}),
  ...(args.motionSimRefine !== undefined ? { motionSimRefine: args.motionSimRefine } : {}),
  incremental: args.incremental,
  ...(args.contextRenders ? { contextRenders: true } : {}),
  assembly: args.assembly,
  ...(args.noPlan ? { noPlan: true } : {}),
  ...(args.incrementalMotion !== undefined ? { incrementalMotion: args.incrementalMotion } : {}),
  ...(args.motionAware !== undefined ? { motionAware: args.motionAware } : {}),
  ...(args.motionOnly !== undefined ? { motionOnly: args.motionOnly } : {}),
  refine: !args.noRefine,
  exportStl: args.exportStl,
  paint: args.paint,
  motion: args.motion,
    redo: args.redo,
  });
} catch (e) {
  // A crashed run's artifacts are how you diagnose it — sync before rethrowing.
  staging.finish("after error");
  throw e;
}
staging.finish("run complete");
// A successful sync removes the temporary directory. Report and classify the
// persistent artifacts; on a failed sync the retained temporary paths stay valid.
if (!existsSync(staging.workDir))
  result = rebaseStagedPaths(result, staging.workDir, args.outputDir);

console.log("\n" + report(`stage breakdown`, [
  ["LLM — draft gen", "llm.generate", 0],
  ["LLM — refine critic", "llm.critic", 0],
  ["LLM — refine patch", "llm.patch", 0],
  ["OpenSCAD total", "openscad.total", 0],
  ["  colour split", "openscad.split", 1],
  // NOT the --assembly feature: this is the whole-model compile every part
  // pays for the connectivity gate. The two sat one line apart in the table
  // under names a reader would reasonably conflate.
  ["  part gate (whole-model)", "openscad.assembly", 1],
  ["  refine compiles", "openscad.refine", 1],
  ["  refine measure", "openscad.measure", 1],
  ["  part measure (motion/assembly)", "openscad.part_measure", 1],
  ["Blender total", "blender.parts_color", 0],
  ["  AO renders", "blender.ao", 1],
  ["  refine views", "blender.refine", 1],
  // Phase 4 has no single aggregate stage, so these are listed flat rather
  // than under a parent that would double-count one of its own children.
  ["Motion — LLM plan", "llm.motion-plan", 0],
  ["Motion — LLM author", "llm.motion-author", 0],
  ["Motion — LLM refine", "llm.motion-refine", 0],
  ["Motion — LLM sim-refine", "llm.motion-sim-refine", 0],
  ["Motion — link meshes", "motion.links", 0],
  ["Motion — Isaac validate", "motion.isaac", 0],
  ["Paint — LLM extract", "llm.paint-extract", 0],
  ["Paint — LLM assign", "llm.paint-assign", 0],
  ["Paint — LLM refine", "llm.paint-refine", 0],
  ["Paint — LLM subparts", "llm.paint-subparts", 0],
  ["Paint — geometry split", "paint.split", 0],
  ["Paint — colour split", "paint.color_split", 0],
  ["Paint — subpart validate", "paint.subpart_validate", 0],
  ["Paint — PBR renders", "paint.render", 0],
]));
console.log(`\n=== Procedura done ===`);
console.log(`  output_dir: ${result.outputDir}`);
console.log(`  trajectory: ${result.trajectoryPath}`);
if (result.draft) {
  console.log(`  phase 1 (draft):  ${result.draft.ok ? "ok" : "FAILED"}` +
              ` (${Math.round(result.draft.durationMs / 1000)}s)`);
}
console.log(`  phase 2 (refine): verdict=${result.refine.verdict} ` +
            `steps=${result.refine.steps}`);
console.log(`  outputs: ${result.refine.outputs.scadPath}`);
if (result.refine.outputs.stlPath) console.log(`           ${result.refine.outputs.stlPath}`);
if (result.paint) {
  console.log(`  phase 3 (paint):  ${result.paint.ok ? "ok" : "FAILED"}` +
              ` (${result.paint.parts.length} parts, ${Math.round(result.paint.durationMs / 1000)}s)`);
  if (result.paint.paintedObjPath) console.log(`           ${result.paint.paintedObjPath}`);
  if (result.paint.materialsPath) console.log(`           ${result.paint.materialsPath}`);
}
if (result.motion) {
  console.log(`  phase 4 (motion): ${result.motion.ok ? "ok" : "FAILED"}` +
              ` (${result.motion.linkCount} links, ${result.motion.jointCount} joints, ` +
              `${Math.round(result.motion.durationMs / 1000)}s)`);
  if (result.motion.planSource) console.log(`           plan_source=${result.motion.planSource}`);
  if (result.motion.usdaPath) console.log(`           ${result.motion.usdaPath}`);
  if (result.motion.urdfPath) console.log(`           ${result.motion.urdfPath}`);
  if (result.motion.planPath) console.log(`           ${result.motion.planPath}`);
  if (result.motion.validation?.ran) {
    console.log(`           isaac_validation=${result.motion.validation.ok ? "passed" : "FAILED"}` +
                `${result.motion.simRefined ? " (after sim-refine)" : ""}` +
                ` strict=${result.motion.validation.strictOk ? "ok" : "advisory-issues"}`);
  } else if (result.motion.validation?.skippedReason) {
    console.log(`           isaac_validation=skipped (${result.motion.validation.skippedReason})`);
  }
  if (result.motion.warnings.length > 0) {
    console.log(`           warnings: ${result.motion.warnings.length}`);
  }
}

// Exit semantics: 0 = ok mesh, 3 = mesh produced but a phase reported non-ok,
// 1 = no mesh. Classify by produced mesh, not verdict; a motion/validation
// failure never masks a good mesh as exit 1.
const meshProduced = existsSync(result.refine.outputs.objPath ?? result.refine.outputs.scadPath);
const motionOk = !result.motion
  || (result.motion.ok && (!result.motion.validation?.ran || result.motion.validation.ok === true));
process.exit(meshProduced ? (result.refine.ok && motionOk ? 0 : 3) : 1);
