/**
 * What the access gate in App.jsx says while it has no access decision, and
 * which button it offers under the text ("reload", "refresh" or null).
 *
 * An account-load stop (AppContext's profileIssue, which App reads as
 * limitedLaunch.initializationError) comes first, in launch mode and
 * invitation mode alike: the app has stopped either way, and the message is
 * the only place the member learns why, what to do, and the support
 * reference. It is one paragraph per line (Delete All My Data's held screen,
 * deletionUnconfirmedMessage, has four). Every such message asks for a
 * reload, so that is the button.
 */
export function accessGateStatus({ enabled, initializationError, identityWaiting, error, profileReady } = {}) {
  if (initializationError) return { lines: String(initializationError).split("\n").filter(Boolean), action: "reload" };
  // The identity check had no answer (a weak signal), and this device holds
  // no membership answer to open the records on: it is asked again on its
  // own (AppContext identity retry), so this is a wait, not a failure, and
  // there is nothing to tap. A Reload button under "Trying again on its own"
  // said the opposite (lab, release goal2).
  if (identityWaiting) return { lines: ["The connection is too weak to confirm your account right now. Trying again on its own."], action: null };
  if (!enabled) return { lines: ["Checking your invitation…"], action: null };
  if (error) return { lines: [String(error)], action: profileReady ? "refresh" : "reload" };
  if (!profileReady) return { lines: ["Your account setup could not finish. Reload to try again."], action: "reload" };
  return { lines: ["Checking your membership…"], action: null };
}
