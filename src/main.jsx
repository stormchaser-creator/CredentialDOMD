import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import "./styles/base.css";

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  // Surface clearly in dev — production builds without a key are broken.
  console.error("CredentialDOMD: VITE_CLERK_PUBLISHABLE_KEY is not set. Auth will not work.");
}

// Inject Content Security Policy in production only (Vite dev mode uses inline scripts)
if (import.meta.env.PROD) {
  const connectSources = [
    "'self'",
    "https://generativelanguage.googleapis.com",
    "https://npiregistry.cms.hhs.gov",
    // Clerk frontend API (the *.clerk.accounts.dev / *.clerk.com hosts the SDK calls)
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://clerk-telemetry.com",
    // Clerk's Smart CAPTCHA is Cloudflare Turnstile — its widget posts back here.
    "https://challenges.cloudflare.com",
  ];
  // Include the Supabase project URL if configured
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  if (supabaseUrl) {
    connectSources.push(supabaseUrl);
  }

  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'self'",
    // Clerk injects a small bootstrap script that needs to run on the page.
    // Cloudflare Turnstile (Clerk's CAPTCHA) ships its bootstrap from challenges.cloudflare.com.
    "script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src " + connectSources.join(" "),
    "img-src 'self' data: blob: https://img.clerk.com",
    // Turnstile renders the challenge in an iframe from challenges.cloudflare.com.
    "frame-src https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
  ].join("; ");
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
      >
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
