// Fixed facts of the QA lab (step 2: sign-in, mocks, functions).
//
// Nothing here is a secret. Every value that must be secret for the lab to be
// honest (the token signing key, the fake provider keys, webhook secrets) is
// generated per machine by lab-secrets.mjs into the gitignored .generated/.

/** Reserved test domain (.test never resolves publicly). Every test physician's address is on it. */
export const LAB_EMAIL_DOMAIN = 'qa.credentialdomd.test';

/**
 * The issuer the lab's mock Clerk puts in every token it mints. A reserved
 * .test host, so a lab token can never be mistaken for a production one, and
 * shaped like production's (https, no port) because the database only accepts
 * that shape for Clerk issuers (clerk_continuity_runs checks).
 */
export const LAB_ISSUER = 'https://clerk.qa.credentialdomd.test';
/** The lab's stand-in for the retired development Clerk instance (continuity source). */
export const LAB_LEGACY_ISSUER = 'https://clerk-legacy.qa.credentialdomd.test';

/** Production's pinned values the lab must replace in its own build only (qa-lab/app/vite.config.mjs). */
export const PRODUCTION_ISSUER = 'https://clerk.credentialdomd.com';
export const PRODUCTION_LEGACY_ISSUER = 'https://dynamic-goshawk-87.clerk.accounts.dev';

/**
 * The origin every edge function pins (CORS, Origin checks, the azp claim).
 * The lab's app server presents requests to the functions as coming from it,
 * exactly as the live app at /app/ does. Browsers never see this origin.
 */
export const APP_PUBLIC_ORIGIN = 'https://credentialdomd.com';

/** The local Supabase stack (CLI defaults, supabase/config.toml). */
export const SUPABASE_API_URL = 'http://127.0.0.1:54321';
/** How containers (edge functions) reach a server on this machine's loopback. */
export const DOCKER_HOST_ALIAS = 'host.docker.internal';

/** First ports tried for the lab's own servers; the next free one is used. */
export const DEFAULT_MOCK_PORT = 54380;
export const DEFAULT_APP_PORT = 54390;

/** Only these hosts may appear in anything the lab points a function or the app at. */
export const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', DOCKER_HOST_ALIAS]);

/** Mount points inside the mock server (one process, one port). Stripe's SDK always calls /v1/ at the root. */
export const MOCK_PATHS = Object.freeze({
  clerk: '/clerk',          // Clerk Backend API (/clerk/v1/...), JWKS (/clerk/.well-known/jwks.json)
  resend: '/resend',        // Resend API (/resend/emails)
  anthropic: '/anthropic',  // Anthropic API (/anthropic/v1/messages)
  gemini: '/gemini',        // Gemini API (/gemini/v1beta/models/...)
  telegram: '/telegram',    // Telegram Bot API (/telegram/bot<token>/sendMessage)
  qa: '/qa',                // the lab's own API: test physicians, sessions, tokens, inbox, Stripe helpers
});

/** Paths the QA app server proxies (same origin as the app, so the browser needs no CORS). */
export const APP_PROXY = Object.freeze({
  supabase: '/__qa/sb',     // -> the local Supabase gateway, Origin presented as APP_PUBLIC_ORIGIN
  mock: '/__qa/mock',       // -> the mock server
});

/** The token template the app asks Clerk for (src/lib/supabase.js). */
export const SUPABASE_TEMPLATE = 'supabase';
