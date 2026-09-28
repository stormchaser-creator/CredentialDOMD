/**
 * The understanding step's one model call (intakeUnderstanding.mjs), made by
 * email-inbound on the SHARED Anthropic key, metered the way ai-proxy meters
 * that key. Nothing here decides what an email means; it only admits the
 * call or declines it, makes it, and says why.
 *
 *   admit   admitUnderstanding, before anything is scanned or sent:
 *           who     an active account, or an admin whose forward is
 *                   positively authenticated; anyone else gets the rules
 *           daily   public.reserve_ai_call on the understanding step's OWN
 *                   scopes, never Vera's "anthropic" one, so a stream of
 *                   forwards cannot use up the physician's assistant for the
 *                   day: INTAKE_SCOPE for a positively authenticated
 *                   forward, and a much smaller INTAKE_UNVERIFIED_SCOPE for a
 *                   forward that only failed to fail. The cap applies to
 *                   admins too. Before 2026-09-28 (evening) an admin was
 *                   uncapped here as in ai-proxy; but ai-proxy's admin is an
 *                   authenticated session, and here "admin" came from a From
 *                   header the email never proved, so a forged forward from
 *                   the owner's address could buy Opus calls without limit.
 *   dollars the provider's count of THIS request (count_tokens, from the same
 *           object that is sent), priced at the worst case and held against
 *           the month with public.reserve_ai_spend, then settled at what it
 *           cost; a ledger or a count that cannot answer means no call. Only
 *           an admin with a proven forward skips the hold, as in ai-proxy.
 *   meter   one public.ai_usage row per call, exactly as ai-proxy writes it:
 *           path "v1/messages", provider "anthropic", the vendor's token
 *           counts and cost_usd at list price, or ok false with the status
 *   time    a strict per-request timeout and no retries, both clipped to
 *           the caller's deadline; a call with too little time left is not
 *           made, and a call that times out settles at its worst case,
 *           because it may have billed
 *
 * The request carries no tools, no betas and no server-side fallback: the
 * shared key pays only for what the price table can price (ai-proxy refuses
 * a beta header for the same reason), and the fallback here is the rules. A
 * refusal, a reply cut off at max_tokens, or any failure at all returns
 * { ok: false } and the caller reads the email with the rules instead.
 *
 * Never logs the key, the request, or an error's text.
 */
import Anthropic from "npm:@anthropic-ai/sdk@0.115.0";
import { meterUsage, priceFor } from "./aiPricing.ts";
import { aiAdmissionVerdict, AI_CODES, anthropicWorstCaseFromTokens, countedInputTokens, countPayload } from "../ai-proxy/limits.ts";

export const ANTHROPIC_USAGE_PATH = "v1/messages";   // ai_usage.path for Anthropic rows, as ai-proxy writes it
export const INTAKE_SCOPE = "anthropic_intake";                        // ai_reservations.scope, a positively authenticated forward
export const INTAKE_UNVERIFIED_SCOPE = "anthropic_intake_unverified";  // ai_reservations.scope, any other forward
// The token count's own timeout, at most; the deadline can make it shorter.
export const COUNT_TIMEOUT_MS = 10_000;

// deno-lint-ignore no-explicit-any
type Db = any;

export interface AdmissionInput {
  db: Db;
  profileId: string;
  isAdmin: boolean;
  active: boolean;
  /** The forward is positively authenticated (email-inbound mayFileFrom). */
  verified: boolean;
  key: string;
  dailyLimit: number;
  unverifiedDailyLimit: number;
  now?: Date;
}

export type Admission =
  | { ok: true; uncapped: boolean; scope: string }
  | { ok: false; why: string };

export interface UnderstandingCall {
  db: Db;
  profileId: string;
  admission: Admission;
  key: string;
  request: Record<string, unknown>;
  budgetHardUsd: number;
  timeoutMs: number;
  /** Epoch ms by which the call must be over (email-inbound's scan budget); absent means no deadline. */
  deadline?: number;
  /** The least time worth starting the call with; less than this left and no call is made. */
  minMs?: number;
  now?: Date;
}

export type UnderstandingCallResult =
  | { ok: true; message: Anthropic.Message; costUsd: number | null }
  | { ok: false; why: string };

function startOfTodayUtc(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ai-proxy's prompt_chars for an Anthropic request: text in system and messages, never a file. */
export function promptChars(body: unknown): number {
  let n = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") { n += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string") n += o.text.length;
      for (const k of ["system", "messages", "content"]) if (k in o) walk(o[k], depth + 1);
    }
  };
  walk(body, 0);
  return Math.min(n, 2_000_000_000);
}

/**
 * May this email be read by the model? Reserves one of the day's reads on
 * the understanding step's own scope when it may. Called before any
 * attachment is scanned for the reading, so a forward over the allowance
 * costs nothing but the rules. Never throws.
 */
export async function admitUnderstanding(input: AdmissionInput): Promise<Admission> {
  if (!input.key) return { ok: false, why: "shared Anthropic key not configured" };
  // An admin is an admin only when the forward proves who sent it.
  const admin = input.isAdmin && input.verified;
  if (!input.active && !admin) return { ok: false, why: "account not active" };
  const scope = input.verified ? INTAKE_SCOPE : INTAKE_UNVERIFIED_SCOPE;
  const limit = input.verified ? input.dailyLimit : input.unverifiedDailyLimit;
  let reserved: { data?: unknown; error?: unknown };
  try {
    reserved = await input.db.rpc("reserve_ai_call", {
      p_user: input.profileId, p_scope: scope, p_limit: limit, p_since: startOfTodayUtc(input.now ?? new Date()),
    });
  } catch (e) {
    reserved = { error: e };
  }
  const verdict = aiAdmissionVerdict(reserved, AI_CODES.quota, null);
  if (!verdict.allow) {
    if (verdict.code !== AI_CODES.quota) return { ok: false, why: "AI ledger unavailable" };
    return { ok: false, why: input.verified ? "over the day's limit for reading forwards" : "over the day's limit for reading unverified forwards" };
  }
  return { ok: true, uncapped: admin, scope };
}

