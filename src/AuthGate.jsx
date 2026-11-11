import { lazy, Suspense, useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import AuthPage from "./components/pages/AuthPage.jsx";
import UpdatePrompt from "./components/shared/UpdatePrompt";
import { recoverStartupModule } from "./utils/startupModule.js";
import { readLastIdentity } from "./utils/offlineSession";
import { stashAppDeepLink, takeAppDeepLink } from "./utils/supportDeepLink.js";
import { watchChunkFailures, CHUNK_RETRY_DELAY_MS } from "./utils/chunkRecovery.js";
import { deferChunkFailure, reportError, setErrorScreen } from "./lib/errorReport.js";

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
// Shared with App.jsx's mount effect (utils/startupModule.js
// clearStartupModuleGuard): each module's own import.meta.url differs
// between the two files, so a build id keyed on that would never match.
const STARTUP_BUILD_ID = typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : "dev";
export const loadApp = () => import("./App.jsx").catch(() => new Promise(resolve => setTimeout(resolve, 1000)).then(() => import("./App.jsx")));
const App = lazy(() => loadApp().catch(error => {
  // Prefetch failures never reload a visitor who is entering their email.
  // This catch runs only while mounting the root App; no workspace exists yet.
  const recovering = recoverStartupModule(error, {
    storage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value) },
    reload: () => window.location.reload(), online: navigator.onLine,
    build: STARTUP_BUILD_ID,
  });
  // Keep Suspense while navigation starts. If a host refuses the reload,
  // fall back to the existing error screen instead of waiting forever.
  if (recovering) return new Promise((_, reject) => setTimeout(() => reject(error), 5000));
  throw error;
}));
export const APP_PREFETCH_DELAY_MS = 1500;
// Clerk's own script can fail to load before isLoaded ever answers, while
// this wait view is the only thing mounted: AuthPage's chunk-failure watcher
// (utils/chunkRecovery.js) does not exist yet, since it only mounts once
// Clerk says this visitor is signed out. The client error report holds no
// screen context (src/lib/errorReport.js), so the 2026-10-31 report (ticket
// 7bbd451d, "Loading chunk 344 failed" on Clerk's own framework chunk)
// cannot be placed on this screen or the already-covered sign-in widget for
// certain; this gap is real either way, since this view mounts first on
// every cold start. Nothing is typed or shown here, so one reload is safe.
const WAIT_CHUNK_RELOAD_KEY = "credentialdomd-wait-chunk-reload";
const WAIT_CHUNK_FIXED_MESSAGE = "Fixed by itself: the sign-in library loaded after a piece of it was lost on the connection, following a reload.";

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
  useEffect(() => { setErrorScreen(view); }, [view]);
  useEffect(() => { if (isLoaded && userId) setAppWanted(true); }, [isLoaded, userId]);

  useEffect(() => {
    if (view !== "wait") return undefined;
    let timer;
    const stop = watchChunkFailures(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // If the loop guard cannot be persisted, keep the existing manual
        // reload rather than risk reloading forever.
        try {
          if (sessionStorage.getItem(WAIT_CHUNK_RELOAD_KEY) === import.meta.url) return;
          sessionStorage.setItem(WAIT_CHUNK_RELOAD_KEY, import.meta.url);
        } catch { return; }
        // Deferred, not lost: this reload is the recovery attempt, so the
        // failure the global listener is holding (lib/errorReport.js) must
        // not go out as unresolved the moment reload fires pagehide. The
        // outcome is settled below, once this reload answers.
        deferChunkFailure();
        window.location.reload();
      }, CHUNK_RETRY_DELAY_MS);
    });
    return () => { clearTimeout(timer); stop(); };
  }, [view]);

  useEffect(() => {
    // Clerk answering, either way, means the reload (if this is the page it
    // led to) worked: lift the loop guard so a later, unrelated failure in
    // this tab on this build still gets a reload, and tell the owner this
    // one fixed itself instead of leaving it silently unresolved.
    if (!isLoaded) return undefined;
    try {
      if (sessionStorage.getItem(WAIT_CHUNK_RELOAD_KEY) !== import.meta.url) return undefined;
      sessionStorage.removeItem(WAIT_CHUNK_RELOAD_KEY);
    } catch { return undefined; }
    reportError(WAIT_CHUNK_FIXED_MESSAGE, "info");
    return undefined;
  }, [isLoaded]);

  useEffect(() => {
    if (!signedOut) return undefined;
    // The link an email opened (main.jsx captureAppDeepLink) is kept for this
    // tab, renewed as App would, so it is still there once he has signed in.
    const keepLink = () => {
      const link = takeAppDeepLink();
      if (link) stashAppDeepLink(link);
    };
    keepLink();
    // A mail link can reuse this sign-in tab without loading main.jsx again.
    window.addEventListener("hashchange", keepLink);
    // The app, quietly, once the sign-in screen is up.
    const timer = setTimeout(() => { loadApp().catch(() => { /* fetched again when it is needed */ }); }, APP_PREFETCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", keepLink);
    };
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
