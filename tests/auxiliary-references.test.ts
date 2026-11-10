import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUXILIARY_MANIFEST, resolveAuxiliaryReferences, snapshotAuxiliaryReferences } from "../src/pipeline/auxiliary-references.ts";

const temporary: string[] = [];
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "procedura-multiview-"));
  temporary.push(path);
  return path;
}
function image(path: string): string {
  writeFileSync(path, png);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("directory inputs preserve camera order and frame, and exclude contact sheets", () => {
  const input = directory();
  const front = image(join(input, "02_front.png"));
  const top = image(join(input, "01_top.png"));
  image(join(input, "contact_sheet.png"));
  image(join(input, "02_front.r1024.png"));
  writeFileSync(join(input, "cameras.json"), JSON.stringify({
    up_axis: "y", front_axis: "+x", projection: "orthographic",
    views: [{ file: "02_front.png", view: "front", camera_position: [1, 0, 0] },
      { file: "01_top.png", view: "top" }, { file: "02_front.r1024.png", view: "front resized" }],
  }));
  const references = resolveAuxiliaryReferences({ viewsDir: input });
  expect(references.map(reference => reference.path)).toEqual([front, top]);
  expect(references[0]!.camera).toMatchObject({ up_axis: "y", front_axis: "+x", camera_position: [1, 0, 0] });
  expect(references.map(reference => reference.label)).toEqual(["front", "top"]);
  expect(resolveAuxiliaryReferences({ images: [top] })).toEqual([references[1]!]);
});

test("directories without camera metadata load numbered views naturally and ignore derived images", () => {
  const input = directory();
  const tenth = image(join(input, "view10.png"));
  const second = image(join(input, "view2.png"));
  image(join(input, "contact_sheet.png"));
  image(join(input, "view2.r1024.png"));
  expect(resolveAuxiliaryReferences({ viewsDir: input }).map(reference => reference.path)).toEqual([second, tenth]);
  expect(resolveAuxiliaryReferences({ images: [tenth, second] }).map(reference => reference.path)).toEqual([tenth, second]);
});

test("invalid, duplicate, mixed, missing, empty, and excessive inputs fail explicitly", () => {
  const input = directory();
  expect(() => resolveAuxiliaryReferences({ viewsDir: input })).toThrow("No auxiliary PNG");
  const valid = image(join(input, "front.png"));
  const invalid = join(input, "invalid.png");
  writeFileSync(invalid, "not an image");
  expect(() => resolveAuxiliaryReferences({ images: [invalid] })).toThrow("must be PNG");
  expect(() => resolveAuxiliaryReferences({ images: [valid, valid] })).toThrow("Duplicate");
  expect(() => resolveAuxiliaryReferences({ images: [valid], viewsDir: input })).toThrow("either");
  expect(() => resolveAuxiliaryReferences({ images: [join(input, "missing.png")] })).toThrow("not found");
  expect(() => resolveAuxiliaryReferences({ images: Array(16).fill(valid) })).toThrow("At most 15");
  writeFileSync(join(input, "cameras.json"), JSON.stringify({ views: [{ file: "../front.png" }] }));
  expect(() => resolveAuxiliaryReferences({ viewsDir: input })).toThrow("in its directory");
});

test("snapshots preserve selected images and metadata after source files change", () => {
  const source = image(join(directory(), "front.png"));
  const output = directory();
  const requested = [{ path: source, label: "front", camera: { up_axis: "y" } }];
  const saved = snapshotAuxiliaryReferences(output, requested, false);
  expect(saved[0]!.path).not.toBe(source);
  expect(saved[0]!.sourcePath).toBe(source);
  expect(readFileSync(saved[0]!.path)).toEqual(png);
  const manifest = JSON.parse(readFileSync(join(output, AUXILIARY_MANIFEST), "utf8"));
  expect(manifest.references[0].sourcePath).toBe(source);
  expect(manifest.references[0].camera.up_axis).toBe("y");
  writeFileSync(source, Buffer.concat([png, Buffer.from([2])]));
  expect(snapshotAuxiliaryReferences(output, undefined, true)).toEqual(saved);
  expect(() => snapshotAuxiliaryReferences(output, requested, true)).toThrow("changed during resume");
  writeFileSync(saved[0]!.path, Buffer.concat([png, Buffer.from([3])]));
  expect(() => snapshotAuxiliaryReferences(output, undefined, true)).toThrow("Saved auxiliary image changed");
});

test("resuming cannot silently change order, labels, metadata, or introduce auxiliary guidance", () => {
  const input = directory();
  const output = directory();
  const first = { path: image(join(input, "first.png")), label: "first", camera: { up_axis: "y" } };
  const second = { path: image(join(input, "second.png")), label: "second" };
  snapshotAuxiliaryReferences(output, [first, second], false);
  expect(() => snapshotAuxiliaryReferences(output, [second, first], true)).toThrow("changed during resume");
  expect(() => snapshotAuxiliaryReferences(output, [{ ...first, camera: { up_axis: "z" } }, second], true)).toThrow("changed during resume");
  expect(() => snapshotAuxiliaryReferences(directory(), [first], true)).toThrow("existing plan");
});

test("CLI documents both inputs and rejects auxiliary-only and one-shot requests before generation", () => {
  const cwd = resolve(import.meta.dir, "..");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", "scripts/procedura.ts", ...args], { cwd });
  const help = run("--help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("--aux-views-dir");
  expect(help.stdout.toString()).toContain("--aux-image");
  expect(run("-o", "/unused", "--aux-image", "front.png").exitCode).toBe(2);
  expect(run("-o", "/unused", "--image", "original.png", "--aux-image", "front.png", "--one-shot").exitCode).toBe(2);
});

for (const [name, args, count] of [
  ["planning uses only the original; part generation receives twelve Hunyuan views", [], 3],
  ["no-plan selection uses only the original; part generation receives Hunyuan views", ["--no-plan"], 2],
  ["part-generation retries retain Hunyuan views and priority instructions", ["--retry"], 4],
  ["no-plan generation retries retain Hunyuan views", ["--no-plan", "--retry"], 3],
  ["ordinary single-image drafting still uses one reference at every stage", ["--no-aux"], 3],
] as const) {
  test(name, () => {
    const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "fixtures/multiview-draft.ts"), ...args], {
      cwd: resolve(import.meta.dir, ".."), timeout: 10000,
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(String(count) + " drafting requests verified");
  });
}

test("refinement critic and patch ignore saved Hunyuan views", () => {
  const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "fixtures/multiview-refine.ts")], {
    cwd: resolve(import.meta.dir, ".."), timeout: 10000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("2 refinement requests verified");
});
