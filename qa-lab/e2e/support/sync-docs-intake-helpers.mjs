// Helpers for the sync / documents / intake journeys
// (sync-docs-intake*.spec.mjs). Everything here talks to this machine only:
// the local stack through ./lab.mjs, the mock server's inbox and inbound
// endpoint, and the browser the fixtures guard.
//
// Nothing here names a real mailbox. The product's own role addresses
// (contacts@, support@ on the product domain) are built from their parts, so
// the public-repo safety test (which allows only docs@ literally) keeps
// holding; they are the product's addresses, not people.
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { GENERATED_DIR } from '../../lib/paths.mjs';
import {
  LAB_EMAIL_DOMAIN, chooseFiles, field, goTab, labExec, mockApi, openCredentials, rows, row, sleep, stamp, syntheticPdf, waitFor,
} from './lab.mjs';

/** The product's own domain, for its role addresses (contacts@, support@). */
export const PRODUCT_DOMAIN = 'credentialdomd.com';
export const productAddress = (local) => `${local}@${PRODUCT_DOMAIN}`;
export const DOCS = productAddress('docs');

/** A synthetic QA mailbox on the reserved domain. */
export const qaMailbox = (prefix) => `${prefix}-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;

/** Mail arriving at an app address (the mock stores it and sends the signed email.received webhook). */
export const inbound = (body) => mockApi('/qa/inbound', { method: 'POST', body, timeoutMs: 180000 });

/** An Authentication-Results header that passes DMARC, SPF and DKIM for `domain` (the lab's authserv-id). */
export const AUTH_PASS = (domain = LAB_EMAIL_DOMAIN) => ({
  'authentication-results': `mx.qa.credentialdomd.test; dmarc=pass header.from=${domain}; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}`,
});

/**
 * A Gmail-style forward of a credentialer's email: the physician's own note on
 * top, then the forwarded header block and the original message.
 */
export function forwardedText({ note = 'Forwarding this, please handle.', fromName, fromAddr, subject, to = 'Physician', body, messageId }) {
  return [
    note,
    '',
    '---------- Forwarded message ---------',
    `From: ${fromName} <${fromAddr}>`,
    `Date: Tue, Sep 29, 2026 at 9:14 AM`,
    `Subject: ${subject}`,
    `To: ${to}`,
    ...(messageId ? [`Message-ID: <${messageId}>`] : []),
    '',
    body,
  ].join('\n');
}

/**
 * The understanding step's reading (email-inbound -> mock Anthropic), scripted
 * for the one request whose body contains `match`.
 */
export async function scriptReading(match, { intent = 'request', asks = [], summary = 'a QA request', confidence = 'high', records = [], attachments = [] }) {
  return mockApi('/qa/ai/next', { method: 'POST', body: {
    provider: 'anthropic', match,
    response: { text: JSON.stringify({ intent, asks, attachments, summary, confidence, records }) },
  } });
}

/**
 * Whether the edge runtime sends the docs@/cme@ understanding step's model call
 * to the lab's mock. That call (supabase/functions/_shared/intakeModelCall.ts)
 * uses the Anthropic SDK with no baseURL, so it goes where ANTHROPIC_BASE_URL
 * says, or to https://api.anthropic.com. The lab's functions environment sets
 * ANTHROPIC_BASE_URL to the mock since 2026-09-30 (qa-lab/lib/functions-env.mjs
 * SDK_HOST_VARIABLES); a lab started before that would send every forward the
 * model is allowed to read to the real API as a count_tokens request, so the
 * journeys check the running stack's config rather than assume.
 */
export function intakeModelRoutedLocally() {
  try {
    const toml = readFileSync(path.join(GENERATED_DIR, 'stack', 'supabase', 'config.toml'), 'utf8');
    const section = toml.split(/^\[edge_runtime\.secrets\]\s*$/m)[1]?.split(/^\[/m)[0] || '';
    const m = /^ANTHROPIC_BASE_URL\s*=\s*"([^"]+)"/m.exec(section);
    if (!m) return false;
    const host = new URL(m[1]).hostname;
    return ['host.docker.internal', '127.0.0.1', 'localhost', 'kong'].includes(host) || host.endsWith('.test');
  } catch { return false; }
}

/**
 * Uses up this synthetic member's daily allowance for the understanding
 * step's model reads (public.ai_reservations, the ledger reserve_ai_call
 * counts; local database, setup only), so the product itself declines the
 * model call and reads every forward with its rules, as it does live once an
 * account is over the day's allowance. Nothing is then sent to any model.
 */
export function useUpIntakeAllowance(profileId) {
  labExec(`insert into public.ai_reservations (user_id, scope, created_at)
    select '${profileId}'::uuid, s, now() from unnest(array['anthropic_intake', 'anthropic_intake_unverified']) s, generate_series(1, 200)`);
  return row(`select count(*)::int as n from public.ai_reservations where user_id = '${profileId}' and scope like 'anthropic_intake%'`).n;
}

/** The inbound ledger row for a message, once processed. */
export async function inboundRow(where, timeoutMs = 90000) {
  return waitFor('the inbound ledger row', async () => {
    const r = row(`select id, route, status, detail, profile_id, subject from public.inbound_emails where ${where} order by created_at desc limit 1`);
    return r && r.status !== 'processing' ? r : null;
  }, { timeoutMs, intervalMs: 1000 });
}

// ── The REST writes the app makes (SYNC-002) ─────────────────────────────────

const columnCache = new Map();
/** The columns of a public table in the local database (production's schema, per qa:parity). */
export function columnsOf(table) {
  if (!columnCache.has(table)) {
    const cols = rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = '${table.replace(/'/g, '')}'`).map((r) => r.column_name);
    columnCache.set(table, new Set(cols));
  }
  return columnCache.get(table);
}

