// Practice > Work: Mark as sent for a large stipend-contract invoice on a phone
// (ticket "Invoicce", fix/sanford-mark-sent da183629).
//
// An invoice went to the agency from an iPhone and nothing recorded it, and
// Mark as sent would not record it either. The account is shaped like the one
// that did it, with SYNTHETIC values only (no real facility, agency, rate,
// date, number or note): one stipend agreement (a call stipend covering the
// first hours, an after-stipend rate, an orientation rate, a 07:00 call-day
// start, three coverage blocks in America/Chicago) and 28 unbilled work
// entries over its first three call days: 2 orientation, 3 rounding, 5
// procedures, 17 short calls (billed at the 15-minute minimum, several after
// midnight on the previous call day) and a sign-out, all written into the lab
// database as another device would have put them there.
//
// Each journey runs on a phone (390 x 844, iPhone user agent, touch) and once
// at a desk (1280 x 900):
//   * localStorage full (every character of this browser's 5,242,880 taken,
//     as offline-storage.spec measures it): Mark as sent with a number and a
//     past sent day;
//   * the membership endpoint (billing-entitlements) failing at the network
//     level for a while after an answer: Mark as sent, kept on the device
//     while the check cannot answer, then on the account once it can;
//   * the same endpoint failing from the page load (no answer this session):
//     Mark as sent says it was refused and why, and records once the endpoint
//     is back and the physician taps again;
//   * localStorage full and a share sheet that never answers (iOS standalone):
//     the preview asks "Did it go out?"; the page is reloaded before anything
//     recorded it, the Work log says the invoice went to the share sheet, is
//     not recorded, and asks again; one tap on "Yes, it was sent" records it
//     (fix/invoice-ios-record).
// Every one checks the database (the invoice row, all 28 entries carrying its
// id), the Work log (every entry billed, nothing left to invoice) and that a
// reload keeps it.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './support/fixtures.mjs';
import {
  accessSnapshot, goTab, labExec, lit, localStorageUse, newMember, pendingOps, row, rows, sleep, waitFor, waitForMemberApp, lab, SHOT_DIR,
} from './support/lab.mjs';
import { localDay, subTab } from './support/practice-helpers.mjs';
import { PHONES, newPhoneMember, phoneTab, phoneUse } from './support/phone-helpers.mjs';
import { iosModelInitScript } from './support/ios.mjs';
import { QA_APP_DIST } from '../lib/paths.mjs';

const TZ = 'America/Chicago';
const ENTRIES = 28;
const CHROMIUM_LOCALSTORAGE_CHARS = 5_242_880;

/** The UTC ISO moment of wall-clock `hhmm` on local day `day` in America/Chicago. */
function chicago(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (shown - guess)).toISOString();
}
const addDays = (day, n) => new Date(Date.UTC(...day.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) + n * 864e5).toISOString().slice(0, 10);
const ymd = (day) => day.replaceAll('-', '');

// [type, call day offset, local start (day offset, HH:MM), minutes logged, description]. Calls under
// 15 minutes bill the 15-minute minimum. A call before 07:00 belongs to the previous call day.
const SHAPE = [
  ['Orientation', 0, [0, '08:15'], 150, null],
  ['Orientation', 0, [0, '11:15'], 240, null],
  ['Rounding', 0, [0, '15:15'], 240, 'QA synthetic rounds'],
  ['Call', 0, [0, '22:40'], 1, 'QA synthetic phone call'],
  ['Call', 0, [1, '01:05'], 7, 'QA synthetic phone call'],
  ['Call', 0, [1, '01:40'], 2, 'QA synthetic phone call'],
  ['Call', 0, [1, '02:10'], 1, 'QA synthetic phone call'],
  ['Rounding', 1, [1, '07:20'], 120, 'QA synthetic rounds'],
  ['Procedure', 1, [1, '09:20'], 120, 'QA synthetic procedure'],
  ['Call', 1, [1, '11:20'], 60, 'QA synthetic phone call'],
  ['Procedure', 1, [1, '12:20'], 330, 'QA synthetic procedure'],
  ['Procedure', 1, [1, '17:50'], 165, 'QA synthetic procedure'],
  ['Call', 1, [1, '22:25'], 1, 'QA synthetic phone call'],
  ['Call', 1, [1, '22:40'], 1, 'QA synthetic phone call'],
  ['Call', 1, [1, '23:05'], 1, 'QA synthetic phone call'],
  ['Call', 1, [2, '00:02'], 1, 'QA synthetic phone call'],
  ['Call', 1, [2, '03:01'], 1, 'QA synthetic phone call'],
  ['Call', 1, [2, '03:12'], 1, 'QA synthetic phone call'],
  ['Call', 1, [2, '03:49'], 1, 'QA synthetic phone call'],
  ['Call', 1, [2, '04:11'], 1, 'QA synthetic phone call'],
  ['Call', 1, [2, '06:40'], 1, 'QA synthetic phone call'],
  ['Rounding', 2, [2, '07:20'], 240, 'QA synthetic rounds'],
  ['Procedure', 2, [2, '11:20'], 210, 'QA synthetic procedure'],
  ['Procedure', 2, [2, '14:50'], 315, 'QA synthetic procedure'],
  ['Call', 2, [2, '22:44'], 1, 'QA synthetic phone call'],
  ['Call', 2, [3, '01:20'], 3, 'QA synthetic phone call'],
  ['Call', 2, [3, '05:26'], 1, 'QA synthetic phone call'],
  ['Sign-out', 2, [3, '06:20'], 135, 'QA synthetic sign-out'],
];

/**
 * The stipend agreement and its 28 unbilled entries, written into the lab database for `pid`. The
 * contract started 14 days ago, so every entry is in the past and the contract is current.
 */
function seedStipendAccount(pid, tag) {
  const start = localDay(-14);
  const contractId = randomUUID();
  const facility = `QA Synthetic Stipend Hospital ${tag}`;
  const coverage = [
    { tz: TZ, start, end: addDays(start, 3), startTime: '16:00', endTime: '07:00' },
    { tz: TZ, start: addDays(start, 41), end: addDays(start, 48), startTime: '06:00', endTime: '06:00' },
    { tz: TZ, start: addDays(start, 95), end: addDays(start, 101), startTime: '06:00', endTime: '06:00' },
  ];
  const values = SHAPE.map(([type, callOff, [dayOff, hhmm], minutes, description], i) => {
    const day = addDays(start, dayOff);
    const startAt = chicago(day, hhmm);
    const endAt = new Date(Date.parse(startAt) + minutes * 60000).toISOString();
    const billed = type === 'Call' && minutes < 15 ? 15 : minutes;
    const created = new Date(Date.parse(endAt) + 60000).toISOString();
    return `(${lit(randomUUID())}, ${lit(pid)}, ${lit(contractId)}, ${lit(type)}, ${lit(day)}, ${lit(addDays(start, callOff))}, ${lit(startAt)}, ${lit(endAt)}, ${minutes}, ${billed}, ${description ? lit(`${description} ${i + 1}`) : 'null'}, ${lit(created)})`;
  });
  labExec(`
    insert into public.locum_contracts (id, user_id, facility, agency, bill_to, start_date, end_date, pay_model, hourly_rate, call_hourly_rate, call_stipend, stipend_hours,
      overage_hourly_rate, orientation_hourly_rate, orientation_fee, orientation_billed, increment_minutes, min_call_minutes, day_start_hour, split_at_day_start, work_state, coverage_periods)
    values (${lit(contractId)}, ${lit(pid)}, ${lit(facility)}, 'QA Synthetic Staffing', 'QA Synthetic Staffing', ${lit(start)}, ${lit(addDays(start, 101))}, 'stipend', 0, 0, 1800, 4,
      210, 190, 0, false, 15, 15, 7, false, 'CO', ${lit(JSON.stringify(coverage))}::jsonb);
    insert into public.work_log (id, user_id, contract_id, type, date, call_day, start_time, end_time, duration_min, billed_min, description, created_at)
    values ${values.join(',\n')};`);
  return { contractId, facility, start };
}

/** Everything the lab holds for the account's invoice `number` and the seeded entries. */
function accountState(pid, contractId, number) {
  const inv = number ? row(`select id, number, method, sent_at, total_amount, entry_ids, period_start, period_end, lines from public.invoices where user_id = ${lit(pid)} and number = ${lit(number)}`) : null;
  const work = rows(`select id, invoice_id from public.work_log where user_id = ${lit(pid)} and contract_id = ${lit(contractId)}`);
  const invoices = rows(`select number from public.invoices where user_id = ${lit(pid)}`).map((r) => r.number);
  const lines = inv ? (Array.isArray(inv.lines) ? inv.lines : JSON.parse(inv.lines || '[]')) : [];
  return {
    inv, invoices, orientationLines: lines.filter((l) => /^Orientation/.test(l.label || '')).length,
    entries: work.length,
    carrying: inv ? work.filter((w) => w.invoice_id === inv.id).length : 0,
    unbilled: work.filter((w) => !w.invoice_id).length,
    entryIds: inv ? (Array.isArray(inv.entry_ids) ? inv.entry_ids.length : JSON.parse(inv.entry_ids || '[]').length) : 0,
  };
}

/** Fills localStorage to its last character with a key the app never reads (another page's data). */
async function fillLocalStorage(page) {
  return page.evaluate(() => {
    const free = () => {
      const key = 'qa-lab-free-probe';
      let lo = 0;
      let hi = 6_000_000;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        try { localStorage.setItem(key, 'x'.repeat(mid)); localStorage.removeItem(key); lo = mid; }
        catch { try { localStorage.removeItem(key); } catch { /* none */ } hi = mid - 1; }
      }
      return lo + key.length;
    };
    let n = 0;
    for (let room = free(); room > 8 && n < 64; room = free(), n += 1) {
      const key = `qa-lab-filler-${n}`;
      try { localStorage.setItem(key, 'f'.repeat(Math.max(1, room - key.length))); } catch { try { localStorage.setItem(key, 'f'.repeat(Math.max(1, room - key.length - 64))); } catch { /* the next round finds less */ } }
    }
    return { free: free(), keys: n };
  });
}

