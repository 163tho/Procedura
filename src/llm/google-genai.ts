/**
 * Google GenAI (Gemini) native protocol.
 *
 * Talks the native `generateContent` REST shape used by Google's GenAI API.
 * An OpenAI-compatible proxy that translates to Gemini internally can be reached
 * with the stock OpenAIChat protocol; this adapter exists for the native path
 * `…/v1beta/models/{model}:streamGenerateContent`, which is the only place
 * `thinkingConfig` and first-class thought parts are available.
 *
 * Wire mapping (canonical → Gemini):
 *   system              → systemInstruction.parts[].text
 *   user   / assistant  → contents[{role:"user"|"model", parts:[…]}]
 *   tool (result)       → contents[{role:"user", parts:[functionResponse, …]}]
 *   text                → {text}
 *   image               → {inlineData:{mimeType,data}}
 *   tool-call           → {functionCall:{name,args}}
 *   tool-result         → {functionResponse:{name,response}}
 *   tools               → [{functionDeclarations:[{name,description,parameters}]}]
 *
 * Streaming (`?alt=sse`) events are `data: {GenerateContentResponse}` chunks:
 *   candidates[0].content.parts[]  → text-delta / thinking-delta / tool-call-*
 *   candidates[0].finishReason     → message-finish
 *   usageMetadata                  → token usage
 *
 * parseEvent is intentionally STATELESS across chunks (no module-level per-stream
 * state): the batch runs many streams in parallel and shared mutable state would
 * corrupt them. Gemini emits each functionCall whole in one chunk (not as arg
 * deltas), and the harness executes any accumulated tool calls regardless of the
 * final finish reason (agent.ts), so per-chunk emission is sufficient.
 */

import type { JsonObject } from "@harness/template/types";
import type { CanonicalRequest, LLMEvent, Protocol } from "@harness/template/llm/protocol";

type Raw = { event: string; data: string };

// ── thinking / generation defaults ─────────────────────────────────────────
// Gateways commonly drop a request that goes ~180s with no bytes flowing; long
// thinking happens BEFORE the first answer byte. Streaming + includeThoughts
// keeps the socket busy (thought text streams first), so we always ask for
// thoughts. thinkingBudget max is 32768; maxOutputTokens max is 65536 and is a
// SHARED pool for thinking + answer, so we size it at the ceiling.
const DEFAULT_THINKING_BUDGET = 32768;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/** JSON-Schema keys the Gemini `Schema` type understands. Everything else
 *  (uniqueItems, additionalProperties, $schema, $ref, const, oneOf, …) makes the
 *  native API 400 with "Unknown name …", so we drop it. */
const GEMINI_SCHEMA_KEYS = new Set([
  "type", "format", "title", "description", "nullable", "enum",
  "items", "properties", "required", "propertyOrdering",
  "minItems", "maxItems", "minimum", "maximum",
  "minLength", "maxLength", "pattern", "example", "default", "anyOf",
]);

/** Recursively strip a JSON Schema down to Gemini-supported keys. */
function sanitizeGeminiSchema(schema: unknown): JsonObject {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return {} as JsonObject;
  }
  const src = schema as JsonObject;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: JsonObject = {};
      for (const [pk, pv] of Object.entries(v as JsonObject)) {
        props[pk] = sanitizeGeminiSchema(pv);
      }
      out[k] = props;
    } else if (k === "items") {
      out[k] = Array.isArray(v) ? v.map(sanitizeGeminiSchema) as unknown as JsonObject : sanitizeGeminiSchema(v);
    } else if (k === "anyOf" && Array.isArray(v)) {
      out[k] = v.map(sanitizeGeminiSchema) as unknown as JsonObject;
    } else {
      out[k] = v as JsonObject[string];
    }
  }
  return out;
}

/** Canonical content part → Gemini part. Returns null for parts with no Gemini
 *  representation (e.g. prior-turn thinking, which Gemini rejects as input). */
function toGeminiPart(
  p: CanonicalRequest["messages"][number]["content"][number],
): JsonObject | null {
  switch (p.kind) {
    case "text":
      return { text: p.text };
    case "image":
      return { inlineData: { mimeType: p.mimeType, data: p.data } };
    case "tool-call":
      return { functionCall: { name: p.toolName, args: p.input ?? {} },
        ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) };
    case "tool-result": {
      // functionResponse.response must be a JSON object (Struct). Wrap scalars.
      const response: JsonObject =
        p.output !== null && typeof p.output === "object"
          ? (p.output as JsonObject)
          : { output: typeof p.output === "string" ? p.output : JSON.stringify(p.output) };
      return { functionResponse: { name: p.toolName ?? "tool", response } };
    }
    case "thinking":
      return null; // output-only; not a valid input part
    case "document":
      return { text: `[document: ${p.filename ?? p.mimeType}]` };
  }
}

