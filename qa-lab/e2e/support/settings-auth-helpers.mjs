// Helpers for the settings and sign-in journeys (settings-auth*.spec.mjs):
// the Setup board (desk rail and phone accordion), the Profile & settings
// page, a phone-sized browser, and the lab-only stand-ins these journeys put
// in front of public registers so that nothing leaves this machine.
//
// Everything here talks to this machine only. The registry answers below are
// synthetic (a made-up NPI, a made-up physician, reserved .test addresses);
// they are served by Playwright inside the journey's own browser and never
// reach NLM, NPPES, CMS or PubMed.
import { guardContext, watchPage } from './fixtures.mjs';
import { goTab, openMore, row, sleep, waitForMemberApp } from './lab.mjs';

// ── Setup board ────────────────────────────────────────────────────────────

/** More > Setup, waiting for the page heading. */
export async function openSetupPage(page) {
  await openMore(page, 'Setup');
  await page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 30000 });
}

/** Opens a task row's "…" menu and taps one of its choices. */
export async function taskMenu(page, label, choice) {
  await page.getByRole('button', { name: `More for ${label}` }).first().click();
  await page.getByRole('button', { name: choice, exact: true }).first().click();
}

/** The progress line under the strip: { label, done, total, skipped, left } or null. */
export async function stripCounts(page) {
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const m = /(Protected|[A-Z][a-z]+(?: [a-z]+)*): (\d+) of (\d+) done(?: · (\d+) skipped)?/.exec(text);
  if (!m) return null;
  const left = /Nothing left\.|(\d+) left/.exec(text.slice(m.index));
  return { label: m[1], done: Number(m[2]), total: Number(m[3]), skipped: Number(m[4] || 0), left: left ? (left[1] ? Number(left[1]) : 0) : null };
}

/** The profile's stored setup board state (profiles.setup_state), parsed. */
export function setupStateOf(profileId) {
  const r = row(`select setup_state from public.profiles where id = '${profileId}'`);
  return r?.setup_state || null;
}

/** Waits until the debounced setup write (1.2 s) has landed and `predicate(state)` holds. */
export async function waitForSetupState(profileId, predicate, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = setupStateOf(profileId);
    if (last && predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

/**
 * The Setup count on Home's card ("Setup · 2 of 6"), the More tile and the Credentials rail.
 * `homeRegression` is Home's other one-line form: once Protected was stamped and a
 * Protected row with a regression line has come undone, Home names it instead of
 * counting ("Setup: your DEA registration is no longer on file", SetupCard.jsx Form D,
 * tier1Regressed), and `home` is then null.
 */
export async function setupCountsEverywhere(page) {
  const grab = (text, re) => { const m = re.exec(text.replace(/\s+/g, ' ')); return m ? `${m[1]} of ${m[2]}` : null; };
  await goTab(page, 'Home');
  await sleep(800);
  // Home's card: "Setup · n of m" (Protected unfinished, or the one-line form once it was stamped)
  // or "Packet setup · n of m" (Protected finished, the packet left).
  const homeText = await page.locator('body').innerText();
  const home = grab(homeText, /[Ss]etup · (\d+) of (\d+)/);
  const homeRegression = (/Setup: ([^›\n]{1,120}?)\s*›/.exec(homeText) || [])[1]?.trim() || null;
  await goTab(page, 'More');
  await sleep(500);
  const more = grab(await page.getByRole('button', { name: /Setup Get everything on file/ }).first().innerText().catch(() => ''), /(\d+) of (\d+)/);
  await goTab(page, 'Credentials');
  await sleep(800);
  const railButton = page.getByRole('button', { name: /Setup.*\d+ of \d+/ }).first();
  const rail = grab(await railButton.innerText().catch(() => ''), /(\d+) of (\d+)/);
  return { home, homeRegression, more, rail };
}

// ── Profile & settings ─────────────────────────────────────────────────────

export async function openSettings(page) {
  await openMore(page, 'Profile & settings');
  await page.getByRole('heading', { name: 'Profile & settings' }).first().waitFor({ timeout: 30000 });
}

/** The card (a settings section) whose heading is `title`. */
export function settingsCard(page, title) {
  return page.locator('div').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
}

/** Reload and wait for the member app, as a physician coming back would. */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
}

// ── Browsers ──────────────────────────────────────────────────────────────

/**
 * A phone-sized browser (375 x 812, touch), guarded like every journey
 * context: nothing may leave this machine. The caller closes it.
 */
export async function phoneBrowser(browser, report) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  await guardContext(context, report);
  const page = await context.newPage();
  watchPage(page, report);
  return { context, page };
}

// ── Synthetic public registers (served inside the journey's browser) ──────

/**
 * Answers the NLM Clinical Tables NPI mirror (what the production build asks,
 * src/utils/npiLookup.js) with one synthetic physician, in the browser only.
 * `licenses` = [{ state, number, primary }]. Returns a counter of the lookups.
 */
export async function serveSyntheticRegistry(page, person) {
  const calls = { count: 0, urls: [] };
  const extra = {
    NPI: [person.npi], 'name.first': [person.first], 'name.last': [person.last], 'name.credential': [person.credential || 'MD'],
    gender: ['U'],
    licenses: [(person.licenses || []).map((l, i) => ({
      taxonomy: { code: '207T00000X', classification: 'Neurological Surgery' }, lic_number: l.number, lic_state: l.state,
      is_primary_taxonomy: i === 0 ? 'Y' : 'N',
    }))],
    'addr_practice.line1': ['1 QA Registry Way'], 'addr_practice.line2': [''], 'addr_practice.city': ['Testville'],
    'addr_practice.state': [person.state || 'CO'], 'addr_practice.zip': ['80202'], 'addr_practice.phone': ['5550100199'],
  };
  await page.route('https://clinicaltables.nlm.nih.gov/**', async (route) => {
    calls.count += 1;
    calls.urls.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([1, [person.npi], extra]) });
  });
  return calls;
}