/** The invoice-handoff notes this device kept in IndexedDB (credentialdomd-invoice-handoff / notes). */
// release/goal5 (aa12a8c1): "Did <number> go out?" comes into view with Yes and No when it
// appears (RevealOnShow). Measured as the physician sees it, with nothing scrolled by the
// journey: the question and both buttons lie wholly inside the viewport and inside every
// scroller that holds them, and the point at the centre of each is that element (no sticky top
// bar, tab bar or dialog edge over it). Polled for up to 3 s (the reveal is smooth); the time it
// took is part of the evidence. Then a viewport-only screenshot (what is on the screen, not the
// full page) under the run's shots folder.
async function askInView(page, ask, { shot } = {}) {
  const measure = () => ask.evaluate((root) => {
    const win = root.ownerDocument.defaultView;
    const vw = win.innerWidth; const vh = win.innerHeight;
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    const clips = [];
    for (let p = root.parentElement; p && p !== root.ownerDocument.documentElement; p = p.parentElement) {
      const cs = win.getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) clips.push({ el: p.tagName.toLowerCase() + (p.getAttribute('role') ? `[role=${p.getAttribute('role')}]` : ''), ...r(p) });
    }
    const buttons = [...root.querySelectorAll('button')].filter((b) => /Yes, it was sent|No, it did not go out/.test(b.textContent || ''));
    const title = [...root.querySelectorAll('*')].find((e) => /^Did .+ go out\?$/.test((e.textContent || '').trim()) && !e.querySelector('button')) || root;
    const parts = [['question', title], ...buttons.map((b) => [(b.textContent || '').trim(), b])];
    const out = parts.map(([name, el]) => {
      const b = r(el);
      const inViewport = b.top >= 0 && b.left >= 0 && b.bottom <= vh && b.right <= vw;
      const inClips = clips.every((c) => b.top >= c.top - 1 && b.bottom <= c.bottom + 1);
      const cx = (b.left + b.right) / 2; const cy = (b.top + b.bottom) / 2;
      const hit = cy >= 0 && cy < vh ? root.ownerDocument.elementFromPoint(cx, cy) : null;
      const uncovered = !!hit && (hit === el || el.contains(hit));
      return { name, ...b, inViewport, inClips, uncovered, hit: hit && hit !== el && !el.contains(hit) ? (hit.tagName.toLowerCase() + ':' + (hit.textContent || '').trim().slice(0, 30)) : undefined };
    });
    return { viewport: `${vw}x${vh}`, scrollY: Math.round(win.scrollY), clips, parts: out, buttons: buttons.length, ok: buttons.length === 2 && out.every((p) => p.inViewport && p.inClips && p.uncovered) };
  });
  const start = Date.now();
  let m = await measure();
  while (!m.ok && Date.now() - start < 3000) { await sleep(150); m = await measure(); }
  m.ms = Date.now() - start;
  if (shot) {
    const file = path.join(SHOT_DIR, `${shot.replace(/[^A-Za-z0-9._-]+/g, '_')}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
    m.shot = file;
  }
  return m;
}
const inViewText = (m) => `${m.ok ? 'in view' : 'NOT in view'} at ${m.viewport} after ${(m.ms / 1000).toFixed(1)} s; ${m.parts.map((p) => `${p.name} ${p.top}-${p.bottom}${p.inViewport ? '' : ' off-screen'}${p.inClips ? '' : ' clipped'}${p.uncovered ? '' : ` covered by ${p.hit || 'nothing hit'}`}`).join('; ')}; scrollers ${m.clips.map((c) => `${c.el} ${c.top}-${c.bottom}`).join(', ') || 'none'}${m.shot ? `; screenshot ${path.relative(process.cwd(), m.shot)}` : ''}`;

async function handoffNotes(page) {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'credentialdomd-invoice-handoff')) return [];
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('credentialdomd-invoice-handoff'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      if (!db.objectStoreNames.contains('notes')) return [];
      return await new Promise((resolve) => {
        const t = db.transaction('notes', 'readonly');
        const all = t.objectStore('notes').getAll();
        all.onsuccess = () => resolve(all.result.flat().map((n) => ({ number: n.number, handed: !!n.handed, days: n.days?.length || 0 })));
        all.onerror = () => resolve([]);
      });
    } finally { db.close(); }
  });
}

/**
 * A share sheet that takes the file and never answers (the iOS standalone case): navigator.share
 * records the file's name and never settles.
 */
async function installHangingShare(page) {
  await page.evaluate(() => {
    window.__qaShared = [];
    navigator.canShare = () => true;
    navigator.share = (data) => { window.__qaShared.push({ title: data.title || '', files: (data.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) }); return new Promise(() => {}); };
  });
}

/**
 * The membership endpoint, failing at the network level while `on`: every request to
 * billing-entitlements (the preflight included) is aborted as a dropped connection would be.
 */
async function membershipOutage(context) {
  const state = { on: false, blocked: 0, passed: 0 };
  await context.route(/\/functions\/v1\/billing-entitlements(\?|$)/, async (route) => {
    if (state.on) { state.blocked += 1; return route.abort('internetdisconnected'); }
    state.passed += 1;
    return route.fallback();
  });
  return state;
}

// Exact persisted evidence for this account's deliberately aborted membership
// requests. A different error or a second occurrence remains an unclaimed fault.
async function claimMembershipFault(qa, userId, since, messages, reason) {
  for (const message of messages) {
    await waitFor('the deliberately induced membership report', async () => {
      const found = rows(`select id from public.client_errors where created_at >= ${lit(since)} and auth_user_id = ${lit(userId)} and kind = 'error' and message = ${lit(message)}`);
      return found.length ? found : null;
    }, { timeoutMs: 10000, intervalMs: 250 });
    const until = row('select clock_timestamp() as at').at;
    const reports = rows(`select id, kind, message, auth_user_id from public.client_errors where created_at >= ${lit(since)} and created_at <= ${lit(until)} and auth_user_id = ${lit(userId)} and kind = 'error' and message = ${lit(message)}`);
    qa.intentionalClientErrors(reports, { message, kind: 'error', authUserId: userId, count: 1,
      reason: `${reason} Database fault window: ${since} through ${until}.` });
  }
}

async function checkPracticeAccess(qa, page, userId) {
  await qa.feature('BILL-006', 'The full member has Practice access before the deliberate outage', async () => {
    const snapshot = accessSnapshot(userId);
    qa.check('the current account snapshot grants Practice write', snapshot?.capabilities?.practice?.write === true);
    for (const tab of ['Work', 'RVUs', 'Sched.', 'Invoices', 'Contracts', 'Exp.', 'To do']) {
      qa.check(`Practice shows the "${tab}" sub-tab`, await page.getByRole('button', { name: tab, exact: true }).first().isVisible().catch(() => false));
    }
  });
}

const DEVICES = [
  { name: 'phone', use: phoneUse(390), label: PHONES[390].name },
  { name: 'desk', use: { viewport: { width: 1280, height: 900 } }, label: '1280x900' },
];

for (const device of DEVICES) {
  test.describe(`work invoice mark as sent (${device.name} ${device.label})`, () => {
    test.use(device.use);
    const phone = device.name === 'phone';
    const press = (loc) => (phone ? loc.tap() : loc.click());

    async function member(page, names) {
      return phone ? newPhoneMember(page, names) : newMember(page, names);
    }
    async function openWork(page) {
      if (phone) await phoneTab(page, 'Practice'); else await goTab(page, 'Practice');
      await subTab(page, 'Work');
    }
    async function reopen(page) {
      await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
      await waitForMemberApp(page);
      await openWork(page);
    }
    /** Invoice N unbilled entries > the day picker > Invoice N days: the preview, its number reserved. */
    async function openPreview(page, qa) {
      const cta = page.getByRole('button', { name: new RegExp(`Invoice ${ENTRIES} unbilled entries`) });
      await cta.waitFor({ timeout: 60000 });
      await press(cta);
      const picker = page.getByRole('dialog', { name: 'Which days go on this invoice?' });
      await picker.waitFor();
      const build = picker.getByRole('button', { name: /^Invoice \d+ days?/ });
      const buildLabel = (await build.innerText()).replace(/\s+/g, ' ');
      await press(build);
      const preview = page.getByRole('dialog', { name: 'Invoice preview' });
      await preview.waitFor();
      await preview.getByText('Reserving the invoice number…').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
      const number = ((await preview.innerText()).match(/INV-\d{8}-\d+(-[A-Z0-9]{3})?/) || [null])[0];
      qa.check('the day picker offers the three call days', /^Invoice 3 days: \$[\d,]+\.\d\d$/.test(buildLabel), buildLabel);
      return { preview, buildLabel, number, total: Number((buildLabel.match(/\$([\d,]+\.\d\d)/) || [0, '0'])[1].replace(/,/g, '')) };
    }
    async function markAsSent(preview, { number, day }) {
      await press(preview.getByRole('button', { name: 'Sent it already? Mark as sent' }));
      const num = preview.getByRole('textbox', { name: 'Invoice number' });
      await num.fill(number);
      await preview.getByLabel('Date sent').fill(day);
      return preview.getByRole('button', { name: 'Record as sent', exact: true });
    }
    /** What the Work log shows: entries labelled billed, and whether anything is left to invoice. */
    async function workShows(page, number) {
      await sleep(1500);
      const text = (await page.locator('main, body').first().innerText()).replace(/[ \t]+/g, ' ');
      const cta = await page.getByRole('button', { name: /Invoice \d+ unbilled entr/ }).count();
      // Phone: each entry card's BILLED tag; desk: each row's Invoice status cell names the invoice.
      const billed = phone ? await page.getByText('BILLED', { exact: true }).count() : await page.getByText(number, { exact: true }).count();
      const notInvoiced = (text.match(/Not invoiced/g) || []).length;
      return { cta, billed, notInvoiced, unrecordedBanner: /is not recorded/.test(text) };
    }
    async function checkRecorded(qa, page, { pid, contractId, number, total, sentDay, method }) {
      const state = await waitFor('the invoice and its 28 entries on the account', async () => {
        const s = accountState(pid, contractId, number);
        return s.inv && s.carrying === ENTRIES ? s : null;
      }, { timeoutMs: 120000, intervalMs: 1000 }).catch(() => accountState(pid, contractId, number));
      qa.check(`an invoices row ${number}, method ${method}`, !!state.inv && state.inv.method === method, state.inv ? `${state.inv.number} ${state.inv.method} $${state.inv.total_amount}` : `none; the account's invoices: ${state.invoices.join(', ') || 'none'}`);
      qa.check('the invoice is for the total the day picker showed', !!state.inv && Math.abs(Number(state.inv.total_amount) - total) < 0.005, `${state.inv?.total_amount} vs ${total}`);
      qa.check(`its entry_ids list all ${ENTRIES} entries`, state.entryIds === ENTRIES, `${state.entryIds}`);
      qa.check(`all ${ENTRIES} work_log rows carry its id; none unbilled`, state.carrying === ENTRIES && state.unbilled === 0, JSON.stringify({ carrying: state.carrying, unbilled: state.unbilled, entries: state.entries }));
      if (sentDay) {
        const expected = new Date(`${sentDay}T12:00:00`).toISOString();
        qa.check(`sent_at is the day entered (${sentDay}, local noon)`, !!state.inv && new Date(state.inv.sent_at).toISOString() === expected, `${state.inv?.sent_at} vs ${expected}`);
      }
      // No one-time orientation fee on this agreement (orientation_fee 0), so orientation_billed stays
      // false by design (billing.js: the flag marks that fee); the two orientation entries bill hourly.
      qa.check('the invoice carries the two orientation entries as hourly lines', state.orientationLines === 2, `${state.orientationLines} orientation lines`);
      qa.check('exactly one invoice on the account', state.invoices.length === 1, state.invoices.join(', '));
      const shown = await workShows(page, number);
      await qa.shot(`${number} billed in Work`);
      qa.check(`the Work log shows every entry billed and nothing left to invoice`, shown.cta === 0 && shown.billed >= ENTRIES && shown.notInvoiced === 0, JSON.stringify(shown));
      return state;
    }
    async function checkAfterReload(qa, page, { pid, contractId, number }) {
      await reopen(page);
      const shown = await workShows(page, number);
      const state = accountState(pid, contractId, number);
      await qa.shot(`${number} after reload`);
      qa.check('after a reload: every entry still billed, nothing to invoice, no unrecorded banner', shown.cta === 0 && shown.billed >= ENTRIES && shown.notInvoiced === 0 && !shown.unrecordedBanner, JSON.stringify(shown));
      qa.check('after a reload: the database still has the invoice and all 28 entries on it', !!state.inv && state.carrying === ENTRIES, JSON.stringify({ inv: !!state.inv, carrying: state.carrying }));
      await subTab(page, 'Invoices');
      const listed = await page.getByText(number, { exact: false }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
      qa.check(`the Invoices tab lists ${number}`, listed);
    }

    test(`localStorage full: Mark as sent with a number and a past day records the invoice and bills all 28 entries (${device.name})`, {
      tag: ['@PRAC-002', '@SYNC-003', ...(phone ? ['@phone'] : [])],
    }, async ({ page, qa }) => {
      test.setTimeout(10 * 60 * 1000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const { profile } = await member(page, { firstName: 'Stella', lastName: `Stipend ${device.name}` });
      const seed = seedStipendAccount(profile.id, tag);
      await reopen(page);
      const fill = await fillLocalStorage(page);
      const use = await localStorageUse(page);
      qa.check('lab setup: localStorage is full (24 characters or fewer free)', fill.free <= 24 && use.chars > CHROMIUM_LOCALSTORAGE_CHARS - 200, JSON.stringify({ ...fill, used: use.chars }));
      const number = `INV-${ymd(addDays(seed.start, 3))}-01`;
      const sentDay = addDays(seed.start, 3);

      await qa.feature('PRAC-002', `Mark as sent on a full device (${device.name})`, async () => {
        const { preview, total, number: shownNumber } = await openPreview(page, qa);
        qa.check('the preview has its number', !!shownNumber, shownNumber);
        const record = await markAsSent(preview, { number, day: sentDay });
        qa.check('Record as sent can be tapped', await record.isEnabled());
        await qa.shot('mark as sent form, full device');
        await press(record);
        const said = await page.getByText(`${number} is on the Invoices tab as sent`).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
        qa.check('the app says the invoice is on the Invoices tab as sent and its entries are billed', said);
        await preview.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
        await checkRecorded(qa, page, { pid: profile.id, contractId: seed.contractId, number, total, sentDay, method: 'marked' });
        const alerts = qa.report.dialogs.filter((d) => /not recorded|refused|could not/i.test(d));
        qa.check('no refusal or not-recorded alert', alerts.length === 0, alerts.join(' | '));
      }, { soft: true });

      await qa.feature('SYNC-003', `The marked invoice survives a reload on a full device (${device.name})`, async () => {
        const still = await localStorageUse(page);
        qa.check('localStorage is still full', still.chars > CHROMIUM_LOCALSTORAGE_CHARS - 200, `${still.chars}`);
        await checkAfterReload(qa, page, { pid: profile.id, contractId: seed.contractId, number });
      }, { soft: true });
    });

    test(`membership endpoint failing after an answer: Mark as sent is kept on the device and reaches the account once the endpoint is back (${device.name})`, {
      tag: ['@PRAC-002', '@BILL-006', ...(phone ? ['@phone'] : [])],
    }, async ({ page, qa, context }) => {
      test.setTimeout(10 * 60 * 1000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const outage = await membershipOutage(context);
      const { user, profile } = await member(page, { firstName: 'Otto', lastName: `Outage ${device.name}` });
      const seed = seedStipendAccount(profile.id, tag);
      await reopen(page);
      await sleep(2000);
      await checkPracticeAccess(qa, page, user.id);
      const number = `INV-${ymd(addDays(seed.start, 3))}-01`;
      const sentDay = addDays(seed.start, 2);

      await qa.feature('PRAC-002', `Mark as sent while the membership check cannot answer (${device.name})`, async () => {
        qa.check('lab setup: the membership check answered before the outage', outage.passed > 0, `${outage.passed} answered`);
        const faultSince = row('select clock_timestamp() as at').at;
        outage.on = true;
        // The phone comes back to the app: the check runs, and fails.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await waitFor('a failed membership check', async () => (outage.blocked > 0 ? true : null), { timeoutMs: 20000 }).catch(() => null);
        qa.check('lab setup: the membership check failed at the network level', outage.blocked > 0, `${outage.blocked} blocked`);
        const { preview, total } = await openPreview(page, qa);
        const record = await markAsSent(preview, { number, day: sentDay });
        qa.check('Record as sent can be tapped while the check cannot answer', await record.isEnabled());
        await qa.shot('mark as sent form, membership failing');
        await press(record);
        const said = await page.getByText(`${number} is on the Invoices tab as sent`).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
        const problem = await preview.getByRole('alert').allInnerTexts().catch(() => []);
        qa.check('the app records it (on this device while the check cannot answer)', said, said ? '' : (problem.join(' | ') || 'nothing said'));
        await preview.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
        const shown = await workShows(page, number);
        qa.check('the Work log shows every entry billed at once', shown.cta === 0 && shown.billed >= ENTRIES, JSON.stringify(shown));
        // For a while: the endpoint stays down half a minute more.
        await sleep(30000);
        const during = accountState(profile.id, seed.contractId, number);
        qa.check('lab evidence: the membership endpoint was refused throughout', outage.blocked >= 2, `${outage.blocked} blocked requests`);
        console.log(`qa-lab: during the outage the account had invoice=${!!during.inv}, ${during.carrying} entries on it`);
        outage.on = false;
        await checkRecorded(qa, page, { pid: profile.id, contractId: seed.contractId, number, total, sentDay, method: 'marked' });
        await claimMembershipFault(qa, user.id, faultSince, [
          'Membership check failed (network:membership_information_unavailable)',
          'Save kept on device awaiting membership check (check_failed, invoices)',
          'Save kept on device awaiting membership check (check_failed, workLog)',
        ], 'PRAC-002 deliberately aborts this member\'s membership endpoint after a valid answer, verifies the local invoice and all entries, then restores the endpoint and verifies the saved account copy.');
      }, { soft: true });

      await qa.feature('SYNC-003', `The marked invoice survives a reload after the outage (${device.name})`, async () => {
        await checkAfterReload(qa, page, { pid: profile.id, contractId: seed.contractId, number });
      }, { soft: true });
    });

    test(`membership endpoint failing from the page load: Mark as sent says why it is refused and records once the endpoint is back (${device.name})`, {
      tag: ['@PRAC-002', '@BILL-006', ...(phone ? ['@phone'] : [])],
    }, async ({ page, qa, context }) => {
      test.setTimeout(10 * 60 * 1000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const outage = await membershipOutage(context);
      const { user, profile } = await member(page, { firstName: 'Nora', lastName: `Noanswer ${device.name}` });
      const seed = seedStipendAccount(profile.id, tag);
      const number = `INV-${ymd(addDays(seed.start, 3))}-01`;
      const sentDay = addDays(seed.start, 4);
      await openWork(page);
      await checkPracticeAccess(qa, page, user.id);

      await qa.feature('PRAC-002', `Mark as sent with no membership answer this session (${device.name})`, async () => {
        const faultSince = row('select clock_timestamp() as at').at;
        outage.on = true;
        const downAt = Date.now();
        await reopen(page);
        // The member app opens from this device's copy before the load's first check is sent
        // (2026-10-01, full regression pass 2: Work was open 90 ms before the first refused POST).
        await waitFor('a failed membership check', async () => (outage.blocked > 0 ? true : null), { timeoutMs: 20000 }).catch(() => null);
        qa.check('lab setup: the membership check failed at the network level from the load', outage.blocked > 0, `${outage.blocked} blocked`);
        const { preview, total } = await openPreview(page, qa);
        const record = await markAsSent(preview, { number, day: sentDay });
        qa.check('Record as sent can be tapped (only the membership check may hold it back)', await record.isEnabled());
        await press(record);
        await sleep(1500);
        const said = await page.getByText(`${number} is on the Invoices tab as sent`).first().isVisible().catch(() => false);
        const problem = (await preview.getByRole('alert').allInnerTexts().catch(() => [])).join(' | ');
        await qa.shot('record as sent, no membership answer');
        qa.check('with no answer, the tap is recorded or the form says it was refused and why', said || /Record as sent was refused\. .+/.test(problem), problem || 'nothing said');
        // Keep the endpoint down for 40 seconds, then verify the exact device copy
        // before allowing any membership answer or retry.
        while (Date.now() - downAt < 40000) await sleep(1000);
        const pending = await pendingOps(page);
        const keptInvoice = pending.find(op => op?.collectionKey === 'invoices' && op.payload?.number === number);
        const queuedWork = pending.filter(op => op?.collectionKey === 'workLog');
        const keptWork = keptInvoice?.payload?.id ? queuedWork.filter(op => op.payload?.invoiceId === keptInvoice.payload.id) : [];
        const beforeAnswer = accountState(profile.id, seed.contractId, number);
        qa.check('no invoice or billed entry reaches the account without a membership answer',
          !beforeAnswer.inv && beforeAnswer.carrying === 0 && beforeAnswer.unbilled === ENTRIES,
          JSON.stringify({ invoice: !!beforeAnswer.inv, carrying: beforeAnswer.carrying, unbilled: beforeAnswer.unbilled }));
        if (keptInvoice) {
          qa.check('the device keeps this invoice and all 28 distinct work entries while no answer is available',
            !!keptInvoice.payload.id && keptWork.length === ENTRIES && new Set(keptWork.map(op => op.payload.id)).size === ENTRIES,
            JSON.stringify({ invoice: !!keptInvoice.payload.id, queuedEntries: keptWork.length }));
        } else {
          qa.check('a refused invoice has an explicit reason and no queued invoice work',
            /Record as sent was refused\. .+/.test(problem) && !said && queuedWork.length === 0, problem);
        }
        outage.on = false;
        let taps = 1;
        const recorded = said || await waitFor('Record as sent to record', async () => {
          if (await page.getByText(`${number} is on the Invoices tab as sent`).first().isVisible().catch(() => false)) return true;
          if (await preview.isVisible().catch(() => false)) {
            const again = preview.getByRole('button', { name: 'Record as sent', exact: true });
            if (await again.isEnabled().catch(() => false)) { await press(again).catch(() => {}); taps += 1; }
          }
          return null;
        }, { timeoutMs: 120000, intervalMs: 5000 }).catch(() => false);
        qa.check('once the endpoint is back, Record as sent records it', !!recorded, `${taps} taps; ${outage.blocked} blocked, ${outage.passed} answered`);
        await preview.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
        await checkRecorded(qa, page, { pid: profile.id, contractId: seed.contractId, number, total, sentDay, method: 'marked' });
        await claimMembershipFault(qa, user.id, faultSince, [
          'Membership check failed (network:membership_information_unavailable)',
          ...(keptInvoice ? [
            'Save kept on device awaiting membership check (no_answer, invoices)',
            'Save kept on device awaiting membership check (no_answer, workLog)',
          ] : ['Save refused (no_answer, invoices)']),
        ], 'PRAC-002 deliberately aborts the membership endpoint from this member\'s page load, proves either the exact queued invoice/work entries or explicit refusal with no server write, then restores the endpoint and verifies the invoice and all entries.');
      }, { soft: true });

      await qa.feature('SYNC-003', `The marked invoice survives a reload (${device.name})`, async () => {
        await checkAfterReload(qa, page, { pid: profile.id, contractId: seed.contractId, number });
      }, { soft: true });
    });

    test(`a share sheet that never answers, then a reload, on a full device: the reminder asks whether it went out and one tap on Yes records it (${device.name})`, {
      tag: ['@PRAC-002', '@PRAC-016', '@SYNC-003', ...(phone ? ['@phone'] : [])],
    }, async ({ page, qa }) => {
      test.setTimeout(10 * 60 * 1000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const { user, profile } = await member(page, { firstName: 'Hana', lastName: `Handoff ${device.name}` });
      const seed = seedStipendAccount(profile.id, tag);
      await reopen(page);
      const fill = await fillLocalStorage(page);
      qa.check('lab setup: localStorage is full (24 characters or fewer free)', fill.free <= 24, JSON.stringify(fill));
      let number = null;
      let total = 0;

      await qa.feature('PRAC-002', `The share sheet takes the invoice and never answers; the page reloads (${device.name})`, async () => {
        // Bracket this deliberate fault on the database clock, not the host clock.
        const faultSince = row('select clock_timestamp() as at').at;
        await installHangingShare(page);
        const opened = await openPreview(page, qa);
        ({ number, total } = opened);
        const { preview } = opened;
        await press(preview.getByRole('button', { name: 'Send invoice…' }));
        await press(page.getByRole('button', { name: /PDF Polished invoice/ }));
        const handed = await waitFor('the file at the share sheet', async () => { const s = await page.evaluate(() => window.__qaShared || []); return s.length ? s : null; }, { timeoutMs: 30000 }).catch(() => []);
        qa.check('the share sheet was handed the invoice PDF', handed.some((s) => s.files.some((f) => /pdf/.test(f.type) && f.name.includes(number))), JSON.stringify(handed));
        const notes = await waitFor('the handoff note in IndexedDB', async () => { const n = await handoffNotes(page); return n.some((x) => x.number === number) ? n : null; }, { timeoutMs: 15000 }).catch(() => []);
        qa.check('a note of the handoff is kept in IndexedDB although localStorage is full', notes.some((n) => n.number === number && n.handed && n.days === 3), JSON.stringify(notes));
        const stamped = await waitFor('the server stamp', async () => row(`select shared_at, shared_contract_id from public.invoice_number_reservations where user_id = ${lit(profile.id)} and number = ${lit(number)} and shared_at is not null`), { timeoutMs: 15000 }).catch(() => null);
        qa.check('the server stamps the number as handed to the share sheet (the contract id only)', stamped?.shared_contract_id === seed.contractId, JSON.stringify(stamped));
        // The phone comes back from Mail with the sheet still unanswered.
        await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
        // fix/invoice-ios-record (6b4cd7dd): the preview asks "Did <number> go out?" instead of
        // saying the sheet has not answered.
        const unanswered = await preview.getByText(`Did ${number} go out?`).waitFor({ timeout: 20000 }).then(() => true, () => false);
        qa.check('the preview asks whether the invoice went out (the share sheet has not answered)', unanswered);
        const mark = preview.getByRole('button', { name: 'Sent it already? Mark as sent' });
        qa.check('Mark as sent is offered and enabled while the sheet has not answered', await mark.isEnabled().catch(() => false));
        qa.check('nothing is recorded yet', !row(`select id from public.invoices where user_id = ${lit(profile.id)}`));
        const message = 'Invoice share sheet did not answer after the page came back';
        // The unresolved test share and explicit focus event above cause one
        // watchUnanswered report. No other account, message or occurrence is allowed.
        await waitFor('the deliberately unanswered share report', async () => {
          const found = rows(`select id from public.client_errors where created_at >= ${lit(faultSince)} and auth_user_id = ${lit(user.id)} and kind = 'error' and message = ${lit(message)}`);
          return found.length ? found : null;
        }, { timeoutMs: 10000, intervalMs: 250 });
        const faultUntil = row('select clock_timestamp() as at').at;
        const reports = rows(`select id, kind, message, auth_user_id from public.client_errors where created_at >= ${lit(faultSince)} and created_at <= ${lit(faultUntil)} and auth_user_id = ${lit(user.id)} and kind = 'error' and message = ${lit(message)}`);
        qa.intentionalClientErrors(reports, { message, kind: 'error', authUserId: user.id, count: 1,
          reason: `PRAC-002 deliberately leaves this member's synthetic invoice share promise unresolved, dispatches focus, and verifies the unanswered warning and no invoice. Database fault window: ${faultSince} through ${faultUntil}.` });
        await qa.shot('share unanswered');
      }, { soft: true });

      await qa.feature('PRAC-016', `After the reload, the Work log's reminder asks whether it went out; one tap on Yes records it (${device.name})`, async () => {
        // The page is reloaded (an update on focus, or iOS dropping the app) before the sheet answers.
        // fix/invoice-ios-record (6b4cd7dd): a note this device handed to the share sheet asks "Did
        // it go out?" in the reminder, and "Yes, it was sent" records it in one tap when its entries
        // are all still unbilled and come to its total (Record it stays for a note known only from
        // the server, or a refused record).
        const before = qa.report.dialogs.length;
        await reopen(page);
        const banner = page.getByRole('status').filter({ hasText: `${number} is not recorded` });
        const shown = await banner.first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        const text = shown ? (await banner.first().innerText()).replace(/\s+/g, ' ') : '';
        if (shown) {
          // release/goal5: the reminder's question comes into view with its buttons, clear of the
          // sticky top bar and the tab bar (RevealOnShow, page margins).
          const browserName = page.context().browser()?.browserType().name() || 'browser';
          const seen = await askInView(page, banner.first(), { shot: `in view ${browserName} work reminder ${device.name}` });
          qa.check('release/goal5: the reminder\'s "Did it go out?" and its Yes and No are in view, not covered by either bar', seen.ok, inViewText(seen));
        }
        await qa.shot('unrecorded banner');
        qa.check(`the Work log says ${number} went to the share sheet, is not recorded, and asks whether it went out`, shown && text.includes('Did it go out?') && text.includes('went to the share sheet') && text.includes('tap Yes, it was sent'), text || 'no banner');
        await press(banner.first().getByRole('button', { name: 'Yes, it was sent' }));
        const said = await page.getByText(`${number} is on the Invoices tab as sent`).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
        qa.check('one tap: the app says it is on the Invoices tab as sent', said);
        const asked = qa.report.dialogs.slice(before);
        qa.check('no question or alert on the way (one tap)', asked.length === 0, asked.join(' | '));
        await checkRecorded(qa, page, { pid: profile.id, contractId: seed.contractId, number, total, sentDay: null, method: 'share-confirmed' });
        const inv = row(`select sent_at from public.invoices where user_id = ${lit(profile.id)} and number = ${lit(number)}`);
        qa.check('sent_at is the day it went to the share sheet', !!inv && localDay(0, new Date(inv.sent_at)) === localDay(), inv?.sent_at);
        const banners = await page.getByRole('status').filter({ hasText: 'is not recorded' }).count();
        qa.check('the banner is gone', banners === 0, `${banners}`);
        const listed = rows(`select number from public.invoice_number_reservations r where r.user_id = ${lit(profile.id)} and r.shared_at is not null
          and not exists (select 1 from public.invoices i where i.user_id = r.user_id and lower(btrim(i.number)) = lower(r.number))`);
        qa.check('no stamped number is left without an invoice (list_shared_invoice_numbers is empty)', listed.length === 0, JSON.stringify(listed));
      }, { soft: true });

      await qa.feature('SYNC-003', `The recorded invoice survives a reload; no banner comes back (${device.name})`, async () => {
        await checkAfterReload(qa, page, { pid: profile.id, contractId: seed.contractId, number });
      }, { soft: true });
    });
  });
}

// ── The owner's sequence, 2026-10-01 (installed iPhone app, iOS 18.7) ──────────────────────────
//
// What his phone did, as production recorded it: the membership check timed out at launch
// ("Membership check failed (timeout:network:membership_information_unavailable)"); ten seconds
// later the invoice preview reserved its number; the invoice went out through the share sheet
// and Mail sent it; the share sheet never reported back; the server's stamp of the hand-off
// (mark_invoice_number_shared) never landed; nothing recorded the invoice and its items stayed
// unbilled. fix/invoice-ios-record makes the preview ask "Did <number> go out?" once the page is
// back in front, and "Yes, it was sent" record exactly that invoice in one tap.
//
// The same sequence on a phone (390 x 844, touch, an iPhone user agent; WebKit as the installed
// app with -c qa-lab/e2e/webkit.config.mjs), with the iOS behaviour model of support/ios.mjs for
// the page leaving the front and coming back, on each screen that sends an invoice:
//   Days & call (a day-rate agreement: 12 past days on the invoice, a later day left unbilled),
//   Work log (the stipend agreement above: 28 entries over three call days),
//   Expenses (four expenses to one agency on the invoice, one to another agency left unbilled).
// The network, per request to the lab's API (support: ownerNetwork):
//   1. launch: the membership endpoint holds every request until the app gives up (9 s), the
//      rest answers; the app's own report of the timeout is checked in client_errors;
//   2. a moment of signal: the membership endpoint answers; the invoice is built (its number
//      reserved on the server) and Send is tapped with the answer in hand;
//   3. as the file goes to the share sheet the network drops entirely (the stamp cannot land);
//      the share sheet takes the PDF and never reports back; the page leaves the front (Mail);
//   4. the page comes back with the network back except the membership endpoint, which times
//      out again (his repeated timeouts): the stamp lands; the preview asks "Did it go out?";
//      once the resume's membership check has timed out, ONE tap on "Yes, it was sent";
//   5. the screen shows every item billed at once; the share sheet then reports the send late;
//      the membership endpoint answers again and the record reaches the server.
// Checked: the invoice row (number, method share-confirmed, dated when it went to the share
// sheet, the total built, every item on it, the item left out still unbilled), exactly one
// invoice under that number, no question or alert on the Yes, the stamp landing after the
// network returned and cleared once recorded, nothing left owed or noted on the device, and a
// reload keeping it all.

/** How long the membership endpoint holds a request while it "times out" (the app gives up at 9 s). */
const HANG_MS = 15000;
const ENTITLEMENTS = /\/functions\/v1\/billing-entitlements(\?|$)/;
const REPORT_ERROR = /\/functions\/v1\/report-error(\?|$)/;
/** A report the app sent, by message prefix or event: 'row' when client_errors has it, else the function's answer. */
const reportSeen = (net, match) => net.reports.filter((x) => (typeof match === 'string' ? x.event === match : match.test(x.message)));

/**
 * The owner's network, per request to the lab's API. `membership`: 'ok' or 'hang' (a POST to
 * billing-entitlements is held HANG_MS, then failed as a timeout; the app has given up by then).
 * `api`: 'ok' or 'down' (every request to PostgREST, the functions and Storage fails as a
 * dropped connection, the membership endpoint included). Records what it held and cut, and,
 * from the page, each membership answer (200) and each membership request that failed.
 */
async function ownerNetwork(context, page) {
  const net = { membership: 'ok', api: 'ok', held: [], answered: [], failed: [], cut: [], reports: [] };
  await context.route(/\/(rest|functions|storage)\/v1\//, async (route) => {
    if (net.api !== 'down') return route.fallback();
    const req = route.request();
    net.cut.push(`${req.method()} ${new URL(req.url()).pathname}`);
    return route.abort('internetdisconnected');
  });
  await context.route(ENTITLEMENTS, async (route) => {
    const req = route.request();
    if (net.api === 'down' || req.method() !== 'POST' || net.membership !== 'hang') return route.fallback();
    net.held.push(Date.now());
    await sleep(HANG_MS);
    return route.abort('timedout').catch(() => {});
  });
  page.on('response', (r) => { if (ENTITLEMENTS.test(r.url()) && r.request().method() === 'POST' && r.status() === 200) net.answered.push(Date.now()); });
  page.on('requestfailed', (r) => { if (ENTITLEMENTS.test(r.url()) && r.method() === 'POST') net.failed.push(Date.now()); });
  // What the app sent to report-error (sendBeacon or fetch), and what it answered. The function
  // keeps at most 30 rows per hashed IP in 10 minutes (supabase/functions/report-error,
  // RATE_MAX_ROWS) and every lab browser is 127.0.0.1, so with other runs on the lab a report
  // the app did send can be answered 429 and have no row (2026-10-02 00:23 UTC, three journeys).
  page.on('request', (r) => {
    if (!REPORT_ERROR.test(r.url()) || r.method() !== 'POST') return;
    let body = {};
    try { body = JSON.parse(r.postData() || '{}'); } catch { /* not JSON */ }
    const entry = { at: Date.now(), kind: body.kind, message: String(body.message || ''), event: body.extra?.event || null, status: null };
    net.reports.push(entry);
    r.response().then((res) => { entry.status = res?.status() ?? null; }, () => {});
  });
  return net;
}

/**
 * A share sheet that takes the file and does not report back until the journey says so
 * (settleShareLate): navigator.share records what it was handed, and the page leaves the front
 * a moment later (the sheet hands over to Mail; window.__ios, support/ios.mjs).
 */
async function installLateShare(page, { backgroundAfterMs = 400 } = {}) {
  await page.evaluate((ms) => {
    window.__qaShared = [];
    window.__qaShareSettle = [];
    navigator.canShare = () => true;
    navigator.share = (data) => new Promise((resolve, reject) => {
      window.__qaShared.push({ at: Date.now(), title: data?.title || '', files: (data?.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) });
      window.__qaShareSettle.push({ resolve, reject });
      setTimeout(() => window.__ios.toBackground(), ms);
    });
  }, backgroundAfterMs);
}
/**
 * The share sheet answers now (late): 'sent' (the promise resolves, a reported send) or 'cancel'
 * (it rejects with AbortError, which iOS answers after Mail or Gmail has sent the file, per
 * fix/invoice-ios-record 6b4cd7dd). Returns how many sheets it answered.
 */
const settleShareLate = (page, how = 'sent') => page.evaluate((h) => {
  const list = (window.__qaShareSettle || []).splice(0);
  for (const s of list) { if (h === 'cancel') s.reject(new DOMException('Share canceled', 'AbortError')); else s.resolve(); }
  return list.length;
}, how);

/** The hand-off notes and the stamps still owed, as this device keeps them (IndexedDB, both web stores). */
async function deviceHandoff(page) {
  return page.evaluate(async () => {
    const owed = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k?.startsWith('credentialdomd-invoice-handoff-stamps-v1')) continue;
        // release/goal2 (64da81dc) keeps { v, list } (a version for the Cache Storage copy); before, the list itself.
        try { const v = JSON.parse(store.getItem(k) || '[]'); for (const s of (Array.isArray(v) ? v : v?.list || [])) owed.push(s?.number); } catch { /* not ours */ }
      }
    }
    let notes = [];
    if ((await indexedDB.databases()).some((d) => d.name === 'credentialdomd-invoice-handoff')) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('credentialdomd-invoice-handoff'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        if (db.objectStoreNames.contains('notes')) {
          notes = await new Promise((resolve) => {
            const all = db.transaction('notes', 'readonly').objectStore('notes').getAll();
            all.onsuccess = () => resolve(all.result.flat().map((n) => ({ number: n.number, handed: !!n.handed })));
            all.onerror = () => resolve([]);
          });
        }
      } finally { db.close(); }
    }
    return { owed, notes };
  });
}

