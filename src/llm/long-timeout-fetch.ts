/**
 * Resilient fetch for LLM requests — bounded timeout + jittered retry.
 *
 * LLM gateways are intermittently unstable (dropped connections, 5xx, slow
 * generations). Two gaps in the defaults this fixes:
 *
 *  1. Bun's global `fetch` has a 300s default timeout — too short for slow
 *     high-reasoning models (GPT-5.5 heavy SCAD-gen runs ~80s→300s+), so a
 *     still-streaming generation is cut off as "The operation timed out."
 *  2. The harness's own retry (route.ts `fetchWithRetry`, 4 attempts) has no
 *     jitter, so N parallel cases retry in lockstep and hammer a struggling
 *     proxy in sync, and it caps backoff at 4s.
 *
 * Design (informed by an adversarial review of the layering):
 *  - This wrapper is layered UNDER the harness's `fetchWithRetry`. To avoid the
 *    two retry layers multiplying into an unbounded wall-clock hang on a dead
 *    endpoint, OUR layer is bounded by an absolute deadline (`TOTAL_DEADLINE_MS`)
 *    across all its attempts — never per-attempt-count alone. The harness still
 *    wraps us (≤4×), so a *persistently* dead endpoint fails in ≤ ~4·deadline,
 *    which is bounded (and a dead endpoint fails the run regardless).
 *  - The per-attempt timeout is a TOTAL request budget (time-to-headers AND body
 *    streaming, since the signal stays bound to the Response). It is sized well
 *    above the slowest expected generation. If a generation still exceeds it, we
 *    abort with a NON-"timeout"-named reason so the harness's resume-on-
 *    interruption does NOT replay the prompt (which would duplicate output) —
 *    it surfaces as a clean error that the draft/refine retry handles.
 *  - Caller aborts (e.g. the refine edit-cap signal) are NEVER retried.
 *
 * Wired via `createLLMClient({ fetch: longTimeoutFetch })` into `createHarness`
 * in both draft.ts and refine.ts. Tunable via env (nurse a flaky endpoint
 * without code changes):
 *   PROCEDURA_LLM_TIMEOUT_MS    per-attempt request budget (default 600000)
 *   PROCEDURA_LLM_DEADLINE_MS   wall-clock cap across all our attempts (default 600000)
 *   PROCEDURA_LLM_MAX_ATTEMPTS  max attempts within the deadline (default 5)
 */

import { trackedFetch } from "../tracking/fetch.ts";
import { recordRetryWait } from "../tracking/context.ts";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Per-attempt request budget (headers + body). Above the slowest expected gen. */
export const LLM_FETCH_TIMEOUT_MS = envInt("PROCEDURA_LLM_TIMEOUT_MS", 600_000);
/** Absolute wall-clock cap across ALL of this layer's attempts. Bounds the
 *  worst case so the harness's outer retry can't multiply us into an hours-long
 *  hang on a black-hole endpoint. */
export const LLM_DEADLINE_MS = envInt("PROCEDURA_LLM_DEADLINE_MS", 600_000);
/** Max attempts within the deadline. */
export const LLM_MAX_ATTEMPTS = envInt("PROCEDURA_LLM_MAX_ATTEMPTS", 5);
/** Per-CHUNK idle deadline over a streaming response body. A healthy generation
 *  emits tokens continuously (idle gaps < seconds); a mid-stream STALL — the
 *  upstream drops the stream but the TCP socket stays open so no read-timeout
 *  ever fires — leaves the body idle forever and the consumer awaits the next
 *  chunk indefinitely (observed: a whole run hung ~a day). If no chunk arrives
 *  within this window we abort the body so the read throws and the draft/refine
 *  transport-retry re-requests. This bounds IDLE time, not TOTAL duration, so a
 *  legitimately long generation that keeps streaming is never cut off. */
export const LLM_STREAM_IDLE_MS = envInt("PROCEDURA_LLM_STREAM_IDLE_MS", 300_000);

