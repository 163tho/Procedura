import { readFileSync } from "node:fs";
import type { Usage } from "./usage.ts";

export interface Rates {
  input: number; output: number; cache_read: number; cache_write_5m: number; cache_write_1h: number;
}
export interface Pricing {
  currency: "USD"; basis: string; source: string; as_of: string; models: Record<string, Rates>;
}
export function loadPricing(path = process.env.PROCEDURA_PRICING_FILE): Pricing {
  // Snapshot of public list prices, never a claim about an organization's contract.
  const pricing: Pricing = {
    currency: "USD", basis: "published_list_price_estimate",
    source: "https://platform.claude.com/docs/en/about-claude/pricing", as_of: "2026-11-06",
    models: { "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.10, cache_write_5m: 2.5, cache_write_1h: 4 } },
  };
  if (!path) return pricing;
  const supplied = JSON.parse(readFileSync(path, "utf8")) as Pricing;
  if (supplied.currency !== "USD" || !supplied.as_of || !supplied.source || !supplied.models)
    throw new Error("Pricing file requires currency USD, as_of, source, and models.");
  for (const rates of Object.values(supplied.models)) for (const key of ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"] as const)
    if (!Number.isFinite(rates[key]) || rates[key] < 0) throw new Error("Pricing rates must be nonnegative USD per million tokens: " + key);
  return { ...supplied, basis: supplied.basis || "configured_rate_estimate" };
}
export function estimateCost(
  pricing: Pricing, model: string | null, endpoint: string | null, usage: Usage | null,
  complete: boolean, raw: Record<string, any>, parameters: Record<string, unknown>,
) {
  const unknown = (reason: string) => ({ estimated_usd: null, basis: pricing.basis, assumptions: [] as string[], unavailable_reason: reason });
  if (!complete || !usage || usage.uncached_input_tokens === null || usage.output_tokens === null) return unknown("Usage is missing or incomplete.");
  // Public Anthropic rates apply only to Anthropic's direct endpoint. Explicit
  // user pricing can also describe a gateway or another provider.
  if (pricing.basis === "published_list_price_estimate" && endpoint && new URL(endpoint).hostname !== "api.anthropic.com")
    return unknown("No pricing configured for this endpoint.");
  const rates = model ? pricing.models[model] : undefined;
  if (!rates) return unknown("No pricing configured for this model.");
  if (parameters.speed === "fast" || parameters.service_tier === "priority" || parameters.inference_geo === "us")
    return unknown("This pricing snapshot does not cover the requested pricing modifiers.");
  if (Object.values(raw.server_tool_use ?? {}).some(value => typeof value === "number" && value > 0))
    return unknown("Additional server-tool charges require separate pricing.");
  const assumptions: string[] = [];
  if (usage.format !== "anthropic" && usage.cache_read_input_tokens === null)
    assumptions.push("Cache breakdown unavailable; input is estimated at the base rate.");
  let write5 = usage.cache_write_5m_tokens ?? 0;
  const write1 = usage.cache_write_1h_tokens ?? 0;
  if ((usage.cache_creation_input_tokens ?? 0) > write5 + write1) {
    const configured = JSON.stringify(parameters.cache_control ?? {});
    if (configured.includes("1h")) return unknown("Cache write duration breakdown is unavailable.");
    write5 += usage.cache_creation_input_tokens! - write5 - write1;
    assumptions.push("Cache writes without a duration breakdown use the default five-minute rate.");
  }
  const cost = (usage.uncached_input_tokens * rates.input + usage.output_tokens * rates.output
    + (usage.cache_read_input_tokens ?? 0) * rates.cache_read
    + write5 * rates.cache_write_5m + write1 * rates.cache_write_1h) / 1e6;
  return { estimated_usd: cost, basis: pricing.basis, assumptions, unavailable_reason: null };
}
