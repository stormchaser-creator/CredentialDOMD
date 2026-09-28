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
  if (!state || state.dismissed) return null;
  return {
    kind: state.kind,
    phase: landed ? "confirmed" : state.phase,
    // A beta holder's opt-in is charged at the beta's end, not at Checkout.
    deferred: access?.freeBeta?.state === "active",
    retry: () => setState(current => current && { ...current, phase: "confirming", round: current.round + 1 }),
    dismiss: () => setState(current => current && { ...current, dismissed: true }),
  };
}