/** A day-rate agreement (with a call grid) and 13 worked days: 12 in the past (4 with primary call), 1 two days ahead. */
function seedDayRateAccount(pid, tag) {
  const contractId = randomUUID();
  const hospital = 'QA Synthetic Valley Hospital (QSV)';
  const cover = JSON.stringify([{ start: localDay(-40), end: localDay(20) }]);
  const grid = JSON.stringify([{ hospital, primary: 1200, backup: 600 }]);
  labExec(`insert into public.locum_contracts (id, user_id, facility, short_name, agency, bill_to, start_date, end_date, pay_model, day_rate, call_rate_grid, work_state, coverage_periods)
    values (${lit(contractId)}, ${lit(pid)}, ${lit(`QA Synthetic Valley Group ${tag}`)}, 'QSVG', 'QA Synthetic Staffing', 'QA Synthetic Staffing', ${lit(localDay(-40))}, ${lit(localDay(20))}, 'daily', 1850, ${lit(grid)}::jsonb, 'CO', ${lit(cover)}::jsonb);`);
  const billed = [];
  const values = [];
  for (let i = 0; i < 12; i++) {
    const id = randomUUID();
    billed.push(id);
    const calls = i % 3 === 0 ? JSON.stringify([{ hospital, role: 'primary' }]) : '[]';
    values.push(`(${lit(id)}, ${lit(pid)}, ${lit(contractId)}, ${lit(localDay(-30 + 2 * i))}, true, ${lit(calls)}::jsonb, ${i % 3 === 0 ? 3050 : 1850}, ${lit(`QA synthetic day ${i + 1}`)}, true)`);
  }
  const later = randomUUID();
  values.push(`(${lit(later)}, ${lit(pid)}, ${lit(contractId)}, ${lit(localDay(2))}, true, '[]'::jsonb, 1850, 'QA synthetic later day', true)`);
  labExec(`insert into public.duty_days (id, user_id, contract_id, date, worked_day, call_periods, amount, notes, placement_ok) values ${values.join(',\n')};`);
  return { contractId, billed, left: [later], table: 'duty_days' };
}

