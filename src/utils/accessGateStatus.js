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
export function accessGateStatus({ enabled, initializationError, error, profileReady } = {}) {
  if (initializationError) return { lines: String(initializationError).split("\n").filter(Boolean), action: "reload" };
  if (!enabled) return { lines: ["Checking your invitation…"], action: null };
  if (error) return { lines: [String(error)], action: profileReady ? "refresh" : "reload" };
  if (!profileReady) return { lines: ["Your account setup could not finish. Reload to try again."], action: "reload" };
  return { lines: ["Checking your membership…"], action: null };
}
