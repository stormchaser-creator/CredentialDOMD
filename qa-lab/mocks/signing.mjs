// Signatures the lab's mocks produce, each in its real provider's format:
//   * RS256 JWTs (Clerk session and template tokens), verifiable with the JWKS
//     the mock Clerk serves; the local Supabase stack trusts the same key.
//   * Svix webhook signatures (Clerk and Resend webhooks).
//   * Stripe-Signature headers (Stripe webhooks).
// tests/qa-lab/mocks.test.mjs checks each with the provider's own
// library (jose, svix, stripe) at the versions the edge functions import.
import { createHmac, createPrivateKey, sign } from 'node:crypto';

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** Signs `claims` as an RS256 JWT with the lab key (a private JWK with kid). */
export function signJwt(claims, jwk) {
  const header = { alg: 'RS256', typ: 'JWT', kid: jwk.kid };
  const data = `${b64url(header)}.${b64url(claims)}`;
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  return `${data}.${sign('sha256', Buffer.from(data), key).toString('base64url')}`;
}

/** Decodes a JWT's payload without verifying it (display and tests only). */
export function decodeJwt(token) {
  const [, payload] = String(token).split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/** Svix headers for `body` (a string) signed with a whsec_ secret. */
export function svixHeaders(secret, body, { id, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  if (!/^whsec_/.test(secret)) throw new Error('a Svix secret starts with whsec_');
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
}

/** A Stripe-Signature header for `payload` (the exact body string). */
export function stripeSignature(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}
