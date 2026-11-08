/** Preserve provider counts; unknown categories remain null. */
type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export interface Usage {
  format: "anthropic" | "openai" | "gemini";
  input_tokens: number | null; // total input, including cache categories
  uncached_input_tokens: number | null;
  output_tokens: number | null; // includes reasoning, where the provider counts it
  reasoning_tokens: number | null; // subset, never added again
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
}

export function normalizeUsage(raw: unknown, format: Usage["format"]): Usage {
  const u = object(raw);
  const cache = object(u.cache_creation);
  const inputDetails = object(u.prompt_tokens_details ?? u.input_tokens_details);
  const outputDetails = object(u.completion_tokens_details ?? u.output_tokens_details);
  const read = number(format === "gemini" ? u.cachedContentTokenCount
    : format === "anthropic" ? u.cache_read_input_tokens
      : inputDetails.cached_tokens ?? u.cache_read_input_tokens);
  const reportedWrite = number(u.cache_creation_input_tokens);
  const write5 = number(cache.ephemeral_5m_input_tokens);
  const write1 = number(cache.ephemeral_1h_input_tokens);
  const write = reportedWrite ?? (write5 !== null || write1 !== null ? (write5 ?? 0) + (write1 ?? 0) : null);
  const input = number(format === "gemini" ? u.promptTokenCount
    : format === "anthropic" ? u.input_tokens : u.prompt_tokens ?? u.input_tokens);
  const output = number(format === "gemini" ? u.candidatesTokenCount
    : format === "anthropic" ? u.output_tokens : u.completion_tokens ?? u.output_tokens);
  const reasoning = number(format === "gemini" ? u.thoughtsTokenCount : outputDetails.reasoning_tokens);
  return {
    format,
    input_tokens: input === null ? null : format === "anthropic" ? input + (read ?? 0) + (write ?? 0) : input,
    uncached_input_tokens: input === null ? null : format === "anthropic" ? input
      : Math.max(0, input - (read ?? 0) - (write ?? 0)),
    output_tokens: output === null ? null : format === "gemini" ? output + (reasoning ?? 0) : output,
    reasoning_tokens: reasoning, cache_read_input_tokens: read, cache_creation_input_tokens: write,
    cache_write_5m_tokens: write5, cache_write_1h_tokens: write1,
  };
}

/** Bounded, incremental SSE/JSON inspection. The original bytes are never changed. */
export class UsageReader {
  raw: ObjectValue = {};
  format: Usage["format"] = "openai";
  model: string | null = null;
  messageId: string | null = null;
  terminal = false;
  private sawFinish = false;
  responseParameters: ObjectValue = {};
  providerError: string | null = null;
  parseErrors = 0;
  private buffer = "";
  private decoder = new TextDecoder();
  constructor(private sse: boolean) {}
  private packet(packet: ObjectValue): void {
    if (typeof packet.model === "string") this.model = packet.model;
    if (typeof packet.id === "string") this.messageId = packet.id;
    const message = object(packet.message);
    for (const key of ["service_tier", "speed", "inference_geo"]) {
      if (packet[key] !== undefined || message[key] !== undefined)
        this.responseParameters[key] = packet[key] ?? message[key];
    }
    if (packet.choices?.some((choice: ObjectValue) => choice.finish_reason)
      || packet.type === "message_delta" && packet.delta?.stop_reason) this.sawFinish = true;
    if (typeof message.model === "string") this.model = message.model;
    if (typeof message.id === "string") this.messageId = message.id;
    const usage = packet.usageMetadata ?? packet.usage ?? message.usage;
    if (usage && typeof usage === "object") {
      const current = object(usage);
      this.format = packet.usageMetadata ? "gemini"
        : "input_tokens" in current || packet.type === "message_start" || packet.type === "message_delta"
          ? "anthropic" : "openai";
      this.raw = { ...this.raw, ...current };
    }
    if (packet.type === "message_stop") this.terminal = true;
    // Non-streaming successful JSON messages carry a final stop reason.
    if (!this.sse && (packet.stop_reason || packet.choices || packet.data || packet.candidates)) this.terminal = true;
    if (packet.candidates?.some((c: ObjectValue) => c.finishReason)) this.terminal = true;
    if (packet.error || packet.type === "error") this.providerError = String(object(packet.error).type ?? object(packet.error).code ?? "provider_error");
  }
  private parse(data: string): void {
    if (data.trim() === "[DONE]") { this.terminal = true; return; }
    if (!data.trim()) return;
    try { this.packet(JSON.parse(data)); } catch { this.parseErrors++; }
  }
  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (!this.sse) {
      if (this.buffer.length > 32 * 1024 * 1024) { this.buffer = ""; this.parseErrors++; }
      return;
    }
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, boundary).replace(/\r$/, "");
      this.buffer = this.buffer.slice(boundary + 1);
      if (line.startsWith("data:")) this.parse(line.slice(5).trimStart());
    }
    if (this.buffer.length > 2 * 1024 * 1024) { this.buffer = ""; this.parseErrors++; }
  }
  end(): void {
    this.buffer += this.decoder.decode();
    if (!this.sse) this.parse(this.buffer);
    else if (this.buffer.startsWith("data:")) this.parse(this.buffer.slice(5).trim());
    this.buffer = "";
    if (this.sawFinish) this.terminal = true;
  }
  get usage(): Usage | null {
    return Object.keys(this.raw).length ? normalizeUsage(this.raw, this.format) : null;
  }
}
