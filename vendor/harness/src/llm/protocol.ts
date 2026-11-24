/**
 * Wire-protocol contract.
 *
 * Pattern source: opencode packages/llm/src/route/protocol.ts.
 * The four-axis decomposition is `Protocol × Endpoint × Auth × Framing`.
 * Each protocol owns:
 *   - body construction from canonical request
 *   - body schema for validation
 *   - stream-event interpretation (SSE / chunked / WebSocket / binary)
 */

import type { FinishReason, JsonObject, ModelRef, TokenUsage } from "../types.ts";

// ──────────────────────────────────────────────────────────────────────────
// Canonical request (provider-agnostic input to the LLM layer)
// ──────────────────────────────────────────────────────────────────────────

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: CanonicalPart[];
  /** Optional cache hint — see cache-policy.ts. */
  cacheHint?: "ephemeral" | { ttlSeconds: number };
}

/** Base64-encoded image that can be attached to a `tool-result` part.
 * Protocols that natively support images inside tool results (Anthropic
 * Messages) pack them in-place; protocols that don't (OpenAI Chat) splice
 * the attachments into a synthetic user turn that follows the tool message.
 */
export interface ImageAttachment {
  kind: "image";
  data: string;          // base64-encoded
  mimeType: string;      // e.g. "image/png"
  label?: string;        // short text shown alongside (e.g. "AO isometric")
}

export type CanonicalPart =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "document"; data: string; mimeType: string; filename?: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: JsonObject;
      /** Opaque Gemini function-call signature; echo it unchanged on continuation. */
      thoughtSignature?: string }
  | { kind: "tool-result"; toolCallId: string; toolName?: string;
      output: string | JsonObject; isError?: boolean;
      /** Optional images that came back from the tool (e.g. renders). */
      attachments?: ImageAttachment[] }
  | { kind: "thinking"; text: string; signature?: string };

export interface CanonicalToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** Optional cache hint. */
  cacheHint?: "ephemeral" | { ttlSeconds: number };
}

export interface CanonicalRequest {
  model: ModelRef;
  system?: { text: string; cacheHint?: CanonicalMessage["cacheHint"] }[];
  messages: CanonicalMessage[];
  tools?: CanonicalToolDef[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  /** Provider-specific opaque options (thinking config, reasoning effort, ...). */
  providerOptions?: JsonObject;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

// ──────────────────────────────────────────────────────────────────────────
// Canonical stream events (provider-agnostic output)
// ──────────────────────────────────────────────────────────────────────────

export type LLMEvent =
  | { kind: "message-start" }
  | { kind: "text-delta"; text: string }
  | { kind: "thinking-delta"; text: string; signature?: string }
  | { kind: "tool-call-start"; toolCallId: string; toolName: string; thoughtSignature?: string }
  | { kind: "tool-call-delta"; toolCallId: string; argDelta: string }
  | { kind: "tool-call-finish"; toolCallId: string; input: JsonObject }
  | { kind: "message-finish"; reason: FinishReason; usage: TokenUsage }
  | { kind: "error"; error: Error; recoverable: boolean };

// ──────────────────────────────────────────────────────────────────────────
// Protocol contract
// ──────────────────────────────────────────────────────────────────────────

export interface Protocol<RawEvent = unknown> {
  /** Stable id for registry lookup and route caching. */
  id: string;
  /** Construct the HTTP/WS body from canonical request. */
  buildBody(req: CanonicalRequest): JsonObject;
  /** One iteration: consume one raw stream event, emit zero or more LLMEvents. */
  parseEvent(raw: RawEvent): LLMEvent[];
  /** Returns true when this raw event terminates the stream. */
  isTerminal?(raw: RawEvent): boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-protocol helpers (the `protocols/shared.ts` toolkit)
// ──────────────────────────────────────────────────────────────────────────

export const ProtocolShared = {
  joinText(deltas: { text: string }[]): string {
    return deltas.map((d) => d.text).join("");
  },
  parseToolInput(s: string): JsonObject {
    try { return JSON.parse(s) as JsonObject; }
    catch { return { __invalid: s }; }
  },
};
