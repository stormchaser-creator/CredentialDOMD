/**
 * The proxy's bounds, as pure functions.
 *
 * Everything here is about the same failure: this function runs on an edge
 * instance with a fixed heap and a wall-clock limit, in front of two paid
 * providers, for a user population that anyone on the internet can join
 * (Clerk sign-up is open). Three separate reviews found the same shape of
 * mistake in it, so the pieces live here where node can run them:
 *
 *   MEASURING A BODY IN CHARACTERS. requestByteLength used String.length,
 *   which counts UTF-16 code units. For the bodies this proxy actually
 *   carries -- a scan is mostly one big base64 blob -- that is one byte per
 *   character and the number was right. For a body full of non-ASCII text it
 *   under-counts by up to 3x, and for a body full of emoji or CJK the 20 MiB
 *   ceiling was really a 60 MiB ceiling. The fix is to count UTF-8 bytes.
 *
 *   READING A BODY WITHOUT A CEILING. The size check ran on Content-Length
 *   and then the whole body was read with req.text(). A chunked request sends
 *   no Content-Length, so the check was skipped and the read was unbounded:
 *   the way to kill the worker was to omit a header. readBodyBounded stops at
 *   the ceiling instead, whatever the headers say.
 *
 *   READING A RESPONSE WITHOUT A CEILING. Same again on the way back. The
 *   upstreams are trusted, but "trusted" is not "bounded", and a provider
 *   incident that returns a huge body should not take the proxy down with it.
 */

/**
 * Length of a string in UTF-8 bytes, without allocating a copy of it.
 *
 * TextEncoder would be shorter and allocates a second buffer as large as the
 * string, which for a 13 MiB scan body is 13 MiB of heap spent on measuring.
 * This walks the code points instead.
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;                       // lone high surrogate
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The size of the request body in bytes.
 *
 * Content-Length is the real byte count and is checked BEFORE the body is
 * read, so an oversized request is refused without being pulled into memory.
 * When it is missing or unusable the already-read text is measured properly,
 * in UTF-8 bytes rather than in characters.
 */
export function requestByteLength(contentLength: string | null, raw: string): number {
  const n = Number(contentLength);
  return Number.isFinite(n) && n > 0 ? n : utf8ByteLength(raw);
}

export interface BoundedRead {
  /** False when the source went past maxBytes; `text` is then not usable. */
  ok: boolean;
  text: string;
  /** Bytes read. When ok is false this is the point the read stopped at. */
  bytes: number;
  tooLarge: boolean;
  /** Set when the stream itself failed. */
  error: string | null;
}

/**
 * Read a body as text, stopping the moment it goes past `maxBytes`.
 *
 * Deliberately not `await req.text()` behind a Content-Length check: a chunked
 * request declares no length, so that check does not run and the read is
 * unbounded. This one holds whatever the headers say, and it cancels the
 * stream rather than draining it, so an oversized upload stops costing us at
 * the ceiling instead of at its own size.
 *
 * The decoder is streaming, so a multi-byte character split across two chunks
 * is decoded once, not twice or half.
 */
