/**
 * runProcedura — the unified text → param3d pipeline.
 *
 *   text → image-gen → SCAD-gen → compile → agent loop → normalise → preview
 *
 * Two phases under one trajectory file:
 *   Phase 1 (draft) : runs only if the output dir is missing artifacts
 *                     (image.png / draft.scad / draft.stl) AND `text` is
 *                     supplied. If you point at a dir that already has those,
 *                     this phase is skipped.
 *   Phase 2 (refine): runs unless `refine: false`, in which case the draft is
 *                     promoted to final.* and refine is skipped. Picks up where
 *                     draft left off.
 *
 * The two phases internally create their own harness instances (the agent
 * loop needs tools + an image-aware engine bound to a real image file; the
 * draft stage doesn't have those), but they share a single trajectory writer
 * so all events land in one `_trajectory/procedura-<id>.jsonl`.
 *
 * Resume modes:
 *   { text, outputDir }                — full pipeline
 *   { outputDir } (artifacts present)  — refine only
 *   { text, outputDir, redo }          — force re-draft even if artifacts exist
 */

import { recordRun } from "../tracking/run-record.ts";
import { inPhase, skipPhase } from "../tracking/context.ts";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { createFileTrajectoryWriter } from "../trajectory/writer.ts";
import { runDraft, type DraftResult } from "./draft.ts";
import { runIncrementalDraft, type IncrementalDraftResult } from "./draft-incremental.ts";
import { runRefine, type RefineResult } from "./refine.ts";
import { runDirectRefine } from "./refine-direct.ts";
import { runPaint, type PaintResult } from "./paint.ts";
import { runMotionExport, type MotionExportResult } from "./motion.ts";
import type { MotionCollisionApproximation } from "../motion/types.ts";
import { renderAOViews } from "../render/ao.ts";
import type { AuxiliaryReference } from "./auxiliary-references.ts";

