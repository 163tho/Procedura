/**
 * Run on local disk, sync to the real output directory at the end.
 *
 * The output root is commonly a shared sshfs mount. Measured on this setup:
 * 4.61 MB/s write, 2.45 MB/s read, against 1158/7936 MB/s on local disk. The
 * pipeline writes and re-reads its intermediates constantly — one 26-part
 * assault_buggy run moved 3.3 GB of per-part STL alone, which cost ~36 of its
 * 52.7 compute minutes purely in transfer.
 *
 * `render/parts_split.ts` already keeps the biggest offender (the context
 * render's throwaway meshes) local. This does the same for EVERYTHING: the run
 * writes to a local staging dir and the results are synced once, in bulk, at the
 * end. Bulk transfer is also where sshfs is least bad — one large sequential
 * copy instead of thousands of small scattered writes.
 *
 * The sync runs on failure too. A crashed run's artifacts are how you find out
 * WHY it crashed, so losing them to a local temp dir would be worse than the
 * slow writes this exists to avoid.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/** Filesystem types that are slow enough to be worth staging around. */
const REMOTE_FS = /^(fuse\.sshfs|fuse|nfs\d?|cifs|smbfs|afpfs|9p|davfs)$/;

/**
 * Is `dir` (or its nearest existing parent) on a network filesystem?
 *
 * Reads /proc/mounts and takes the longest mountpoint prefix, which is how the
 * kernel resolves it. Returns false when it cannot tell — staging should be an
 * optimisation, never a reason a run fails to start.
 */
export function isRemoteFs(dir: string): boolean {
  try {
    let probe = dir;
    while (probe !== "/" && !existsSync(probe)) probe = join(probe, "..");
    const resolved = realpathSync(probe);
    const mounts = readFileSync("/proc/mounts", "utf8");
    let bestLen = -1;
    let bestType = "";
    for (const line of mounts.split("\n")) {
      const [, mnt, type] = line.split(/\s+/);
      if (!mnt || !type) continue;
      const point = mnt.replace(/\\040/g, " ");
      if (resolved === point || resolved.startsWith(point === "/" ? "/" : `${point}/`)) {
        if (point.length > bestLen) { bestLen = point.length; bestType = type; }
      }
    }
    return REMOTE_FS.test(bestType);
  } catch {
    return false;
  }
}

export interface Staging {
  /** Where the run should actually write. */
  workDir: string;
  /** Copy staged results to the real destination. Safe to call twice. */
  finish: (label: string) => void;
}

/**
 * Stage `finalDir` on local disk when it lives on a network mount.
 *
 * `mode`: "auto" stages only for a remote destination, "always" forces it,
 * "off" disables. Returns a passthrough when staging is not used, so callers
 * need no branching.
 */
export function beginStaging(
  finalDir: string,
  mode: "auto" | "always" | "off",
  log: (s: string) => void = console.log,
): Staging {
  const passthrough: Staging = { workDir: finalDir, finish: () => undefined };
  if (mode === "off") return passthrough;
  if (mode === "auto" && !isRemoteFs(finalDir)) return passthrough;

  const root = process.env["PROCEDURA_STAGING_ROOT"] || tmpdir();
  mkdirSync(root, { recursive: true });
  const workDir = mkdtempSync(join(root, "procedura-stage-"));
  log(`[staging] writing to local disk ${workDir}`);
  log(`[staging]   -> will sync to ${finalDir}`);

  // Seed resumes with their existing artifacts. Tracking files remain live at
  // the final destination and must never be overwritten by staged copies.
  const exclusions = ["--exclude=/run.json", "--exclude=/api_calls.jsonl", "--exclude=/.run.lock"];
  if (existsSync(finalDir)) {
    const seed = Bun.spawnSync(["rsync", "-a", ...exclusions, finalDir.replace(/\/+$/, "") + "/", workDir + "/"],
      { stdout: "pipe", stderr: "pipe" });
    if (seed.exitCode !== 0) throw new Error("Cannot stage existing output: " + seed.stderr.toString().slice(0, 300));
  }

  let done = false;
  const finish = (label: string): void => {
    if (done) return;
    done = true;
    try {
      mkdirSync(finalDir, { recursive: true });
      const t0 = Date.now();
      // Trailing slash on the source copies its CONTENTS into finalDir.
      const p = Bun.spawnSync(["rsync", "-a", ...exclusions, `${workDir}/`, `${finalDir}/`],
        { stdout: "pipe", stderr: "pipe" });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (p.exitCode === 0) {
        log(`[staging] synced to ${finalDir} in ${secs}s (${label})`);
        rmSync(workDir, { recursive: true, force: true });
      } else {
        // Keep the staging dir: it now holds the only copy.
        log(`[staging] SYNC FAILED (${p.stderr.toString().slice(0, 300)})`);
        log(`[staging] results are KEPT at ${workDir} — copy them by hand`);
      }
    } catch (e) {
      log(`[staging] sync error: ${(e as Error).message}`);
      log(`[staging] results are KEPT at ${workDir}`);
    }
  };
  return { workDir, finish };
}

/** Map returned artifact paths after a successful staging sync. */
export function rebaseStagedPaths<T>(value: T, workDir: string, finalDir: string): T {
  const source = resolve(workDir), destination = resolve(finalDir);
  if (source === destination) return value;
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (item === source) return destination;
      return item.startsWith(source + sep) ? destination + item.slice(source.length) : item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return visit(value) as T;
}