export async function readTextBounded(source: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> }, maxBytes: number): Promise<BoundedRead> {
  const stream = source.body;
  if (!stream) {
    // No stream to bound (an empty body, or a runtime that does not expose
    // one). text() on an absent body is cheap and cannot be large.
    try {
      const text = await source.text();
      const bytes = utf8ByteLength(text);
      if (bytes > maxBytes) return { ok: false, text: "", bytes, tooLarge: true, error: null };
      return { ok: true, text, bytes, tooLarge: false, error: null };
    } catch (e) {
      return { ok: false, text: "", bytes: 0, tooLarge: false, error: (e as Error).message };
    }
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* already closing */ }
        return { ok: false, text: "", bytes, tooLarge: true, error: null };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text, bytes, tooLarge: false, error: null };
  } catch (e) {
    try { await reader.cancel(); } catch { /* already closing */ }
    return { ok: false, text: "", bytes, tooLarge: false, error: (e as Error).message };
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// ─── The admission ledger's answer ───────────────────────────────────────────

export const AI_CODES = {
  /** The operator has not configured a shared key. Persistent; the client may switch shared AI off on it. */
  notConfigured: "shared_key_not_configured",
  /** This account is over its daily allowance for the provider. */
  quota: "quota",
  /** Too many calls in a few seconds. Transient by construction. */
  rateLimited: "ai_rate_limited",
  /**
   * The ledger could not answer, so nothing was sent. Transient; NEVER a
   * reason to switch shared AI off, and NEVER answered with 503. See the
   * status note on aiAdmissionVerdict.
   */
  accounting: "ai_accounting_unavailable",
  /** A pricing option the shared key's rate table cannot price. Persistent for this request. */
  unpricedOption: "option_not_allowed",
  /**
   * A content block whose size is not carried by the request body, so the
   * request-body bound cannot bound it. Persistent for this request.
   */
  unboundedSource: "source_not_allowed",
  /**
   * A request carrying media could not be measured before it was sent, so it
   * was not sent. Transient: the count is a network call like any other.
   */
  countUnavailable: "ai_token_count_unavailable",
  /**
   * The request carries input the token counter cannot see, so no count can
   * describe it. Persistent for this request.
   */
  uncountable: "request_not_countable",
} as const;

export interface AiAdmission {
  /** Forward the call upstream. False means answer with status/body and stop. */
  allow: boolean;
  status: number;
  code: string;
  /** Seconds, for the Retry-After header. Null when retrying will not help soon. */
  retryAfter: number | null;
  /** For the log only. */
  why: string;
}

export const AI_ALLOWED: AiAdmission = { allow: true, status: 200, code: "reserved", retryAfter: null, why: "reserved" };

/**
 * Read reserve_ai_call's answer, the same three-way shape reserve_send has.
 *
 * The third outcome is the one that was wrong before this existed. The daily
 * Anthropic cap was a SELECT count followed by a decision, which two calls
 * arriving together both pass, and an error from the count was invisible. Now
 * the count and the insert are one statement, "no row" is the only over-limit
 * answer, and a ledger that cannot answer refuses RETRYABLY rather than
 * waving the call through. Refusing here costs the provider nothing, because
 * admission is decided before the upstream fetch is made.
 *
 * `overCode` is the caller's word for being over this particular limit: the
 * daily provider cap answers "quota", which the client already understands as
 * a reason to route elsewhere, while the short burst window answers
 * "ai_rate_limited", which means "in a moment", not "today".
 *
 * EVERY REFUSAL HERE IS 429, INCLUDING THE ACCOUNTING ONE, and that is the
 * part to keep. The accounting branch answered 503 for one day, and 503 is
 * the one status the SHIPPED client reads as "the operator has configured no
 * shared key": src/utils/aiClient.js then calls setSharedAiStatus({ shared:
 * false }), which persists in localStorage, so a physician stayed switched
 * off until they cleared site storage. The new client reads the body code
 * before the status and is safe either way, but this app is a PWA with a
 * precache service worker, so an installed browser keeps running the previous
 * bundle after the functions are deployed. A response must be safe for the
 * client that is actually running, not for the one we just built. 429 with a
 * Retry-After is also the honest status for "try again in thirty seconds":
 * the old bundle reads a 429 whose code is neither "quota" nor "budget" and
 * changes nothing, which degrades to one failed call instead of a dead
 * feature.
 */
export function aiAdmissionVerdict(
  result: { data?: unknown; error?: unknown } | null | undefined,
  overCode: string,
  overRetryAfter: number | null,
): AiAdmission {
  if (!result) {
    return { allow: false, status: 429, code: AI_CODES.accounting, retryAfter: 30, why: "no result from reserve_ai_call" };
  }
  if (result.error) {
    const e = result.error as { message?: unknown };
    const why = typeof e?.message === "string" && e.message ? e.message : String(result.error);
    return { allow: false, status: 429, code: AI_CODES.accounting, retryAfter: 30, why };
  }
  const data = result.data;
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    return {
      allow: false,
      status: 429,
      code: overCode,
      retryAfter: overRetryAfter,
      why: overCode === AI_CODES.rateLimited ? "too many calls in the burst window" : "at or over the limit for the window",
    };
  }
  return AI_ALLOWED;
}