export interface RunProceduraOpts {
  /** Free-text prompt. Required unless artifacts already exist in outputDir. */
  text?: string;
  outputDir: string;
  /** Max refine loop iterations. Default DEFAULT_REFINE_STEPS (6). */
  maxSteps?: number;
  /** Model for the refine loop. Default DEFAULT_MODEL. */
  agentModel?: string;
  /** Model for the draft SCAD-gen call. Default DEFAULT_MODEL. */
  scadModel?: string;
  /** Model for image-gen. Default DEFAULT_IMAGE_MODEL. */
  imageModel?: string;
  /** When set, skip image-gen in the draft phase and use this image file as
   *  the reference (copied to <outputDir>/image.png). SCAD-gen still runs. */
  inputImage?: string;
  /** Hunyuan mesh renders for incremental part generation only; excluded from planning and refinement. */
  auxiliaryReferences?: AuxiliaryReference[];
  /** Text-only: generate with NO reference image at all. Skips image-gen in the
   *  draft; refine and paint follow automatically by detecting the absent
   *  image.png. Incremental draft only — `runDraft` still needs an image. */
  textOnly?: boolean;
  /** Force re-run of draft even if image+scad+stl already exist. */
  redo?: boolean;
  /** Use the incremental, part-by-part draft stage (plan → for each part:
   * generate one module → focused refine) instead of the single-shot draft.
   * The final whole-model Phase 2 refine still runs afterwards. */
  incremental?: boolean;
  /** Motion-aware incremental generation: the plan declares per-part
   * articulation intent and the builder mesh-measures each committed moving
   * part into motion_incremental.json for the Phase 4 motion planner. Auto-on
   * when `incremental` and `motion` are both set; pass false to disable
   * (also: env PROCEDURA_INCREMENTAL_MOTION=0). */
  incrementalMotion?: boolean;
  /** Run the motion-AWARE draft without running Phase 4.
   *
   * The draft-side work (plan declares joint intent, each moving part is
   * mesh-measured into motion_incremental.json) costs no extra LLM calls and
   * cannot be recovered afterwards — it depends on per-part state that only
   * exists while the part is being built. Phase 4 costs four LLM calls and an
   * Isaac run, and CAN be done later from final.scad plus the sidecar.
   *
   * So they are separable, and this separates them: set to force the awareness
   * on (or off) independently of `motion`. Default: on exactly when `motion`
   * and `incremental` are both set, which is the historical behaviour. */
  motionAware?: boolean;
  /** Run ONLY Phase 4 over an output dir that already has final.scad: no
   *  draft, no refine, nothing overwritten. The pair to `motionAware` — build
   *  the shape now, articulate it later.
   *
   *  Without this, "run motion on an existing dir" means `-o dir --motion`,
   *  which re-runs the whole refine; and adding --no-refine to stop that
   *  PROMOTES THE DRAFT OVER final.scad, discarding the refine already paid
   *  for. Both are silent. */
  motionOnly?: boolean;
  /** Show the generator a render of the build-so-far before each part
   *  (incremental only). Default false: it costs a Blender pass per part.
   *  The best-quality configuration turns it on. */
  contextRenders?: boolean;
  /** Assembly-aware incremental generation: inline the mating-feature helper
   * library and append a mating prompt so parts join through real interfaces
   * (shared-nominal pegs/sockets, bolt patterns, snaps). Opt-in; independent of
   * motion. Env kill switch: PROCEDURA_INCREMENTAL_ASSEMBLY=0. Incremental only. */
  assembly?: boolean;
  /** Multi-ref (incremental only): generate this many EXTRA reference views from
   * the text and attach all (primary + extras) to the plan / per-part gen calls.
   * 0 (default) = single reference. */
  extraRefs?: number;
  /** NO-PLAN ablation (incremental only): drop the plan stage — no upfront
   * decomposition and no plan review. Before each part the model sees the
   * reference, the build so far and the parts already built, and returns either
   * the next part or "done". Everything else (per-part gen, gates, sidecars,
   * refine) is unchanged, so the arm isolates what the plan stage is worth.
   * Env: PROCEDURA_NO_PLAN=1. */
  noPlan?: boolean;
  /** Run the whole-model Phase 2 refine. Default true. When false, the draft IS
   * the final model: draft.{scad,stl,obj} are promoted to final.* and a
   * synthetic verdict="skipped" RefineResult is returned (no refine loop). */
  refine?: boolean;
  /** Persist the binary STL deliverable (draft.stl / final.stl) alongside the
   * OBJ. Default false — only the normalized OBJ (+ SCAD) is exported; STL is
   * kept in internal build dirs for connectivity/rendering. */
  exportStl?: boolean;
  /** Run the Phase 3 paint stage: a vision LLM assigns a per-part PBR material
   * (colour + material class + roughness/metalness) from the reference image,
   * then emits material-annotated deliverables (final_materials.json,
   * final_painted.scad, final_painted.obj/.mtl, preview_painted/). Default
   * false — opt-in; works on whichever shape Phase 2 produced (incremental or
   * one-shot). */
  paint?: boolean;
  /** Vision model for the paint stage. Default DEFAULT_PAINT_MODEL. */
  paintModel?: string;
  /** Run a post-SCAD Isaac/OpenUSD motion export. Writes motion/final_motion.usda
   *  plus per-link meshes. If motionPlanPath is omitted, a two-call LLM motion
   *  planner/author pass scans the SCAD and render feedback to produce the
   *  articulation plan. */
  motion?: boolean;
  /** Optional motion sidecar JSON: links, joints, limits and drives. */
  motionPlanPath?: string;
  /** Vision/reasoning model for the motion planner. Default DEFAULT_MOTION_MODEL. */
  motionModel?: string;
  /** Disable the LLM planner when no motionPlanPath is supplied; falls back to
   *  one rigid link per top-level module with fixed joints. */
  motionUseLlm?: boolean;
  /** Run one LLM repair pass after the motion author call. Default true. */
  motionRefine?: boolean;
  motionAuthor?: boolean;
  /** Override whether the root link is fixed to world. Default true. */
  motionFixedBase?: boolean;
  /** Default USD Physics mesh collision approximation for motion links. */
  motionCollision?: MotionCollisionApproximation;
  /** Also export URDF (motion/urdf/robot.urdf + meshes). Default false. */
  motionUrdf?: boolean;
  /** Validate the exported asset headlessly in Isaac Sim. Default true when an
   *  Isaac install is found. */
  motionValidate?: boolean;
  /** One extra LLM refine round fed with the Isaac validation report when
   *  validation flags issues. Default true. */
  motionSimRefine?: boolean;
  /** Optional labels for thesis experiment aggregation. */
  experimentName?: string;
  datasetId?: string;
  repetition?: number;
  /** Final output destination when artifacts are built on a local staging disk. */
  trackingOutputDir?: string;
  /** Optional JSON pricing snapshot; otherwise use PROCEDURA_PRICING_FILE or built-in rates. */
  pricingFile?: string;
  signal?: AbortSignal;
}