/**
 * Records every PostgREST insert/upsert/update the app sends from `page`
 * (the API proxy's /rest/v1/<table>), with the keys of each row and the answer.
 */
export function watchRestWrites(page) {
  const writes = [];
  page.on('requestfinished', async (req) => {
    try {
      const u = new URL(req.url());
      const m = /\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
      if (!m || !['POST', 'PATCH'].includes(req.method())) return;
      let body = null;
      try { body = req.postDataJSON(); } catch { body = null; }
      const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
      const keys = [...new Set(list.flatMap((r) => Object.keys(r || {})))];
      const res = await req.response();
      let text = '';
      try { text = res ? (await res.text()).slice(0, 300) : ''; } catch { text = ''; }
      writes.push({ table: m[1], method: req.method(), keys, status: res?.status() ?? 0, answer: text });
    } catch { /* page gone */ }
  });
  page.on('requestfailed', (req) => {
    const u = new URL(req.url());
    const m = /\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
    if (!m || !['POST', 'PATCH'].includes(req.method())) return;
    writes.push({ table: m[1], method: req.method(), keys: [], status: 0, answer: `failed: ${req.failure()?.errorText || ''}` });
  });
  return writes;
}

/** Every write whose keys name a column the table does not have (one unknown key rejects the whole row). */
export function unknownColumns(writes) {
  const out = [];
  for (const w of writes) {
    const cols = columnsOf(w.table);
    if (!cols.size) { out.push({ ...w, unknown: ['<no such table>'] }); continue; }
    const unknown = w.keys.filter((k) => !cols.has(k));
    if (unknown.length) out.push({ ...w, unknown });
  }
  return out;
}

// ── Network conditions (browser side only) ───────────────────────────────────

/**
 * Makes the app's requests matching `test(url, method)` fail as a dropped
 * connection would, until the returned function is called. Only the
 * browser's own requests are affected; the lab is untouched.
 */
