// Helpers the Credentials journeys (e2e/cred*.spec.mjs) share: dates, filling a
// section's form, adding licenses and CME the way a physician does, reading
// what the app hands the browser (downloads, the clipboard, the share sheet),
// and the lab's stand-ins for what a desk browser in a test cannot do itself
// (a camera, speech recognition, a phone's contact picker, a public registry
// or a board's web page). Every stand-in answers on this machine: nothing
// here reaches another host.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { field, lab, openCredentials, sleep, waitFor } from './lab.mjs';

const require = createRequire(import.meta.url);

/** YYYY-MM-DD, `offset` days from today (UTC). */
export const day = (offset = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
/** YYYY-MM-DD, `months` months from today. */
export const monthsFrom = (months) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };

/**
 * Sets one form control found by its label: a value of {index: n} picks the nth
 * option, {label: 'x'} an option by its text, a boolean ticks a checkbox.
 */
export async function fillField(scope, label, value) {
  const control = field(scope, label);
  const tag = await control.evaluate((e) => `${e.tagName}:${e.type || ''}`);
  if (tag.startsWith('SELECT')) {
    if (value && typeof value === 'object' && 'index' in value) return control.selectOption({ index: value.index });
    if (value && typeof value === 'object' && 'label' in value) {
      const labels = await control.locator('option').allInnerTexts();
      const pick = labels.find((l) => l.trim() === value.label) || labels.find((l) => l.includes(value.label));
      return control.selectOption({ label: pick });
    }
    return control.selectOption(String(value));
  }
  if (tag === 'INPUT:checkbox') return value ? control.check() : control.uncheck();
  return control.fill(String(value));
}

/** Fills [label, value] pairs in order. */
export async function fillForm(scope, pairs) {
  for (const [label, value] of pairs) await fillField(scope, label, value);
}

/** Opens Credentials > section and its Add form; returns the dialog. */
export async function openAdd(page, section, dialogName = 'Add') {
  await openCredentials(page, section);
  const dlg = page.getByRole('dialog', { name: dialogName });
  for (let i = 0; i < 3 && !(await dlg.isVisible().catch(() => false)); i++) {
    if (!(await page.getByRole('dialog').count())) await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    await dlg.waitFor({ timeout: 8000 }).catch(() => {});
  }
  await dlg.waitFor({ timeout: 5000 });
  return dlg;
}

/** Presses the dialog's Add/Save and waits for it to close; returns whether it closed (and the refusal text if not). */
export async function saveDialog(dlg, { name = /^(Add|Save)$/, timeout = 20000 } = {}) {
  await dlg.getByRole('button', { name }).last().click();
  const closed = await dlg.waitFor({ state: 'detached', timeout }).then(() => true, () => false);
  const refusal = closed ? '' : ((await dlg.innerText().catch(() => '')).match(/Required[^\n]*|Set a lock code[^\n]*/)?.[0] || 'the form stayed open');
  return { closed, refusal };
}

/** Adds a license through Credentials > Licenses > Add. */
export async function addLicense(page, { type = 'State Medical License', name, number, state, issued, expires, cycleStart, dateUnknown = false } = {}) {
  const dlg = await openAdd(page, 'Licenses');
  await fillField(dlg, 'Type', type);
  if (name) await fillField(dlg, /^(Display Name|What Is It In\?)/, name);
  if (number) await fillField(dlg, 'License #', number);
  if (state) await fillField(dlg, 'State', state);
  if (issued) await fillField(dlg, 'Issued', issued);
  if (expires) await fillField(dlg, /^Expires/, expires);
  if (dateUnknown) await dlg.getByRole('checkbox', { name: /not yet known/ }).check();
  if (cycleStart) await fillField(dlg, /CME Cycle Start/, cycleStart);
  return saveDialog(dlg);
}

/** Adds a CME entry through CME Credits > Add (topics are tag buttons). */
export async function addCme(page, { title, category = 'AMA PRA Category 1', hours, date, provider, topics = [] } = {}) {
  const dlg = await openAdd(page, 'CME Credits', 'Add CME');
  await fillField(dlg, 'Activity / Title', title);
  await fillField(dlg, 'Credit Category', { label: category });
  await fillField(dlg, 'Hours', String(hours));
  await fillField(dlg, 'Date Completed', date);
  if (provider) await fillField(dlg, 'Provider / Institution', provider);
  for (const t of topics) await dlg.getByRole('button', { name: new RegExp(`^(\\u2713 )?${t.replace(/[()/]/g, '.')}$`) }).first().click();
  return saveDialog(dlg);
}