export interface RunProceduraResult {
  outputDir: string;
  trajectoryPath: string;
  draft?: DraftResult | IncrementalDraftResult;
  refine: RefineResult;
  /** Present only when `paint` was requested. */
  paint?: PaintResult;
  /** Present only when `motion` was requested. */
  motion?: MotionExportResult;
}

function hasDraftArtifacts(dir: string): boolean {
  // The reference is image.png normally and the text spec in a text-only run,
  // which never writes one. Requiring the image unconditionally would make
  // every text-only dir look un-drafted, so --paint or a resume on one would
  // silently rebuild the model from scratch.
  const hasReference = existsSync(join(dir, "image.png"))
    || existsSync(join(dir, "effective_text.txt"))
    || existsSync(join(dir, "prompt.txt"));
  return (
    hasReference &&
    existsSync(join(dir, "draft.scad")) &&
    // The mesh deliverable is the OBJ; STL is only present with --export-stl.
    (existsSync(join(dir, "draft.obj")) || existsSync(join(dir, "draft.stl")))
  );
}

/** An incremental draft that was killed mid-build: plan.json exists but fewer
 *  parts are committed (have an after_gen.scad) than the plan declares. Such a
 *  dir should be RESUMED (continue the remaining parts), not skipped as "done". */
function isDraftIncomplete(dir: string): boolean {
  const planPath = join(dir, "plan.json");
  if (!existsSync(planPath)) return false;
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as unknown[];
    if (!Array.isArray(plan) || plan.length === 0) return false;
    const partsDir = join(dir, "_parts");
    if (!existsSync(partsDir)) return true;
    const committed = readdirSync(partsDir)
      .filter((d) => existsSync(join(partsDir, d, "after_gen.scad"))).length;
    return committed < plan.length;
  } catch { return false; }
}

export async function runProcedura(opts: RunProceduraOpts): Promise<RunProceduraResult> {
  return recordRun(opts.trackingOutputDir ?? opts.outputDir, opts, () => runProceduraImpl(opts), result => {
    const draft = result.draft;
    const parts = draft && "parts" in draft ? draft.parts : [];
    const needsReview = !result.refine.ok || result.paint?.ok === false
      || Boolean(result.paint?.degraded?.length) || result.motion?.ok === false;
    return {
      status: opts.signal?.aborted || result.refine.verdict === "aborted" ? "aborted" : needsReview ? "needs_review" : "completed",
      outcome: {
        draft: draft ? { ok: draft.ok, duration_ms: draft.durationMs,
          parts_planned: "plan" in draft ? draft.plan.length : null,
          parts_generated: "partsGenerated" in draft ? draft.partsGenerated : null,
          failed_parts: parts.filter(part => !part.generated).map(part => part.name) } : { reused: true },
        refine: { ok: result.refine.ok, verdict: result.refine.verdict, steps: result.refine.steps,
          tool_calls: result.refine.toolCalls, summary: result.refine.summary },
        paint: result.paint ? { ok: result.paint.ok, degraded: result.paint.degraded ?? [], error: result.paint.error ?? null } : null,
        motion: result.motion ? { ok: result.motion.ok, links: result.motion.linkCount, joints: result.motion.jointCount,
          warnings: result.motion.warnings, errors: result.motion.errors, validation: result.motion.validation ?? null } : null,
      },
    };
  });
}