/** Status codes worth retrying — transient gateway / rate-limit / upstream.
 *  529 = "provider resource exhausted / overloaded" (some gateways surface
 *  upstream Vertex rate-limits as 529); it is transient, so back off + retry. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 529]);

const BACKOFF_BASE_MS = 750;
const BACKOFF_CAP_MS = 15_000;

/**
 * Statuses meaning "the provider is temporarily unable to serve", as opposed to
 * ordinary transport jitter.
 *
 * CLIProxyAPI returns 503 `auth_unavailable` while an upstream credential is
 * being rotated or is exhausted, and it can stay that way for MINUTES. The
 * normal ladder spends ~11s across 5 attempts, so a run walks straight through
 * its whole retry budget and dies — this cost two complete assault_buggy runs,
 * one of them at part 18 of 19. Back off far harder for these, bounded by the
 * same overall deadline, so a transient provider outage costs waiting rather
 * than the entire run.
 */
const UNAVAILABLE_STATUS = new Set([429, 503, 529]);
const UNAVAILABLE_BASE_MS = envInt("PROCEDURA_LLM_UNAVAILABLE_BASE_MS", 5_000);
const UNAVAILABLE_CAP_MS = envInt("PROCEDURA_LLM_UNAVAILABLE_CAP_MS", 120_000);

/** Marker name for our per-attempt budget abort. Deliberately contains no
 *  "timeout"/"timed out"/"socket"/"network" so the harness's
 *  isResumableInterruption does NOT treat it as a resumable network drop. */
const BUDGET_ABORT = "LlmBudgetExceeded";

/** Marker for a mid-stream idle-stall abort. Like BUDGET_ABORT it avoids the
 *  "timeout"/"socket"/"network"/"closed" substrings so the harness's
 *  isResumableInterruption does NOT replay the prompt (which would duplicate
 *  output) — it surfaces as a clean throw the draft/refine loop's broad
 *  transport-retry (GEN_TRANSPORT_MAX_RETRIES) re-requests from scratch. */
const STREAM_IDLE_ABORT = "LlmStreamIdle";

/**
 * Wrap a response body so a mid-stream STALL is caught. Arms an idle timer that
 * fires if no chunk arrives within LLM_STREAM_IDLE_MS; the timer resets on every
 * chunk. On fire it aborts `ctrl` (the fetch's own controller), which errors the
 * underlying body read — the wrapped stream propagates that as a stream error to
 * the consumer. A `done` read or a cancel tears the timer down.
 */
function idleGuardedBody(
  body: ReadableStream<Uint8Array>,
  ctrl: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(
      () => ctrl.abort(new DOMException("LLM stream idle — no data received", STREAM_IDLE_ABORT)),
      LLM_STREAM_IDLE_MS,
    );
  };
  const disarm = (): void => { if (idle) { clearTimeout(idle); idle = undefined; } };
  return new ReadableStream<Uint8Array>({
    start() { arm(); },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { disarm(); controller.close(); return; }
        arm(); // a chunk arrived — reset the idle deadline
        controller.enqueue(value);
      } catch (e) {
        disarm();
        controller.error(e);
      }
    },
    cancel(reason) { disarm(); return reader.cancel(reason); },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Jittered exponential backoff: base·2^(n-1), capped, then ×0.7..1.3 jitter.
 *  `unavailable` selects the long ladder — see UNAVAILABLE_STATUS. */
