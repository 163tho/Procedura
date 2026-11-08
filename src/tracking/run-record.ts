import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { inRun, trackingContext, type TrackingSink } from "./context.ts";
import { configuration, environmentMetadata, inputMetadata, outputMetadata, sourceMetadata } from "./metadata.ts";
import { loadPricing, type Pricing } from "./pricing.ts";
import type { Usage } from "./usage.ts";

type Data = Record<string, any>;
const now = () => new Date().toISOString();
export const safeError = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1500);
function readLedger(path: string): { calls: Map<string, Data>; malformed: number } {
  const calls = new Map<string, Data>();
  let malformed = 0;
  if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n").filter(line => line.trim())) {
    try {
      const entry = JSON.parse(line);
      if (entry.call_id) calls.set(entry.call_id, { ...calls.get(entry.call_id), ...entry });
    } catch { malformed++; }
  }
  return { calls, malformed };
}
export function summarizeCalls(calls: Data[]) {
  const known = calls.filter(call => call.usage_status === "complete");
  const sums = (key: keyof Usage) => known.reduce((total, call) => total + (Number(call.usage?.[key]) || 0), 0);
  const costs = calls.filter(call => typeof call.cost?.estimated_usd === "number");
  const knownCost = costs.reduce((total, call) => total + call.cost.estimated_usd, 0);
  return {
    calls: calls.length, completed_calls: calls.filter(call => call.status === "completed").length,
    failed_calls: calls.filter(call => ["failed", "interrupted", "cancelled"].includes(call.status)).length,
    usage_complete_calls: known.length, usage_incomplete_calls: calls.length - known.length,
    tokens: {
      reported_input_tokens: sums("input_tokens"), reported_output_tokens: sums("output_tokens"),
      reported_total_tokens: sums("input_tokens") + sums("output_tokens"),
      // Reasoning is a subset of output. Cache is a subset of total input.
      reported_reasoning_tokens: sums("reasoning_tokens"), reported_cache_read_tokens: sums("cache_read_input_tokens"),
      complete: known.length === calls.length,
    },
    cost: {
      currency: "USD", known_estimated_usd: knownCost,
      estimated_usd: costs.length === calls.length ? knownCost : null,
      priced_calls: costs.length, unpriced_calls: calls.length - costs.length,
      billed_usd: null, note: "Local estimates, not an invoice or remaining credit balance.",
    },
    api_request_duration_ms_sum: calls.reduce((total, call) => total + (call.duration_ms ?? 0), 0),
    by_stage: breakdown(calls, "stage"),
    by_model: breakdown(calls, "model"),

  };
}

function breakdown(calls: Data[], dimension: string) {
  return Object.fromEntries([...new Set(calls.map(call => String(call[dimension] ?? call.requested_model ?? "unknown")))].map(value => {
    const matching = calls.filter(call => String(call[dimension] ?? call.requested_model ?? "unknown") === value);
    const reported = matching.filter(call => call.usage_status === "complete");
    const priced = matching.filter(call => typeof call.cost?.estimated_usd === "number");
    const cost = priced.reduce((n, call) => n + call.cost.estimated_usd, 0);
    return [value, {
      calls: matching.length, usage_complete: reported.length === matching.length,
      input_tokens: reported.reduce((n, call) => n + (call.usage.input_tokens ?? 0), 0),
      output_tokens: reported.reduce((n, call) => n + (call.usage.output_tokens ?? 0), 0),
      known_estimated_usd: cost, estimated_usd: priced.length === matching.length ? cost : null,
    }];
  }));
}

const activeRecorders = new Set<RunRecorder>();
function onInterrupt() {
  for (const recorder of [...activeRecorders]) recorder.finish("aborted", null, "Interrupted by SIGINT.");
  process.exit(130);
}
function onTerminate() {
  for (const recorder of [...activeRecorders]) recorder.finish("aborted", null, "Interrupted by SIGTERM.");
  process.exit(143);
}

export class RunRecorder implements TrackingSink {
  readonly pricing: Pricing;
  readonly attemptId = randomUUID();
  readonly directory: string;
  private summary: Data;
  private attempt: Data;
  private calls: Map<string, Data>;
  private summaryPath: string;
  private ledgerPath: string;
  private lockPath: string;
  private start = performance.now();
  private finished = false;
  private artifactDirectory: string;
  private exitHandler = () => this.finish("interrupted", null, "Process exited before pipeline finalization.");

