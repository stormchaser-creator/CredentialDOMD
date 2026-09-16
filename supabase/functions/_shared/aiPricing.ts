/**
 * List prices for the models the shared keys may run, in USD per million
 * tokens, and the arithmetic that turns a vendor's usage block into the
 * ai_usage.cost_usd figure the monthly budget is measured against.
 *
 * Existing prices were fetched 2026-09-02 (see
 * docs/SCALE-AND-COST-PLAN-2026-09-02.md, section 4). Gemini 3.8 Flash's
 * Standard prices and scheduled increase were verified 2026-09-15 at
 * https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash .
 * Both tables are mirrored in aiPricing.json; scripts/ai-pricing.test.mjs
 * fails if they drift. Change both. Call priceFor rather than reading the
 * base table directly so announced price changes take effect by date.
 *
 * This meters generation tokens, not explicit-cache storage or tool fees.
 * The app uses Standard generateContent with text/image/PDF input and no
 * grounding tools; those inputs share Gemini 3.8 Flash's listed input rate.
 *
 * An unknown model yields a null cost. A row with tokens and no dollars is
 * honest; a guessed price is not.
 *
 * Column meanings (both vendors, so one sum works across providers):
 *   input      uncached prompt tokens (Anthropic input_tokens; Gemini
 *              promptTokenCount minus cachedContentTokenCount)
 *   cacheRead  prompt tokens served from cache
 *   cacheWrite prompt tokens written to cache (Anthropic only)
 *   output     completion tokens (Anthropic output_tokens, which already
 *              include thinking; Gemini candidatesTokenCount)
 *   thinking   Gemini thoughtsTokenCount, billed at the output price
 */

export interface ModelPrice {
  input: number;        // $/M uncached input tokens
  output: number;       // $/M output tokens (Gemini: thinking tokens too)
  cacheWrite?: number;  // $/M tokens written to the prompt cache (5-minute TTL)
  cacheRead?: number;   // $/M tokens served from cache
}

export const AI_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5":    { input: 5,    output: 25,   cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5":  { input: 2,    output: 10,   cacheWrite: 2.5,  cacheRead: 0.2 },
  "gemini-2.5-flash": { input: 0.3,  output: 2.5,  cacheRead: 0.03 },
  "gemini-2.5-pro":   { input: 1.25, output: 10 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
};

// Ordered oldest first. Use UTC boundaries consistently with ai_usage's
// daily/monthly accounting. Google lists the change by calendar date.
export const AI_PRICE_CHANGES: Record<string, { effectiveAt: string; price: ModelPrice }[]> = {
  "gemini-3.8-flash": [
    { effectiveAt: "2027-01-01T00:00:00.000Z", price: { input: 1.5, output: 7.5, cacheRead: 0.15 } },
  ],
};

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  thinking: number | null;
}

/** The ai_usage columns one metered call writes. */
export interface MeteredColumns {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  thinking_tokens: number | null;
  cost_usd: number | null;
}

// A vendor may answer with a dated or preview variant of a listed model
// ("claude-opus-5-20260601", "gemini-2.5-flash-preview-05-20", a Vertex
// "@20260601"). Those share the list price. Anything else after the name
// (-lite, -8b, -image) is a different product at a different price: unknown.
const VARIANT_SUFFIX = /^(-\d{8}|-\d{3}|-preview(-\d{2}-\d{2})?|@\d{8})$/;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Strip the Gemini "models/" prefix and whitespace. */
export function normalizeModel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const m = model.trim().replace(/^models\//, "");
  return m || null;
}

/** The model's price on the request date (default: now), or null if unknown. */
export function priceFor(model: unknown, at: Date = new Date()): { key: string; price: ModelPrice } | null {
  const m = normalizeModel(model);
  const timestamp = at.getTime();
  if (!m || !Number.isFinite(timestamp)) return null;
  for (const key of Object.keys(AI_PRICES)) {
    if (m === key || (m.startsWith(key) && VARIANT_SUFFIX.test(m.slice(key.length)))) {
      let price = AI_PRICES[key];
      for (const change of AI_PRICE_CHANGES[key] || []) {
        if (timestamp >= Date.parse(change.effectiveAt)) price = change.price;
      }
      return { key, price };
    }
  }
  return null;
}

/** Round to the numeric(12,6) column. */
export const roundUsd = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Dollars for one call, or null when the model is not priced or the usage
 * carries no token counts at all (a failed call). A cached token on a model
 * whose cache price is not listed bills at the input price, an upper bound,
 * never a discount that was not fetched.
 */
export function costUsd(model: unknown, usage: TokenUsage, at: Date = new Date()): number | null {
  const hit = priceFor(model, at);
  if (!hit) return null;
  const { price } = hit;
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.thinking];
  if (parts.every((p) => p == null)) return null;
  const perM = (tokens: number | null, rate: number) => ((tokens || 0) * rate) / 1_000_000;
  const total =
    perM(usage.input, price.input) +
    perM(usage.cacheRead, price.cacheRead ?? price.input) +
    perM(usage.cacheWrite, price.cacheWrite ?? price.input) +
    perM(usage.output, price.output) +
    perM(usage.thinking, price.output);
  return roundUsd(total);
}

/** Anthropic Messages response -> { model, usage } or null when it carries no usage block. */
export function anthropicUsage(body: unknown): { model: string | null; usage: TokenUsage } | null {
  const o = body as Record<string, unknown> | null;
  const u = o && typeof o === "object" ? (o.usage as Record<string, unknown> | undefined) : undefined;
  if (!u || typeof u !== "object") return null;
  return {
    model: normalizeModel(o!.model),
    usage: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      thinking: null, // folded into output_tokens by the API
    },
  };
}

/** Gemini generateContent response -> { model, usage } or null when it carries no usageMetadata. */
export function geminiUsage(body: unknown): { model: string | null; usage: TokenUsage } | null {
  const o = body as Record<string, unknown> | null;
  const u = o && typeof o === "object" ? (o.usageMetadata as Record<string, unknown> | undefined) : undefined;
  if (!u || typeof u !== "object") return null;
  const prompt = num(u.promptTokenCount);
  const cached = num(u.cachedContentTokenCount);
  return {
    model: normalizeModel(o!.modelVersion),
    usage: {
      // promptTokenCount includes the cached tokens; store the uncached remainder.
      input: prompt == null ? null : Math.max(0, prompt - (cached || 0)),
      output: num(u.candidatesTokenCount),
      cacheRead: cached,
      cacheWrite: null,
      thinking: num(u.thoughtsTokenCount),
    },
  };
}

const EMPTY_USAGE: TokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null, thinking: null };

/**
 * The ai_usage columns for one call. `body` is the parsed upstream JSON (or
 * null when it was not JSON / the call failed); `requestModel` is what the
 * client asked for and is recorded when the vendor names no model. Cost is
 * priced on the model that answered, at the request date when supplied.
 */
export function meterUsage(provider: "gemini" | "anthropic", requestModel: unknown, body: unknown, at: Date = new Date()): MeteredColumns {
  const parsed = provider === "anthropic" ? anthropicUsage(body) : geminiUsage(body);
  const model = parsed?.model || normalizeModel(requestModel);
  const usage = parsed?.usage || EMPTY_USAGE;
  return {
    model,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
    thinking_tokens: usage.thinking,
    cost_usd: parsed ? costUsd(model, usage, at) : null,
  };
}
