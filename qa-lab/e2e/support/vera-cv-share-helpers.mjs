// Steps the Vera, CV and sharing journeys share (vera-cv-share*.spec.mjs).
//
// Everything here stays on this machine:
//   * the device stand-ins record what the app hands to the phone's share
//     sheet, the clipboard and the Mail / Messages apps (navigator.share,
//     navigator.clipboard, window.open of mailto: / sms:), as a physician's
//     phone would receive them, instead of opening anything;
//   * Vera's answers are the lab's mock AI, scripted per question
//     (scriptAi with the question text as its match);
//   * the recipient's administrator page (landing/credential-access.html and
//     public/credential-access/*) is served from the repository files on the
//     lab app's origin, with its endpoint pointed at the lab's API proxy
//     instead of production's project (the only two changes; read below);
//   * a member's own Anthropic key is a lab-generated fake, and calls the app
//     sends to api.anthropic.com with it are answered by the lab's mock
//     Anthropic (the browser never reaches Anthropic).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { REPO_ROOT } from '../../lib/paths.mjs';
import {
  chooseFiles, field, lab, openCredentials, openMore, row, rows, scriptAi, sleep, waitFor,
} from './lab.mjs';

/** A per-run tag for question texts (so scripted answers never match another run's question). */
export function runTag() {
  return `Q${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

export const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

/**
 * Stands in for the phone's share sheet, clipboard, Mail and Messages. Must be
 * installed before the app loads (an init script). What the app hands over is
 * kept in window.__qa: shared [{title,text,files:[{name,type,size}]}], clipboard
 * [text], opened [url]. `canShareFiles: false` models a desktop browser that
 * cannot attach files to a share.
 */
export async function installDeviceStandIns(context, { share = true, canShareFiles = true } = {}) {
  await context.addInitScript(({ share, canShareFiles }) => {
    const qa = { shared: [], clipboard: [], opened: [], shareAttempts: 0 };
    Object.defineProperty(window, '__qa', { value: qa, configurable: true });
    if (share) {
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => {
        qa.shareAttempts += 1;
        const files = await Promise.all([...(data?.files || [])].map(async (f) => ({ name: f.name, type: f.type, size: f.size, head: await f.slice(0, 5).text().catch(() => '') })));
        qa.shared.push({ title: data?.title || '', text: data?.text || '', url: data?.url || '', files });
      } });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => (d?.files?.length ? canShareFiles : true) });
    } else {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    }
    const clip = { writeText: async (t) => { qa.clipboard.push(String(t)); }, readText: async () => qa.clipboard.at(-1) || '' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clip });
    const open = window.open.bind(window);
    window.open = (url, target, features) => {
      qa.opened.push(String(url));
      if (/^(mailto|sms|tel):/i.test(String(url))) return null;
      return open(url, target, features);
    };
  }, { share, canShareFiles });
}

/** What the device stand-ins recorded so far. */
export async function deviceLog(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__qa || { shared: [], clipboard: [], opened: [] })));
}

/** A minimal valid Word document (.docx) whose only text is `text` (synthetic). */
export async function syntheticDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replace(/[<&>]/g, ' ')}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ── Vera ────────────────────────────────────────────────────────────────────

export const veraBox = (page) => page.getByRole('textbox', { name: /Ask Vera anything/ });

/** More > Vera, waiting for the composer. */
export async function openVera(page) {
  await openMore(page, 'Vera');
  await veraBox(page).waitFor({ timeout: 30000 });
}

/**
 * Asks Vera `question` (typed, Send) after queuing the mock model's answer for
 * exactly that question: { reply, actions }. Returns true once `expectText`
 * (default: the reply's first 40 characters) is on screen.
 */
export async function askVera(page, question, answer, { expectText, provider = 'gemini', timeoutMs = 60000, attach } = {}) {
  const response = provider === 'anthropic' ? { text: JSON.stringify(answer) } : { json: answer };
  if (answer) await scriptAi(provider, response, question);
  if (attach) {
    await chooseFiles(page, page.getByRole('button', { name: '📎' }), [attach]);
    await page.getByText(`📎 ${attach.name}`).first().waitFor({ timeout: 10000 });
  }
  await veraBox(page).fill(question);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const want = expectText || (answer?.reply || '').slice(0, 40);
  if (!want) return true;
  return page.getByText(want).first().waitFor({ timeout: timeoutMs }).then(() => true, () => false);
}

/** The action card (one per proposed action) whose text matches, with its buttons. */
export function actionCard(page, text) {
  const card = page.locator('div').filter({ hasText: text }).filter({ has: page.getByRole('button', { name: /^(Approve|Dismiss)$/ }) }).last();
  return {
    card,
    approve: card.getByRole('button', { name: 'Approve', exact: true }),
    dismiss: card.getByRole('button', { name: 'Dismiss', exact: true }),
    replyByEmail: card.getByRole('button', { name: 'Reply by email', exact: true }),
  };
}

/** The card's header line once done ("… ✓ done"), or null. */
export async function cardDone(page, header) {
  const done = page.getByText(new RegExp(`${header}.*✓ done`)).first();
  return done.waitFor({ timeout: 15000 }).then(() => true, () => false);
}

// ── Records the journeys set up through the app's own forms ─────────────────

/** Credentials > <section> > Add, fill `values` ({label: value | {select}}), save. */
export async function addRecord(page, section, values, { dialogName } = {}) {
  await openCredentials(page, section);
  const d = dialogName ? page.getByRole('dialog', { name: dialogName }) : page.getByRole('dialog').last();
  for (let attempt = 0; attempt < 3 && !(await d.isVisible().catch(() => false)); attempt++) {
    if (!(await page.getByRole('dialog').count())) await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    await d.waitFor({ timeout: 10000 }).catch(() => {});
  }
  await d.waitFor({ timeout: 5000 });
  for (const [label, value] of Object.entries(values)) {
    const control = field(d, label);
    const tag = await control.evaluate((e) => e.tagName.toLowerCase());
    if (tag === 'select') await control.selectOption(value);
    else await control.fill(String(value));
  }
  await d.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
  await d.waitFor({ state: 'detached', timeout: 20000 });
  await sleep(2000);
}

/**
 * Opens the record's editor from its row (the pencil beside the star) and
 * attaches a file; `fill` ({label: value}) sets fields the editor needs
 * before it will save (a license imported without an expiration date).
 */
export async function attachToRecord(page, section, rowText, file, { fill = {} } = {}) {
  await openCredentials(page, section);
  const star = page.getByRole('button', { name: /(Add to|Remove from) Favorites/ });
  const box = page.locator('tr, div').filter({ hasText: rowText }).filter({ has: star }).last();
  await box.getByRole('button', { name: /(Add to|Remove from) Favorites/ }).first().locator('xpath=..').locator('button').nth(2).click();
  const edit = page.getByRole('dialog', { name: 'Edit' });
  await edit.waitFor();
  await chooseFiles(page, edit.getByRole('button', { name: 'Upload' }), [file]);
  await edit.getByText(file.name).first().waitFor({ timeout: 30000 });
  for (const [label, value] of Object.entries(fill)) await field(edit, label).fill(String(value));
  await sleep(1500);
  await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
  await edit.waitFor({ state: 'detached', timeout: 20000 });
}

/** Waits for the documents row with that name (optionally linked to `linked`). */
export async function waitForDocument(profileId, name, { linked, timeoutMs = 30000 } = {}) {
  return waitFor(`the document ${name}`, async () => {
    const r = row(`select * from public.documents where user_id = '${profileId}' and name = '${name.replace(/'/g, "''")}'`);
    if (!r) return null;
    if (linked && !(r.linked_to || '').includes(linked)) return null;
    if (!r.storage_path) return null;
    return r;
  }, { timeoutMs, intervalMs: 500 }).catch(() => null);
}