export const GoogleGenAI: Protocol<Raw> = {
  id: "google-genai",

  buildBody(req: CanonicalRequest): JsonObject {
    const contents: JsonObject[] = [];
    for (const m of req.messages) {
      const role = m.role === "assistant" ? "model" : "user"; // user | tool → "user"
      const parts: JsonObject[] = [];
      // Images attached to tool results can't ride inside functionResponse, so
      // they get appended as sibling inlineData parts in the same user content.
      const attachmentParts: JsonObject[] = [];
      for (const p of m.content) {
        const gp = toGeminiPart(p);
        if (gp) parts.push(gp);
        if (p.kind === "tool-result" && p.attachments?.length) {
          for (const a of p.attachments) {
            if (a.label) attachmentParts.push({ text: a.label });
            attachmentParts.push({ inlineData: { mimeType: a.mimeType, data: a.data } });
          }
        }
      }
      parts.push(...attachmentParts);
      if (parts.length === 0) continue; // never emit an empty content
      contents.push({ role, parts });
    }

    const body: JsonObject = { contents };

    if (req.system && req.system.length) {
      body["systemInstruction"] = {
        parts: [{ text: req.system.map((s) => s.text).join("\n\n") }],
      };
    }

    if (req.tools && req.tools.length) {
      body["tools"] = [{
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeGeminiSchema(t.inputSchema),
        })),
      }];
      // Map toolChoice → functionCallingConfig. Default (auto/undefined) is left
      // implicit so the model decides.
      if (req.toolChoice === "none") {
        body["toolConfig"] = { functionCallingConfig: { mode: "NONE" } };
      } else if (req.toolChoice === "required") {
        body["toolConfig"] = { functionCallingConfig: { mode: "ANY" } };
      } else if (typeof req.toolChoice === "object" && req.toolChoice?.name) {
        body["toolConfig"] = {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: [req.toolChoice.name] },
        };
      }
    }

    // generationConfig (thinking on by default; overridable via providerOptions).
    const genCfg: JsonObject = {
      maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: DEFAULT_THINKING_BUDGET, includeThoughts: true },
    };
    if (req.temperature !== undefined) genCfg["temperature"] = req.temperature;
    if (req.topP !== undefined) genCfg["topP"] = req.topP;
    if (req.topK !== undefined) genCfg["topK"] = req.topK;

    // providerOptions escape hatch: a `generationConfig` sub-object is merged
    // (so callers can tweak thinkingBudget without losing our defaults); any
    // other keys are assigned at the top level.
    if (req.providerOptions) {
      const { generationConfig: pgc, ...rest } = req.providerOptions as JsonObject & {
        generationConfig?: JsonObject;
      };
      if (pgc && typeof pgc === "object") {
        Object.assign(genCfg, pgc);
        if ((pgc as JsonObject)["thinkingConfig"] && typeof (pgc as JsonObject)["thinkingConfig"] === "object") {
          genCfg["thinkingConfig"] = {
            ...(genCfg["thinkingConfig"] as JsonObject),
            ...((pgc as JsonObject)["thinkingConfig"] as JsonObject),
          };
        }
      }
      Object.assign(body, rest);
    }

    body["generationConfig"] = genCfg;
    return body;
  },

  parseEvent(raw: Raw): LLMEvent[] {
    if (!raw.data || raw.data === "[DONE]") return [];
    let chunk: {
      candidates?: {
        content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: JsonObject } }[] };
        finishReason?: string;
      }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      error?: { message?: string; status?: string; code?: number };
    };
    try {
      chunk = JSON.parse(raw.data) as typeof chunk;
    } catch {
      // Tolerate a garbage/truncated SSE line — one bad chunk must not kill an
      // expensive in-flight generation.
      console.error(`  [google-genai] skipping unparseable SSE chunk (${raw.data.length} chars): ${raw.data.slice(0, 120)}`);
      return [];
    }

    // Streamed error object (e.g. a gateway idle-timeout surfaces here).
    if (chunk.error) {
      const msg = chunk.error.message ?? chunk.error.status ?? "unknown Gemini error";
      return [{ kind: "error", error: new Error(`Gemini: ${msg}`), recoverable: false }];
    }

    const out: LLMEvent[] = [];
    const cand = chunk.candidates?.[0];
    let sawFunctionCall = false;

    for (const part of cand?.content?.parts ?? []) {
      if (part.functionCall?.name) {
        sawFunctionCall = true;
        const callId = `gm_call_${++functionCallCounter}`;
        out.push({ kind: "tool-call-start", toolCallId: callId, toolName: part.functionCall.name,
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) });
        out.push({ kind: "tool-call-delta", toolCallId: callId, argDelta: JSON.stringify(part.functionCall.args ?? {}) });
      } else if (part.thought === true && part.text) {
        out.push({ kind: "thinking-delta", text: part.text });
      } else if (part.text) {
        out.push({ kind: "text-delta", text: part.text });
      }
    }

    if (cand?.finishReason) {
      const usage = {
        input: chunk.usageMetadata?.promptTokenCount ?? 0,
        output: (chunk.usageMetadata?.candidatesTokenCount ?? 0) + (chunk.usageMetadata?.thoughtsTokenCount ?? 0),
      };
      // A functionCall in this chunk means the turn ends to run tools → surface
      // it as a tool-calls finish so the agent loop keeps going. (Gemini reports
      // finishReason="STOP" even for function calls.)
      const reason = sawFunctionCall ? "tool-calls" as const
        : cand.finishReason === "MAX_TOKENS" ? "length" as const
        : cand.finishReason === "SAFETY" || cand.finishReason === "RECITATION" || cand.finishReason === "PROHIBITED_CONTENT"
          ? "content-filter" as const
        : "stop" as const;
      out.push({ kind: "message-finish", reason, usage });
    } else if (chunk.usageMetadata && !cand) {
      // Trailing usage-only chunk with no candidate — surface usage as a stop.
      out.push({
        kind: "message-finish",
        reason: "stop",
        usage: {
          input: chunk.usageMetadata.promptTokenCount ?? 0,
          output: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
        },
      });
    }
    return out;
  },
};

// Monotonic tool-call id source. Unlike a per-index map this is only ever
// incremented (never read-then-written against a shared key), so parallel
// streams sharing it still get unique ids — no cross-stream corruption.
let functionCallCounter = 0;
