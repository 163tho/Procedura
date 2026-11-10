import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const DRAFT_IMAGE_BUDGET = 16;
export const AUXILIARY_MANIFEST = "auxiliary_references.json";

export interface AuxiliaryReference {
  path: string;
  /** Original source before an image was copied into the output directory. */
  sourcePath?: string;
  label: string;
  camera?: Record<string, unknown>;
}

interface CameraManifest {
  views: { file: string; view?: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

interface SavedReference extends AuxiliaryReference {
  sha256: string;
  sourcePath: string;
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function checkImage(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error("Auxiliary image not found: " + path);
  if (!readFileSync(path).subarray(0, 8).equals(pngSignature))
    throw new Error("Auxiliary images must be PNG files: " + path);
}

function checkCount(count: number): void {
  if (count >= DRAFT_IMAGE_BUDGET)
    throw new Error("At most 15 auxiliary images are supported alongside the primary image by the current 16-image draft budget.");
}

function readCameras(directory: string): CameraManifest | undefined {
  const path = join(directory, "cameras.json");
  if (!existsSync(path)) return undefined;
  const camera = JSON.parse(readFileSync(path, "utf8")) as CameraManifest;
  if (!camera || !Array.isArray(camera.views))
    throw new Error("cameras.json must contain a views array: " + path);
  for (const view of camera.views) {
    if (!view || typeof view.file !== "string" || basename(view.file) !== view.file || !/\.png$/i.test(view.file))
      throw new Error("Each camera view must name a PNG file in its directory: " + path);
  }
  return camera;
}

export function resolveAuxiliaryReferences(input: {
  images?: readonly string[];
  viewsDir?: string;
}): AuxiliaryReference[] {
  if (input.viewsDir !== undefined && input.images?.length)
    throw new Error("Use either --aux-views-dir or repeated --aux-image, not both.");
  let paths = [...(input.images ?? [])];
  if (input.viewsDir !== undefined) {
    const directory = resolve(input.viewsDir);
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      throw new Error("Auxiliary views directory not found: " + directory);
    const cameras = readCameras(directory);
    paths = cameras
      ? cameras.views
        .filter(view => !/^contact[_-]?sheet/i.test(view.file) && !/\.r\d+\.png$/i.test(view.file))
        .map(view => join(directory, view.file))
      : readdirSync(directory)
        .filter(name => /\.png$/i.test(name) && !/^contact[_-]?sheet/i.test(name) && !/\.r\d+\.png$/i.test(name))
        .sort((first, second) => first.localeCompare(second, "en", { numeric: true }))
        .map(name => join(directory, name));
    if (paths.length === 0) throw new Error("No auxiliary PNG views found in " + directory);
  }
  checkCount(paths.length);
  const seen = new Set<string>();
  return paths.map(source => {
    if (typeof source !== "string" || !source.trim()) throw new Error("An auxiliary image path is required.");
    const path = resolve(source);
    checkImage(path);
    const identity = realpathSync(path);
    if (seen.has(identity)) throw new Error("Duplicate auxiliary image: " + path);
    seen.add(identity);
    const cameras = readCameras(dirname(path));
    const view = cameras?.views.find(entry => entry.file === basename(path));
    const { views: _views, ...frame } = cameras ?? { views: [] };
    return {
      path,
      label: typeof view?.view === "string" && view.view.trim() ? view.view : basename(path),
      ...(view ? { camera: { ...frame, ...view } } : {}),
    };
  });
}

export function snapshotAuxiliaryReferences(
  outputDir: string,
  requested: readonly AuxiliaryReference[] | undefined,
  resume: boolean,
): AuxiliaryReference[] {
  const manifestPath = join(outputDir, AUXILIARY_MANIFEST);
  const describe = (references: readonly AuxiliaryReference[]) => references.map(reference => {
    checkImage(reference.path);
    return { label: reference.label, camera: reference.camera, sha256: sha(reference.path) };
  });
  if (resume && existsSync(manifestPath)) {
    const saved = JSON.parse(readFileSync(manifestPath, "utf8")) as { references: SavedReference[] };
    const references = saved.references.map(reference => ({
      path: resolve(outputDir, reference.path), sourcePath: reference.sourcePath, label: reference.label,
      ...(reference.camera ? { camera: reference.camera } : {}),
    }));
    const actual = describe(references);
    if (actual.some((reference, index) => reference.sha256 !== saved.references[index]!.sha256))
      throw new Error("Saved auxiliary image changed; restore it before resuming.");
    if (requested !== undefined && JSON.stringify(describe(requested)) !== JSON.stringify(actual))
      throw new Error("Auxiliary references changed during resume. Use a new output directory or --redo.");
    return references;
  }
  if (resume && requested?.length)
    throw new Error("Cannot add auxiliary references to an existing plan. Use a new output directory or --redo.");
  const references = requested ?? [];
  checkCount(references.length);
  const descriptions = describe(references);
  if (references.length === 0 && !existsSync(manifestPath)) return [];
  const saved = references.map((reference, index): SavedReference => {
    const path = join("_aux_refs", String(index + 1).padStart(2, "0") + ".png");
    const destination = resolve(outputDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    if (resolve(reference.path) !== destination) copyFileSync(reference.path, destination);
    return { ...reference, path, sourcePath: resolve(reference.sourcePath ?? reference.path), sha256: descriptions[index]!.sha256 };
  });
  writeFileSync(manifestPath, JSON.stringify({ schema: 1, references: saved }, null, 2) + "\n");
  return saved.map(reference => ({
    path: resolve(outputDir, reference.path), sourcePath: reference.sourcePath, label: reference.label,
    ...(reference.camera ? { camera: reference.camera } : {}),
  }));
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(resolveAuxiliaryReferences(JSON.parse(process.argv[2] ?? "{}"))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
