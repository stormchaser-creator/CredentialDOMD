const encoder = new TextEncoder();
export const CREDENTIAL_PORTAL_POLICY = Object.freeze({ enabled: false, maxDocuments: 10, maxFileBytes: 10485760, maxTotalBytes: 31457280, origin: 'https://credentialdomd.com' });
export function base64url(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid encrypted payload');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
export const token = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export function otp() {
  const data = new Uint32Array(1);
  do { crypto.getRandomValues(data); } while (data[0] >= 4294000000);
  return String(data[0] % 1000000).padStart(6, '0');
}
export async function digest(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function createPortalCrypto(secret) {
  // A separately provisioned 256-bit secret, never an API key or JWT secret.
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret) || decode(secret).length !== 32) throw Error('Portal encryption is not configured');
  const material = crypto.subtle.importKey('raw', decode(secret), 'HKDF', false, ['deriveKey']);
  const derive = async (purpose, algorithm, usages) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('credentialdomd-portal-v1'), info: encoder.encode(purpose) }, await material, algorithm, false, usages);
  const aes = derive('mail-outbox', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
  const mac = derive('otp-and-limits', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const hmac = async text => [...new Uint8Array(await crypto.subtle.sign('HMAC', await mac, encoder.encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
  return {
    otpDigest: (invite, version, code) => hmac(`otp:${invite}:${version}:${code}`),
    recipientLimitKey: email => hmac(`recipient-limit:${email}`),
    async seal(mailId, payload) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`outbox:${mailId}`) }, await aes, encoder.encode(JSON.stringify(payload)));
      return `v1.${base64url(nonce)}.${base64url(new Uint8Array(ciphertext))}`;
    },
    async open(mailId, envelope) {
      const [version, nonce, ciphertext, extra] = String(envelope).split('.');
      if (version !== 'v1' || extra) throw Error('Invalid encrypted payload');
      const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(nonce), additionalData: encoder.encode(`outbox:${mailId}`) }, await aes, decode(ciphertext));
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    },
  };
}

export function normalizePortalEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null;
  if (email.split('@')[0].length > 64 || email.startsWith('.') || email.includes('..') || email.includes('.@')) return null;
  return email; // No plus-address stripping, alias inference, or mailbox fallback.
}
export function safeInlineMime(bytes, declared) {
  const start = Array.from(bytes.slice(0, 8));
  if (declared === 'application/pdf' && new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
  if (declared === 'image/png' && start.join(',') === '137,80,78,71,13,10,26,10') return 'image/png';
  if (declared === 'image/jpeg' && start[0] === 255 && start[1] === 216 && start[2] === 255) return 'image/jpeg';
  if (declared === 'text/plain') {
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return 'text/plain; charset=utf-8'; } catch { /* Force download. */ }
  }
  return null;
}
