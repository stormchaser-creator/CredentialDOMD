import { captureLaunchInvitation } from "./utils/launchInvitation.js";
import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider, useUser } from "@clerk/clerk-react";
import App from "./App";
import { install as installErrorReporting, ErrorBoundary, setErrorUser } from "./lib/errorReport";
import "./styles/base.css";
import { sweepLapsedQueues, sweepSignOutIntents, watchSignOutIntents, sweepPendingOfflinePurges } from "./utils/storageScope";
import { SIGN_IN_LOCALIZATION } from "./utils/signInMethods";
import { appContentSecurityPolicy } from "./utils/appCsp";
import { setInvoiceHandoffPurge } from "./utils/storageScope";
import { purgeHandoffStores, sweepHandoffPurges } from "./utils/invoiceHandoffStore.js";

// Global error sink (window.onerror + unhandledrejection -> report-error
// function -> public.client_errors). Installed before anything renders so a
// crash inside Clerk or App init is still captured.
captureLaunchInvitation();
installErrorReporting();
// Sign out and Delete All My Data remove the invoice hand-off notes with the
// account's other keys (utils/invoiceHandoffStore.js). Its IndexedDB half,
// when an earlier page could not finish it, is finished now.
setInvoiceHandoffPurge(purgeHandoffStores);
sweepHandoffPurges().catch(() => {});
// Writes a lapsed session left on this device whose account never came back
// (utils/storageScope.js purgeUserStorage) go after their time limit.
sweepLapsedQueues();
// A Sign out's marker names its account, so it is removed right after the
// purge; tabs keep what they need in memory. Note other tabs' markers as
// they are written, and remove any a closed tab left past its two minutes
// (utils/storageScope.js SIGNOUT_INTENT_BASE).
watchSignOutIntents();
sweepSignOutIntents();
// A Sign out or data deletion whose IndexedDB half could not be reached then
// (the store would not open) is finished now, before any account loads
// (utils/storageScope.js OFFLINE_PURGE_BASE).
sweepPendingOfflinePurges().catch(() => {});

// Attaches the Clerk user id to error reports once auth resolves. Lives
// inside ClerkProvider so it can use the hook without touching App.
// eslint-disable-next-line react-refresh/only-export-components
function ErrorUserSync() {
  const { isLoaded, user } = useUser();
  React.useEffect(() => {
    if (isLoaded) setErrorUser(user?.id || null);
  }, [isLoaded, user?.id]);
  return null;
}

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  // Surface clearly in dev — production builds without a key are broken.
  console.error("CredentialDOMD: VITE_CLERK_PUBLISHABLE_KEY is not set. Auth will not work.");
}

// Inject Content Security Policy in production only (Vite dev mode uses inline scripts).
// The policy itself is utils/appCsp.js, so a node test reads what ships.
if (import.meta.env.PROD) {
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = appContentSecurityPolicy(import.meta.env.VITE_SUPABASE_URL);
  document.head.prepend(csp);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ClerkProvider
        publishableKey={CLERK_PUBLISHABLE_KEY}
        // The app is mounted at /app/ on gh-pages, so all Clerk-managed routes
        // hang off that base.
        signInUrl="/app/"
        signUpUrl="/app/"
        afterSignOutUrl="/app/"
        signInFallbackRedirectUrl="/app/"
        signUpFallbackRedirectUrl="/app/"
        localization={SIGN_IN_LOCALIZATION}
      >
        <ErrorUserSync />
        <App />
      </ClerkProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// Register service worker for PWA. The path is BASE_URL-relative because the
// app deploys under /app/ on gh-pages — the old hardcoded "/sw.js" 404'd
// there, so production never actually had a service worker. Update detection
// and the refresh UX live in components/shared/UpdatePrompt.jsx; this only
// registers and periodically nudges the registration.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register(
        `${import.meta.env.BASE_URL}sw.js`
      );
      // Ask the browser to re-check sw.js on each full page load — combined
      // with the build-id stamp in sw.js this makes every deploy detectable.
      reg.update().catch(() => {});
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  });
}
