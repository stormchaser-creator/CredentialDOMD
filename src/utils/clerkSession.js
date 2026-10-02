// The same Clerk session: the same object, or (Clerk builds a new Session
// object for the same session whenever its client is refreshed, for example
// the touch it sends each time the page gets focus, as an iPhone resumes it)
// one with the same session id for the same user. A sign-out leaves none; a
// new sign-in or another account is another session id.
//
// Every "is this still the session the request started under" check uses
// this, never `===` on the objects: compared by object, a ticket or reply
// sent while the iPhone app came back to the front was stored but the sheet
// stayed on "Sending..." (IOS-SUPPORT-1, -2), and admin calls failed with
// "session changed" (2026-10-01).
export const sessionUser = session => session?.user?.id ?? session?.userId ?? null;
export function sameClerkSession(saved, current) {
  if (!saved || !current) return false;
  if (saved === current) return true;
  return typeof saved.id === "string" && saved.id !== "" && current.id === saved.id
    && sessionUser(saved) !== null && sessionUser(current) === sessionUser(saved);
}
