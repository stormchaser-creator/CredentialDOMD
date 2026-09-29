// The environment `supabase functions serve` gives every edge function in the lab.
//
// Rules (tests/qa-lab/functions-env.test.mjs):
//   * Every provider location points at the lab's mock server, reached from the
//     edge-runtime container through host.docker.internal. The functions read
//     these through the base-URL overrides added for the lab (CLERK_API_BASE,
//     CLERK_JWKS_URL, CLERK_PRODUCTION_ISSUER, RESEND_API_BASE, STRIPE_API_BASE,
//     ANTHROPIC_API_BASE, GEMINI_API_BASE, TELEGRAM_API_BASE); production sets
//     none of them, so production keeps the real providers.
//   * Every key and secret is a lab-generated value (lab-secrets.mjs) or a local
//     vault value from step 1. None is, or can be, a production value.
//   * assertLabOnlyEnv refuses to write a file that breaks either rule.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by
// the CLI (the local gateway and its keys) and are not set here.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOCKER_HOST_ALIAS, LAB_ISSUER, LAB_LEGACY_ISSUER, LOCAL_HOSTS, MOCK_PATHS, LAB_EMAIL_DOMAIN } from './lab-config.mjs';
import { labSecrets, vaultSecrets } from './lab-secrets.mjs';
import { FUNCTIONS_ENV } from './paths.mjs';

/**
 * Feature switches as the lab runs them, and why. Where production's value is
 * documented it is used; the rest are ON so the feature can be exercised.
 * Override any of these for one run with QA_FN_<NAME>=value.
 */
export const FEATURE_SWITCHES = Object.freeze({
  CREDENTIALDOMD_BILLING_MODE: ['live', 'production runs live mode (its founding program is livemode = true); the lab\'s Stripe and Clerk are mocks'],
  CLERK_CONTINUITY_ENABLED: ['true', 'production: every sign-in goes through initialize-clerk-profile (VITE_CLERK_CONTINUITY_ENABLED=true in the deploy)'],
  CREDENTIAL_PORTAL_ENABLED: ['true', 'administrator share is live in production (owner-only there; every active lab account here)'],
  CREDENTIAL_PORTAL_PRIVACY_READY: ['true', 'required with CREDENTIAL_PORTAL_ENABLED'],
  CREDENTIAL_PORTAL_OWNER_PROFILES: ['*', 'every active lab account may use the administrator share'],
  MEMBER_SUPPORT_VIEW_ENABLED: ['true', 'member-consented support view is live in production'],
  CREDENTIALDOMD_ADMIN_LIFETIME_ENABLED: ['true', 'on so the admin lifetime screens can be exercised'],
  VERA_SOURCE_RETRIEVAL_ENABLED: ['false', 'docs/VERA-SOURCE-EVIDENCE.md: off at all three gates'],
  SUPPORT_AUTOMATION_MODE: ['disabled', 'the code default; automated support sends are not launched'],
  SUPPORT_OUTBOUND_ENABLED: ['false', 'docs/AUTONOMOUS-SUPPORT-IMPLEMENTATION.md: defaults false'],
  SUPPORT_CANARY_VERIFIED: ['false', 'the code default'],
  INBOUND_AUTHSERV_IDS: [`mx.${LAB_EMAIL_DOMAIN}`, 'the authserv-id lab inbound mail is stamped with'],
});

const SECRET_NAME = /(KEY|SECRET|TOKEN|PEPPER)$/;
const LOCATION_NAME = /(_BASE|_URL|ISSUER)$/;
const PROVIDER_HOSTS = /api\.clerk\.com|clerk\.credentialdomd\.com|clerk\.accounts\.dev|api\.stripe\.com|api\.resend\.com|anthropic\.com|googleapis\.com|telegram\.org|supabase\.co\b/i;