/** Five travel expenses: four to one agency (the invoice), one older one to another agency (left unbilled). */
function seedExpenseAccount(pid, tag) {
  const agency = `QA Synthetic Staffing ${tag}`;
  const shape = [['Flight', 'QA Synthetic Air', 412.6, -12], ['Hotel', 'QA Synthetic Inn', 689.25, -10], ['Rental car', 'QA Synthetic Cars', 301.4, -9], ['Meals', 'QA Synthetic Diner', 58.75, -8]];
  const billed = [];
  const values = shape.map(([category, vendor, amount, day]) => {
    const id = randomUUID();
    billed.push(id);
    return `(${lit(id)}, ${lit(pid)}, ${lit(localDay(day))}, ${lit(category)}, ${lit(vendor)}, ${amount}, ${lit(agency)}, ${lit(`QA synthetic ${category.toLowerCase()}`)})`;
  });
  const other = randomUUID();
  values.push(`(${lit(other)}, ${lit(pid)}, ${lit(localDay(-20))}, 'Parking', 'QA Synthetic Garage', 24.5, ${lit(`QA Synthetic Other Agency ${tag}`)}, 'QA synthetic parking')`);
  labExec(`insert into public.travel_expenses (id, user_id, date, category, vendor, amount, agency, notes) values ${values.join(',\n')};`);
  return { contractId: null, billed, left: [other], table: 'travel_expenses', agency };
}

