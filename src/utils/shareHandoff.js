/**
 * A share sheet send recorded when the file is handed over, not when the
 * sheet answers (iPhone app, 2026-10-01 QA lab under the iOS model).
 *
 * On the installed iPhone app the share sheet's promise often never settles
 * once Mail takes over, and iOS may discard or reload the page while Mail is
 * in front. Every send that wrote its record, cleared its busy state or said
 * "Sent" only after `await navigator.share()` lost all three: a packet that
 * went out by Mail had no Send history row, its screen stayed in Select or on
 * "Working…" or "Building PDF", and a second tap was told the files were too
 * large. The invoice send already works this way (invoiceHandoff.js, owned by
 * the invoice flow); this is the same rule for every other share:
 *
 *  - `onHanded` runs as the sheet is asked for (just after navigator.share
 *    is called, in the same task): write the record, show the message,
 *    leave Select, clear the busy state;
 *  - `onUndo(outcome)` runs only when the sheet says the send did not happen
 *    (the member cancelled: AbortError) or could not start (another share is
 *    still open: InvalidStateError; the tap no longer counts as one:
 *    NotAllowedError; anything else): take the record back;
 *  - `onUnanswered`, optional, runs once when the page is back in front and
 *    the sheet has still not answered a moment later (or after a long wait
 *    in any case), for a screen that holds something until the answer.
 *
 * Resolves to "shared", "cancelled", "busy", "blocked" or "failed", and never
 * rejects. A promise that never settles never resolves either, which is why
 * everything the member must see happens in `onHanded`.
 */

import { holdWriteRefusalAlerts } from "./limitedLaunchAccess.js";

export const SHARE_ANSWER_GRACE_MS = 3000;
export const SHARE_ANSWER_WAIT_MS = 45000;

export function shareOutcome(err) {
  if (err?.name === "AbortError") return "cancelled";
  if (err?.name === "InvalidStateError") return "busy";
  if (err?.name === "NotAllowedError") return "blocked";
  return "failed";
}

/** What to tell the member when a share did not start; `failed` is the screen's own words. */
export function shareNotStartedMessage(outcome, failed = "Sharing failed. Try again.") {
  if (outcome === "busy") return "A share sheet is still open. Finish or close it in the other app, then send again. Nothing was sent twice.";
  if (outcome === "blocked") return "The share sheet did not open. Tap Send again.";
  if (outcome === "failed") return failed;
  return null;
}

/**
 * `onUnanswered` once the page is back in front (visible or focused, or
 * touched) and the sheet has still not answered `graceMs` later, or after
 * `waitMs` in any case. A blur or a hide in the grace cancels it: the focus
 * was the share sheet handing over to Mail's compose sheet, not his return,
 * and the alert would have come over the compose sheet for a send he might
 * still cancel (review of 9484782c). A touch on the page is his return
 * whatever events the sheet's dismissal sent: the page cannot be touched
 * under a sheet, and the in-app compose sheet may close without a focus
 * event. Returns stop().
 */
export function watchShareUnanswered(onUnanswered, { graceMs = SHARE_ANSWER_GRACE_MS, waitMs = SHARE_ANSWER_WAIT_MS, doc = globalThis.document, win = globalThis.window } = {}) {
  let done = false, grace = null;
  const fire = () => {
    if (done) return;
    stop();
    try { onUnanswered(); } catch { /* the screen's own business */ }
  };
  const cancelGrace = () => { if (grace) { clearTimeout(grace); grace = null; } };
  const back = () => {
    if (done) return;
    if (doc?.visibilityState === "hidden") { cancelGrace(); return; }
    if (!grace) { grace = setTimeout(fire, graceMs); grace?.unref?.(); }
  };
  const away = () => { if (!done) cancelGrace(); };
  // waitMs Infinity: only a return to the front fires it.
  const wait = Number.isFinite(waitMs) ? setTimeout(fire, waitMs) : null;
  wait?.unref?.();
  try { doc?.addEventListener?.("visibilitychange", back); } catch { /* no document */ }
  try { doc?.addEventListener?.("pointerdown", back, true); } catch { /* no document */ }
  try { win?.addEventListener?.("focus", back); } catch { /* no window */ }
  try { win?.addEventListener?.("blur", away); } catch { /* no window */ }
  function stop() {
    done = true;
    if (wait) clearTimeout(wait);
    cancelGrace();
    try { doc?.removeEventListener?.("visibilitychange", back); } catch { /* gone */ }
    try { doc?.removeEventListener?.("pointerdown", back, true); } catch { /* gone */ }
    try { win?.removeEventListener?.("focus", back); } catch { /* gone */ }
    try { win?.removeEventListener?.("blur", away); } catch { /* gone */ }
  }
  return stop;
}

export async function shareAtHandoff(payload, { share, onHanded, onUndo, onUnanswered, watch = watchShareUnanswered, holdAlerts = holdWriteRefusalAlerts } = {}) {
  const send = share || ((p) => globalThis.navigator.share(p));
  // The sheet is asked for first, then onHanded runs in the same task. Run
  // before it, a write refused by the membership (read-only, the identity
  // wait) showed its alert inside the tap, before the sheet was asked for:
  // he saw "can't save" for a send he had not made, and a slow dismissal
  // cost the tap its permission, so the sheet did not open (link audit,
  // 2026-10-01). Run after it, the same alert still came in the same task as
  // the sheet, two presentations asked of iOS at once, and still before he
  // had chosen to send or cancel. So a refusal inside onHanded (or onUndo)
  // never alerts there: it is said once the sheet answers that it went, or
  // once he is back in front with the sheet still silent, and forgotten when
  // the sheet says the send did not happen (nothing was left to record).
  // Never on a plain timeout: Mail's compose sheet over the installed app
  // leaves the page visible, so 45 s spent writing is not a return to the
  // front, and the alert would come over the sheet for a send he might still
  // cancel (review of 27a0d491). The hold stays open until then, so a share
  // log the membership check takes back later (an answer that was only old)
  // waits for the same moment (holdWriteRefusalAlerts); the watch runs
  // whether or not anything is held yet for that reason.
  let sent;
  try { sent = Promise.resolve(send(payload)); } catch (err) { sent = Promise.reject(err); }
  const held = holdAlerts();
  try { onHanded?.(); } catch { /* the record is the screen's; the share is already asked for */ } finally { held.stop(); }
  let stopTelling = () => {};
  const tell = () => { stopTelling(); held.show(); };
  stopTelling = watch(tell, { waitMs: Infinity });
  const stop = typeof onUnanswered === "function" ? watch(onUnanswered) : () => {};
  try {
    await sent;
    stop();
    tell();
    return "shared";
  } catch (err) {
    stop();
    stopTelling();
    // The hand-off's own record may not stand: refused (said or taken back
    // by the check), or still waiting for the check's answer.
    const inDoubt = held.pending === true || held.awaiting > 0;
    held.drop();
    const outcome = shareOutcome(err);
    // Taking back a record that was refused is refused too: nothing to say.
    // A record that was kept is another matter: a refusal of its take-back
    // (now, or when the check answers) leaves a send he cancelled in Send
    // history, and is said as any refused save is (review of 9484782c).
    if (!inDoubt) {
      try { onUndo?.(outcome); } catch { /* as above */ }
      return outcome;
    }
    const undoHeld = holdAlerts();
    try { onUndo?.(outcome); } catch { /* as above */ } finally { undoHeld.drop(); }
    return outcome;
  }
}