/** The share_log rows of a member, newest first. */
export function shareLog(profileId) {
  return rows(`select item_id, item_name, section, method, recipient, sent_at, created_at from public.share_log where user_id = '${profileId}' order by created_at desc`);
}

// ── Anthropic with the member's own key ─────────────────────────────────────

/**
 * Answers the app's calls to https://api.anthropic.com (a member's own key)
 * from the lab's mock Anthropic, with the CORS headers the real API sends, and
 * records each one. Returns the list of recorded calls.
 */
export async function answerAnthropicFromMock(page) {
  const rt = lab();
  const calls = [];
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-expose-headers': '*',
  };
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    calls.push({ method: req.method(), path: u.pathname, key: (req.headers()['x-api-key'] || '').slice(0, 12), body: req.postData() || '' });
    const h = req.headers();
    const response = await route.fetch({ url: `${rt.urls.mock}/anthropic${u.pathname}`, headers: {
      'content-type': 'application/json', 'x-api-key': h['x-api-key'] || '', 'anthropic-version': h['anthropic-version'] || '2023-06-01',
    } });
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
  return calls;
}

// ── The administrator's page (recipient side) ───────────────────────────────

const PORTAL_FILES = path.join(REPO_ROOT, 'public', 'credential-access');
const PORTAL_PAGE = path.join(REPO_ROOT, 'landing', 'credential-access.html');
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.html': 'text/html' };