function backoffMs(attempt: number, unavailable = false): number {
  const base = unavailable ? UNAVAILABLE_BASE_MS : BACKOFF_BASE_MS;
  const cap = unavailable ? UNAVAILABLE_CAP_MS : BACKOFF_CAP_MS;
  const exp = Math.min(base * 2 ** (attempt - 1), cap);
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/** Should a thrown fetch error be retried? Caller aborts and our own budget
 *  abort and transient transport failures → retry; genuine errors → no. */
function isRetryableThrow(e: Error): boolean {
  if ((e as { name?: string }).name === BUDGET_ABORT) return true; // our per-attempt budget
  if ((e as { name?: string }).name === "TimeoutError") return true;
  const s = `${e.name} ${e.message}`.toLowerCase();
  return (
    s.includes("timed out") || s.includes("timeout") ||
    s.includes("reset") || s.includes("econn") || s.includes("eof") ||
    s.includes("socket") || s.includes("fetch failed") || s.includes("network") ||
    s.includes("closed") || s.includes("unexpected")
  );
}

const wrapped = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const caller = init?.signal ?? undefined;
  const start = Date.now();
  let lastErr: Error | undefined;

  let unavailable = false;
  let unavailableTries = 0;
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    const elapsed = Date.now() - start;
    const remaining = LLM_DEADLINE_MS - elapsed;
    if (remaining <= 0) break; // wall-clock deadline reached

    // Per-attempt budget = min(configured, time left). Use an explicit controller
    // with a non-"timeout" reason so a mid-stream fire isn't resumed by the harness.
    const ctrl = new AbortController();
    const perAttempt = Math.min(LLM_FETCH_TIMEOUT_MS, remaining);
    const timer = setTimeout(
      () => ctrl.abort(new DOMException("LLM per-attempt budget exceeded", BUDGET_ABORT)),
      perAttempt,
    );
    const signal = caller ? AbortSignal.any([caller, ctrl.signal]) : ctrl.signal;
    try {
      // `timeout: false` disables BUN'S OWN fetch timeout, which defaults to
      // 300s and surfaces as a bare "The operation timed out." That default sits
      // BENEATH our per-attempt budget, so a legitimately long generation (high
      // reasoning effort, big part plans) was being cut at 5 minutes no matter
      // how large PROCEDURA_LLM_TIMEOUT_MS was set. We deliberately keep our own two
      // guards instead: the per-attempt budget below, and the per-chunk idle
      // deadline on the body — those bound IDLE time and total attempts without
      // capping a healthy stream that is still emitting tokens.
      const res = await trackedFetch(input, { ...init, signal, timeout: false } as RequestInit);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === LLM_MAX_ATTEMPTS) {
        // Headers arrived → the per-attempt budget covered time-to-headers and
        // the `finally` clears it. The body would then stream UNGUARDED (that is
        // the mid-stream-stall hang). Re-use the SAME `ctrl` to guard the body
        // with a per-chunk idle deadline: a healthy stream keeps resetting it; a
        // stall trips it and errors the read so the transport-retry re-requests.
        if (res.ok && res.body) {
          return new Response(idleGuardedBody(res.body, ctrl), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
        return res; // non-ok final / bodyless → hand back as-is
      }
      await res.body?.cancel().catch(() => undefined); // free the connection
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      unavailable = UNAVAILABLE_STATUS.has(res.status);
    } catch (e) {
      const err = e as Error;
      // A caller-initiated abort is intentional — never retry it.
      if (caller?.aborted || !isRetryableThrow(err) || attempt === LLM_MAX_ATTEMPTS) throw err;
      lastErr = err;
      unavailable = false;
    } finally {
      clearTimeout(timer);
    }

    const delay = Math.min(
      backoffMs(unavailable ? unavailableTries : attempt, unavailable),
      Math.max(0, LLM_DEADLINE_MS - (Date.now() - start)),
    );
    if (delay <= 0) break; // no time left to back off + retry
    if (unavailable) {
      // Provider-unavailable retries do not consume the transport attempt
      // budget: that budget exists for flaky sockets, and burning it on an
      // upstream outage is what killed whole runs. The DEADLINE still bounds us.
      unavailableTries += 1;
      attempt -= 1;
    }
    console.error(
      "  [llm-fetch] " +
      (unavailable
        // The transport attempt counter is deliberately not advanced for these,
        // so printing it here would read as a stuck or zeroed attempt number.
        ? `provider unavailable, waiting it out (try ${unavailableTries})`
        : `attempt ${attempt}/${LLM_MAX_ATTEMPTS}`) +
      ` failed: ${lastErr?.message ?? "unknown"}; retrying in ${delay}ms`,
    );
    const waitStart = performance.now();
    await sleep(delay);
    recordRetryWait(performance.now() - waitStart);
  }
  throw lastErr ?? new Error("llm fetch: deadline reached without a response");
};

// `typeof fetch` also carries Bun's `preconnect`; this is a thin wrapper used
// only by the LLM client, so the cast is safe.
export const longTimeoutFetch = wrapped as unknown as typeof fetch;
