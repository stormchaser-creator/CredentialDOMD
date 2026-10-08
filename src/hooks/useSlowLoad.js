import { useEffect, useState } from "react";

// The first screen ("Loading...") while sign-in or the account load has not
// finished. Every read the load waits on now has its own deadline
// (lib/supabase.js LOAD_READ_LIMIT_MS), but anything else can still hold it
// (Clerk's script on a dead link, a device store that never opens), and a
// bare "Loading..." gave a new member nothing to do: one sat on it past 2.5
// minutes, where a reload loaded in 0.8 s (signup review 2026-10-07). After
// RELOAD_OFFER_MS the screen offers Reload; after SLOW_REPORT_MS the wait is
// reported once per page, with the stage it was in and nothing else.
export const LOAD_RELOAD_OFFER_MS = 10_000;
export const LOAD_SLOW_REPORT_MS = 15_000;
export const SLOW_LOAD_TEXT = "This is taking longer than usual. Reload to try again.";

let reportedThisPage = false;
/** Tests only: a new page. */
export function resetSlowLoadReport() { reportedThisPage = false; }

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * `stage`: null while nothing is waiting, else "sign-in" or "account".
 * Returns true once the wait has lasted long enough to offer Reload.
 */
export function useSlowLoad(stage, { report, offerMs = LOAD_RELOAD_OFFER_MS, reportMs = LOAD_SLOW_REPORT_MS } = {}) {
  // One wait at a time: a new stage, or a new wait after the screen had
  // loaded, starts unslowed. AppInner stays mounted when the account loads
  // again (a purge from another device, loadAgain), and a slowness kept from
  // an earlier wait showed Reload on the next one at once.
  const [wait, setWait] = useState({ stage: null, slow: false });
  let current = wait;
  if (wait.stage !== (stage || null)) {
    current = { stage: stage || null, slow: false };
    setWait(current);
  }
  useEffect(() => {
    if (!stage) return undefined;
    const offer = setTimeout(() => setWait(w => (w.stage === stage ? { stage, slow: true } : w)), offerMs);
    // A page in the background is not loading slowly: iOS pauses it.
    const reportTimer = setTimeout(() => {
      if (reportedThisPage || !visible() || typeof report !== "function") return;
      reportedThisPage = true;
      try { report(`Account load still waiting after ${Math.round(reportMs / 1000)} s (${stage}).`, { event: "load_slow", stage, seconds: Math.round(reportMs / 1000) }); }
      catch { /* reporting never blocks */ }
    }, reportMs);
    return () => { clearTimeout(offer); clearTimeout(reportTimer); };
  }, [stage, offerMs, reportMs]); // eslint-disable-line react-hooks/exhaustive-deps
  return !!stage && current.slow;
}