/**
 * A synthetic public-record envelope in the shape supabase/functions/public-record
 * returns (normalize.ts buildEnvelope). `failPubmed` reports PubMed as down.
 */
export function syntheticEnvelope({ npi, failPubmed = false, fetchedAt = new Date().toISOString() }) {
  const source = (id, name) => ({ name, url: '', fetchedAt });
  const findings = [
    { id: `nppes:license:NM|QAPR${npi.slice(-4)}`, section: 'licenses', kind: 'stateLicense', label: `NM medical license QAPR${npi.slice(-4)}`,
      detail: 'The NPI registry carries this license number under your taxonomy record. It does not carry the issue or expiration date, so add the expiration date from your license before you save it.',
      fields: { type: 'State Medical License', name: 'NM Medical License', licenseNumber: `QAPR${npi.slice(-4)}`, state: 'NM', notes: 'Imported from NPPES NPI Registry (Neurological Surgery)' },
      needs: ['expirationDate'], source: source('nppes', 'NPPES NPI Registry'), confidence: 'record' },
    { id: 'cms:education:medicalSchool', section: 'education', kind: 'medicalSchool', label: 'Qa State University School of Medicine, class of 2010',
      detail: 'Medicare lists your graduation year as 2010. Medicare carries the year only, so set the graduation date before you save it.',
      fields: { type: 'Doctor of Medicine (MD)', institution: 'Qa State University School of Medicine', name: 'MD Diploma, Qa State University School of Medicine', notes: 'Medicare lists the graduation year as 2010.' },
      needs: ['graduationDate'], source: source('cmsClinician', 'Medicare Care Compare (Doctors and Clinicians)'), confidence: 'record' },
    { id: 'cms:workHistory:QAORG1', section: 'workHistory', kind: 'practiceOrganization', label: 'Qa Neurosurgery Group (Testville, CO)',
      detail: 'Medicare lists this organization as a practice location enrolled under your NPI. That is evidence you practised there, not a start or end date, so fill in your title and dates before you save it.',
      fields: { employer: 'Qa Neurosurgery Group', city: 'Testville', state: 'CO', description: 'Practice location listed by Medicare Care Compare' },
      needs: [], source: source('cmsClinician', 'Medicare Care Compare (Doctors and Clinicians)'), confidence: 'lead' },
  ];
  const pubmed = { id: 'pubmed:publication:99000001', section: 'publications', kind: 'publication', label: 'A synthetic QA paper on test fixtures',
    detail: 'QA Journal, 2021. Matched by author name only.',
    fields: { pmid: '99000001', url: 'https://pubmed.ncbi.nlm.nih.gov/99000001/', citation: 'Physician Q. A synthetic QA paper on test fixtures. QA Journal. 2021.', year: '2021', name: 'QA Journal 2021: A synthetic QA paper on test fixtures', notes: 'Found on PubMed by author name. Confirm this is your paper.' },
    needs: [], source: source('pubmed', 'PubMed'), confidence: 'lead' };
  const report = (id, name, status = 'ok', count = 1) => ({ id, name, url: '', fetchedAt, status, count });
  return {
    npi, fetchedAt,
    findings: failPubmed ? findings : [...findings, pubmed],
    sources: [report('nppes', 'NPPES NPI Registry'), report('cmsClinician', 'Medicare Care Compare (Doctors and Clinicians)'),
      report('cmsAffiliation', 'Medicare Care Compare (facility affiliations)', 'ok', 0),
      failPubmed ? report('pubmed', 'PubMed', 'error', 0) : report('pubmed', 'PubMed')],
    errors: failPubmed ? [{ source: 'pubmed', message: 'PubMed did not answer (QA lab stand-in)' }] : [],
  };
}

/**
 * Answers the browser's call to the public-record function with synthetic
 * envelopes (`next()` decides each answer), so the edge function never asks
 * the real registers. Returns the recorded request bodies.
 */
export async function servePublicRecord(page, next) {
  const bodies = [];
  const cors = (req) => ({
    'access-control-allow-origin': req.headers().origin || '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  });
  await page.route('**/functions/v1/public-record', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors(req), body: 'ok' });
    let body = null; try { body = req.postDataJSON(); } catch { body = null; }
    bodies.push(body);
    const answer = await next(body, bodies.length);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors(req), body: JSON.stringify(answer) });
  });
  return bodies;
}

/** A small valid PNG of `w` x `h` (a solid colour, synthetic). */
export function solidPng(w = 64, h = 64, rgb = [30, 140, 200]) {
  // Built by hand: PNG signature, IHDR, one IDAT (stored zlib), IEND.
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; } }
  // zlib stored blocks (no compression), max 65535 bytes each.
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, i + 65535);
    const head = Buffer.alloc(5); head[0] = i + 65535 >= raw.length ? 1 : 0; head.writeUInt16LE(part.length, 1); head.writeUInt16LE(~part.length & 0xffff, 3);
    blocks.push(head, part);
  }
  let a = 1, b = 0; for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const adler = Buffer.alloc(4); adler.writeUInt32BE(((b << 16) | a) >>> 0);
  const zlib = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adler]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', Buffer.alloc(0))]);
}