const OWNER_SCREENS = [
  {
    key: 'days', label: 'Days & call', items: 'days',
    seed: seedDayRateAccount,
    async open(page) {
      await phoneTab(page, 'Practice');
      await subTab(page, 'Work');
      await page.getByRole('heading', { name: 'Days & call' }).waitFor({ timeout: 30000 });
    },
    cta: (page) => page.getByRole('button', { name: /Invoice \d+ unbilled days?/ }),
    async build(page, qa) {
      await this.cta(page).first().tap();
      const picker = page.getByRole('dialog', { name: 'Which days go on this invoice?' });
      await picker.waitFor();
      const build = picker.getByRole('button', { name: /^Invoice \d+ days?/ });
      const label = (await build.innerText()).replace(/\s+/g, ' ');
      qa.check('the day picker checks the 12 past days (the later one left out)', /^Invoice 12 days: \$[\d,]+\.\d\d$/.test(label), label);
      await build.tap();
      const sheet = page.getByRole('dialog', { name: 'Invoice preview' });
      await sheet.waitFor();
      await sheet.getByText('Reserving the invoice number…').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
      const number = ((await sheet.innerText()).match(/INV-\d{8}-\d+(-[A-Z0-9]{3})?/) || [null])[0];
      return { sheet, number, total: Number((label.match(/\$([\d,]+\.\d\d)/) || [0, '0'])[1].replace(/,/g, '')) };
    },
    async send(page, sheet) {
      await sheet.getByRole('button', { name: 'Send invoice…' }).tap();
      await page.getByRole('button', { name: /PDF Polished invoice/ }).tap();
    },
    async onScreen(page) {
      const text = (await page.locator('main, body').first().innerText()).replace(/[ \t]+/g, ' ');
      const cta = await this.cta(page).first().innerText().catch(() => '');
      return { billed: (text.match(/· billed/g) || []).length, cta: cta.replace(/\s+/g, ' ').trim(), unrecorded: /is not recorded/.test(text) };
    },
    shownOk: (s) => s.billed === 12 && /Invoice 1 unbilled day\b/.test(s.cta),
  },
  {
    key: 'work', label: 'Work log', items: 'entries',
    seed: (pid, tag) => {
      const s = seedStipendAccount(pid, tag);
      return { contractId: s.contractId, billed: rows(`select id from public.work_log where user_id = ${lit(pid)} and contract_id = ${lit(s.contractId)}`).map((r) => r.id), left: [], table: 'work_log' };
    },
    async open(page) {
      await phoneTab(page, 'Practice');
      await subTab(page, 'Work');
    },
    cta: (page) => page.getByRole('button', { name: /Invoice \d+ unbilled entr/ }),
    async build(page, qa) {
      const cta = page.getByRole('button', { name: new RegExp(`Invoice ${ENTRIES} unbilled entries`) });
      await cta.waitFor({ timeout: 60000 });
      await cta.tap();
      const picker = page.getByRole('dialog', { name: 'Which days go on this invoice?' });
      await picker.waitFor();
      const build = picker.getByRole('button', { name: /^Invoice \d+ days?/ });
      const label = (await build.innerText()).replace(/\s+/g, ' ');
      qa.check('the day picker offers the three call days', /^Invoice 3 days: \$[\d,]+\.\d\d$/.test(label), label);
      await build.tap();
      const sheet = page.getByRole('dialog', { name: 'Invoice preview' });
      await sheet.waitFor();
      await sheet.getByText('Reserving the invoice number…').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
      const number = ((await sheet.innerText()).match(/INV-\d{8}-\d+(-[A-Z0-9]{3})?/) || [null])[0];
      return { sheet, number, total: Number((label.match(/\$([\d,]+\.\d\d)/) || [0, '0'])[1].replace(/,/g, '')) };
    },
    async send(page, sheet) {
      await sheet.getByRole('button', { name: 'Send invoice…' }).tap();
      await page.getByRole('button', { name: /PDF Polished invoice/ }).tap();
    },
    async onScreen(page) {
      const text = (await page.locator('main, body').first().innerText()).replace(/[ \t]+/g, ' ');
      return {
        billed: await page.getByText('BILLED', { exact: true }).count(),
        cta: String(await this.cta(page).count()),
        notInvoiced: (text.match(/Not invoiced/g) || []).length,
        unrecorded: /is not recorded/.test(text),
      };
    },
    shownOk: (s) => s.billed >= ENTRIES && s.cta === '0' && s.notInvoiced === 0,
  },
  {
    key: 'expenses', label: 'Expenses', items: 'expenses',
    seed: seedExpenseAccount,
    async open(page) {
      await phoneTab(page, 'Practice');
      await subTab(page, 'Exp.');
      await page.getByText('Travel expenses', { exact: true }).waitFor({ timeout: 30000 });
    },
    cta: (page) => page.getByRole('button', { name: /^Invoice \d+ expenses?:/ }),
    async build(page, qa, { pid }) {
      const cta = this.cta(page).first();
      await cta.waitFor({ timeout: 60000 });
      qa.check('the screen offers to invoice the five expenses', /^Invoice 5 expenses:/.test((await cta.innerText()).trim()), await cta.innerText());
      await cta.tap();
      const sheet = page.getByRole('dialog', { name: 'Invoice expenses' });
      await sheet.waitFor();
      await sheet.getByRole('button', { name: 'Create & send with receipts' }).waitFor({ timeout: 60000 });
      const text = (await sheet.innerText()).replace(/\s+/g, ' ');
      const total = Number(((text.match(/Total \$([\d,]+\.\d\d)/) || [0, '0'])[1]).replace(/,/g, ''));
      qa.check('the sheet checks the four expenses to the first agency', Math.abs(total - (412.6 + 689.25 + 301.4 + 58.75)) < 0.005, `Total ${total}`);
      const number = row(`select number from public.invoice_number_reservations where user_id = ${lit(pid)} and number like 'EXP-%' order by reserved_at desc limit 1`)?.number || null;
      return { sheet, number, total };
    },
    async send(page, sheet) {
      await sheet.getByRole('button', { name: 'Create & send with receipts' }).tap();
    },
    async onScreen(page, number) {
      const text = (await page.locator('main, body').first().innerText()).replace(/[ \t]+/g, ' ');
      const cta = await this.cta(page).first().innerText().catch(() => '');
      return { billed: number ? text.split(`${number} · owed`).length - 1 : 0, cta: cta.replace(/\s+/g, ' ').trim(), unrecorded: /is not recorded/.test(text) };
    },
    shownOk: (s) => s.billed === 4 && /^Invoice 1 expense:/.test(s.cta),
  },
];

