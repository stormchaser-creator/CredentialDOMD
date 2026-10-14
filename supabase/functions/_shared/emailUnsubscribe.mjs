// Unsubscribe links for the emails CredentialDOMD sends people who have not
// asked for them one by one (today: the reminders to an account that signed
// up and did not pay, which are OFF). Pure code, run by node in the tests and
// by Deno in supabase/functions/email-unsubscribe.
//
// THE TOKEN. One per recipient and list, made with HMAC SHA 256:
//
//   v1.<list code>.<profile id, 16 bytes base64url>.<HMAC, 32 bytes base64url>
//
// The MAC covers the version, the list and the profile id, under the edge
// function secret EMAIL_UNSUBSCRIBE_SECRET (its own secret, at least 32
// characters; see the function's header for how it is set). No email address
// or name is in it, and nobody can make one for another profile id or another
// list without the secret. It does not expire: an unsubscribe link has to keep
// working long after the email went out, and acting on it again changes
// nothing (the opt out is recorded once, email_opt_outs). The same profile and
// list always give the same token, so a replay is the same request again.
// EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS, when set, is also accepted, so the secret
// can be rotated without breaking links already sent.
//
// THE LINK. https://credentialdomd.com/api/unsubscribe?t=<token>, the first
// party Worker relay (cloudflare/credentialdomd-api/worker.js), because the
// Supabase gateway serves HTML from *.supabase.co as text/plain.
//
//   GET   a small page with one button. It records nothing: mail scanners
//         (Safe Links, Proofpoint, Mimecast) fetch links before a person does.
//   POST  the button (form field t), or RFC 8058 one click from the mail
//         provider (List-Unsubscribe=One-Click in the body, token in the
//         query). Either records the opt out.

export const UNSUBSCRIBE_BASE = 'https://credentialdomd.com/api/unsubscribe';
export const SIGNUP_REMINDERS = 'signup_reminders';

// list -> the short code in the token and what the page calls it.
export const OPT_OUT_LISTS = Object.freeze({
  [SIGNUP_REMINDERS]: Object.freeze({ code: 'sr', label: 'reminders about finishing your CredentialDOMD membership' }),
});
const LIST_BY_CODE = new Map(Object.entries(OPT_OUT_LISTS).map(([list, { code }]) => [code, list]));

const VERSION = 'v1';
const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 120;
const MAX_BODY_LENGTH = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

const enc = new TextEncoder();

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  if (typeof text !== 'string' || !B64URL.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    // Only the canonical spelling: a second spelling of the same bytes would be a second token.
    return toB64url(bytes) === text ? bytes : null;
  } catch { return null; }
}

const uuidBytes = id => Uint8Array.from(id.replace(/-/g, '').match(/../g), h => parseInt(h, 16));
const bytesUuid = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

const usableSecret = s => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH;

async function mac(secret, list, profileId) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`credentialdomd email unsubscribe ${VERSION}\n${list}\n${profileId}`)));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The token for one profile and list. Throws without a usable secret. */
export async function mintUnsubscribeToken({ profileId, list = SIGNUP_REMINDERS, secret } = {}) {
  const id = String(profileId || '').toLowerCase();
  if (!UUID.test(id)) throw Error('A profile id is required');
  const entry = OPT_OUT_LISTS[list];
  if (!entry) throw Error('Unknown email list');
  if (!usableSecret(secret)) throw Error('The unsubscribe secret is not set');
  return `${VERSION}.${entry.code}.${toB64url(uuidBytes(id))}.${toB64url(await mac(secret, list, id))}`;
}

/**
 * { profileId, list } for a token made with any of the secrets, or null. A
 * changed character anywhere, another profile id, another list or another
 * secret gives null.
 */
export async function verifyUnsubscribeToken(token, secrets) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const list = LIST_BY_CODE.get(parts[1]);
  const idBytes = fromB64url(parts[2]);
  const given = fromB64url(parts[3]);
  if (!list || !idBytes || idBytes.length !== 16 || !given || given.length !== 32) return null;
  const profileId = bytesUuid(idBytes);
  for (const secret of (Array.isArray(secrets) ? secrets : [secrets]).filter(usableSecret)) {
    if (sameBytes(given, await mac(secret, list, profileId))) return { profileId, list };
  }
  return null;
}

