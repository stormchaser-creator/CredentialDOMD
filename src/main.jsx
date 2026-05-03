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
    "script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src " + connectSources.join(" "),
    "img-src 'self' data: blob: https://img.clerk.com",
    "frame-src https://*.clerk.accounts.dev https://*.clerk.com",
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

// Register service worker for PWA — force update on new deploys
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", async () => {
    const reg = await navigator.serviceWorker.register("/sw.js");
    if (reg.waiting) {
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    }
    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      if (newWorker) {
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "activated") {
            window.location.reload();
          }
        });
      }
    });
  });
}