async function runProceduraImpl(opts: RunProceduraOpts): Promise<RunProceduraResult> {
  if (opts.auxiliaryReferences?.length && (!opts.incremental || opts.textOnly || opts.motionOnly || !opts.inputImage))
    throw new Error("Auxiliary references require an explicit primary inputImage and the incremental draft.");
  const outDir = resolve(opts.outputDir);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "_trajectory"), { recursive: true });

  const runStamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const writer = createFileTrajectoryWriter(join(outDir, "_trajectory"), `procedura-${runStamp}`);

  const exportStl = opts.exportStl ?? false;

  console.log(`\n=== Procedura pipeline (text → param3d) ===`);
  console.log(`  output_dir: ${outDir}`);
  console.log(`  trajectory: ${writer.path}`);

  // ── Motion-only: articulate an already-built shape ────────────────────
  // Deliberately its own path rather than a set of skips, because the skips
  // are what is dangerous: --no-refine does not mean "leave final.* alone",
  // it means "promote the draft over final.*".
  if (opts.motionOnly) {
    skipPhase("draft", "Motion-only invocation.");
    skipPhase("refine", "Motion-only invocation.");
    skipPhase("paint", "Motion-only invocation.");
    const finalScad = join(outDir, "final.scad");
    if (!existsSync(finalScad)) {
      await writer.close();
      throw new Error(
        `runProcedura: --motion-only needs an existing ${finalScad}. ` +
        `Build the shape first (optionally with --motion-aware), then run motion over it.`,
      );
    }
    console.log(`\n--- Phase 4 ONLY: motion export over the existing final.scad ---`);
    try {
      const motionResult = await inPhase("motion", () => runMotionExport({
        outputDir: outDir,
        ...(opts.motionPlanPath !== undefined ? { motionPlanPath: opts.motionPlanPath } : {}),
        ...(opts.motionModel !== undefined ? { model: opts.motionModel } : {}),
        ...(opts.motionUseLlm !== undefined ? { useLlm: opts.motionUseLlm } : {}),
        ...(opts.motionRefine !== undefined ? { refine: opts.motionRefine } : {}),
        ...(opts.motionAuthor !== undefined ? { author: opts.motionAuthor } : {}),
        ...(opts.motionFixedBase !== undefined ? { fixedBase: opts.motionFixedBase } : {}),
        ...(opts.motionCollision !== undefined ? { defaultCollision: opts.motionCollision } : {}),
        ...(opts.motionUrdf !== undefined ? { exportUrdf: opts.motionUrdf } : {}),
        ...(opts.motionValidate !== undefined ? { validate: opts.motionValidate } : {}),
        ...(opts.motionSimRefine !== undefined ? { simRefine: opts.motionSimRefine } : {}),
        ...(opts.incrementalMotion !== undefined ? { incrementalMotion: opts.incrementalMotion } : {}),
        log: (line) => console.log(line),
        trajectorySink: writer.sink,
        trajectoryPathOverride: writer.path,
      }));
      if (!motionResult.ok) {
        console.log(`  WARN: motion export failed: ${motionResult.errors.join("; ")}`);
      }
      return {
        outputDir: outDir,
        trajectoryPath: writer.path,
        refine: {
          ok: true, verdict: "skipped",
          summary: "motion-only run; the shape was left exactly as it was found.",
          outputs: {
            scadPath: finalScad,
            ...(existsSync(join(outDir, "final.obj")) ? { objPath: join(outDir, "final.obj") } : {}),
            trajectoryPath: writer.path, diagnosisPath: "",
          },
          steps: 0, toolCalls: 0,
        },
        motion: motionResult,
      };
    } finally {
      await writer.close();
    }
  }

  // Resume a killed incremental build (partial draft present) instead of
  // skipping it as complete.
  const draftIncomplete = Boolean(opts.incremental) && !opts.redo && isDraftIncomplete(outDir);
  const needDraft = opts.redo || !hasDraftArtifacts(outDir) || draftIncomplete;
  if (draftIncomplete) console.log(`  (incremental draft is INCOMPLETE — resuming remaining parts)`);

  let draftResult: DraftResult | IncrementalDraftResult | undefined;

  try {
    if (needDraft) {
      if (!opts.text || !opts.text.trim()) {
        throw new Error(
          `runProcedura: outputDir ${outDir} is missing draft artifacts ` +
          `(image.png / draft.scad / draft.obj) and no \`text\` was supplied. ` +
          `Either point at a dir that already has them, or pass a prompt.`,
        );
      }
      const draftText = opts.text;
      if (opts.incremental) {
        console.log(`\n--- Phase 1: draft (incremental, part-by-part) ---`);
        draftResult = await inPhase("draft", () => runIncrementalDraft({
          text: draftText,
          outputDir: outDir,
          ...(opts.scadModel !== undefined ? { scadModel: opts.scadModel } : {}),
          ...(opts.imageModel !== undefined ? { imageModel: opts.imageModel } : {}),
          ...(opts.inputImage !== undefined ? { inputImage: opts.inputImage } : {}),
          ...(opts.auxiliaryReferences !== undefined ? { auxiliaryReferences: opts.auxiliaryReferences } : {}),
          ...(opts.textOnly ? { textOnly: true } : {}),
          ...(opts.contextRenders ? { contextRenders: true } : {}),
          ...(opts.extraRefs !== undefined ? { extraRefs: opts.extraRefs } : {}),
          exportStl,
          resume: draftIncomplete,
          motionAware: opts.motionAware
            ?? Boolean(opts.incremental && opts.motion && opts.incrementalMotion !== false),
          assemblyAware: Boolean(opts.incremental && opts.assembly),
          ...(opts.noPlan ? { noPlan: true } : {}),
          trajectorySink: writer.sink,
          trajectoryPathOverride: writer.path,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        }));
      } else {
        console.log(`\n--- Phase 1: draft ---`);
        draftResult = await inPhase("draft", () => runDraft({
          text: draftText,
          outputDir: outDir,
          ...(opts.scadModel !== undefined ? { scadModel: opts.scadModel } : {}),
          ...(opts.imageModel !== undefined ? { imageModel: opts.imageModel } : {}),
          ...(opts.inputImage !== undefined ? { inputImage: opts.inputImage } : {}),
          exportStl,
          trajectorySink: writer.sink,
          trajectoryPathOverride: writer.path,
        }));
      }
      if (!draftResult.ok) {
        await writer.close();
        throw new Error(
          `draft phase failed: ${draftResult.compileError ?? "unknown"}. ` +
          `Aborting before refine.`,
        );
      }
    } else {
      skipPhase("draft", "Existing draft artifacts reused.");
      console.log(`\n--- Phase 1: draft SKIPPED (artifacts present in ${outDir}) ---`);
    }

    let refineResult: RefineResult;
    if (opts.refine === false) {
      skipPhase("refine", "Refinement disabled; promoting draft.");
      console.log(`\n--- Phase 2: refine SKIPPED (--no-refine) — promoting draft → final ---`);
      refineResult = await promoteDraftAsFinal(outDir, writer.path, exportStl);
    } else {
      // Refine implementation. `direct` (the default) runs the fixed
      // context → critic → measure → patch → gate cycle as a pipeline; `agent`
      // is the historical seventeen-tool loop, kept for A/B until the benchmark
      // has ruled on the swap. PROCEDURA_REFINE_MODE=agent restores it.
      const refineMode = process.env["PROCEDURA_REFINE_MODE"] === "agent" ? "agent" : "direct";
      console.log(`\n--- Phase 2: refine (${refineMode}) ---`);
      const refineImpl = refineMode === "agent" ? runRefine : runDirectRefine;
      refineResult = await inPhase("refine", () => refineImpl({
        outputDir: outDir,
        ...(opts.agentModel !== undefined ? { model: opts.agentModel } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        exportStl,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        trajectorySink: writer.sink,
        trajectoryPathOverride: writer.path,
      }));
    }

    if (!opts.paint) skipPhase("paint", "Paint not requested.");
    if (!opts.motion) skipPhase("motion", "Motion not requested.");

    // ── Phase 3: paint (opt-in material pass) ─────────────────────────────
    // Operates on final.scad + image.png (written by Phase 2 in both the
    // refine and --no-refine branches), so it is agnostic to how the shape
    // was built. A paint failure is non-fatal: the shape pipeline already
    // succeeded, so we log and return the unpainted result.
    let paintResult: PaintResult | undefined;
    if (opts.paint) {
      console.log(`\n--- Phase 3: paint (per-part material pass) ---`);
      paintResult = await inPhase("paint", () => runPaint({
        outputDir: outDir,
        ...(opts.paintModel !== undefined ? { model: opts.paintModel } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        trajectorySink: writer.sink,
        trajectoryPathOverride: writer.path,
      }));
      if (!paintResult.ok) {
        console.log(`  WARN: paint phase failed: ${paintResult.error ?? "unknown"}`);
      }
    }

    // ── Phase 4: motion export (opt-in) ─────────────────────────────────
    // Runs after final.scad exists. It does not mutate the shape outputs; it
    // compiles selected top-level modules into link meshes and writes a USDA
    // stage with USD Physics rigid bodies/joints for Isaac Sim import.
    let motionResult: MotionExportResult | undefined;
    if (opts.motion) {
      console.log(`\n--- Phase 4: motion export (OpenUSD / Isaac Sim) ---`);
      motionResult = await inPhase("motion", () => runMotionExport({
        outputDir: outDir,
        ...(opts.motionPlanPath !== undefined ? { motionPlanPath: opts.motionPlanPath } : {}),
        ...(opts.motionModel !== undefined ? { model: opts.motionModel } : {}),
        ...(opts.motionUseLlm !== undefined ? { useLlm: opts.motionUseLlm } : {}),
        ...(opts.motionRefine !== undefined ? { refine: opts.motionRefine } : {}),
        ...(opts.motionAuthor !== undefined ? { author: opts.motionAuthor } : {}),
        ...(opts.motionFixedBase !== undefined ? { fixedBase: opts.motionFixedBase } : {}),
        ...(opts.motionCollision !== undefined ? { defaultCollision: opts.motionCollision } : {}),
        ...(opts.motionUrdf !== undefined ? { exportUrdf: opts.motionUrdf } : {}),
        ...(opts.motionValidate !== undefined ? { validate: opts.motionValidate } : {}),
        ...(opts.motionSimRefine !== undefined ? { simRefine: opts.motionSimRefine } : {}),
        ...(opts.incrementalMotion !== undefined ? { incrementalMotion: opts.incrementalMotion } : {}),
        log: (line) => console.log(line),
        trajectorySink: writer.sink,
        trajectoryPathOverride: writer.path,
      }));
      if (!motionResult.ok) {
        console.log(`  WARN: motion export failed: ${motionResult.errors.join("; ")}`);
      } else if (motionResult.validation?.ran && motionResult.validation.ok !== true) {
        console.log(`  WARN: Isaac validation flagged issues: ${(motionResult.validation.errors ?? []).join("; ")}`);
      }
    }

    return {
      outputDir: outDir,
      trajectoryPath: writer.path,
      ...(draftResult !== undefined ? { draft: draftResult } : {}),
      refine: refineResult,
      ...(paintResult !== undefined ? { paint: paintResult } : {}),
      ...(motionResult !== undefined ? { motion: motionResult } : {}),
    };
  } finally {
    await writer.close();
  }
}

/** Refine-skipped path: the draft IS the final model. Copy draft.{scad,obj}
 * (and draft.stl only when exportStl) to final.* so downstream tooling that keys
 * off final.* (judge prepare, results-server, web scan) still works, render the
 * same preview_final/ao-*.png set the refine path produces (from the already-
 * normalized _draft_build/output.stl — see normalizeMeshInPlace), write a
 * final_summary.txt, and return a synthetic verdict="skipped" RefineResult. The
 * draft stage already normalized draft.obj, so final.obj is normalized too. */
async function promoteDraftAsFinal(
  outDir: string, trajectoryPath: string, exportStl: boolean,
): Promise<RefineResult> {
  const copy = (from: string, to: string): boolean => {
    const src = join(outDir, from);
    if (!existsSync(src)) return false;
    copyFileSync(src, join(outDir, to));
    return true;
  };
  copy("draft.scad", "final.scad");
  const haveStl = exportStl ? copy("draft.stl", "final.stl") : false;
  const haveObj = copy("draft.obj", "final.obj");
  const summary = "refine disabled (--no-refine); final.* is the unrefined draft.";
  writeFileSync(
    join(outDir, "final_summary.txt"),
    `verdict: skipped\n\nsummary:\n${summary}\n`,
    "utf8",
  );

  // AO preview — same treatment as the refine path's writeFinalOutputs, just
  // sourced from the draft build's STL instead of a fresh _final_build one.
  let previewDir: string | undefined;
  const buildStl = join(outDir, "_draft_build", "output.stl");
  if (existsSync(buildStl)) {
    const dir = join(outDir, "preview_final");
    mkdirSync(dir, { recursive: true });
    const pr = await renderAOViews({ stlPath: buildStl, outDir: dir, size: 640, samples: 32, aoSamples: 8 });
    if (pr.ok) previewDir = dir;
    else console.log(`  WARN: AO preview failed: ${pr.error}`);
  } else {
    console.log(`  WARN: AO preview skipped — no _draft_build/output.stl found`);
  }

  return {
    ok: true,
    verdict: "skipped",
    summary,
    outputs: {
      scadPath: join(outDir, "final.scad"),
      ...(haveStl ? { stlPath: join(outDir, "final.stl") } : {}),
      ...(haveObj ? { objPath: join(outDir, "final.obj") } : {}),
      ...(previewDir ? { previewDir } : {}),
      trajectoryPath,
      diagnosisPath: "",
    },
    steps: 0,
    toolCalls: 0,
  };
}