/** The env for the functions, as an ordered object. */
export function functionsEnv({ mockPort, appPort, overrides = process.env, secrets = null, vault = null } = {}) {
  if (!Number.isInteger(mockPort) || !Number.isInteger(appPort)) throw new Error('functionsEnv needs the mock and app ports');
  const s = secrets || labSecrets();
  vault ||= vaultSecrets();
  const mock = `http://${DOCKER_HOST_ALIAS}:${mockPort}`;
  const env = {
    // Clerk: the mock is the issuer's key server and Backend API.
    CLERK_ISSUER: LAB_ISSUER,
    CLERK_PRODUCTION_ISSUER: LAB_ISSUER,
    CLERK_JWKS_URL: `${mock}${MOCK_PATHS.clerk}/.well-known/jwks.json`,
    CLERK_API_BASE: `${mock}${MOCK_PATHS.clerk}`,
    CLERK_SECRET_KEY: s.clerk.secretKey,
    CLERK_WEBHOOK_SECRET: s.clerk.webhookSecret,
    CLERK_CONTINUITY_SOURCE_ISSUER: LAB_LEGACY_ISSUER,
    CLERK_CONTINUITY_SOURCE_SECRET_KEY: s.clerk.legacySecretKey,
    // Stripe: the mock at the root of the mock server (the SDK always calls /v1/).
    STRIPE_API_BASE: mock,
    STRIPE_SECRET_KEY: s.stripe.secretKey,
    STRIPE_WEBHOOK_SECRET: s.stripe.webhookSecret,
    STRIPE_PORTAL_CONFIGURATION_ID: s.stripe.portalConfigurationId,
    STRIPE_CREDENTIAL_V2_PRODUCT_ID: s.stripe.coreProductId,
    STRIPE_CREDENTIAL_PRACTICE_V2_PRODUCT_ID: s.stripe.coreLocumProductId,
    // Resend: every email is captured by the mock (inbox at /qa/inbox).
    RESEND_API_BASE: `${mock}${MOCK_PATHS.resend}`,
    RESEND_API_KEY: s.resend.apiKey,
    RESEND_WEBHOOK_SECRET: s.resend.webhookSecret,
    SUPPORT_RESEND_WEBHOOK_SECRET: s.resend.supportWebhookSecret,
    // AI: mocked by default; the mock forwards to a real provider only with QA_AI=real (capped).
    ANTHROPIC_API_BASE: `${mock}${MOCK_PATHS.anthropic}`,
    GEMINI_API_BASE: `${mock}${MOCK_PATHS.gemini}`,
    // Operator alerts land in the mock too.
    TELEGRAM_API_BASE: `${mock}${MOCK_PATHS.telegram}`,
    TELEGRAM_BOT_TOKEN: s.telegram.botToken,
    TELEGRAM_OPERATOR_ID: s.telegram.operatorId,
    // Local shared secrets.
    WELCOME_HOOK_SECRET: vault.welcome_hook_secret,
    CREDENTIAL_PORTAL_SECRET: s.credentialPortalSecret,
    ERROR_IP_PEPPER: s.errorIpPepper,
    // The lab app server relays /api/confirm-forwarding the way production's Cloudflare worker does.
    FORWARDING_CONFIRM_BASE: `http://127.0.0.1:${appPort}/api/confirm-forwarding`,
  };
  for (const [name, [value]] of Object.entries(FEATURE_SWITCHES)) env[name] = value;
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!key.startsWith('QA_FN_')) continue;
    const name = key.slice(6);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`${key}: not a variable name`);
    if (SECRET_NAME.test(name) || LOCATION_NAME.test(name) || name.startsWith('SUPABASE_')) throw new Error(`${key}: keys, secrets and provider locations cannot be overridden (only feature switches)`);
    env[name] = String(value);
  }
  if (!env.WELCOME_HOOK_SECRET) throw new Error('the local vault has no welcome_hook_secret (apply the schema first)');
  assertLabOnlyEnv(env, s, vault);
  return env;
}

/** Throws unless every location is local and every secret came from this lab. */
export function assertLabOnlyEnv(env, secrets = labSecrets(), vault = vaultSecrets()) {
  const generated = new Set(JSON.stringify(secrets).match(/"[^"]{16,}"/g).map((v) => v.slice(1, -1)));
  for (const v of Object.values(vault)) generated.add(v);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`${name}: value must be one line of text`);
    if (PROVIDER_HOSTS.test(value)) throw new Error(`${name} names a real provider or production host`);
    if (LOCATION_NAME.test(name)) {
      const url = new URL(value);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const local = LOCAL_HOSTS.includes(host) || host.endsWith('.test');
      if (!local) throw new Error(`${name} must point at this machine or a reserved .test host, not ${host}`);
    }
    if (SECRET_NAME.test(name) && !generated.has(value)) throw new Error(`${name} is not a lab-generated value`);
  }
  return env;
}

/** dotenv text (values never contain newlines; see assertLabOnlyEnv). */
export function envFileText(env) {
  return ['# GENERATED by qa-lab/lib/functions-env.mjs for `supabase functions serve`. LOCAL lab values only.',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ''].join('\n');
}

export function writeFunctionsEnv(options) {
  const env = functionsEnv(options);
  mkdirSync(path.dirname(FUNCTIONS_ENV), { recursive: true });
  writeFileSync(FUNCTIONS_ENV, envFileText(env), { mode: 0o600 });
  chmodSync(FUNCTIONS_ENV, 0o600);
  return { file: FUNCTIONS_ENV, env };
}
