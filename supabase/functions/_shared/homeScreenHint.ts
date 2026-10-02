// iOS opens a link from Mail in Safari, never in the app installed on the home
// screen, and that app keeps its own sign-in: in Safari the member is signed
// out and signs in again with an emailed code, then works in a Safari tab
// (link audit, 2026-10-01). A web app has no universal link to change that,
// so each email that links into the app also says where to go in it.
export function homeScreenHint(where: string): string {
  return `On an iPhone with CredentialDOMD on your home screen, open it from there and go to ${where}. A link from Mail opens Safari, where you are not signed in.`;
}