// ─── What one call could cost, before it is made ─────────────────────────────

/**
 * What one call could cost, before it is made.
 *
 * THE HISTORY OF THIS NUMBER, because four versions of it were wrong in four
 * different ways and each fix looked complete at the time:
 *
 *   1. a walk over system/messages/content/.text. A supported plain-text
 *      document.source.data of 900,000 characters walked to ZERO.
 *   2. request BODY BYTES at two bytes per token. An image with
 *      source.type=url made a 178-byte request that metered $0.006505.
 *   3. bytes, with url and file sources refused. A VALID 1000x1000 one-bit PNG
 *      deflates to 202 bytes: a 432-byte request reserved $0.001375 and
 *      metered $0.006505, taking a month from $14.998 to $15.004505.
 *   4. bytes for text, the provider's count for media. The counter was sent
 *      five named fields while the paid call kept thinking, output_config and
 *      cache_control; structured output adds billed instructions, so the two
 *      requests were priced differently. And "two bytes per token" was never
 *      established: it was an allowance written as though it were a bound.
 *
 * What survived: the only number not under the caller's control is one the
 * PROVIDER produces from the exact request that will be sent. So every
 * admitted request is counted, from one object that becomes both payloads,
 * and there is no local estimate of input tokens anywhere in this file.
 *
 * Counting is free and separately rate limited. The cost is a second upstream
 * round trip per call, which is the price of the number meaning anything.
 */

/**
 * Headroom on the provider's own count, and WHAT THIS CAP ACTUALLY IS.
 *
 * Say the limitation first, because three earlier versions of this comment
 * described a guarantee the code did not have.
 *
 * THIS IS NOT A MATHEMATICALLY HARD CAP. Anthropic documents count_tokens as
 * an estimate. The entire quantification of its accuracy in the documentation
 * is the phrase "a small amount": no percentage, no absolute bound, no worst
 * case, in either direction. Ten percent is an operational allowance chosen
 * here and nothing published substantiates it. A month can therefore end
 * fractionally over its cap if the provider's count of a request and the
 * provider's metering of that same request disagree by more than the margin.
 * Settlement records the real figure when that happens; recording it is not
 * the same as preventing it, and this comment is not to be edited to imply
 * otherwise.
 *
 * WHAT IT IS, precisely: every admitted request is priced from the provider's
 * count of THAT request, built from the same object that will be sent, with
 * ten percent added, plus the full max_tokens output allowance at the output
 * rate, with input priced at the higher of the input and cache-write rates.
 * Requests the counter cannot describe are refused rather than estimated.
 *
 * WHY NOT A HARD BOUND. One exists and it is the context window: the provider
 * enforces 1,000,000 input tokens on this model class with a 400, which is a
 * documented, deterministic ceiling. Reserving it would make the cap
 * arithmetically airtight. It also costs $5.00 per in-flight request at base
 * input, $6.25 at the five-minute cache-write rate. Against a $15 monthly
 * allowance that is two concurrent requests before everything else is refused,
 * so the airtight cap would take the feature away to protect it. No local
 * bound is available as a middle option: a byte bound is not one, because
 * image cost is a function of pixels and a fifty-byte tool declaration can
 * inject thousands of input tokens with nothing in the body proportional to
 * them.
 *
 * So the residual exposure is stated rather than designed away, and it is
 * bounded in practice by the body ceiling, by the refusals above, and by the
 * fact that the remaining gap is provider-side drift on a request the caller
 * no longer has any way to misdescribe.
 */
export const TOKEN_COUNT_MARGIN = 1.1;

/**
 * The reserved input-token figure from a provider count.
 *
 * STRICT about the shape. The previous version used Number(), and Number(null),
 * Number(false), Number("") and Number([]) are every one of them 0: a
 * malformed counter reply reserved nothing and the paid request went out
 * regardless. A count is a non-negative safe integer or it is not a count.
 */