export async function blockRequests(target, test) {
  let on = true;
  const handler = (route) => {
    const req = route.request();
    if (on && test(new URL(req.url()), req.method())) return route.abort('connectionfailed');
    return route.fallback();
  };
  await target.route('**/*', handler);
  return async () => { on = false; await target.unroute('**/*', handler).catch(() => {}); };
}

/** A REST path of the app's Supabase API (the lab's API proxy). */
export const isRest = (u, table) => u.pathname.startsWith('/rest/v1/') && (!table || u.pathname === `/rest/v1/${table}`);
export const isFunction = (u, name) => u.pathname === `/functions/v1/${name}`;

// ── Files ───────────────────────────────────────────────────────────────────

/** A valid PDF of about `bytes` bytes (a long synthetic text stream), for size and quota checks. */
export function bigPdf(bytes, label = 'QA synthetic large document') {
  const line = `${label} ${'lorem ipsum synthetic text '.repeat(3)}`;
  const n = Math.max(1, Math.ceil(bytes / (line.length + 20)));
  // Varied lines so the bytes differ between files with different labels.
  const text = Array.from({ length: n }, (_, i) => `${line} ${i}`).join(' ');
  return syntheticPdf(text);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A w x h RGB PNG of pseudo-random pixels (does not compress: a real photo's size). */
export function noisyPng(w, h, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s >>> 24; };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rnd();
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A vCard 3.0 file with the given synthetic people. */
export function vcards(people) {
  return people.map((p) => [
    'BEGIN:VCARD', 'VERSION:3.0', `N:${p.last};${p.first};;;`, `FN:${p.first} ${p.last}`,
    ...(p.org ? [`ORG:${p.org}`] : []), ...(p.title ? [`TITLE:${p.title}`] : []),
    ...(p.email ? [`EMAIL;TYPE=INTERNET:${p.email}`] : []), ...(p.phone ? [`TEL;TYPE=CELL:${p.phone}`] : []),
    'END:VCARD',
  ].join('\r\n')).join('\r\n') + '\r\n';
}

/** The entries of a ZIP file (path -> JSZip file). */
export async function readZip(filePath) {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  return zip;
}

// ── App steps ───────────────────────────────────────────────────────────────

/**
 * Credentials > Licenses > Add a license (optionally with a file attached in
 * the Add form). Returns the license row once it is in the database.
 */
export async function addLicense(page, profileId, { type = 'State Medical License', name, number, state = 'CO', expires = '2029-05-31', file } = {}) {
  await openCredentials(page, 'Licenses');
  await page.getByRole('button', { name: 'Add' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add' });
  await dlg.waitFor();
  await field(dlg, 'Type').selectOption(type);
  if (name) await field(dlg, 'Display Name').fill(name);
  if (number) await field(dlg, 'License #').fill(number);
  const st = field(dlg, 'State');
  if (state && await st.count() && await st.isVisible().catch(() => false)) await st.selectOption(state).catch(() => {});
  if (expires) await field(dlg, /^Expires/).fill(expires);
  if (file) {
    await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }), [file]);
    await dlg.getByText(file.name).first().waitFor({ timeout: 30000 });
    await sleep(800);
  }
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.waitFor({ state: 'detached', timeout: 20000 });
  const lic = await waitFor('the license row', async () => row(`select * from public.licenses where user_id = '${profileId}' ${number ? `and license_number = '${number}'` : ''} order by created_at desc limit 1`), { timeoutMs: 30000 });
  let doc = null;
  if (file) doc = await waitFor('the attached document', async () => row(`select * from public.documents where user_id = '${profileId}' and linked_to = 'licenses:${lic.id}' and storage_path is not null`), { timeoutMs: 45000 }).catch(() => null);
  return { lic, doc };
}

/** Opens Documents. */
export const openDocuments = (page) => goTab(page, 'Documents');

/** The text of the whole page, whitespace collapsed. */
export async function pageText(page) { return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' '); }

export { sleep };