// Control (opt-in, never in a normal run): QA_INVOICE_CONTROL_DIST names another QA-lab build's
// output folder (for instance one built from the commit before a fix, with QA_LAB_APP_DIST). The
// owner's journeys then run that build's scripts in their own browser only: the lab build's entry
// script, every asset the other build has, and version.json are answered from it (service workers
// blocked, so nothing is served from a cache). A journey run so is expected to fail where the fix
// matters; nothing else on the lab is touched.
const CONTROL_DIST = process.env.QA_INVOICE_CONTROL_DIST || '';
async function serveControlBuild(context) {
  const entry = (dir) => (readFileSync(path.join(dir, 'index.html'), 'utf8').match(/src="\/app\/assets\/(index-[^"]+\.js)"/) || [])[1];
  const labEntry = entry(path.join(QA_APP_DIST));
  const controlEntry = entry(CONTROL_DIST);
  if (!labEntry || !controlEntry) throw new Error(`control: no entry script (lab ${labEntry}, control ${controlEntry})`);
  const served = [];
  await context.route(/\/app\/(assets\/[^?#]+|version\.json)(\?|#|$)/, async (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/app\//, '');
    const name = rel === `assets/${labEntry}` ? `assets/${controlEntry}` : rel;
    const file = path.join(CONTROL_DIST, name);
    if (!existsSync(file)) return route.fallback();
    served.push(name);
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(file), headers: { 'cache-control': 'no-store' } });
  });
  return { labEntry, controlEntry, served };
}

