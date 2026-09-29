/**
 * A failed membership quote, checkout or invitation activation, as the
 * operator sees it (funnel forensics 2026-09-28: a prospect's checkout failed
 * and nothing reached the error table).
 *
 * The report names the action, the server's fixed refusal code, where the
 * request stopped and its HTTP status, and nothing about who: no quote id,
 * consent hash, token, address, amount or server text. The client error
 * reporter adds its usual envelope. One report per session per action and
 * code, so a buyer who taps Continue five times sends one row.
 *
 * A refusal the page made itself (no fresh membership answer, an expired or
 * no longer eligible offer, or a payment page it chose not to open) carries
 * phase "client", so the operator can tell a buyer stopped at Continue from
 * one the server refused.
 */
import { describeAccessRefreshFailure } from "./accessRefreshFailure.js";

const ACTIONS = new Set(["quote", "checkout", "activate"]);

export function createCheckoutFailureReporter(report) {
  const sent = new Set();
  return (action, error) => {
    if (!ACTIONS.has(action)) return false;
    const failure = describeAccessRefreshFailure(error);
    if (error?.phase === "client") failure.phase = "client";
    const code = failure.code || "unknown";
    const key = `${action}:${code}${failure.phase === "client" ? ":client" : ""}`;
    if (sent.has(key)) return false;
    sent.add(key);
    try {
      const label = failure.phase === "client" ? `Membership ${action} stopped on the page (${code})` : `Membership ${action} failed (${code})`;
      report(label, "error", { event: "membership_checkout_failed", action, ...failure, code });
    } catch { /* Reporting must never change what the buyer sees. */ }
    return true;
  };
}