/** The link that goes in the email and in its List-Unsubscribe header. */
export async function unsubscribeUrl({ profileId, list = SIGNUP_REMINDERS, secret, base = UNSUBSCRIBE_BASE } = {}) {
  if (typeof base !== 'string' || !/^https:\/\/[^\s?#]+$/.test(base)) throw Error('An https unsubscribe base is required');
  return `${base}?t=${encodeURIComponent(await mintUnsubscribeToken({ profileId, list, secret }))}`;
}

/** RFC 2369 and RFC 8058 headers for a message whose unsubscribe link is url. */
export function listUnsubscribeHeaders(url) {
  if (typeof url !== 'string' || !/^https:\/\/[^\s<>,]+$/.test(url)) throw Error('An https unsubscribe link is required');
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

// ─── Pages ──────────────────────────────────────────────────────────────────

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} | CredentialDOMD</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:48px 20px; background:#f7f8fa; color:#1a1a1a;
         font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .card { max-width:480px; margin:0 auto; background:#fff; border:1px solid #e3e6ea; border-radius:12px; padding:28px 24px; }
  h1 { font-size:21px; margin:0 0 12px; }
  p { margin:0 0 14px; }
  button { font:inherit; font-weight:600; color:#fff; background:#1f5fbf; border:0; border-radius:8px; padding:12px 22px; cursor:pointer; }
  .foot { margin-top:24px; font-size:13px; color:#6b7280; }
  a { color:#1f5fbf; }
  @media (prefers-color-scheme: dark) {
    body { background:#111418; color:#e8eaed; }
    .card { background:#1a1e24; border-color:#2c323b; }
    .foot { color:#9aa3ad; }
    a { color:#8ab4f8; }
  }
</style>
</head><body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${body}
    <p class="foot">CredentialDOMD &middot; <a href="https://credentialdomd.com">credentialdomd.com</a></p>
  </div>
</body></html>`;
}

export function confirmUnsubscribePage({ list, token, action }) {
  const label = OPT_OUT_LISTS[list]?.label || 'these emails';
  return page('Unsubscribe', `<p>Stop the ${escapeHtml(label)}?</p>
    <form method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <button type="submit">Unsubscribe</button>
    </form>
    <p class="foot">Nothing changes until you press the button.</p>`);
}

export function unsubscribedPage({ list }) {
  const label = OPT_OUT_LISTS[list]?.label || 'these emails';
  return page('You are unsubscribed', `<p>We will not send you any more ${escapeHtml(label)}.</p>`);
}

export function invalidLinkPage() {
  return page('This link is not valid', `<p>This unsubscribe link is incomplete or was changed. Open the link from the email again, or reply to that email and ask us to stop.</p>`);
}

export function failedPage() {
  return page('Not saved yet', `<p>Your request could not be saved just now. Please press the button again in a minute, or reply to the email and ask us to stop.</p>`);
}

// ─── Handler ────────────────────────────────────────────────────────────────

// No script, no outside resource; the form may post only to its own action's origin.
const pageHeaders = action => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${new URL(action).origin}; base-uri 'none'; frame-ancestors 'none'`,
});
const plain = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

async function readForm(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/x-www-form-urlencoded') && !type.startsWith('multipart/form-data')) return new Map();
  const text = await request.text();
  if (text.length > MAX_BODY_LENGTH) throw Object.assign(Error('too large'), { status: 413 });
  try {
    const form = await new Response(text, { headers: { 'content-type': request.headers.get('content-type') } }).formData();
    return new Map([...form.entries()].filter(([, v]) => typeof v === 'string'));
  } catch { return new Map(); }
}

/**
 * The email-unsubscribe function. secrets(): [current, previous]. store.record
 * (profileId, list, source) records the opt out once and may be called again
 * for the same pair (record_email_opt_out). actionUrl: where the page's form
 * posts (the first party relay).
 */
export function createEmailUnsubscribeHandler({ secrets, store, actionUrl = UNSUBSCRIBE_BASE, log = console }) {
  // https, or plain http on this machine only (a local lab relay).
  if (typeof actionUrl !== 'string' || !/^(https:\/\/[^\s?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[^\s?#]*)$/.test(actionUrl)) throw Error('An https action is required');
  const html = (status, body) => new Response(body, { status, headers: pageHeaders(actionUrl) });
  return async function handle(request) {
    const url = new URL(request.url);
    const keys = (secrets() || []).filter(usableSecret);
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
    }
    // Fail closed: without its secret no token can be checked.
    if (!keys.length) {
      log.error('email-unsubscribe: EMAIL_UNSUBSCRIBE_SECRET is not set');
      return html(503, failedPage());
    }

    if (method !== 'POST') {
      const token = url.searchParams.get('t') || '';
      const found = await verifyUnsubscribeToken(token, keys);
      return found ? html(200, confirmUnsubscribePage({ list: found.list, token, action: actionUrl })) : html(400, invalidLinkPage());
    }

    let form;
    try { form = await readForm(request); } catch (e) { return plain(e.status || 400, 'bad request'); }
    const oneClick = form.get('List-Unsubscribe') === 'One-Click';
    const token = url.searchParams.get('t') || form.get('t') || '';
    const found = await verifyUnsubscribeToken(token, keys);
    if (!found) return oneClick ? plain(400, 'invalid link') : html(400, invalidLinkPage());
    try {
      await store.record(found.profileId, found.list, oneClick ? 'one_click' : 'page');
    } catch (e) {
      // The id is a random uuid, not a person; no token or address is logged.
      log.error('email-unsubscribe: record failed', e instanceof Error ? e.message : String(e));
      return oneClick ? plain(500, 'not saved') : html(500, failedPage());
    }
    return oneClick ? plain(200, 'unsubscribed') : html(200, unsubscribedPage({ list: found.list }));
  };
}
