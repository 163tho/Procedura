import { trackingContext } from "./context.ts";
import { hash, safeEndpoint } from "./metadata.ts";
import { estimateCost } from "./pricing.ts";
import { safeError } from "./run-record.ts";
import { UsageReader } from "./usage.ts";

/** Observe each physical HTTP attempt, including retries and continuations.
 * This neither changes the request nor consumes/duplicates the response body. */
export async function trackedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const context = trackingContext();
  if (!context) return fetch(input, init);
  const endpoint = safeEndpoint(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  let body: Record<string, any> = {};
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { /* no request body is logged */ }
  }
  const parameters = Object.fromEntries([
    "temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens", "reasoning_effort",
    "thinking", "output_config", "service_tier", "speed", "inference_geo", "cache_control", "size", "n",
  ].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  // Preserve explicit cache TTLs without saving prompt text or image data.
  const serializedBody = typeof init?.body === "string" ? init.body : JSON.stringify(body);
  const cacheHints = serializedBody.match(/"ttl"\s*:\s*"(?:1h|5m)"/g) ?? [];
  if (cacheHints.length) parameters.cache_control = cacheHints;
  const requestedModel = typeof body.model === "string" ? body.model
    : endpoint?.match(/\/models\/([^/:]+)/)?.[1] ?? null;
  const call = context.recorder.startCall({
    transport: "http", endpoint, requested_model: requestedModel,
    request_sha256: typeof init?.body === "string" ? hash(init.body) : null,
    request_parameters: parameters,
    request_stats: {
      messages: Array.isArray(body.messages) ? body.messages.length : Array.isArray(body.contents) ? body.contents.length : 0,
      images: (serializedBody.match(/"type":"image(?:_url)?"|"mimeType":"image\//g) ?? []).length,
      system_sha256: body.system ? hash(JSON.stringify(body.system))
        : body.messages?.filter((message: Record<string, unknown>) => message.role === "system").length
          ? hash(JSON.stringify(body.messages.filter((message: Record<string, unknown>) => message.role === "system")))
          : body.systemInstruction ? hash(JSON.stringify(body.systemInstruction)) : null,
    },
  });
  let response: Response;
  try { response = await fetch(input, init); }
  catch (error) {
    call.finish({ status: init?.signal?.aborted ? "interrupted" : "failed", error: safeError(error), usage_status: "unknown" });
    throw error;
  }
  const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id");
  call.update({ http_status: response.status, request_id: requestId });
  if (!response.ok || !response.body) {
    call.finish({ status: response.ok ? "completed" : "failed", usage_status: "unknown" });
    return response;
  }
  const observer = new UsageReader(response.headers.get("content-type")?.includes("text/event-stream") ?? body.stream === true);
  const reader = response.body.getReader();
  let finished = false;
  const finish = (state: string, error?: unknown) => {
    if (finished) return;
    finished = true;
    observer.end();
    const usage = observer.usage;
    const complete = observer.terminal && !observer.providerError && observer.parseErrors === 0
      && usage?.input_tokens !== null && usage?.output_tokens !== null && usage !== null;
    const model = observer.model ?? requestedModel;
    const status = observer.providerError ? "failed" : observer.terminal && state === "cancelled" ? "completed" : state;
    call.finish({
      status, model, message_id: observer.messageId, usage,
      usage_status: complete ? "complete" : usage ? "partial" : "unknown",
      response_parameters: observer.responseParameters,
      usage_raw: observer.raw, usage_parse_errors: observer.parseErrors,
      error: observer.providerError ?? (error === undefined ? null : safeError(error)),
      cost: estimateCost(context.recorder.pricing, model, endpoint, usage, complete, observer.raw, { ...parameters, ...observer.responseParameters }),
    });
  };
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish("completed"); controller.close(); return; }
        observer.push(value);
        controller.enqueue(value);
      } catch (error) { finish("interrupted", error); controller.error(error); }
    },
    async cancel(reason) {
      finish("cancelled");
      await reader.cancel(reason);
    },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
