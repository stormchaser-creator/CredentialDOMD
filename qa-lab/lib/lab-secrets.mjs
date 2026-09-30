// The QA lab's own keys and fake provider secrets, generated once per machine
// into .generated/lab-secrets.json (mode 600, gitignored).
//
// None of these is, or can become, a production value: every one is random
// bytes made here. They only ever authenticate the lab's pieces to each other
// (the mock Clerk signs tokens the local stack trusts; the functions present a
// fake Stripe key the mock Stripe accepts). Prefixes such as sk_live_ exist
// because the functions check them (production identity reads require a
// sk_live_ Clerk key); the mocks, not the prefix, decide what a key can do.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { LAB_SECRETS_JSON, LOCAL_SECRETS_JSON } from './paths.mjs';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Random base62 text of `n` characters (rejection-free: 62 of 256 byte values mapped by modulo of 248). */
export function randomAlnum(n) {
  let out = '';
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248 && out.length < n) out += ALNUM[b % 62];
    }
  }
  return out;
}

const tag = 'qalab';
/** A fresh set of lab secrets (random; nothing is read or written). */
export function generateLabSecrets() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    note: 'QA-lab LOCAL secrets, random, generated on this machine. Not production values; never copy them anywhere else.',
    version: 1,
    createdAt: new Date().toISOString(),
    // The mock Clerk's token key. The local stack trusts it (auth.signing_keys_path in the generated stack config).
    signingKey: { ...jwk, kid: `qa-lab-${randomAlnum(10)}`, alg: 'RS256', use: 'sig', key_ops: ['sign', 'verify'] },
    clerk: {
      secretKey: `sk_live_${tag}${randomAlnum(40)}`,
      // The retired development instance the continuity flow reads (a second mock instance).
      legacySecretKey: `sk_test_${tag}${randomAlnum(40)}`,
      webhookSecret: `whsec_${randomBytes(24).toString('base64')}`,
      instanceId: `ins_${tag}${randomAlnum(20)}`,
    },
    stripe: {
      secretKey: `sk_live_${tag}${randomAlnum(40)}`,
      webhookSecret: `whsec_${tag}${randomAlnum(32)}`,
      portalConfigurationId: `bpc_${tag}${randomAlnum(16)}`,
      coreProductId: `prod_${tag}Core${randomAlnum(8)}`,
      coreLocumProductId: `prod_${tag}CoreLocum${randomAlnum(8)}`,
    },
    resend: {
      apiKey: `re_${tag}_${randomAlnum(32)}`,
      webhookSecret: `whsec_${randomBytes(24).toString('base64')}`,
      supportWebhookSecret: `whsec_${randomBytes(24).toString('base64')}`,
    },
    ai: {
      // Stored in the local app_secrets so ai-proxy has "a key"; the mock ignores it.
      geminiPlaceholder: `qa-lab-placeholder-${randomAlnum(32)}`,
      anthropicPlaceholder: `qa-lab-placeholder-${randomAlnum(32)}`,
    },
    telegram: { botToken: `100000:${tag}${randomAlnum(30)}`, operatorId: '100000' },
    credentialPortalSecret: randomBytes(32).toString('base64url'),
    errorIpPepper: randomAlnum(40),
  };
}

/** Loads the lab secrets, creating them on first use. */
export function labSecrets() {
  if (existsSync(LAB_SECRETS_JSON)) return JSON.parse(readFileSync(LAB_SECRETS_JSON, 'utf8'));
  mkdirSync(path.dirname(LAB_SECRETS_JSON), { recursive: true });
  const secrets = generateLabSecrets();
  writeFileSync(LAB_SECRETS_JSON, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  chmodSync(LAB_SECRETS_JSON, 0o600);
  return secrets;
}

/** The public half of the token key, as a JWKS. */
export function publicJwks(secrets = labSecrets()) {
  const { kty, n, e, kid, alg } = secrets.signingKey;
  return { keys: [{ kty, n, e, kid, alg, use: 'sig' }] };
}

/**
 * Local vault values made in step 1 (apply-schema). WELCOME_HOOK_SECRET must be
 * the vault's welcome_hook_secret, because database triggers send it to the
 * functions (tests/hook-secret-vault.test.mjs describes the production shape).
 */
export function vaultSecrets() {
  if (!existsSync(LOCAL_SECRETS_JSON)) throw new Error('qa-lab/.generated/local-secrets.json is missing: apply the schema first (npm run qa:up)');
  return JSON.parse(readFileSync(LOCAL_SECRETS_JSON, 'utf8')).vault || {};
}
