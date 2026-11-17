/**
 * One short email to the owner when the intake's model reading fails, at most
 * one in any 24 hours (2026-11-17). On 2026-11-05 the Anthropic intake key ran
 * out of credit and nobody knew for twelve days: every forward was read by
 * the rules and the ledger said so, but no one reads the ledger.
 *
 * Off unless INTAKE_AI_FAILURE_ALERTS is "on" (or "1", "true"). The owner
 * asked on 2026-10-30/31 for no emails about what is wrong, with technical
 * issues handled by the scheduled agents (20261031200000_owner_email_kinds),
 * so this stays off until he turns it on.
 *
 * Only an error a provider answered with counts (an HTTP 4xx or 5xx: out of
 * credit, a revoked token, a daily allowance spent, an outage), never a
 * timeout or a reply that did not parse. The 24 hours are held in the
 * database (public.claim_intake_ai_alert, 20261117120000), so two emails
 * failing at once, on two workers, still send one alert; a send that fails
 * gives its claim back so the next failure can try again.
 */
import { OWNER_NOTIFY_FROM, OWNER_NOTIFY_TO } from "./ownerNotify.mjs";

/** Is the alert switched on? */
export function alertsEnabled(value) {
  return ["on", "1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

/** The failures worth an alert: those a provider answered with an error status. */
export function alertableFailures(failures) {
  return (Array.isArray(failures) ? failures : []).filter((f) => f && Number.isInteger(f.status) && f.status >= 400 && f.status <= 599);
}

const clean = (s, max) => String(s ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The email, or null for no failures. Says which reader failed and why, and that the rules stood in. */
export function aiAlertEmail(failures, { at = new Date() } = {}) {
  const list = alertableFailures(failures);
  if (!list.length) return null;
  const lines = list.map((f) => `- ${clean(f.provider, 40)}: ${clean(f.why, 300)}`);
  return {
    from: OWNER_NOTIFY_FROM,
    to: [OWNER_NOTIFY_TO],
    subject: "CredentialDOMD: email intake AI is failing",
    text: [
      `The AI that reads forwards to docs@ and cme@ failed at ${at.toISOString()}:`,
      ...lines,
      "",
      "Forwards are still being handled, by the keyword rules, which are less accurate. Nothing was lost.",
      "This alert is sent at most once a day. Turn it off by unsetting INTAKE_AI_FAILURE_ALERTS on the email-inbound function.",
    ].join("\n"),
  };
}

/**
 * Send the alert when it is on, a failure warrants it, and no alert went out
 * in the last 24 hours. deps: { db, send(payload) -> { ok } }. Returns
 * "off" | "none" | "recent" | "sent" | "failed". Never throws.
 */
export async function maybeAlertOwner({ enabled, failures, db, send, at = new Date() }) {
  if (!enabled) return "off";
  const email = aiAlertEmail(failures, { at });
  if (!email) return "none";
  const list = alertableFailures(failures);
  let id = null;
  try {
    const { data, error } = await db.rpc("claim_intake_ai_alert", {
      p_provider: clean(list.map((f) => f.provider).join(","), 40),
      p_detail: clean(list.map((f) => f.why).join("; "), 500),
    });
    if (error) return "failed";
    id = data ?? null;
  } catch {
    return "failed";
  }
  if (id === null || id === undefined) return "recent";
  let ok = false;
  try {
    ok = Boolean((await send(email))?.ok);
  } catch {
    ok = false;
  }
  try {
    if (ok) await db.from("intake_ai_alerts").update({ sent_at: at.toISOString() }).eq("id", id);
    else await db.from("intake_ai_alerts").delete().eq("id", id);
  } catch { /* the claim stands; at worst one alert is skipped */ }
  return ok ? "sent" : "failed";
}
