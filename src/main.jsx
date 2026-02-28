import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/base.css";

// Inject Content Security Policy in production only (Vite dev mode uses inline scripts)
if (import.meta.env.PROD) {
  const connectSources = [
    "'self'",
    "https://generativelanguage.googleapis.com",
    "https://npiregistry.cms.hhs.gov",
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
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src " + connectSources.join(" "),
    "img-src 'self' data: blob:",
  ].join("; ");
  document.head.prepend(csp);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
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