/** The private page's HTML as the lab serves it: the endpoint's connect-src is the lab's API proxy. */
function administratorPageHtml(rt) {
  return readFileSync(PORTAL_PAGE, 'utf8')
    .replace(/connect-src 'self' https:\/\/[a-z0-9]+\.supabase\.co/, `connect-src 'self' ${rt.urls.apiOrigin}`)
    .replace(/; upgrade-insecure-requests/, '');
}

/**
 * Serves the private administrator page's files (public/credential-access/*)
 * at <lab app>/credential-access/, as package-site.mjs publishes them with the
 * portal switched on (enablePortalConfig), with one lab change: the endpoint
 * is the lab's API proxy instead of production's project. The page itself is
 * put in place by openAdministratorPage. The inline scripts are untouched,
 * so the page's CSP hashes still hold.
 */
export async function serveAdministratorPage(context) {
  const rt = lab();
  const endpoint = `${rt.urls.apiOrigin}/functions/v1/credential-portal`;
  await context.route(new RegExp(`^${rt.urls.appOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/credential-access/[^#?]+`), async (route) => {
    const u = new URL(route.request().url());
    const rel = u.pathname.replace(/^\/credential-access\//, '');
    const file = path.join(PORTAL_FILES, rel);
    if (!rel || !file.startsWith(PORTAL_FILES + path.sep)) return route.fulfill({ status: 404, body: '' });
    let body;
    try { body = readFileSync(file); } catch { return route.fulfill({ status: 404, body: '' }); }
    if (rel === 'portal.mjs') {
      const text = body.toString('utf8');
      const enabled = text.replace(/(export const PORTAL_CONFIG = Object\.freeze\(\{\n {2}enabled: )false(,\n)/, '$1true$2')
        .replace(/endpoint: "https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/credential-portal"/, `endpoint: ${JSON.stringify(endpoint)}`);
      if (!/enabled: true/.test(enabled) || !enabled.includes(endpoint)) throw new Error('the recipient portal config changed shape; the lab cannot serve it');
      body = Buffer.from(enabled);
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body });
  });
  return `${rt.urls.appOrigin}/credential-access/`;
}

/**
 * Opens the private page at <lab app>/credential-access/#invite=<token>.
 *
 * The lab app server does not serve this page (it 404s), and a document the
 * test itself answers (route.fulfill) has no network address, so Chromium's
 * Local Network Access check then refuses every call it makes to the lab's
 * API proxy on 127.0.0.1 ("Permission was denied for this request to access
 * the loopback address space"). So the browser really loads the URL from the
 * lab app server (a loopback response), and the page's own HTML is written
 * into that document, where it runs as published: its CSP meta, its two
 * hashed inline scripts, its bootstrap reading the invite from the hash.
 */
export async function openAdministratorPage(page, token) {
  const rt = lab();
  // A fresh document each time (another invite on the same URL would only change the hash).
  await page.goto('about:blank');
  await page.goto(`${rt.urls.appOrigin}/credential-access/${token ? `#invite=${token}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((html) => { document.open(); document.write(html); document.close(); }, administratorPageHtml(rt));
}

/** The invite token in a portal invitation email's text. */
export function inviteTokenFrom(text) {
  return /credential-access\/#invite=([A-Za-z0-9_-]{43})/.exec(text || '')?.[1] || null;
}
/** The six-digit code in a portal code email's text. */
export function codeFrom(text) {
  return /\b(\d{6})\b/.exec(text || '')?.[1] || null;
}