// ── What the app hands the browser ─────────────────────────────────────────

/** Clicks `trigger` and returns the file the page downloads: { name, buffer }. */
export async function download(page, trigger, timeout = 60000) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout }), trigger.click()]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), buffer: await readFile(file) };
}

/** The text of a PDF (pdf.js in this process; the file never leaves the machine). */
export async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: fonts, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const c = await p.getTextContent();
    pages.push(c.items.map((x) => x.str).join(' ').replace(/\s+/g, ' '));
  }
  return { pages: pdf.numPages, text: pages.join('\n'), perPage: pages };
}

/** Rows of the first sheet of an .xlsx (or a .csv) as objects keyed by the header row. */
export async function sheetRows(buffer) {
  const XLSX = await import('xlsx');
  const lib = XLSX.default || XLSX;
  const wb = lib.read(buffer, { type: 'buffer' });
  return lib.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

/** A synthetic .xlsx built here (for imports). `rows` is an array of arrays, the first the header. */
export async function makeXlsx(rows) {
  const XLSX = await import('xlsx');
  const lib = XLSX.default || XLSX;
  const wb = lib.utils.book_new();
  lib.utils.book_append_sheet(wb, lib.utils.aoa_to_sheet(rows), 'Transcript');
  return Buffer.from(lib.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/** Lets the app read and write this context's clipboard, as a physician's browser would after a tap. */
export async function allowClipboard(context) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: lab().urls.appOrigin });
}
export async function clipboardText(page) {
  return page.evaluate(() => navigator.clipboard.readText()).catch((e) => `(clipboard unreadable: ${e.message})`);
}

/**
 * The device's share sheet, stood in for: navigator.share records what it was
 * handed (window.__qaShared). `absent: true` removes it instead, as on a desk
 * browser that has none, so the app takes its copy/download path.
 */
export async function shareSheet(page, { absent = false } = {}) {
  await page.evaluate((none) => {
    window.__qaShared = [];
    const set = (name, value) => Object.defineProperty(navigator, name, { value, configurable: true, writable: true });
    if (none) {
      try { delete Navigator.prototype.share; } catch { /* not configurable */ }
      try { delete Navigator.prototype.canShare; } catch { /* not configurable */ }
      set('share', undefined);
      set('canShare', undefined);
      return;
    }
    set('canShare', () => true);
    set('share', async (d) => { window.__qaShared.push({ title: d.title || '', text: d.text || '', files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) }); });
  }, absent);
}
export async function shared(page) { return page.evaluate(() => window.__qaShared || []); }

// ── Stand-ins for what a test browser cannot do (lab only, all on this machine) ──

/**
 * External pages the app links to (a board's portal, a state guide, a CME
 * provider) answered by a placeholder page on this machine, so a click opens
 * a new tab whose URL can be checked without the browser leaving the lab.
 * Returns the list of URLs opened. Registered after the fixtures' guard, so
 * it takes precedence for these hosts only.
 */
export async function stubExternalPages(context, hosts) {
  const opened = [];
  const hostSet = new Set(hosts);
  await context.route((url) => hostSet.has(url.hostname) || [...hostSet].some((h) => h.startsWith('*.') && url.hostname.endsWith(h.slice(1))), (route) => {
    opened.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>QA lab placeholder</title><p>Placeholder for an external page (QA lab).</p>' });
  });
  return opened;
}

/**
 * The NIH/NLM Clinical Tables mirror of the NPI registry, answered here with
 * synthetic providers (NPIs starting with 0, which the real registry never
 * issues). `providers`: [{ npi, first, last, credential, city, state, licenses: [{ number, state, desc, primary }] }].
 * Returns the request URLs the app made.
 */
