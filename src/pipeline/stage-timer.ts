/**
 * Wall-clock accounting per pipeline stage.
 *
 * A run's cost is dominated by OpenSCAD and Blender, not by the LLM, and the
 * only way to know which stage to attack is to measure them separately. This is
 * a process-global accumulator rather than a threaded-through parameter so a
 * call site deep in the render or compile path can be timed without changing
 * every signature between it and the pipeline entry point.
 *
 * Stages nest: `draft.split` is inside `draft.loop`, so the totals deliberately
 * OVERLAP and must not be summed. `report()` prints children indented under
 * their parent and leaves the arithmetic to the reader.
 */

import { trackingContext, inStage } from "../tracking/context.ts";
interface Stage { ms: number; calls: number }

const stages = new Map<string, Stage>();
let runStart = 0;

/** Start (or restart) the run clock — the denominator for every percentage. */
export function beginRun(): void {
  runStart = Date.now();
  stages.clear();
}

/** Add an already-measured duration to a stage. */
export function addStage(name: string, ms: number): void {
  trackingContext()?.recorder.addTiming(name, ms);
  const s = stages.get(name) ?? { ms: 0, calls: 0 };
  s.ms += ms;
  s.calls += 1;
  stages.set(name, s);
}

/** Time `fn`, attribute it to `name`, and return its result (errors still count). */
export async function timeStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await inStage(name, fn);
  } finally {
    addStage(name, performance.now() - t0);
  }
}

export function stageSnapshot(): Record<string, { minutes: number; calls: number }> {
  const out: Record<string, { minutes: number; calls: number }> = {};
  for (const [k, v] of stages) out[k] = { minutes: v.ms / 60_000, calls: v.calls };
  return out;
}

/**
 * Render the breakdown. `rows` is [label, stageKey, depth] so the caller owns
 * the shape of the report and unmeasured stages simply print as 0.
 */
export function report(
  title: string,
  rows: ReadonlyArray<readonly [string, string, number]>,
): string {
  const wallMin = (Date.now() - runStart) / 60_000;
  const lines = [`=== ${title} — wall ${wallMin.toFixed(1)} min ===`];
  for (const [label, key, depth] of rows) {
    const s = stages.get(key);
    const min = (s?.ms ?? 0) / 60_000;
    const pct = wallMin > 0 ? (min / wallMin) * 100 : 0;
    const indent = "  ".repeat(depth + 1);
    // A CONCURRENT stage sums to more than wall — 18 overlapping paint calls
    // reported 253.7%, which is not a percentage of anything. Print the summed
    // time and mark it rather than emitting a number that cannot be read.
    const concurrent = min > wallMin * 1.02;
    const share = concurrent ? " (concur)" : `(${pct.toFixed(1).padStart(5)}%)`;
    lines.push(
      `${indent}${label.padEnd(34 - indent.length)}${min.toFixed(1).padStart(6)} min ` +
      `${share.padStart(9)}  n=${s?.calls ?? 0}`,
    );
  }
  // Anything instrumented but not placed in `rows` would otherwise vanish.
  const shown = new Set(rows.map((r) => r[1]));
  const extra = [...stages.keys()].filter((k) => !shown.has(k)).sort();
  if (extra.length > 0) {
    lines.push("  --- not in the table above ---");
    for (const k of extra) {
      const s = stages.get(k)!;
      lines.push(`    ${k.padEnd(32)}${(s.ms / 60_000).toFixed(1).padStart(6)} min  n=${s.calls}`);
    }
  }
  return lines.join("\n");
}