test.describe('the owner\'s sequence: launch timeout, Send, an unanswered share sheet while Mail sends, one tap on Yes (phone 390x844)', () => {
  test.use(CONTROL_DIST ? { ...phoneUse(390), serviceWorkers: 'block' } : phoneUse(390));
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(iosModelInitScript);
    if (CONTROL_DIST) {
      const c = await serveControlBuild(context);
      console.log(`qa-lab: CONTROL: ${c.labEntry} answered with ${c.controlEntry} from ${CONTROL_DIST}`);
    }
  });

  for (const screen of OWNER_SCREENS) for (const late of ['sent', 'cancel']) {
    test(`${screen.label}: membership timing out at launch, Send, the share sheet never answers while Mail sends, the page comes back, one tap on Yes records it once (the sheet answers ${late === 'sent' ? 'a send' : 'a cancel'} late)`, {
      tag: ['@PRAC-002', '@PRAC-016', '@BILL-006', '@phone'],
    }, async ({ page, qa, context }) => {
      test.setTimeout(12 * 60 * 1000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const net = await ownerNetwork(context, page);
      const { user, profile } = await newPhoneMember(page, { firstName: 'Owen', lastName: `Owner ${screen.key} ${late}` });
      const pid = profile.id;
      const seed = screen.seed(pid, tag);
      const reopenScreen = async () => {
        await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
        await waitForMemberApp(page);
        await screen.open(page);
      };
      // His phone has the account on it already (the device copy).
      await reopenScreen();
      await screen.cta(page).first().waitFor({ timeout: 60000 });
      await checkPracticeAccess(qa, page, user.id);
      let number = null;
      let total = 0;
      let sheet = null;
      let sharedAt = 0;

      await qa.feature('PRAC-002', `${screen.label}: the invoice goes out under the owner's network (${screen.key})`, async () => {
        // 1. Launch: the membership check times out.
        net.membership = 'hang';
        const launchAt = Date.now();
        await reopenScreen();
        // The app's own report of it, as production has it: the row, or (the lab's per-IP report
        // cap reached by other runs) the report the app sent and report-error refused with 429.
        const TIMEOUT_REPORT = 'Membership check failed (timeout:network:membership_information_unavailable)';
        const timeout = await waitFor('the app\'s report of the timed-out membership check', async () => {
          const r = row(`select message from public.client_errors where auth_user_id = ${lit(user.id)} and message like 'Membership check failed (timeout:%' and created_at > now() - interval '5 minutes' order by created_at limit 1`);
          if (r) return { message: r.message, how: 'row' };
          const sent = reportSeen(net, /^Membership check failed \(timeout:/).find((x) => x.at >= launchAt && x.status !== null);
          return sent ? { message: sent.message, how: `sent, report-error answered ${sent.status}` } : null;
        }, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
        qa.check('lab setup: the membership check timed out at launch, reported as on his phone', !!timeout && timeout.message === TIMEOUT_REPORT,
          `${timeout ? `${timeout.message} (${timeout.how})` : 'no report'}; held ${net.held.filter((t) => t >= launchAt).length}, answered ${net.answered.filter((t) => t >= launchAt).length}`);
        qa.check('lab setup: no membership answer since the launch', net.answered.filter((t) => t >= launchAt).length === 0, `${net.answered.length} answers in all`);
        await screen.cta(page).first().waitFor({ timeout: 60000 });

        // 2. A moment of signal: the membership endpoint answers, the invoice is built.
        net.membership = 'ok';
        const signalAt = Date.now();
        const built = await screen.build(page, qa, { pid });
        ({ sheet, number, total } = built);
        qa.check('the invoice has its number', !!number, number);
        const reserved = number ? row(`select number, shared_at from public.invoice_number_reservations where user_id = ${lit(pid)} and number = ${lit(number)}`) : null;
        qa.check('the server reserved the number (as at 22:19:41 on his phone)', !!reserved && !reserved.shared_at, JSON.stringify(reserved));
        const answered = await waitFor('a membership answer', async () => (net.answered.some((t) => t >= signalAt) ? true : null), { timeoutMs: 45000, intervalMs: 500 }).catch(() => false);
        qa.check('lab setup: the membership endpoint answered before Send', !!answered, `answers since the signal: ${net.answered.filter((t) => t >= signalAt).length}`);
        await sleep(500);

        // 3. Send. As the file goes to the share sheet, the network drops.
        await installLateShare(page);
        net.api = 'down';
        const cutFrom = net.cut.length;
        await screen.send(page, sheet);
        const handed = await waitFor('the file at the share sheet', async () => { const s = await page.evaluate(() => window.__qaShared || []); return s.length ? s : null; }, { timeoutMs: 30000 }).catch(() => []);
        sharedAt = handed[0]?.at || 0;
        qa.check('the share sheet was handed the invoice PDF', handed.some((s) => s.files.some((f) => f.type === 'application/pdf' && f.name.includes(number))), JSON.stringify(handed));
        await sleep(1500);
        qa.check('the page left the front (the share sheet handed over to Mail)', await page.evaluate(() => document.visibilityState === 'hidden'));
        const device = await deviceHandoff(page);
        qa.check('the hand-off is noted on the device as it went', device.notes.some((n) => n.number === number && n.handed), JSON.stringify(device));
        qa.check('the stamp is owed on the device (the server could not be reached)', device.owed.includes(number), JSON.stringify(device.owed));
        const stampCut = net.cut.slice(cutFrom).filter((c) => /mark_invoice_number_shared/.test(c));
        qa.check('lab evidence: the stamp request was cut by the dropped network', stampCut.length >= 1, net.cut.slice(cutFrom).join(', '));
        const unstamped = row(`select shared_at from public.invoice_number_reservations where user_id = ${lit(pid)} and number = ${lit(number)}`);
        qa.check('as on his phone: the server has no stamp yet (shared_at NULL)', !!unstamped && !unstamped.shared_at, JSON.stringify(unstamped));
        qa.check('nothing is recorded yet', !row(`select id from public.invoices where user_id = ${lit(pid)}`));
        // Mail sends while the app is away.
        await sleep(4000);

        // 4. Back: the network is back, the membership endpoint times out again.
        net.membership = 'hang';
        net.api = 'ok';
        const backAt = Date.now();
        await page.evaluate(() => window.__ios.toFront());
        const stamp = await waitFor('the stamp on the server', async () => row(`select shared_at, shared_contract_id from public.invoice_number_reservations where user_id = ${lit(pid)} and number = ${lit(number)} and shared_at is not null`), { timeoutMs: 30000, intervalMs: 500 }).catch(() => null);
        qa.check('the server stamp lands once the network is back, dated when the file went', !!stamp && Math.abs(Date.parse(stamp.shared_at) - sharedAt) < 15000 && (stamp.shared_contract_id || null) === seed.contractId,
          `${JSON.stringify(stamp)}; handed at ${new Date(sharedAt).toISOString()}; landed ${stamp ? ((Date.now() - backAt) / 1000).toFixed(1) : '-'} s after the return or sooner`);
        const ask = await sheet.getByText(`Did ${number} go out?`).waitFor({ timeout: 20000 }).then(() => true, () => false);
        const browserName = page.context().browser()?.browserType().name() || 'browser';
        const seen = ask ? await askInView(page, sheet.getByRole('alert').filter({ hasText: `Did ${number} go out?` }).first(), { shot: `in view ${CONTROL_DIST ? 'control ' : ''}${browserName} ${screen.key} ${late} ${page.viewportSize().width}x${page.viewportSize().height}` }) : null;
        await qa.shot(`${screen.key} asks did it go out`);
        qa.check(`the ${screen.key === 'expenses' ? 'sheet' : 'preview'} asks "Did ${number} go out?"`, ask);
        qa.check(`release/goal5: "Did ${number} go out?" comes into view with Yes and No, not covered, without the member scrolling`, !!seen?.ok, seen ? inViewText(seen) : 'no question');
        // The resume's membership check has timed out (his repeated timeouts) before he answers.
        const resumeFailed = await waitFor('the resume\'s membership check to time out', async () => (net.failed.some((t) => t >= backAt) ? true : null), { timeoutMs: 30000, intervalMs: 500 }).catch(() => false);
        qa.check('lab setup: the membership check after the return timed out too', !!resumeFailed, `held since the return ${net.held.filter((t) => t >= backAt).length}, failed ${net.failed.filter((t) => t >= backAt).length}, answered ${net.answered.filter((t) => t >= backAt).length}`);

        // ONE tap on Yes.
        const dialogsBefore = qa.report.dialogs.length;
        const yesAt = Date.now();
        await sheet.getByRole('button', { name: 'Yes, it was sent' }).tap({ timeout: 20000 });
        const shownAt = await waitFor('every item billed on screen', async () => (screen.shownOk(await screen.onScreen(page, number)) ? Date.now() : null), { timeoutMs: 20000, intervalMs: 500 }).catch(() => null);
        const shown = await screen.onScreen(page, number);
        await qa.shot(`${screen.key} after one tap on yes`);
        qa.check(`one tap: every ${screen.items === 'days' ? 'day on the invoice' : screen.items === 'entries' ? 'entry' : 'expense on the invoice'} is billed on screen at once${seed.left.length ? ', the one left out still unbilled' : ''}`, !!shownAt,
          `${JSON.stringify(shown)}${shownAt ? `; ${((shownAt - yesAt) / 1000).toFixed(1)} s after the tap` : ''}`);
        const asked = qa.report.dialogs.slice(dialogsBefore);
        qa.check('no question or alert on the way (one tap)', asked.length === 0, asked.join(' | '));
        qa.check(`the ${screen.key === 'expenses' ? 'sheet' : 'preview'} closes`, await sheet.waitFor({ state: 'detached', timeout: 20000 }).then(() => true, () => false));
        const during = row(`select count(*)::int as n from public.invoices where user_id = ${lit(pid)}`);
        console.log(`qa-lab: ${screen.key} (late ${late}): with the membership check timing out, the server had ${during.n} invoice row(s) right after the tap; membership held ${net.held.filter((t) => t >= yesAt).length}, answered ${net.answered.filter((t) => t >= yesAt).length}`);

        // 5. The share sheet answers late (a send, or the cancel iOS answers after Mail sent it);
        // the membership endpoint then answers.
        const settled = await settleShareLate(page, late);
        qa.check(`lab setup: the share sheet answered ${late === 'sent' ? 'a send' : 'a cancel (AbortError)'} late`, settled === 1, `${settled}`);
        await sleep(3000);
        const lateDialogs = qa.report.dialogs.slice(dialogsBefore);
        const lateShown = await screen.onScreen(page, number);
        qa.check(`the late ${late === 'sent' ? 'send' : 'cancel'} records nothing twice, takes nothing back and asks nothing`, lateDialogs.length === 0 && screen.shownOk(lateShown) && !lateShown.unrecorded, `${lateDialogs.join(' | ')} ${JSON.stringify(lateShown)}`);
        net.membership = 'ok';
        const okAt = Date.now();
        const inv = await waitFor('the invoice and every item on the server', async () => {
          const r = row(`select id, number, method, sent_at, total_amount, entry_ids from public.invoices where user_id = ${lit(pid)} and number = ${lit(number)}`);
          if (!r) return null;
          const carrying = row(`select count(*)::int as n from public.${seed.table} where user_id = ${lit(pid)} and invoice_id = ${lit(r.id)}`).n;
          return carrying === seed.billed.length ? { ...r, carrying } : null;
        }, { timeoutMs: 180000, intervalMs: 1000 }).catch(() => null);
        const all = rows(`select id, number, method from public.invoices where user_id = ${lit(pid)}`);
        const r = inv || row(`select id, number, method, sent_at, total_amount, entry_ids from public.invoices where user_id = ${lit(pid)} and number = ${lit(number)}`);
        const ids = r ? (Array.isArray(r.entry_ids) ? r.entry_ids : JSON.parse(r.entry_ids || '[]')) : [];
        const items = rows(`select id, invoice_id from public.${seed.table} where user_id = ${lit(pid)}`);
        qa.check('once the membership endpoint answers, the invoice row reaches the server', !!inv,
          `${r ? `${r.number} ${r.method}` : 'no row'} after ${((Date.now() - okAt) / 1000).toFixed(0)} s; answers since ${net.answered.filter((t) => t >= okAt).length}; items ${JSON.stringify(items.map((i) => !!i.invoice_id))}`);
        qa.check('method share-confirmed (recorded on his answer)', r?.method === 'share-confirmed', r?.method);
        qa.check('dated when it went to the share sheet', !!r && Math.abs(Date.parse(r.sent_at) - sharedAt) < 15000, `${r?.sent_at} vs ${new Date(sharedAt).toISOString()}`);
        qa.check('the total the invoice was built with', !!r && Math.abs(Number(r.total_amount) - total) < 0.005, `${r?.total_amount} vs ${total}`);
        qa.check(`its entry_ids are exactly the ${seed.billed.length} items that went`, ids.length === seed.billed.length && seed.billed.every((id) => ids.includes(id)), `${ids.length}`);
        qa.check(`every item that went carries its id${seed.left.length ? '; the one left out is still unbilled' : ''}`, !!r && seed.billed.every((id) => items.find((i) => i.id === id)?.invoice_id === r.id) && seed.left.every((id) => !items.find((i) => i.id === id)?.invoice_id),
          JSON.stringify({ carrying: items.filter((i) => r && i.invoice_id === r.id).length, left: seed.left.map((id) => items.find((i) => i.id === id)?.invoice_id || null) }));
        qa.check(`exactly one invoice under ${number}, and only one on the account`, all.length === 1 && all[0].number === number, JSON.stringify(all));
        // The unstamp after a record waits until the server holds the invoice and goes with the owed-stamp resend
        // (release/goal2: invoice-ios-record round 1 fix 5, every 15 s doubling), so it is waited for, not read at once.
        const recordedAt = Date.now();
        const finalStamp = (await waitFor('the stamp cleared after the record', async () => {
          const s = row(`select shared_at from public.invoice_number_reservations where user_id = ${lit(pid)} and number = ${lit(number)}`);
          return s && !s.shared_at ? s : null;
        }, { timeoutMs: 120000, intervalMs: 1000 }).catch(() => null)) || row(`select shared_at from public.invoice_number_reservations where user_id = ${lit(pid)} and number = ${lit(number)}`);
        console.log(`qa-lab: ${screen.key} (late ${late}): stamp ${finalStamp?.shared_at ? 'still set' : 'cleared'} ${((Date.now() - recordedAt) / 1000).toFixed(0)} s after the record was seen`);
        const listed = rows(`select number from public.invoice_number_reservations r where r.user_id = ${lit(pid)} and r.shared_at is not null
          and not exists (select 1 from public.invoices i where i.user_id = r.user_id and lower(btrim(i.number)) = lower(r.number))`);
        qa.check('the stamp is cleared once recorded and no stamped number is left without an invoice', !!finalStamp && !finalStamp.shared_at && listed.length === 0, JSON.stringify({ finalStamp, listed }));
        const left = await waitFor('nothing owed or noted on the device', async () => { const d = await deviceHandoff(page); return d.owed.length === 0 && !d.notes.some((n) => n.number === number) ? d : null; }, { timeoutMs: 30000 }).catch(async () => deviceHandoff(page));
        qa.check('nothing left owed or noted on the device', left.owed.length === 0 && !left.notes.some((n) => n.number === number), JSON.stringify(left));
        const reports = rows(`select id, kind, auth_user_id, message, extra->>'event' as event from public.client_errors where auth_user_id = ${lit(user.id)} and created_at > to_timestamp(${launchAt / 1000}) order by created_at`);
        console.log(`qa-lab: ${screen.key} (late ${late}): client_errors for this member: ${reports.map((x) => x.event || x.message).join(', ')}`);
        const confirmed = reports.some((x) => x.event === 'invoice_share_confirmed_by_member') ? 'row'
          : reportSeen(net, 'invoice_share_confirmed_by_member').map((x) => `sent, report-error answered ${x.status}`)[0] || null;
        qa.check('the member\'s answer is reported (count only)', !!confirmed, `${confirmed || 'not sent'}; rows: ${reports.map((x) => x.event || x.message).join(', ')}; sent: ${net.reports.map((x) => `${x.event || x.message.slice(0, 40)} ${x.status}`).join(', ')}`);
        // These diagnostics are the declared fault's expected reports. Claim
        // only this account's exact persisted rows after the injected timeout,
        // native handoff, explicit answer and one-invoice recovery are proven.
        // Unknown messages, duplicate rows and every other account stay faults.
        const recovered = !!timeout && answered && resumeFailed && ask && !!shownAt && settled === 1
          && stampCut.length > 0 && !!inv && r?.method === 'share-confirmed'
          && all.length === 1 && all[0].number === number
          && ids.length === seed.billed.length && seed.billed.every(id => ids.includes(id))
          && seed.billed.every(id => items.find(i => i.id === id)?.invoice_id === r.id)
          && seed.left.every(id => !items.find(i => i.id === id)?.invoice_id)
          && left.owed.length === 0 && !left.notes.some(n => n.number === number);
        const confirmationEvents = [...reports, ...reportSeen(net, 'invoice_share_confirmed_by_member')].filter(x => x.event === 'invoice_share_confirmed_by_member');
        qa.check('successful member confirmation is an informational event, never a client error', confirmationEvents.length > 0 && confirmationEvents.every(x => x.kind === 'info'));
        await qa.feature('PRAC-016', `${screen.label}: the shared PDF retains the recorded invoice number (${screen.key})`, async () => {
          qa.check('the native handoff received the original named invoice PDF', handed.some(s => s.files.some(f => f.type === 'application/pdf' && f.name.includes(number) && f.size > 1000)), handed);
          qa.check('the recorded invoice keeps that same number and total exactly once', all.length === 1 && all[0].number === number && r?.number === number && Math.abs(Number(r.total_amount) - total) < 0.005, all);
        });
        if (recovered) {
          const section = { work_log: 'workLog', duty_days: 'dutyDays', travel_expenses: 'travelExpenses' }[seed.table];
          const expected = [
            ['access_refresh_failed', TIMEOUT_REPORT],
            ['invoice_share_unanswered', 'Invoice share sheet did not answer after the page came back'],
            ['write_queued_for_access', 'Save kept on device awaiting membership check (check_failed, invoices)'],
            ['write_queued_for_access', `Save kept on device awaiting membership check (check_failed, ${section})`],
            ...(late === 'cancel' ? [['invoice_share_aborted_after_handoff', 'Invoice share sheet answered a cancel after the hand-off (asked the member)']] : []),
          ];
          for (const [event, message] of expected) {
            const observed = reports.filter(x => x.event === event && x.message === message);
            // A rate-limited report has no database row to explain. It does
            // not grant an allowance for any other report or a missing check.
            if (observed.length) qa.intentionalClientErrors(observed, {
              message, kind: 'error', authUserId: user.id, count: 1,
              reason: `This journey deliberately timed out membership and withheld the share answer (${screen.key}, late ${late}); the member confirmed it and the exact invoice/items recovered once. Fault began ${new Date(launchAt).toISOString()}.`,
            });
          }
        }
      }, { soft: true });

      await qa.feature('SYNC-003', `${screen.label}: after a reload everything stays billed and nothing asks again (${screen.key})`, async () => {
        await reopenScreen();
        await sleep(1500);
        const shown = await screen.onScreen(page, number);
        await qa.shot(`${screen.key} after reload`);
        qa.check('after a reload: every item still billed, no unrecorded reminder', screen.shownOk(shown) && !shown.unrecorded, JSON.stringify(shown));
        qa.check('after a reload: no "Did it go out?" anywhere', !(await page.getByText(`Did ${number} go out?`).count()) && !(await page.getByRole('button', { name: 'Yes, it was sent' }).count()));
        await subTab(page, 'Invoices');
        const listed = await page.getByText(number, { exact: false }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
        qa.check(`the Invoices tab lists ${number}`, listed);
      }, { soft: true });
    });
  }
});
