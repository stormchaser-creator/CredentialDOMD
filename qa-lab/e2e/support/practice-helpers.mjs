// Helpers the Practice journeys share (practice-*.spec.mjs): the Practice
// sub-tabs, the agreement form, the Work tab's Log past time form, and the
// lab's stand-ins for what a phone gives the app and a desk browser does not
// (the share sheet, the microphone, the mail composer), each recording what
// the app handed it. Nothing here reaches beyond this machine: the CallSync
// stand-in answers the app's call to its own edge function in the browser,
// so the function never fetches the real CallSync host (its host is fixed in
// the function and the client, with no lab override).
import { labExec, lit, mockApi, row, signIn, landing, createPhysician, waitForProfile, waitForMemberApp, dismissInterruptions, field, lab } from './lab.mjs';

/** A local calendar day (YYYY-MM-DD) `offset` days from today, as the app's own local-date helpers compute it. */
export function localDay(offset = 0, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Today as the UTC calendar reads it (what `new Date().toISOString().slice(0, 10)` gives). */
export const utcDay = () => new Date().toISOString().slice(0, 10);

/** Practice > <sub-tab> ("Work", "RVUs", "Sched.", "Invoices", "Contracts", "Exp.", "To do"). */
export async function subTab(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click();
}

/** "20:00" -> what the app's time field accepts without the AM/PM chips ("20:00", "9:00a", "12:00p"). */
export function timeText(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (h > 12) return hhmm;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'p' : 'a'}`;
}

/** The "Logging against" select on the Work tab. */
export function loggingAgainst(page) {
  return page.getByText('Logging against', { exact: true }).locator('xpath=..').locator('select').first();
}

/**
 * Practice > Contracts > Add: the agreement form filled the way a physician
 * types it. `blocks`: [{ start, end, startTime?, endTime? }]. `attach`: a
 * file for the form's Upload (the AI read of it is scripted by the caller).
 */
export async function addAgreement(page, a) {
  await subTab(page, 'Contracts');
  const addBtn = page.getByRole('button', { name: /^(Add Agreement|Add)$/ }).first();
  await addBtn.click();
  const d = page.getByRole('dialog', { name: 'Add Agreement' });
  await d.waitFor();
  const set = async (label, value) => { if (value !== undefined && value !== null) await field(d, label).fill(String(value)); };
  await set('Hospital / Facility', a.facility);
  await set('Short name', a.shortName);
  await set('Agency (if any)', a.agency);
  if (a.workState) await field(d, 'Work state (for taxes)').selectOption(a.workState);
  await set('Location', a.location);
  if (a.billTo) await d.getByPlaceholder('billing@hospital.org').fill(a.billTo);
  for (const [i, b] of (a.blocks || []).entries()) {
    await d.getByRole('button', { name: '+ Add a date block' }).click();
    await d.getByLabel(`Block ${i + 1} start date`).fill(b.start);
    if (b.startTime) await d.getByLabel(`Block ${i + 1} start time (optional)`).fill(b.startTime);
    await d.getByLabel(`Block ${i + 1} end date`).fill(b.end);
    if (b.endTime) await d.getByLabel(`Block ${i + 1} end time (optional)`).fill(b.endTime);
  }
  if (a.dayStartHour !== undefined) await field(d, 'Start of the call day').selectOption(String(a.dayStartHour));
  if (a.splitAtDayStart) await d.getByText('Split calls that cross the start of the call day').click();
  await set('Day rate ($/day worked)', a.dayRate);
  await set('Call stipend ($/day)', a.callStipend);
  await set('Stipend covers (hours)', a.stipendHours);
  await set('After-stipend rate ($/hr)', a.overageHourlyRate);
  await set('Hourly rate ($/hr)', a.hourlyRate);
  await set('Flat call rate ($/hr)', a.callHourlyRate);
  await set('Billing increment (min)', a.incrementMinutes);
  await set('Minimum per call (min)', a.minCallMinutes);
  await set('Key terms / notes', a.notes);
  if (a.attach) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), d.getByRole('button', { name: 'Upload', exact: true }).click()]);
    await chooser.setFiles(a.attach);
    // The AI read (scripted or the mock's empty answer) finishes before the form is saved.
    await d.getByText(/Document read|attached|could not be read|no fields/i).first().waitFor({ timeout: 45000 }).catch(() => {});
    if (a.afterAttach) await a.afterAttach(d);
  }
  await d.getByRole('button', { name: 'Add', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
}

/**
 * Work > Log past time, filled as a physician does: type chip, day (Today,
 * Yesterday or a date), start and end times or minutes, notes. `placement`
 * answers the "not in a coverage block" question: 'yes' (default), 'back'
 * (then returns with the form still open), or 'none' (expect none).
 */
export async function logPastTime(page, { type = 'Consult', day = 'Yesterday', start, end, minutes, note, privateNote, contract, placement = 'yes' } = {}) {
  await page.getByRole('button', { name: 'Log past time' }).click();
  const d = page.getByRole('dialog', { name: 'Log past time' });
  await d.waitFor();
  if (contract) await field(d, 'Contract').selectOption({ label: contract });
  await d.getByRole('button', { name: type, exact: true }).click();
  if (day === 'Today' || day === 'Yesterday') await d.getByRole('button', { name: day, exact: true }).click();
  else {
    await d.getByRole('button', { name: 'Other…' }).last().click();
    await d.locator('input[type="date"]').first().fill(day);
  }
  if (start) await field(d, 'Start time').fill(timeText(start));
  if (end) await field(d, 'End time').fill(timeText(end));
  if (minutes) await d.getByPlaceholder('e.g. 60').fill(String(minutes));
  if (note !== undefined) await d.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).fill(note);
  if (privateNote) await d.getByPlaceholder(/patient name \/ MRN reminder/).fill(privateNote);
  await d.getByRole('button', { name: 'Log it' }).click();
  const yes = page.getByRole('button', { name: 'Yes, log it here' });
  const asked = await yes.waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (asked && placement === 'back') {
    await page.getByRole('button', { name: 'Go back' }).click();
    return { asked, dialog: d };
  }
  if (asked) await yes.click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
  return { asked, dialog: d };
}

/**
 * The phone's share sheet, stood in for on a desk browser: navigator.share
 * records what the app shares (files with their bytes as base64) and
 * resolves as a completed share would. window.open records mailto composers.
 */
export async function installShareStandIn(page) {
  await page.evaluate(() => {
    window.__qaShared = [];
    window.__qaOpened = [];
    navigator.canShare = () => true;
    navigator.share = async (data) => {
      const files = [];
      for (const f of data.files || []) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        files.push({ name: f.name, type: f.type, size: f.size, base64: btoa(bin) });
      }
      window.__qaShared.push({ title: data.title || '', text: data.text || '', files });
    };
    const open = window.open;
    window.open = (url, ...rest) => {
      if (/^mailto:/i.test(String(url))) { window.__qaOpened.push(String(url)); return null; }
      window.__qaOpened.push(String(url));
      return open.call(window, url, ...rest);
    };
  });
}
export async function shared(page) { return page.evaluate(() => window.__qaShared || []); }
export async function opened(page) { return page.evaluate(() => window.__qaOpened || []); }

/** The text of a PDF (base64 or bytes), read with pdf.js in Node. */
export async function pdfText(data) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'base64')) : new Uint8Array(data);
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const c = await p.getTextContent();
    out += `${c.items.map((x) => x.str).join(' ')}\n`;
  }
  return out.replace(/[ \t]+/g, ' ');
}

/**
 * The microphone, stood in for: window.SpeechRecognition becomes a recognizer
 * that "hears" `words` as one final result a moment after start(), as the
 * phone's dictation delivers them. Must run before the page's scripts ask for
 * it (an init script) or before the Dictate tap.
 */
export async function installSpeechStandIn(page, words) {
  await page.evaluate((spoken) => {
    class QaRecognition {
      constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; this.onresult = null; this.onend = null; this.onerror = null; this._stopped = false; }
      start() {
        window.__qaMicStarted = (window.__qaMicStarted || 0) + 1;
        setTimeout(() => {
          if (this._stopped) return;
          const alt = { transcript: spoken, confidence: 0.95 };
          const result = [alt]; result.isFinal = true;
          const results = [result];
          this.onresult?.({ resultIndex: 0, results });
        }, 300);
      }
      stop() { if (this._stopped) return; this._stopped = true; setTimeout(() => this.onend?.(), 0); }
      abort() { this.stop(); }
    }
    window.SpeechRecognition = QaRecognition;
    window.webkitSpeechRecognition = QaRecognition;
  }, words);
}

/** Records the bodies the page sends to the ai-proxy function (what the AI provider is asked). */
export function watchAiRequests(page) {
  const seen = [];
  page.on('request', (r) => { if (/\/functions\/v1\/ai-proxy/.test(r.url()) && r.method() === 'POST') seen.push(r.postData() || ''); });
  return seen;
}

/** A device-only localStorage slot of the signed-in member (credentialdomd-<name>:<clerk id>). */
export async function deviceSlot(page, base) {
  return page.evaluate((b) => {
    const id = window.Clerk?.user?.id;
    const raw = id ? localStorage.getItem(`${b}:${id}`) : null;
    try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
  }, base);
}
export async function setDeviceSlot(page, base, value) {
  return page.evaluate(([b, v]) => {
    const id = window.Clerk?.user?.id;
    if (!id) return false;
    localStorage.setItem(`${b}:${id}`, JSON.stringify(v));
    return true;
  }, [base, value]);
}

/**
 * The CallSync feed, stood in for. The app asks its callsync-feed edge
 * function for the feed; this answers that request in the browser with
 * `answer()` ({ status, body }) and records each call, so the function never
 * runs and never contacts CallSync. Registered on the context, so reloads and
 * the once-a-day run on app open are covered.
 */
export async function installCallSyncStandIn(context, answer) {
  const calls = [];
  await context.route('**/functions/v1/callsync-feed', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: 'ok' });
    }
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = null; }
    calls.push({ at: new Date().toISOString(), url: body?.url || null, auth: !!req.headers().authorization });
    const { status = 200, body: out } = await answer(body, calls.length);
    return route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out) });
  });
  return calls;
}

/** An iCal feed shaped like CallSync's: one all-day event per shift ({ date, hospital, coverage, role }). */
export function callSyncIcs(shifts) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//QA Lab//CallSync stand-in//EN'];
  for (const s of shifts) {
    const ymd = s.date.replaceAll('-', '');
    lines.push('BEGIN:VEVENT', `UID:qa-${ymd}-${s.hospital}-${s.role}@qa.credentialdomd.test`, `DTSTART;VALUE=DATE:${ymd}`,
      `SUMMARY:ON CALL — ${s.hospital} ${s.coverage} (${s.role[0].toUpperCase()}${s.role.slice(1)})`,
      `DESCRIPTION:${s.coverage} at ${s.hospital}\\nRole: ${s.role}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * A member whose membership includes Credential but not Practice. The lab
 * cannot sell one while founding places are left (the founding offer
 * includes Practice), so the database records one lifetime Credential grant,
 * the same row and admission the owner's lifetime grant writes, without the
 * Practice row. Setup only; everything after it is the app.
 */
export async function credentialOnlyMember(page, opts = {}) {
  const user = await createPhysician(opts);
  const profile = await waitForProfile(user.id, () => true, 90000);
  labExec(`begin; select set_config('credentialdomd.access_grant','1',true);
    insert into public.access_grants(profile_id, clerk_subject, livemode, scope, kind, source_key, starts_at)
      values (${lit(profile.id)}, ${lit(user.id)}, true, 'credential', 'lifetime', 'qa-lab:credential-only', now());
    update public.profiles set access_status = 'active' where id = ${lit(profile.id)} and access_status = 'pending' and deleted_at is null;
    commit;`);
  await signIn(page, user);
  const where = await landing(page);
  if (where !== 'member') throw new Error(`a Credential-only member should land in the app, landed on: ${where}`);
  await waitForMemberApp(page);
  await dismissInterruptions(page);
  return { user, profile: row(`select * from public.profiles where id = ${lit(profile.id)}`) };
}

/** A Gemini JSON answer queued for the request that contains `match`. */
export async function scriptGeminiJson(json, match) {
  return mockApi('/qa/ai/next', { method: 'POST', body: { provider: 'gemini', response: { json }, match } });
}

/** The lab app's origin, for clipboard permissions. */
export const appOrigin = () => lab().urls.appOrigin;
