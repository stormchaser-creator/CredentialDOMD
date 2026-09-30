/**
 * The app's Content-Security-Policy, which main.jsx adds by <meta> in
 * production builds (Vite dev mode uses inline scripts).
 *
 * It lives here rather than inline in main.jsx so a node test can read the
 * exact policy the app ships (tests/app-csp.test.mjs). Pure: the Supabase URL
 * is passed in, never read from import.meta.
 */
import { signedStorageSource } from "./storageLinks.js";

export function appContentSecurityPolicy(supabaseUrl) {
  const connectSources = [
    "'self'",
    "https://generativelanguage.googleapis.com",
    "https://npiregistry.cms.hhs.gov",
    // NIH/NLM mirror of the NPI registry — used in production (NPPES has no CORS)
    "https://clinicaltables.nlm.nih.gov",
    // Clerk frontend API (the *.clerk.accounts.dev / *.clerk.com hosts the SDK calls)
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    // Production Clerk lives on our own domain once the cutover lands.
    "https://clerk.credentialdomd.com",
    "https://accounts.credentialdomd.com",
    "https://clerk-telemetry.com",
    // Clerk's Smart CAPTCHA is Cloudflare Turnstile — its widget posts back here.
    "https://challenges.cloudflare.com",
    // A physician who pastes their own Anthropic key in Settings talks to
    // Claude straight from the browser (aiClient.js points the SDK at
    // api.anthropic.com and only routes through ai-proxy when there is no own
    // key). Without this entry that direct path was blocked in production, so
    // the one route that costs us nothing failed and only the proxy worked.
    "https://api.anthropic.com",
  ];
  // Include the Supabase project URL if configured
  if (supabaseUrl) {
    connectSources.push(supabaseUrl);
  }

  // A ticket screenshot is a signed Storage link on the Supabase URL. Only
  // that path is allowed, never the whole host (utils/storageLinks.js).
  const imageSources = ["'self'", "data:", "blob:", "https://img.clerk.com"];
  const signedStorage = signedStorageSource(supabaseUrl);
  if (signedStorage) imageSources.push(signedStorage);

  return [
    "default-src 'self'",
    // Clerk injects a small bootstrap script that needs to run on the page.
    // Cloudflare Turnstile (Clerk's CAPTCHA) ships its bootstrap from challenges.cloudflare.com.
    "script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://clerk.credentialdomd.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src " + connectSources.join(" "),
    "img-src " + imageSources.join(" "),
    // Turnstile renders the challenge in an iframe from challenges.cloudflare.com.
    // blob: is a PDF this page built itself and shows in a frame: a receipt in
    // Expenses, and a file opened in the read-only support view (ticket
    // d45e857c). Only same-origin script can create a blob URL.
    "frame-src blob: https://*.clerk.accounts.dev https://*.clerk.com https://clerk.credentialdomd.com https://accounts.credentialdomd.com https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    // index.html switches plain http://credentialdomd.com/app/ to https before
    // this runs; any http:// request the app still makes is upgraded too.
    "upgrade-insecure-requests",
  ].join("; ");
}
