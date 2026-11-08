/**
 * One-shot LLM text generation, with no agent harness around it.
 *
 * Every non-agentic stage in this pipeline — plan, plan review, per-part gen,
 * the refine critic, the refine patch — wants exactly one thing: send a system
 * prompt plus some text and images, get back text and reasoning. None of them
 * calls a tool, so none of them needs a session, a message store, an event bus,
 * a sandbox, or a permission ruleset.
 *
 * They were all built on `createHarness` anyway, which meant each one carried
 * ~150 lines of ceremony — fabricating user/assistant messages and parts purely
 * so the trajectory viewer had something to replay — around a single call. This
 * is that call.
 *
 * The harness stays where it earns its place: an agent that actually calls tools.
 */

import { inStage, trackingContext } from "../tracking/context.ts";
import { createLLMClient, applyAutoCache } from "@harness/template";
import type {
  CanonicalRequest, CanonicalPart, CanonicalMessage,
} from "@harness/template/llm/protocol";
import type { RouteDef } from "@harness/template";
import type { ModelRef } from "@harness/template/types";
import { longTimeoutFetch } from "./long-timeout-fetch.ts";
import { splitThinkTags } from "./think-tags.ts";

export interface GenerateResult {
  text: string;
  reasoning: string;
}

/**
 * The shared client. `maxAttempts: 1` because longTimeoutFetch already owns
 * retry policy — stacking the harness's ladder on top of it multiplies into
 * attempts² POSTs against a failing gateway.
 */
const client = createLLMClient({ fetch: longTimeoutFetch, maxAttempts: 1 });

/** Send one turn; collect the text and reasoning deltas. */
export async function generateOnce(args: {
  route: RouteDef<unknown>;
  model: ModelRef;
  system: string;
  parts: CanonicalPart[];
  signal?: AbortSignal;
  label?: string;
}): Promise<GenerateResult> {
  const req: CanonicalRequest = {
    model: args.model,
    system: [{ text: args.system }],
    messages: [{ role: "user", content: args.parts } satisfies CanonicalMessage],
  };
  applyAutoCache(req, { protocolId: args.route.protocol.id });

  const contextStage = trackingContext()?.stage;
  const stage = contextStage?.startsWith("llm.") ? contextStage : args.label ?? contextStage ?? "llm";
  const events = await inStage(stage, () => client.generate(args.route, req));
  let text = "";
  let reasoning = "";
  for (const ev of events) {
    if (ev.kind === "text-delta") text += ev.text;
    else if (ev.kind === "thinking-delta") reasoning += ev.text;
    else if (ev.kind === "error") throw ev.error;
  }
  // Some models emit reasoning inline as <think>…</think> inside the text
  // channel; fold it into `reasoning` so callers always parse clean output.
  const split = splitThinkTags(text);
  return {
    text: split.text,
    reasoning: reasoning + (split.think ? (reasoning ? "\n\n" : "") + split.think : ""),
  };
}

/**
 * `generateOnce` with a content-level retry.
 *
 * The transport layer retries network failures and 5xx, but a call can return
 * HTTP 200 with an EMPTY body — the model spent its whole turn on reasoning and
 * emitted no answer. That is a transport SUCCESS, so nothing below us retries
 * it, and it is common enough on the Gemini routes to kill a stage. Re-issue.
 */
export async function generateWithRetry(args: {
  route: RouteDef<unknown>;
  model: ModelRef;
  system: string;
  parts: CanonicalPart[];
  attempts?: number;
  label?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<GenerateResult> {
  const attempts = args.attempts ?? 3;
  const log = args.log ?? ((s: string) => console.error(s));
  let lastFailure = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await generateOnce(args);
      if (r.text.trim()) return r;
      lastFailure = "empty response (reasoning only, no text)";
    } catch (e) {
      if (args.signal?.aborted) throw e;
      lastFailure = (e as Error).message;
    }
    if (attempt < attempts) {
      log(`  [llm${args.label ? " " + args.label : ""}] attempt ${attempt}/${attempts}: ${lastFailure}; re-issuing`);
    }
  }
  throw new Error(
    `${args.label ?? "generate"} produced no usable response after ${attempts} attempts — ${lastFailure}`,
  );
}