export function countedInputTokens(counted: unknown): number | null {
  if (typeof counted !== "number") return null;
  if (!Number.isSafeInteger(counted) || counted < 0) return null;
  const withMargin = Math.ceil(counted * TOKEN_COUNT_MARGIN);
  // The margin can carry a maximum safe integer past the safe range, and a
  // number that is no longer exactly representable is not a token count. It
  // refused anyway, because such a count reserves more than any budget holds,
  // but "refuses for the right reason" and "refuses because the arithmetic
  // overflowed into something unenforceable" are not the same guarantee.
  return Number.isSafeInteger(withMargin) ? withMargin : null;
}

/**
 * The fields count_tokens accepts, and nothing else.
 *
 * ALLOWLIST, and the previous two attempts got the direction wrong in opposite
 * ways. First it named five fields to COPY, so thinking and output_config
 * reached the paid call and never the counter. Then it named fields to STRIP
 * and forwarded the rest, on the reasoning that a field added later should be
 * counted rather than dropped. That reasoning is sound and the implementation
 * was still wrong: the endpoint documents EXACTLY these eight body parameters,
 * so forwarding anything else is a 400, and a 400 refuses the request.
 *
 * The real protection against a field added later is not the shape of this
 * list. It is uncountableOption() below, which refuses a request this endpoint
 * cannot describe rather than counting a subset of it.
 *
 * max_tokens is absent because the endpoint does not take it, and because
 * output is reserved separately at its full allowance. Thinking generated in
 * the current turn bills as OUTPUT and is inside that allowance; thinking
 * already in `messages` bills as input and is counted here.
 */
export const COUNT_ACCEPTED_FIELDS = [
  "model", "messages", "system", "tools", "tool_choice",
  "thinking", "output_config", "cache_control",
];

export function countPayload(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of COUNT_ACCEPTED_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  if (out.model === undefined || out.messages === undefined) return null;
  return out;
}

/**
 * Request shapes the counter cannot describe, which therefore cannot be
 * admitted against a count.
 *
 * Each of these bills input tokens that count_tokens will not see, either
 * because the endpoint rejects the shape outright or because the tokens are
 * injected server-side with nothing in the body proportional to them:
 *
 *   mcp_servers        rejected by the counter; the connector's definitions
 *                      bill as input, and Anthropic's guidance is to read the
 *                      cost off the RESPONSE, which is useless before the call
 *   server tools       every one except the advisor tool is rejected by the
 *                      counter. A declaration of ~50 bytes can add thousands
 *                      of input tokens: the computer toolset is documented at
 *                      about 4,520 on this model class
 *   container          not an accepted count parameter
 *
 * The app declares no tools at all through this proxy, so nothing legitimate
 * is refused. A physician's own key never comes through here.
 *
 * Returns the offending shape, or null.
 */
export function uncountableOption(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (o.mcp_servers !== undefined) return "mcp_servers";
  if (o.container !== undefined) return "container";
  const tools = o.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!t || typeof t !== "object") continue;
      const type = (t as Record<string, unknown>).type;
      // A custom tool is the shape the counter prices: a name and a schema,
      // with no type or type "custom". Anything else is a server tool.
      if (type !== undefined && type !== "custom") return `tools[].type=${String(type)}`;
    }
  }
  return null;
}

