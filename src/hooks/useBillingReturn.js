import { useEffect, useState } from "react";
import { BILLING_RETURN_DELAYS_MS, clearBillingReturn, membershipLanded, readBillingReturn } from "../utils/billingReturn.js";

/**
 * What the app tells a buyer back from Stripe (see utils/billingReturn.js).
 * Read once per page load. Null when there is nothing to say.
 *
 * `limitedLaunch` is useLimitedLaunchAccess's answer: its `access` decides
 * when the purchase has landed and its `refresh` asks for a fresh one.
 */
export function useBillingReturn(limitedLaunch, accountId, { win = globalThis.window, delays = BILLING_RETURN_DELAYS_MS } = {}) {
  const [state, setState] = useState(() => {
    const kind = limitedLaunch?.enabled ? readBillingReturn(win?.location?.search) : null;
    return kind ? { kind, phase: kind === "complete" ? "confirming" : "canceled", round: 0, dismissed: false } : null;
  });
  const access = limitedLaunch?.access ?? null;
  const landed = state?.kind === "complete" && membershipLanded(access);
  const refresh = limitedLaunch?.refresh;
  const ready = !!limitedLaunch?.enabled && !!accountId && typeof refresh === "function";
  // Canceled has nothing to wait for; complete waits until the purchase shows.
  useEffect(() => {
    if (state?.kind === "canceled" || landed) clearBillingReturn(win);
  }, [state?.kind, landed, win]);
  // A fresh membership answer on a short backoff until the webhook has landed.
  useEffect(() => {
    if (state?.kind !== "complete" || state.phase !== "confirming" || landed || !ready) return;
    const round = state.round;
    let stopped = false, timer = null, step = 0;
    const next = () => {
      if (stopped) return;
      if (step >= delays.length) {
        setState(current => current && current.round === round && current.phase === "confirming" ? { ...current, phase: "delayed" } : current);
        return;
      }
      timer = setTimeout(async () => {
        step += 1;
        try { await refresh(); } catch { /* The access hook reports its own failures. */ }
        next();
      }, delays[step]);
    };
    next();
    return () => { stopped = true; clearTimeout(timer); };
  }, [state, landed, ready, refresh, delays]);
  if (!state) return null;
  const phase = landed ? "confirmed" : state.phase;
  // Dismissing hides the notice. A completed Checkout still waiting to show
  // stays known (dismissed: true), so the page never asks a member who has
  // just paid to pay again (payFirstMode) and keeps saying it is being
  // confirmed; anything else dismissed has nothing more to say.
  if (state.dismissed && !(state.kind === "complete" && phase !== "confirmed")) return null;
  return {
    kind: state.kind,
    phase,
    dismissed: state.dismissed,
    // A beta holder's opt-in is charged at the beta's end, not at Checkout.
    // Unknown (null) until there is a fresh answer: a page loaded back from
    // Stripe has none yet, and a device's remembered one can be out of date.
    deferred: !access || access.needsRefresh === true ? null : access.freeBeta?.state === "active",
    retry: () => setState(current => current && { ...current, phase: "confirming", round: current.round + 1 }),
    dismiss: () => setState(current => current && { ...current, dismissed: true }),
  };
}