  constructor(outputDir: string, opts: Data) {
    this.directory = resolve(outputDir);
    this.artifactDirectory = resolve(opts.outputDir ?? outputDir);
    this.pricing = loadPricing(opts.pricingFile); // Invalid rates fail before any model call.
    mkdirSync(this.directory, { recursive: true });
    this.summaryPath = join(this.directory, "run.json");
    this.ledgerPath = join(this.directory, "api_calls.jsonl");
    this.lockPath = join(this.directory, ".run.lock");
    this.acquireLock();
    try {
      this.summary = existsSync(this.summaryPath) ? JSON.parse(readFileSync(this.summaryPath, "utf8"))
        : { schema_version: 1, run_id: randomUUID(), created_at: now(), attempts: [],
          prior_untracked_work: ["draft.scad", "plan.json", "final.scad"].some(name => existsSync(join(this.artifactDirectory, name))),
          history_scope: "Recorded invocations only; costs and timing of earlier untracked work are not reconstructed." };
      if (this.summary.schema_version !== 1 || !Array.isArray(this.summary.attempts))
        throw new Error("Unsupported run.json schema; preserve it and use a new output directory.");
      const journal = readLedger(this.ledgerPath);
      this.calls = journal.calls;
      // Preserve a partial final line after a crash, while ensuring new records
      // start on their own line. Its presence is explicitly recorded below.
      if (existsSync(this.ledgerPath)) {
        const text = readFileSync(this.ledgerPath, "utf8");
        if (text.length && !text.endsWith("\n")) appendFileSync(this.ledgerPath, "\n");
      } else writeFileSync(this.ledgerPath, "");
      this.summary.ledger_malformed_lines = journal.malformed;
      for (const previous of this.summary.attempts) if (previous.status === "running") {
        previous.status = "interrupted";
        previous.error = "Previous invocation ended without finalization; its completed calls are retained.";
      }
      for (const call of this.calls.values()) if (call.status === "started") {
        call.status = "interrupted"; call.usage_status = "unknown";
      }
      this.attempt = {
        attempt_id: this.attemptId, previous_attempt_id: this.summary.latest_attempt_id ?? null,
        mode: opts.redo ? "redo" : opts.motionOnly ? "motion-only"
          : existsSync(join(this.directory, "draft.scad")) || existsSync(join(this.directory, "plan.json")) ? "resume-or-reuse" : "new",
        experiment: { name: opts.experimentName ?? null, dataset_id: opts.datasetId ?? null, repetition: opts.repetition ?? null },
        started_at: now(), ended_at: null, status: "running", duration_ms: null,
        source: sourceMetadata(), inputs: inputMetadata(this.artifactDirectory, opts), configuration: configuration(opts),
        environment: environmentMetadata(), pricing: this.pricing, phases: {},
        timings: { stages: {}, retry_wait_ms: 0, note: "API times include network/queue/generation. Nested and concurrent times overlap; do not sum them into wall time." },
        input_artifacts: this.artifacts(), output_artifacts: null, outcome: null, error: null,
      };
      this.summary.attempts.push(this.attempt);
      this.summary.latest_attempt_id = this.attemptId;
      this.summary.output_directory = this.directory;
      this.flush();
      process.once("exit", this.exitHandler);
      if (activeRecorders.size === 0) {
        process.on("SIGINT", onInterrupt);
        process.on("SIGTERM", onTerminate);
      }
      activeRecorders.add(this);
    } catch (error) { unlinkSync(this.lockPath); throw error; }
  }
  private acquireLock(): void {
    if (existsSync(this.lockPath)) {
      const lock = JSON.parse(readFileSync(this.lockPath, "utf8"));
      let active = true;
      if (lock.host === hostname() && Number.isInteger(lock.pid)) {
        try { process.kill(lock.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") active = false;
        }
      }
      if (active) throw new Error("Another invocation owns this output directory (.run.lock). Use separate directories for concurrent experiments.");
      unlinkSync(this.lockPath);
    }
    const fd = openSync(this.lockPath, "wx");
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), attempt_id: this.attemptId })); }
    finally { closeSync(fd); }
  }
  private flush(): void {
    if (this.finished) return;
    for (const attempt of this.summary.attempts)
      attempt.usage = summarizeCalls([...this.calls.values()].filter(call => call.attempt_id === attempt.attempt_id));
    this.summary.totals = summarizeCalls([...this.calls.values()]);
    this.summary.status = this.attempt.status;
    this.summary.updated_at = now();
    const temporary = this.summaryPath + "." + this.attemptId + ".tmp";
    writeFileSync(temporary, JSON.stringify(this.summary, null, 2) + "\n");
    renameSync(temporary, this.summaryPath);
  }
  private artifacts() {
    const artifacts = outputMetadata(this.artifactDirectory);
    for (const [name, record] of Object.entries(artifacts)) if (record) record.path = join(this.directory, name);
    return artifacts;
  }
  skipPhase(name: string, reason: string): void {
    this.attempt.phases[name] = { status: "skipped", reason, duration_ms: 0 };
    this.flush();
  }
  addTiming(name: string, ms: number): void {
    const stages = this.attempt.timings.stages;
    const previous = stages[name] ?? { duration_ms: 0, calls: 0 };
    stages[name] = { duration_ms: previous.duration_ms + ms, calls: previous.calls + 1 };
  }
  addWait(ms: number): void { this.attempt.timings.retry_wait_ms += ms; }
  async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const phase: Data = { started_at: now(), status: "running" };
    this.attempt.phases[name] = phase;
    this.flush();
    try { const result = await fn(); phase.status = (result as Data)?.ok === false ? "needs_review" : "completed"; return result; }
    catch (error) { phase.status = "failed"; phase.error = safeError(error); throw error; }
    finally { phase.ended_at = now(); phase.duration_ms = performance.now() - start; this.flush(); }
  }
  startCall(details: Data) {
    const context = trackingContext();
    const call: Data = {
      schema_version: 1, run_id: this.summary.run_id, attempt_id: this.attemptId, call_id: randomUUID(),
      stage: context?.stage ?? "pipeline", phase: context?.phase ?? "pipeline", started_at: now(),
      status: "started", usage: null, usage_status: "unknown", cost: null, ...details,
    };
    const start = performance.now();
    this.calls.set(call.call_id, call);
    const append = (event: string) => {
      appendFileSync(this.ledgerPath, JSON.stringify({ ...call, event }) + "\n");
      this.flush();
    };
    append("started");
    let done = false;
    return {
      update: (details: Data) => {
        if (done || this.finished) return;
        Object.assign(call, details);
      },
      finish: (details: Data) => {
        if (done || this.finished) return;
        done = true;
        Object.assign(call, details, { ended_at: now(), duration_ms: performance.now() - start });
        append("finished");
      },
    };
  }
  finish(status: string, outcome: unknown, error?: unknown): void {
    if (this.finished) return;
    this.attempt.status = status;
    this.attempt.ended_at = now();
    this.attempt.duration_ms = performance.now() - this.start;
    this.attempt.outcome = outcome;
    this.attempt.error = error === undefined ? null : safeError(error);
    for (const call of this.calls.values()) if (call.attempt_id === this.attemptId && call.status === "started") {
      call.status = "interrupted"; call.usage_status = "unknown";
    }
    this.attempt.output_artifacts = this.artifacts();
    try { this.flush(); }
    finally {
      this.finished = true;
      process.removeListener("exit", this.exitHandler);
      activeRecorders.delete(this);
      if (activeRecorders.size === 0) {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
      }
      if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    }
  }
}

export async function recordRun<T>(outputDir: string, opts: Data, fn: () => Promise<T>, assess: (result: T) => { status: string; outcome: unknown }): Promise<T> {
  const recorder = new RunRecorder(outputDir, opts);
  return inRun(recorder, async () => {
    try {
      const result = await fn();
      const assessment = assess(result);
      recorder.finish(assessment.status, assessment.outcome);
      return result;
    } catch (error) {
      recorder.finish(opts.signal?.aborted ? "aborted" : "failed", null, error);
      throw error;
    }
  });
}
