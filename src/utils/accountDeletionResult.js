import { LEGAL_CONTACT } from "../content/legalText.js";

// Shown to the member, and logged beside the underlying error, when the
// server pass does not finish. Fixed on purpose: delete-account answers a
// failure with the raw Postgres or storage message ("permission denied for
// table ...", "duplicate key value violates ..."), and supabase-js adds its
// own transport sentence. None of that belongs on the member's screen.
export const DELETION_SUPPORT_REFERENCE = "DELETE-SERVER-UNFINISHED";

/**
 * What Delete All My Data tells the member once it has run (SETTINGS-005).
 * `result` is LegalSection's { state: 'done' | 'local' }; null shows nothing.
 * Fixed wording only: the server's error text is never part of it.
 *
 * A server pass that did not confirm has no card: the tab is held
 * (AppContext.holdAfterUnconfirmedDeletion) and the app shows
 * deletionUnconfirmedMessage below on its stopped screen instead.
 */
export function deletionResultMessage(result) {
  if (result?.state === "done") return { ok: true, lines: [
    "All your data was deleted from this device and from our servers.",
    `Your sign-in account stays open. To close it, email ${LEGAL_CONTACT}.`,
  ] };
  if (result?.state === "local") return { ok: false, lines: [
    "Your data was deleted from this device only. The app could not reach our servers, so your cloud records, uploaded files, support tickets, backups and assistant log are still there.",
    "Reconnect, sign in and run Delete All My Data again to remove them.",
  ] };
  return null;
}

/**
 * The server step of Delete All My Data neither answered nor could be read
 * back, so the tab is held until a reload (SYNC-012) and the app shows this
 * on its stopped screen, one line per paragraph. It says what may still be on
 * the servers, what to do, and where to go when it keeps failing, with the
 * support reference the console line carries too. `cloudFailed`: the
 * browser's own pass over the records and uploaded files failed as well.
 */
export function deletionUnconfirmedMessage({ cloudFailed = false } = {}) {
  return [
    "Your data was removed from this device, but our servers did not confirm that the deletion finished.",
    `Until it does, these may still be on our servers: your support tickets and screenshots, the assistant log, feedback and your monthly backups${cloudFailed ? ", and some of your records and uploaded files" : ""}.`,
    "Reload, then run Delete All My Data again before adding anything new. Running it twice is safe.",
    `If it keeps failing, email ${LEGAL_CONTACT} with support reference ${DELETION_SUPPORT_REFERENCE}.`,
  ].join("\n");
}

// The last result, for the rest of this page session. An answered deletion
// reopens the account (AppContext.reopenAfterAccountDeletion), and the app
// shows its loading screen while the account loads again, which unmounts the
// Data Rights page and its card with it. The card reads this when it mounts
// again, for the same account only.
let remembered = null;
export function rememberDeletionResult(accountId, result) {
  remembered = accountId && result ? { accountId, result } : null;
}
export function rememberedDeletionResult(accountId) {
  return accountId && remembered?.accountId === accountId ? remembered.result : null;
}
