// Unit-style checks for the AI price table and the cost arithmetic behind
// ai_usage.cost_usd (supabase/functions/_shared/aiPricing.ts). Node 22.18+
// imports the .ts file directly (type stripping); the JSON mirror is what a
// plainer consumer can load, and the two must agree.
// Run: node scripts/ai-pricing.test.mjs   (pure node, no test runner)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AI_PRICES, AI_PRICE_CHANGES, priceFor, normalizeModel, costUsd, roundUsd, anthropicUsage, geminiUsage, meterUsage,
} from "../supabase/functions/_shared/aiPricing.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const mirror = JSON.parse(readFileSync(path.join(here, "../supabase/functions/_shared/aiPricing.json"), "utf8"));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const close = (name, got, want) => ok(name, typeof got === "number" && Math.abs(got - want) < 1e-9, `got ${got} want ${want}`);

// ── The table and its JSON mirror agree, and carry the plan's list prices ────
eq("mirror matches the TS table", mirror.prices, AI_PRICES);
eq("mirror matches the dated price changes", mirror.priceChanges, AI_PRICE_CHANGES);
eq("Opus 5 list price", AI_PRICES["claude-opus-5"], { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
eq("Sonnet 5 list price", AI_PRICES["claude-sonnet-5"], { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
eq("Gemini 2.5 Flash list price", AI_PRICES["gemini-2.5-flash"], { input: 0.3, output: 2.5, cacheRead: 0.03 });
eq("Gemini 2.5 Pro list price", AI_PRICES["gemini-2.5-pro"], { input: 1.25, output: 10 });
eq("Gemini 3.8 Flash introductory price", AI_PRICES["gemini-3.8-flash"], { input: 0.75, output: 3.75, cacheRead: 0.075 });
ok("every price is a positive finite number", Object.values(AI_PRICES).every(p => Object.values(p).every(v => Number.isFinite(v) && v > 0)));
ok("dated changes have valid dates and positive prices", Object.values(AI_PRICE_CHANGES).every(changes => changes.every(c =>
  Number.isFinite(Date.parse(c.effectiveAt)) && Object.values(c.price).every(v => Number.isFinite(v) && v > 0))));

// ── Model matching: exact, dated/preview variants, never a different product ─
eq("exact opus", priceFor("claude-opus-5")?.key, "claude-opus-5");
eq("dated opus snapshot", priceFor("claude-opus-5-20260601")?.key, "claude-opus-5");
eq("gemini with models/ prefix", priceFor("models/gemini-2.5-flash")?.key, "gemini-2.5-flash");
eq("gemini preview variant", priceFor("gemini-2.5-flash-preview-05-20")?.key, "gemini-2.5-flash");
eq("gemini -001 variant", priceFor("gemini-2.5-pro-001")?.key, "gemini-2.5-pro");
eq("vertex @date variant", priceFor("claude-sonnet-5@20260601")?.key, "claude-sonnet-5");
eq("flash-lite is not flash", priceFor("gemini-2.5-flash-lite"), null);
eq("retired 2.0 flash is unknown", priceFor("gemini-2.0-flash"), null);
eq("opus 4.6 is unknown", priceFor("claude-opus-4-6"), null);
eq("fable is unknown", priceFor("claude-fable-5-1"), null);
eq("empty model", priceFor(""), null);
eq("non-string model", priceFor(42), null);
eq("normalizeModel strips prefix and space", normalizeModel("  models/gemini-2.5-flash "), "gemini-2.5-flash");

// ── Announced 3.8 price change: request-time UTC boundary, including cache ──
const promoDate = new Date("2026-12-31T23:59:59.999Z");
const fullPriceDate = new Date("2027-01-01T00:00:00.000Z");
const promoPrice = { input: 0.75, output: 3.75, cacheRead: 0.075 };
const fullPrice = { input: 1.5, output: 7.5, cacheRead: 0.15 };
eq("3.8 introductory price through last millisecond of December", priceFor("gemini-3.8-flash", promoDate)?.price, promoPrice);
eq("3.8 January increase starts at midnight UTC", priceFor("gemini-3.8-flash", fullPriceDate)?.price, fullPrice);
eq("3.8 January price remains in effect", priceFor("gemini-3.8-flash", new Date("2028-03-01T12:00:00Z"))?.price, fullPrice);
eq("3.8 default date uses current price", priceFor("gemini-3.8-flash")?.price, new Date() < fullPriceDate ? promoPrice : fullPrice);
eq("3.8 dated response model keeps request date's price", priceFor("models/gemini-3.8-flash-20260902", fullPriceDate), { key: "gemini-3.8-flash", price: fullPrice });
eq("3.8 numbered version is metered", priceFor("gemini-3.8-flash-001", promoDate), { key: "gemini-3.8-flash", price: promoPrice });
eq("3.8 preview version is metered", priceFor("gemini-3.8-flash-preview-09-02", promoDate)?.price, promoPrice);
eq("3.8 Vertex version is metered", priceFor("gemini-3.8-flash@20260902", fullPriceDate)?.price, fullPrice);
eq("3.8 image product is not standard Flash", priceFor("gemini-3.8-flash-image", promoDate), null);
eq("3.8 lite product is not standard Flash", priceFor("gemini-3.8-flash-lite", promoDate), null);
eq("invalid request date cannot silently use a guessed price", priceFor("gemini-3.8-flash", new Date("invalid")), null);
eq("older Flash price does not change in January", priceFor("gemini-2.5-flash", fullPriceDate)?.price, AI_PRICES["gemini-2.5-flash"]);

// ── Arithmetic ───────────────────────────────────────────────────────────────
const U = (o) => ({ input: null, output: null, cacheRead: null, cacheWrite: null, thinking: null, ...o });
close("a million uncached Opus input tokens is $5", costUsd("claude-opus-5", U({ input: 1_000_000 })), 5);
close("a million Opus output tokens is $25", costUsd("claude-opus-5", U({ output: 1_000_000 })), 25);
close("Opus cache write 6.25, read 0.50", costUsd("claude-opus-5", U({ cacheWrite: 1_000_000, cacheRead: 1_000_000 })), 6.75);
close("Sonnet 5 full line", costUsd("claude-sonnet-5", U({ input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 })), 14.7);
// A typical Vera turn per the plan: static rulebook read from cache, the
// snapshot uncached, a modest reply. 14769*5 + 9637*0.5 + 1200*25 per million.
close("Vera turn, snapshot uncached", costUsd("claude-opus-5", U({ input: 14769, cacheRead: 9637, output: 1200 })), roundUsd(0.073845 + 0.0048185 + 0.03));
// After the snapshot breakpoint: the same turn reads everything from cache.
close("Vera turn, snapshot cached", costUsd("claude-opus-5", U({ input: 40, cacheRead: 24406, output: 1200 })), roundUsd(0.0002 + 0.012203 + 0.03));
close("Gemini flash scan: text + image prompt, short reply", costUsd("gemini-2.5-flash", U({ input: 8592, output: 400 })), roundUsd(0.0025776 + 0.001));
close("Gemini thinking bills at the output price", costUsd("gemini-2.5-flash", U({ input: 1000, output: 100, thinking: 900 })), roundUsd(0.0003 + 0.00025 + 0.00225));
close("Gemini cached input at 0.03", costUsd("gemini-2.5-flash", U({ input: 2000, cacheRead: 8000, output: 0 })), roundUsd(0.0006 + 0.00024));
close("Gemini Pro cached tokens bill at the input price (no cache price listed)", costUsd("gemini-2.5-pro", U({ input: 0, cacheRead: 1_000_000 })), 1.25);
close("3.8 introductory uncached input, cache read, output and thinking", costUsd("gemini-3.8-flash", U({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000, thinking: 1_000_000 }), promoDate), 8.325);
close("3.8 January doubles all generation rates", costUsd("gemini-3.8-flash", U({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000, thinking: 1_000_000 }), fullPriceDate), 16.65);
close("3.8 has no listed long-context price tier", costUsd("gemini-3.8-flash", U({ input: 300_000, output: 100 }), promoDate), 0.225375);
eq("unknown model gives null, never a guess", costUsd("gemini-2.0-flash", U({ input: 5000, output: 500 })), null);
eq("no token counts at all gives null", costUsd("claude-opus-5", U({})), null);
close("zero tokens is zero dollars, not null", costUsd("claude-opus-5", U({ input: 0, output: 0 })), 0);
eq("rounds to the numeric(12,6) column", costUsd("claude-opus-5", U({ input: 1 })), 0.000005);
eq("roundUsd", roundUsd(0.1234567891), 0.123457);

// ── Parsing the vendors' usage blocks ────────────────────────────────────────
const anthropicBody = {
  id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5",
  content: [{ type: "text", text: "{}" }], stop_reason: "end_turn",
  usage: { input_tokens: 812, output_tokens: 1543, cache_creation_input_tokens: 24406, cache_read_input_tokens: 0 },
};
eq("anthropic usage", anthropicUsage(anthropicBody), {
  model: "claude-opus-5",
  usage: { input: 812, output: 1543, cacheRead: 0, cacheWrite: 24406, thinking: null },
});
eq("anthropic error body has no usage", anthropicUsage({ type: "error", error: { type: "overloaded_error" } }), null);
eq("anthropic non-object", anthropicUsage("nope"), null);

const geminiBody = {
  candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10000, candidatesTokenCount: 420, thoughtsTokenCount: 310, cachedContentTokenCount: 8000, totalTokenCount: 10730 },
  modelVersion: "gemini-2.5-flash",
};
eq("gemini usage stores the uncached remainder", geminiUsage(geminiBody), {
  model: "gemini-2.5-flash",
  usage: { input: 2000, output: 420, cacheRead: 8000, cacheWrite: null, thinking: 310 },
});
eq("gemini usage without cache fields", geminiUsage({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 }, modelVersion: "gemini-2.5-pro" }), {
  model: "gemini-2.5-pro",
  usage: { input: 50, output: 5, cacheRead: null, cacheWrite: null, thinking: null },
});
eq("gemini countTokens reply has no usageMetadata", geminiUsage({ totalTokens: 1234 }), null);

// ── meterUsage: the row the proxy writes ─────────────────────────────────────
eq("metered anthropic row", meterUsage("anthropic", "claude-opus-5", anthropicBody), {
  model: "claude-opus-5", input_tokens: 812, output_tokens: 1543, cache_read_tokens: 0, cache_write_tokens: 24406, thinking_tokens: null,
  cost_usd: roundUsd(812 * 5e-6 + 24406 * 6.25e-6 + 1543 * 25e-6),
});
eq("metered gemini row", meterUsage("gemini", "gemini-2.5-flash", geminiBody), {
  model: "gemini-2.5-flash", input_tokens: 2000, output_tokens: 420, cache_read_tokens: 8000, cache_write_tokens: null, thinking_tokens: 310,
  cost_usd: roundUsd(2000 * 0.3e-6 + 8000 * 0.03e-6 + (420 + 310) * 2.5e-6),
});
eq("failed call keeps the requested model and no dollars", meterUsage("anthropic", "claude-opus-5", { type: "error", error: { type: "rate_limit_error" } }), {
  model: "claude-opus-5", input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, thinking_tokens: null, cost_usd: null,
});
eq("non-JSON upstream", meterUsage("gemini", "models/gemini-2.5-flash", null).model, "gemini-2.5-flash");
eq("response model wins over the request model for pricing", meterUsage("anthropic", "claude-sonnet-5", { ...anthropicBody, model: "claude-opus-5" }).cost_usd,
  roundUsd(812 * 5e-6 + 24406 * 6.25e-6 + 1543 * 25e-6));
eq("unknown responding model: tokens kept, cost null", meterUsage("gemini", "gemini-2.5-flash", { ...geminiBody, modelVersion: "gemini-2.5-flash-lite" }), {
  model: "gemini-2.5-flash-lite", input_tokens: 2000, output_tokens: 420, cache_read_tokens: 8000, cache_write_tokens: null, thinking_tokens: 310, cost_usd: null,
});
const gemini38Body = { ...geminiBody, modelVersion: "gemini-3.8-flash-001" };
eq("3.8 metering subtracts cache from prompt and bills separate thinking once", meterUsage("gemini", "gemini-3.8-flash", gemini38Body, promoDate), {
  model: "gemini-3.8-flash-001", input_tokens: 2000, output_tokens: 420, cache_read_tokens: 8000, cache_write_tokens: null, thinking_tokens: 310,
  cost_usd: roundUsd(2000 * 0.75e-6 + 8000 * 0.075e-6 + (420 + 310) * 3.75e-6),
});
eq("3.8 metering forwards January request date", meterUsage("gemini", "gemini-3.8-flash", gemini38Body, fullPriceDate).cost_usd,
  roundUsd(2000 * 1.5e-6 + 8000 * 0.15e-6 + (420 + 310) * 7.5e-6));
eq("3.8 responding model controls price over old requested model", meterUsage("gemini", "gemini-2.5-flash", gemini38Body, promoDate).cost_usd,
  meterUsage("gemini", "gemini-3.8-flash", gemini38Body, promoDate).cost_usd);
eq("3.8 request model supplies price if response omits version", meterUsage("gemini", "models/gemini-3.8-flash", { ...gemini38Body, modelVersion: undefined }, fullPriceDate).cost_usd,
  meterUsage("gemini", "gemini-3.8-flash", gemini38Body, fullPriceDate).cost_usd);
eq("3.8 error with no usage does not invent a charge", meterUsage("gemini", "gemini-3.8-flash", { error: { code: 503 } }, promoDate).cost_usd, null);
const multimodal38 = {
  modelVersion: "gemini-3.8-flash",
  usageMetadata: {
    promptTokenCount: 10000, candidatesTokenCount: 100, thoughtsTokenCount: 100,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 5000 }, { modality: "IMAGE", tokenCount: 4000 }, { modality: "AUDIO", tokenCount: 1000 }],
  },
};
eq("3.8 modality details do not double count aggregate prompt tokens", meterUsage("gemini", "gemini-3.8-flash", multimodal38, promoDate).cost_usd, 0.00825);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
