import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/base.css";

// Inject Content Security Policy in production only (Vite dev mode uses inline scripts)
if (import.meta.env.PROD) {
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self' https://api.anthropic.com https://npiregistry.cms.hhs.gov",
    "img-src 'self' data: blob:",
  ].join("; ");
  document.head.prepend(csp);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register service worker for PWA
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