export interface ModelPriceLine {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/**
 * The reservation, in dollars, from the provider's count of this exact
 * request:
 *
 *   input   the counted tokens plus margin, priced at the higher of the input
 *           and cache-write rates, because a cache write costs more than a
 *           plain input token and the count does not say which it will be
 *   output  max_tokens in full, the ceiling the request itself sets
 *
 * Generated thinking bills as output and is drawn from that same allowance.
 *
 * Takes the price line rather than the model name: the caller resolves it
 * through priceFor(model, requestDate), which honours the dated rate step. A
 * price line with a missing, NaN or non-positive rate is NOT priced as zero;
 * it returns null and the caller refuses rather than spending uncapped.
 */
export function anthropicWorstCaseFromTokens(price: ModelPriceLine | null | undefined, inTokens: number | null, maxTokens: number): number | null {
  if (!price) return null;
  const out = Number(maxTokens);
  if (inTokens === null || !Number.isFinite(inTokens) || inTokens < 0 || !Number.isFinite(out) || out < 0) return null;

  const usable = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const inBase = usable(price.input);
  const outRate = usable(price.output);
  // A malformed rate must not silently become zero: that is a price list bug
  // presenting as a free model.
  if (inBase === null || outRate === null) return null;
  const cw = price.cacheWrite === undefined ? inBase : usable(price.cacheWrite);
  if (cw === null) return null;

  const usd = (inTokens * Math.max(inBase, cw) + out * outRate) / 1e6;
  if (!Number.isFinite(usd) || usd < 0) return null;
  // Six places, matching the ledger column, rounded UP so the estimate is never
  // fractionally under what it is estimating.
  return Math.ceil(usd * 1e6) / 1e6;
}

/**
 * Content forms whose SIZE does not travel in the request body.
 *
 * anthropicWorstCaseUsd bounds a request by counting the bytes that arrived,
 * which is only a bound while every token the provider will read is one of
 * those bytes. A remote source breaks that: the body carries a URL and the
 * provider fetches the content itself, so a 178-byte body can meter as a
 * 1,296-token image, and a URL PDF can expand without any ceiling the body
 * can express. Measured by the reviewer against the bundled handler: 178
 * bytes reserved $0.000582 and the same call metered $0.006505, which is how
 * a request was admitted at $14.999 of prior spend and settled at $15.0055.
 * Settlement recorded the overspend honestly, and recording it is not the
 * same as bounding it.
 *
 * So the shared key takes only sources it can measure before it sends them.
 * This is an ALLOWLIST, not a list of the two forms known to be unbounded: a
 * source form added to the API later is refused until someone decides how to
 * price it, which is the safe direction for a cap.
 *
 *   base64   the bytes are in the body
 *   text     the characters are in the body
 *   content  nested blocks, themselves in the body and walked by this function
 *
 * A physician's own key never comes through here and is unaffected. Nothing in
 * the app sends any other form: every attachment is read in the browser and
 * posted as base64 (src/utils/assistant.js). The Files API and URL sources are
 * refusals, not regressions.
 *
 * Returns the offending form, or null.
 */
export const BOUNDED_SOURCE_TYPES = new Set(["base64", "text", "content"]);

export function unboundedSource(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  let found: string | null = null;
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 8 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const src = o.source;
    if (src && typeof src === "object" && !Array.isArray(src)) {
      const t = (src as Record<string, unknown>).type;
      // A source object with no type at all is not a content block this
      // understands; refuse it too rather than walk past it.
      const label = typeof o.type === "string" ? o.type : "content";
      if (typeof t !== "string" || !BOUNDED_SOURCE_TYPES.has(t)) {
        found = `${label}.source.type=${t === undefined ? "(missing)" : String(t)}`;
        return;
      }
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(body, 0);
  return found;
}

/**
 * Pricing options the shared key does not carry.
 *
 * One-hour cache creation costs 2x base input rather than the 1.25x five-minute
 * rate the table holds, and US-only inference adds 10% across every token
 * category and stacks with caching. Neither is in the rate table, so a request
 * using them would be admitted at one price and billed at another. The shared
 * key's contract refuses them rather than pretending to price them; a
 * physician's own key is unaffected, because it never comes through here.
 *
 * Returns the offending option, or null.
 */
export function unpricedOption(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const top = body as Record<string, unknown>;
  if (top.inference_geo !== undefined) return "inference_geo";
  if (top.context_management !== undefined) return "context_management";

  let found: string | null = null;
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 8 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const cc = o.cache_control as Record<string, unknown> | undefined;
    if (cc && typeof cc === "object" && cc.ttl !== undefined && cc.ttl !== "5m") {
      found = `cache_control.ttl=${String(cc.ttl)}`;
      return;
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(body, 0);
  return found;
}
