import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileRecord, hash, sourceRelativePath } from "./metadata.ts";

export interface ReferenceInput {
  path: string;
  role: "primary_image" | "auxiliary_image" | "reference_mesh";
  /** Original file before it was copied into the output directory. Null for generated inputs. */
  sourcePath?: string | null;
  origin?: "supplied" | "generated" | "resumed" | "unknown";
  provenance?: string;
}
type Data = Record<string, any>;
const slash = (path: string) => path.split(sep).join("/");
function modeFor(primary: number, auxiliary: number, meshes: number): string {
  if (meshes) return primary + auxiliary ? "images_and_mesh" : "reference_mesh";
  return primary + auxiliary > 1 ? "multi_view_images" : primary + auxiliary === 1 ? "single_image" : "text_only";
}

/** Tracks declared inputs initially, then the reference sets actually attached.
 * It never scans a directory of renders or guesses inputs from file extensions. */
export class InputTracker {
  private references = new Map<string, Data>();
  private observed = false;
  private stages: Record<string, string> = {
    planning: "not_run", part_generation: "not_run", refinement: "not_run",
  };
  private stageCounts: Record<string, Data> = {};
  private previous: Data[];
  private primarySource?: string;
  readonly prompt: string | null;
  readonly promptHash: string | null;

  constructor(private output: string, private opts: Data, previous?: Data) {
    const previousInputs = previous?.inputs ?? {};
    this.previous = [
      previousInputs.primary_image,
      ...(previousInputs.auxiliary_images ?? []),
      ...(previousInputs.reference_meshes ?? []),
    ].filter(Boolean);
    // Schema 1 used one absolute image path.
    if (previousInputs.image) this.previous.push({
      ...previousInputs.image, source_path: sourceRelativePath(previousInputs.image.path), run_copy: "image.png",
    });
    this.prompt = opts.text ?? ["effective_text.txt", "prompt.txt", "brief.md"]
      .map(name => join(output, name)).filter(existsSync).map(path => readFileSync(path, "utf8"))[0] ?? null;
    this.promptHash = this.prompt === null ? null : hash(this.prompt);
    if (opts.inputImage) this.primarySource = resolve(opts.inputImage);
    if (!opts.textOnly) {
      const existing = !opts.redo && existsSync(join(output, "image.png")) ? join(output, "image.png") : null;
      const image = opts.inputImage ?? existing;
      if (image && existsSync(image)) this.remember({
        path: image, role: "primary_image", sourcePath: opts.inputImage,
        origin: opts.inputImage ? "supplied" : "resumed",
      });
    }
  }
  private remember(reference: ReferenceInput): void {
    const absolute = resolve(reference.path);
    const file = fileRecord(absolute);
    const local = relative(this.output, absolute);
    const withinOutput = !isAbsolute(local) && local !== ".." && !local.startsWith(".." + sep);
    const runCopy = withinOutput ? slash(local) : null;
    const identity = reference.role + ":" + absolute;
    const current = this.references.get(identity);
    const inherited = current && file && current.sha256 === file.sha256 ? current
      : this.previous.find(item => file && item.sha256 === file.sha256
        && (item.role === undefined || item.role === reference.role)
        && (item.run_copy === runCopy || reference.role === "primary_image"));
    const original = reference.sourcePath === null ? null
      : reference.sourcePath !== undefined ? sourceRelativePath(reference.sourcePath)
      : inherited ? inherited.source_path
        : reference.role === "primary_image" && this.primarySource ? sourceRelativePath(this.primarySource)
          : reference.origin === "generated" ? null : sourceRelativePath(absolute);
    const record = {
      role: reference.role, source_path: original, run_copy: runCopy,
      sha256: file?.sha256 ?? null, bytes: file?.bytes ?? null,
      origin: reference.origin ?? inherited?.origin ?? "unknown",
      provenance: reference.provenance ?? inherited?.provenance ?? null,
    };
    this.references.set(identity, record);
  }
  record(stage: string, references: readonly ReferenceInput[]): void {
    if (!this.observed) {
      // Replace requested inputs with what the pipeline actually loaded. Keep
      // requested provenance available while resolving the first observed set.
      const declared = [...this.references.values()];
      this.previous.push(...declared);
      this.references.clear();
      this.observed = true;
    }
    for (const reference of references) this.remember(reference);
    references = [...new Map(references.map(item => [item.role + ":" + resolve(item.path), item])).values()];
    const primary = references.filter(item => item.role === "primary_image").length;
    const auxiliary = references.filter(item => item.role === "auxiliary_image").length;
    const meshes = references.filter(item => item.role === "reference_mesh").length;
    this.stages[stage] = modeFor(primary, auxiliary, meshes);
    this.stageCounts[stage] = {
      primary_image_count: primary, auxiliary_image_count: auxiliary, reference_mesh_count: meshes,
    };
  }
  skipped(phase: string): void {
    if (phase === "draft") for (const stage of ["planning", "part_generation"]) this.stages[stage] = "skipped";
    else if (phase === "refine") this.stages.refinement = "skipped";
  }
  get inputs() {
    const values = [...this.references.values()];
    return {
      prompt: this.prompt, prompt_sha256: this.promptHash,
      primary_image: values.find(item => item.role === "primary_image") ?? null,
      auxiliary_images: values.filter(item => item.role === "auxiliary_image"),
      reference_meshes: values.filter(item => item.role === "reference_mesh"),
      motion_plan: this.opts.motionPlanPath ? (() => {
        const record = fileRecord(this.opts.motionPlanPath);
        return record ? { source_path: sourceRelativePath(this.opts.motionPlanPath), bytes: record.bytes, sha256: record.sha256 } : null;
      })() : null,
    };
  }
  get summary() {
    const values = [...this.references.values()];
    const primary = values.filter(item => item.role === "primary_image").length;
    const auxiliary = values.filter(item => item.role === "auxiliary_image").length;
    const meshes = values.filter(item => item.role === "reference_mesh").length;
    const mode = primary + auxiliary + meshes || this.observed || this.opts.textOnly ? modeFor(primary, auxiliary, meshes) : "pending";
    let label = mode === "pending" ? "Reference inputs not loaded yet" : mode === "text_only" ? "Text only"
      : primary + auxiliary === 1 ? "Single reference image" : primary + " reference " + (primary === 1 ? "image" : "images") + " + " + auxiliary + " auxiliary " + (auxiliary === 1 ? "view" : "views");
    if (meshes) label = (primary + auxiliary ? label + " + " : "") + meshes + " reference " + (meshes === 1 ? "mesh" : "meshes");
    const provenance = [...new Set(values.filter(item => item.role === "auxiliary_image").map(item => item.provenance).filter(Boolean))];
    return {
      mode, label, resolution: this.observed ? "observed" : mode === "pending" ? "pending" : "declared_or_reused",
      text_prompt_used: Boolean(this.prompt),
      primary_image_count: primary, auxiliary_image_count: auxiliary, total_reference_image_count: primary + auxiliary,
      auxiliary_source: provenance.length === 1 ? provenance[0] : provenance.length ? provenance : null,
      reference_mesh_used: meshes > 0, reference_mesh_count: meshes,
      used_by_stage: { ...this.stages }, reference_counts_by_stage: { ...this.stageCounts },
      current_build_feedback_enabled: Boolean(this.opts.incremental) && (process.env.PROCEDURA_CONTEXT_VIEWS !== undefined
        ? Boolean(process.env.PROCEDURA_CONTEXT_VIEWS.split(",").some(view => ["front", "back", "left", "right", "top", "bottom", "isometric"].includes(view.trim())))
        : Boolean(this.opts.contextRenders)),
    };
  }
}