/**
 * Make the call, or decline. Returns the model's message on success, with
 * what it cost; otherwise { ok: false, why } with a reason fit for a log
 * line (never an error's text, which can carry a URL).
 */
export async function callUnderstanding(input: UnderstandingCall): Promise<UnderstandingCallResult> {
  const { db, profileId, admission, key, request } = input;
  if (!admission.ok) return { ok: false, why: admission.why };
  if (!key) return { ok: false, why: "shared Anthropic key not configured" };
  const startedAt = input.now ?? new Date();
  const model = String(request.model ?? "");
  const maxTokens = Number(request.max_tokens);
  const chars = promptChars(request);
  const minMs = Math.max(1, input.minMs ?? Math.min(8_000, input.timeoutMs));
  const left = () => (typeof input.deadline === "number" ? input.deadline - Date.now() : Number.POSITIVE_INFINITY);
  if (left() < minMs) return { ok: false, why: "time budget spent" };
  // No retries: a retry is a second paid call against one hold, and the
  // rules are the fallback, not another attempt.
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: input.timeoutMs });

  const logUsage = async (row: Record<string, unknown>) => {
    try {
      const { error } = await db.from("ai_usage").insert({ user_id: profileId, ...row });
      if (error) console.error("understanding: ai_usage insert failed");
    } catch { /* a logging failure never stops the intake */ }
  };
  const settle = async (hold: string | null, actualUsd: number | null) => {
    if (!hold) return;
    try {
      const { error } = await db.rpc("settle_ai_spend", { p_hold: hold, p_actual_usd: actualUsd });
      if (error) console.error(`understanding: hold ${hold} did not settle; it stays at its worst case until it does`);
    } catch {
      console.error(`understanding: hold ${hold} did not settle`);
    }
  };

  let hold: string | null = null;
  if (!admission.uncapped) {
    // The month's dollars, from the provider's own count of this request,
    // counted in what time the call can spare.
    const toCount = countPayload(request);
    if (!toCount) return { ok: false, why: "request not countable" };
    const countMs = Math.min(COUNT_TIMEOUT_MS, left() - minMs);
    if (countMs < 1) return { ok: false, why: "time budget spent" };
    let counted: number | null = null;
    try {
      const c = await client.messages.countTokens(toCount as unknown as Anthropic.MessageCountTokensParams, { timeout: countMs });
      counted = countedInputTokens((c as { input_tokens?: unknown }).input_tokens);
    } catch {
      counted = null;
    }
    if (counted === null) return { ok: false, why: "token count unavailable" };
    const worst = anthropicWorstCaseFromTokens(priceFor(model, startedAt)?.price, counted, maxTokens);
    if (worst === null) return { ok: false, why: `no price for ${model}` };
    let spend: Record<string, unknown>;
    try {
      const { data, error } = await db.rpc("reserve_ai_spend", { p_user: profileId, p_worst_case_usd: worst, p_cap_usd: input.budgetHardUsd });
      spend = error ? { outcome: "unavailable" } : ((data ?? { outcome: "unavailable" }) as Record<string, unknown>);
    } catch {
      spend = { outcome: "unavailable" };
    }
    if (spend.outcome === "over") return { ok: false, why: "over the month's AI budget" };
    if (spend.outcome !== "held") return { ok: false, why: "spend ledger unavailable" };
    hold = String(spend.hold);
  }

  // The call's own timeout, clipped to what is left of the deadline. Too
  // little left and it is not made: the hold is released at nothing.
  const createMs = Math.min(input.timeoutMs, left());
  if (createMs < minMs) {
    await settle(hold, 0);
    return { ok: false, why: "time budget spent" };
  }
  let message: Anthropic.Message;
  try {
    message = await client.messages.create(request as unknown as Anthropic.MessageCreateParamsNonStreaming, { timeout: createMs });
  } catch (e) {
    // Most specific first. A timeout or a dropped connection may have billed
    // something nobody can see, so its hold stays at the worst case; an
    // error the API answered with bills nothing and reports no usage.
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: false, status: null, prompt_chars: chars, provider: "anthropic", model });
      await settle(hold, null);
      return { ok: false, why: "the model call timed out" };
    }
    if (e instanceof Anthropic.APIConnectionError) {
      await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: false, status: null, prompt_chars: chars, provider: "anthropic", model });
      await settle(hold, null);
      return { ok: false, why: "the AI service was unreachable" };
    }
    if (e instanceof Anthropic.APIError) {
      const status = typeof e.status === "number" ? e.status : null;
      await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: false, status, prompt_chars: chars, provider: "anthropic", model });
      await settle(hold, status === null ? null : 0);
      return { ok: false, why: `the AI service answered ${status ?? "with an error"}` };
    }
    await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: false, status: null, prompt_chars: chars, provider: "anthropic", model });
    await settle(hold, null);
    return { ok: false, why: "the model call failed" };
  }

  const metered = meterUsage("anthropic", model, message, startedAt);
  await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: true, status: 200, prompt_chars: chars, provider: "anthropic", ...metered });
  const cost = typeof metered.cost_usd === "number" ? metered.cost_usd : null;
  await settle(hold, cost);
  return { ok: true, message, costUsd: cost };
}
