import { lazy, Suspense, useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import AuthPage from "./components/pages/AuthPage.jsx";
import UpdatePrompt from "./components/shared/UpdatePrompt";
import { readLastIdentity } from "./utils/offlineSession";
import { stashAppDeepLink, takeAppDeepLink } from "./utils/supportDeepLink.js";

// The sign-in screen used to wait for the whole app: one 4.3 MB script (1.3 MB
// compressed), then Clerk's own, before anything showed. On a slow phone
// connection that was 8.7 s of a blank page for someone who had just pressed
// "Create your account" (signup review 2026-10-07). The app is its own chunk
// now (precached by the service worker with the entry, scripts/sw-precache.mjs),
// and a visitor Clerk says is signed out gets the sign-in screen without it.
//
// The app is fetched at once when this device has a recorded signed-in
// identity (a returning member, and the only case the offline fallback can
// open), as soon as Clerk says someone is signed in, and, for a visitor on
// the sign-in screen, once that screen is up, so signing in does not wait for it.
// One more try after a moment: a chunk lost to a dropped connection (or a
// deploy that replaced it while this page sat open) is fetched again before
// the error screen.
export const loadApp = () => import("./App.jsx").catch(() => new Promise(resolve => setTimeout(resolve, 1000)).then(() => import("./App.jsx")));
const App = lazy(loadApp);
export const APP_PREFETCH_DELAY_MS = 1500;

const knownMember = () => { try { return !!readLastIdentity(); } catch { return false; } };

/** Which screen: "sign-in" (no app), "wait" (Clerk loading, no member here), or "app". */
export function gateView({ isLoaded, userId, appWanted }) {
  if (isLoaded && !userId && !appWanted) return "sign-in";
  if (appWanted || (isLoaded && !!userId)) return "app";
  return "wait";
}

export default function AuthGate() {
  const { isLoaded, userId } = useAuth();
  const signedOut = isLoaded && !userId;
  const [appWanted, setAppWanted] = useState(knownMember);
  const view = gateView({ isLoaded, userId, appWanted });
  useEffect(() => { if (isLoaded && userId) setAppWanted(true); }, [isLoaded, userId]);

  useEffect(() => {
    if (!signedOut) return undefined;
    // The link an email opened (main.jsx captureAppDeepLink) is kept for this
    // tab, renewed as App would, so it is still there once he has signed in.
    const link = takeAppDeepLink();
    if (link) stashAppDeepLink(link);
    // The app, quietly, once the sign-in screen is up.
    const timer = setTimeout(() => { loadApp().catch(() => { /* fetched again when it is needed */ }); }, APP_PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signedOut]);

  if (view === "sign-in") return <>
    <AuthPage />
    {/* Manual updates stay available at sign-in; never an automatic reload during email entry. */}
    <UpdatePrompt allowAutomaticUpdates={false} />
  </>;
  // Clerk still loading for a device with no recorded member: nothing to show
  // yet, as before (the app's own screens rendered nothing until Clerk answered).
  if (view === "wait") return <UpdatePrompt allowAutomaticUpdates={false} />;
  return <Suspense fallback={<div role="status" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 500, opacity: 0.7 }}>Loading...</div>}><App /></Suspense>;
}
