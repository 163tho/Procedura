/**
 * One-shot LLM text generation, with no agent harness around it.
 *
 * Every non-agentic stage in this pipeline — plan, plan review, ordinary part gen,
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
 * GLB-guided part generation additionally uses the narrow tool loop below.
 */

import { inStage, trackingContext } from "../tracking/context.ts";
import { createLLMClient, applyAutoCache } from "@harness/template";
import type {
  CanonicalRequest, CanonicalPart, CanonicalMessage, CanonicalToolDef, LLMEvent,
} from "@harness/template/llm/protocol";
import type { RouteDef } from "@harness/template";
import type { ModelRef } from "@harness/template/types";
import { longTimeoutFetch } from "./long-timeout-fetch.ts";
import { splitThinkTags } from "./think-tags.ts";
import type { JsonObject } from "@harness/template/types";

export interface GenerateResult {
  text: string;
  reasoning: string;
}

export interface GenerationTool {
  definition: CanonicalToolDef;
  execute(input: JsonObject, toolCallId: string): Promise<Extract<CanonicalPart, { kind: "tool-result" }>>;
}

/** Part-generation-only tool loop. Ordinary generations keep their existing path. */
export async function generateWithTools(args: {
  route: RouteDef<unknown>; model: ModelRef; system: string; parts: CanonicalPart[];
  tool: GenerationTool; label: string; signal?: AbortSignal;
  maxToolCalls?: number;
  onImagesAttached?: (toolCallIds: string[]) => void;
  // Test seam: exercises the conversation without issuing paid requests.
  generate?: (request: CanonicalRequest) => Promise<LLMEvent[]>;
}): Promise<GenerateResult> {
  const messages: CanonicalMessage[] = [{ role: "user", content: args.parts }];
  const imageSlots = 16 - args.parts.filter(part => part.kind === "image").length;
  if (imageSlots < 1) throw new Error("GLB guidance requires one free image slot.");
  let calls = 0;
  let reasoning = "";
  for (;;) {
    args.signal?.throwIfAborted();
    // Keep the newest requested views in context, retaining earlier camera/error
    // text and call/result pairs. This bounds images across the whole conversation.
    let remaining = imageSlots;
    for (const message of [...messages].reverse()) for (const part of [...message.content].reverse()) {
      if (part.kind !== "tool-result" || !part.attachments) continue;
      part.attachments = remaining > 0 ? part.attachments.slice(-remaining) : [];
      remaining -= part.attachments.length;
    }
    const attached = messages.flatMap(message => message.content.flatMap(part =>
      part.kind === "tool-result" && part.attachments?.length ? [part.toolCallId] : []));
    if (attached.length) args.onImagesAttached?.(attached);
    const request: CanonicalRequest = {
      model: args.model, system: [{ text: args.system }], messages,
      tools: [args.tool.definition], toolChoice: "auto", signal: args.signal,
    };
    applyAutoCache(request, { protocolId: args.route.protocol.id });
    const events = await inStage(args.label, () => args.generate ? args.generate(request) : client.generate(args.route, request));
    const content: CanonicalPart[] = [];
    const pending = new Map<string, { name: string; json: string; input?: JsonObject; thoughtSignature?: string }>();
    let text = "";
    for (const event of events) {
      if (event.kind === "error") throw event.error;
      if (event.kind === "text-delta") text += event.text;
      if (event.kind === "thinking-delta") {
        reasoning += event.text;
        content.push({ kind: "thinking", text: event.text, signature: event.signature });
      }
      if (event.kind === "tool-call-start") pending.set(event.toolCallId, {
        name: event.toolName, json: "", thoughtSignature: event.thoughtSignature,
      });
      if (event.kind === "tool-call-delta") {
        // Anthropic delta IDs are block indexes; its start IDs are tool IDs.
        const call = pending.get(event.toolCallId) ?? [...pending.values()].at(-1);
        if (call) call.json += event.argDelta;
      }
      if (event.kind === "tool-call-finish") {
        const call = pending.get(event.toolCallId);
        if (call) call.input = event.input;
      }
    }
    const split = splitThinkTags(text);
    if (split.think) reasoning += split.think;
    if (pending.size === 0) return { text: split.text, reasoning };
    if (split.text) content.push({ kind: "text", text: split.text });
    const results: CanonicalPart[] = [];
    for (const [id, call] of pending) {
      if (++calls > (args.maxToolCalls ?? 8)) throw new Error("GLB guidance tool-call budget exhausted for this generation attempt.");
      let input: JsonObject;
      try { input = call.input ?? JSON.parse(call.json || "{}"); }
      catch { input = { __invalid: call.json }; }
      content.push({ kind: "tool-call", toolCallId: id, toolName: call.name, input,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) });
      if (call.name !== args.tool.definition.name) {
        results.push({ kind: "tool-result", toolCallId: id, toolName: call.name, isError: true, output: "Unknown tool." });
      } else results.push(await args.tool.execute(input, id));
    }
    messages.push({ role: "assistant", content }, { role: "tool", content: results });
  }
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