export async function stubNpiRegistry(context, providers) {
  const calls = [];
  await context.route((url) => url.hostname === 'clinicaltables.nlm.nih.gov', (route) => {
    const u = new URL(route.request().url());
    calls.push(u.toString());
    const terms = (u.searchParams.get('terms') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const stateQ = (u.searchParams.get('q') || '').match(/addr_practice\.state:(\w\w)/)?.[1];
    const hits = providers.filter((p) => (terms.length === 0 || terms.every((t) => `${p.npi} ${p.first} ${p.last}`.toLowerCase().includes(t)))
      && (!stateQ || p.state === stateQ));
    const extra = {
      NPI: hits.map((p) => p.npi), 'name.first': hits.map((p) => p.first), 'name.last': hits.map((p) => p.last),
      'name.credential': hits.map((p) => p.credential), gender: hits.map(() => 'U'),
      licenses: hits.map((p) => p.licenses.map((l) => ({ lic_number: l.number, lic_state: l.state, is_primary_taxonomy: l.primary ? 'Y' : 'N', taxonomy: { code: '207T00000X', classification: l.desc || 'Neurological Surgery' } }))),
      'addr_practice.line1': hits.map(() => '1 QA Way'), 'addr_practice.line2': hits.map(() => ''), 'addr_practice.city': hits.map((p) => p.city),
      'addr_practice.state': hits.map((p) => p.state), 'addr_practice.zip': hits.map(() => '00000'), 'addr_practice.phone': hits.map(() => '555-010-0000'),
    };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify([hits.length, hits.map((p) => p.npi), extra, hits.map((p) => [p.npi])]) });
  });
  return calls;
}

/**
 * A camera for getUserMedia: a canvas stream with a drawn "card", or a refusal
 * (NotAllowedError) when window.__qaCameraDeny is true. Installed before the
 * app loads (addInitScript), so reload after calling it.
 */
export async function fakeCamera(context) {
  await context.addInitScript(() => {
    window.__qaCameraCalls = 0;
    const md = navigator.mediaDevices || {};
    const real = md.getUserMedia ? md.getUserMedia.bind(md) : null;
    const fake = async () => {
      window.__qaCameraCalls += 1;
      if (window.__qaCameraDeny) { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; }
      const c = document.createElement('canvas');
      c.width = 640; c.height = 400;
      const ctx = c.getContext('2d');
      const draw = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 400); ctx.fillStyle = '#123'; ctx.font = '28px sans-serif'; ctx.fillText('QA synthetic license card', 40, 200); };
      draw();
      setInterval(draw, 100);
      return c.captureStream(10);
    };
    try { Object.defineProperty(navigator, 'mediaDevices', { value: { ...md, getUserMedia: fake, enumerateDevices: async () => [] }, configurable: true }); } catch { if (md) md.getUserMedia = fake; }
    void real;
  });
}

/**
 * The browser's speech engine: window.SpeechRecognition whose instance the test
 * drives. window.__qaSay(text) delivers a final result; stop() ends it.
 */
export async function fakeSpeech(context) {
  await context.addInitScript(() => {
    class QaRecognition {
      constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; this.onresult = null; this.onend = null; this.onerror = null; window.__qaRecognition = this; }
      start() { window.__qaListening = true; }
      stop() { window.__qaListening = false; setTimeout(() => this.onend && this.onend(), 0); }
      abort() { this.stop(); }
    }
    window.SpeechRecognition = QaRecognition;
    window.webkitSpeechRecognition = QaRecognition;
    window.__qaSay = (text) => {
      const r = window.__qaRecognition;
      if (!r || !r.onresult) return false;
      const result = [{ transcript: text, confidence: 0.95 }];
      result.isFinal = true;
      r.onresult({ results: [result], resultIndex: 0 });
      return true;
    };
  });
}

/**
 * A phone's contact picker (Contact Picker API, Chrome on Android): the next
 * select() answers with `contact` ({ name, email, tel }). Installed before the
 * app loads; reload after calling it.
 */
export async function fakeContactPicker(context, contact) {
  await context.addInitScript((c) => {
    window.ContactsManager = function ContactsManager() {};
    const picker = {
      select: async () => [{ name: [c.name], email: [c.email], tel: [c.tel] }],
      getProperties: async () => ['name', 'email', 'tel'],
    };
    try { Object.defineProperty(navigator, 'contacts', { value: picker, configurable: true }); } catch { navigator.contacts = picker; }
  }, contact);
}

/** Waits for a database condition (a read-only query result). */
export async function dbWait(what, fn, timeoutMs = 20000) {
  return waitFor(what, async () => fn() || null, { timeoutMs, intervalMs: 500 }).catch(() => null);
}

/** rgb(...) text -> [r, g, b]. */
export function rgb(text) { return (String(text).match(/\d+/g) || []).slice(0, 3).map(Number); }
/** Roughly which colour family a computed colour is. */
export function hue(text) {
  const [r, g, b] = rgb(text);
  if ([r, g, b].some((x) => Number.isNaN(x))) return 'unknown';
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 40) return 'grey';
  if (r >= g && r >= b) return g > 0.55 * r ? 'amber' : 'red';
  if (g >= r && g >= b) return 'green';
  return 'blue';
}

export { sleep };
