import type { Usage } from "./usage.ts";

type Data = Record<string, any>;
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// Suppress binary floating-point noise without fixing costs to a currency scale.
// Raw estimates remain unchanged in the journal.
const cleanCost = (value: number) => Number(value.toPrecision(15));

function metrics(calls: Data[]): Data {
  const reported = calls.filter(call => call.usage_status === "complete");
  const sum = (key: keyof Usage) => reported.reduce((n, call) => n + (Number(call.usage?.[key]) || 0), 0);
  const priced = calls.filter(call => numeric(call.cost?.estimated_usd));
  const knownCost = cleanCost(priced.reduce((n, call) => n + call.cost.estimated_usd, 0));
  const complete = priced.length === calls.length;
  return {
    requests: calls.length,
    input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"),
    usage_complete: reported.length === calls.length,
    estimated_cost_usd: complete ? knownCost : null,
    cost_complete: complete,
    ...(!complete ? { known_estimated_cost_usd: knownCost } : {}),
    request_time_seconds_sum: calls.reduce((n, call) => n + (call.duration_ms ?? 0), 0) / 1000,
  };
}

function breakdown(calls: Data[], dimension: "phase" | "stage"): Data {
  const groups = new Map<string, Data[]>();
  for (const call of calls) {
    const key = String(call[dimension] ?? "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(call);
  }
  return Object.fromEntries([...groups].map(([key, group]) => [key, metrics(group)]));
}

/** One accounting block per invocation. Each physical request occurs once per
 * breakdown; phase and stage views are alternative partitions, not extra costs. */
export function summarizeCalls(calls: Data[]): Data {
  const result = metrics(calls);
  const reported = calls.filter(call => call.usage_status === "complete");
  const priced = calls.filter(call => numeric(call.cost?.estimated_usd));
  const sum = (key: keyof Usage) => reported.reduce((n, call) => n + (Number(call.usage?.[key]) || 0), 0);
  const assumptions = [...new Set(calls.flatMap(call => call.cost?.assumptions ?? []))];
  return {
    requests: result.requests,
    completed_requests: calls.filter(call => call.status === "completed").length,
    failed_requests: calls.filter(call => ["failed", "interrupted", "cancelled"].includes(call.status)).length,
    input_tokens: result.input_tokens, output_tokens: result.output_tokens,
    // Subsets of the reported input/output counts, never added a second time.
    reported_reasoning_tokens: sum("reasoning_tokens"),
    reported_cache_read_tokens: sum("cache_read_input_tokens"),
    usage_complete: result.usage_complete,
    usage_complete_requests: reported.length,
    usage_incomplete_requests: calls.length - reported.length,
    estimated_cost_usd: result.estimated_cost_usd,
    cost_complete: result.cost_complete,
    priced_requests: priced.length,
    unpriced_requests: calls.length - priced.length,
    ...(!result.cost_complete ? { known_estimated_cost_usd: result.known_estimated_cost_usd } : {}),
    request_time_seconds_sum: result.request_time_seconds_sum,
    models: [...new Set(calls.map(call => call.model ?? call.requested_model).filter(Boolean))],
    ...(assumptions.length ? { pricing_assumptions: assumptions } : {}),
    by_phase: breakdown(calls, "phase"),
    by_stage: breakdown(calls, "stage"),
  };
}

function legacyBreakdown(groups: Data | undefined): Data | null {
  if (!groups) return null;
  return Object.fromEntries(Object.entries(groups).map(([name, value]) => {
    const group = value as Data;
    const complete = numeric(group.estimated_usd);
    return [name, {
      requests: group.calls,
      input_tokens: group.input_tokens, output_tokens: group.output_tokens,
      usage_complete: group.usage_complete,
      estimated_cost_usd: complete ? group.estimated_usd : null,
      cost_complete: complete,
      ...(!complete && numeric(group.known_estimated_usd) ? { known_estimated_cost_usd: group.known_estimated_usd } : {}),
      // Versions 1/2 did not save per-stage request times in these aggregates.
      request_time_seconds_sum: null,
    }];
  }));
}

function legacyAccounting(usage: Data): Data {
  const requests = usage.calls ?? null;
  const cost = usage.cost ?? {};
  const complete = numeric(cost.estimated_usd);
  return {
    requests,
    completed_requests: usage.completed_calls ?? null,
    failed_requests: usage.failed_calls ?? null,
    input_tokens: usage.tokens?.reported_input_tokens ?? null,
    output_tokens: usage.tokens?.reported_output_tokens ?? null,
    reported_reasoning_tokens: usage.tokens?.reported_reasoning_tokens ?? null,
    reported_cache_read_tokens: usage.tokens?.reported_cache_read_tokens ?? null,
    usage_complete: usage.tokens?.complete ?? false,
    usage_complete_requests: usage.usage_complete_calls ?? null,
    usage_incomplete_requests: usage.usage_incomplete_calls ?? null,
    estimated_cost_usd: complete ? cost.estimated_usd : null,
    cost_complete: complete,
    priced_requests: cost.priced_calls ?? null,
    unpriced_requests: cost.unpriced_calls ?? null,
    ...(!complete && numeric(cost.known_estimated_usd) ? { known_estimated_cost_usd: cost.known_estimated_usd } : {}),
    ...(cost.billed_usd != null ? { billed_usd: cost.billed_usd } : {}),
    request_time_seconds_sum: numeric(usage.api_request_duration_ms_sum) ? usage.api_request_duration_ms_sum / 1000 : null,
    models: Object.keys(usage.by_model ?? {}),
    by_phase: requests === 0 ? {} : null,
    by_stage: legacyBreakdown(usage.by_stage),
    // Without the full journal these legacy aggregates cannot be reproduced.
    ...(usage.by_model ? { by_model: legacyBreakdown(usage.by_model) } : {}),
  };
}

/** Prefer the journal when it covers the saved record. Never turn historical
 * costs into zero because a journal was deleted or truncated. */
export function recoverAccounting(attempt: Data, calls: Data[]): Data {
  const saved = attempt.api ?? (attempt.usage ? legacyAccounting(attempt.usage) : null);
  const requests = saved?.requests;
  const reported = calls.filter(call => call.usage_status === "complete").length;
  const priced = calls.filter(call => numeric(call.cost?.estimated_usd)).length;
  const completed = calls.filter(call => call.status === "completed").length;
  // A torn final event can leave the same number of call IDs but lose usage.
  const coversSaved = !saved || (
    (!numeric(requests) || calls.length >= requests)
    && reported >= (saved.usage_complete_requests ?? (saved.usage_complete ? requests : 0) ?? 0)
    && priced >= (saved.priced_requests ?? (saved.cost_complete ? requests : 0) ?? 0)
    && completed >= (saved.completed_requests ?? 0)
  );
  if ((calls.length > 0 || requests === 0) && coversSaved) return summarizeCalls(calls);
  if (saved) return {
    ...saved, ledger_complete: false, ledger_requests: calls.length,
  };
  return {
    requests: null, completed_requests: null, failed_requests: null,
    input_tokens: null, output_tokens: null, reported_reasoning_tokens: null, reported_cache_read_tokens: null,
    usage_complete: false, usage_complete_requests: null, usage_incomplete_requests: null,
    estimated_cost_usd: null, cost_complete: false, priced_requests: null, unpriced_requests: null,
    request_time_seconds_sum: null, models: [],
    by_phase: null, by_stage: null, ledger_complete: false, ledger_requests: calls.length,
    accounting_unavailable_reason: "No saved accounting or recoverable API journal for this invocation.",
  };
}
