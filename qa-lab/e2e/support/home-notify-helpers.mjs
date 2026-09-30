// Helpers the Home and notification journeys share (home-notify*.spec.mjs).
//
// Everything here talks to this machine only: the lab app in the journey's
// browser, the local stack through support/lab.mjs (PostgREST as the member,
// read-only SQL), and the mock server. Records a journey seeds are synthetic
// and written as the member through PostgREST, so row-level security applies
// exactly as it does for the app; they stand for records that reached the
// account another way (the registry import, another device, Vera), used only
// where the app's own form refuses the shape a checklist step needs or where a
// step needs many records at once.
import { inflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  SHOT_DIR, createPhysician, dismissInterruptions, goTab, lab, landing, payForMembership, profileOf, restAs, row, signIn, sleep, waitFor,
  waitForMemberApp, waitForProfile,
} from './lab.mjs';
import { foundingPlaces, resetFoundingPlaces } from '../../founding-reset.mjs';

/** An ISO date `offset` days from today (UTC), as the app's date inputs take it. */
export const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

/**
 * Inserts synthetic rows into one of the member's tables as the member
 * (PostgREST, RLS applies), one request per row so rows may carry different
 * columns. Returns the new ids in order.
 */
export async function seed(user, profileId, table, records) {
  const ids = [];
  for (const r of records) {
    const id = r.id || crypto.randomUUID();
    const res = await restAs(user, table, { method: 'POST', body: { ...r, id, user_id: profileId } });
    if (res.status >= 300) throw new Error(`seeding ${table} as the member: ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
    ids.push(id);
  }
  return ids;
}

/** Reloads the app and waits for the member screens (the member's next visit). */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  await sleep(1200);
}

/** The visible text of the page, whitespace collapsed. */
export async function bodyText(page) {
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

/** The top bar's page title (Dashboard, Credentials, Documents, Practice, More). */
export async function pageTitle(page) {
  return page.evaluate(() => {
    const bars = [...document.querySelectorAll('div')].filter((d) => getComputedStyle(d).position === 'sticky' && d.getBoundingClientRect().top <= 1 && d.getBoundingClientRect().height < 120);
    const bar = bars.find((b) => /Dashboard|Credentials|Documents|Practice|More|Team|Share/.test(b.innerText));
    if (!bar) return null;
    const t = [...bar.querySelectorAll('div')].find((d) => /^(Dashboard|Credentials|Documents|Practice|More|Team|Share)$/.test(d.textContent.trim()) && d.children.length === 0);
    return t ? t.textContent.trim() : null;
  });
}

/** Whether the top bar shows its Back button. */
export async function hasBackButton(page) {
  return (await page.getByRole('button', { name: /^Back$/ }).count()) > 0;
}

/**
 * The top bar's two icon buttons (bell, theme), left to right. They have no
 * accessible names, so they are found as the only icon buttons in the bar
 * (the bell may carry a count badge).
 */
export async function topBarIcons(page) {
  const vw = page.viewportSize()?.width || 1280;
  const out = [];
  for (const h of await page.getByRole('button').all()) {
    const box = await h.boundingBox().catch(() => null);
    if (!box || box.y > 70 || box.y < 0 || box.x < vw - 140) continue;
    const text = (await h.innerText().catch(() => 'x')).trim();
    if (!/^(\d+|9\+)?$/.test(text)) continue;
    out.push({ h, x: box.x, text });
  }
  out.sort((a, b) => a.x - b.x);
  return { bell: out[0]?.h || null, bellBadge: out[0]?.text || '', theme: out[1]?.h || null };
}

/** The top bar's avatar circle (a clickable div carrying the initials or photo). */
export function topBarAvatar(page) {
  return page.locator('div[style*="border-radius: 18px"][style*="cursor: pointer"]').first();
}

/** Switches the viewport; the app re-reads its layout on resize (>= 1024 px is desk). */
export async function setWidth(page, width, height = width < 1024 ? 812 : 900) {
  await page.setViewportSize({ width, height });
  await sleep(900);
}

/**
 * The phone's bottom tab bar buttons: Home, Credentials, the green +, the
 * Practice (or Team) slot and More. Found from its Home button's parent.
 */
export async function phoneBar(page) {
  const home = page.getByRole('button', { name: /^Home$/ }).last();
  const bar = home.locator('xpath=..');
  const buttons = await bar.locator(':scope > button').all();
  const info = [];
  for (const b of buttons) {
    info.push({
      b,
      label: (await b.innerText().catch(() => '')).trim(),
      // The active tab carries a 4 x 4 dot.
      dot: await b.evaluate((el) => [...el.querySelectorAll('div')].some((d) => d.style.width === '4px' && d.style.height === '4px')).catch(() => false),
    });
  }
  return { bar, buttons: info };
}

/**
 * Replaces window.open with a recorder, as the device's mail and Messages
 * apps would receive what the app hands them (mailto:, sms:, a blob). The
 * journey reads them back with opened(); each call starts a fresh list.
 */
export async function recordOpens(page) {
  await page.evaluate(() => {
    window.__qaOpened = [];
    window.open = (url, target) => { window.__qaOpened.push({ url: String(url), target: target || '' }); return null; };
  });
}
export async function opened(page) { return page.evaluate(() => window.__qaOpened || []); }

/**
 * The lab's stand-in for the device's share sheet: records what the app
 * shares (title, text, files), as expenses-backup.spec.mjs does.
 */
export async function recordShares(page) {
  await page.evaluate(() => {
    window.__qaShared = [];
    navigator.canShare = () => true;
    navigator.share = async (data) => { window.__qaShared.push({ title: data.title || '', text: data.text || '', files: (data.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) }); };
  });
}
export async function shared(page) { return page.evaluate(() => window.__qaShared || []); }

/**
 * The lab's stand-in for the browser's notification permission prompt and
 * the notifications the OS would show, installed before the app loads:
 * permission starts at "default" (a browser that has never been asked),
 * requestPermission() answers as a physician who taps Allow, the answer is
 * remembered across reloads as a browser remembers it, and every
 * notification the page creates is recorded (window.__qaNotifications).
 * Headless Chromium answers "denied" for every site, which would hide the
 * Enable button the checklist step taps.
 */
export async function installNotificationStandIn(context) {
  await context.addInitScript(() => {
    const KEY = '__qa_lab_notification_permission';
    const shown = [];
    const asks = [];
    let perm = 'default';
    try { perm = localStorage.getItem(KEY) || 'default'; } catch { /* storage off */ }
    class QaNotification {
      constructor(title, options = {}) { shown.push({ title: String(title), body: String(options.body || ''), tag: String(options.tag || ''), at: Date.now() }); this.onclick = null; }
      close() {}
      static get permission() { return perm; }
      static async requestPermission() { asks.push(Date.now()); perm = 'granted'; try { localStorage.setItem(KEY, perm); } catch { /* storage off */ } return perm; }
    }
    Object.defineProperty(window, 'Notification', { value: QaNotification, configurable: true, writable: true });
    window.__qaNotifications = shown;
    window.__qaPermissionAsks = asks;
  });
}

/** The shared hook secret the database's dispatch_* functions send (the LOCAL vault). */
export function localHookSecret() {
  const r = row(`select decrypted_secret as s from vault.decrypted_secrets where name = 'welcome_hook_secret'`);
  if (!r?.s) throw new Error('no welcome_hook_secret in the local vault');
  return r.s;
}

/**
 * Calls one of the lab's edge functions the way its pg_cron dispatcher does
 * (x-hook-secret), with a body that names one row, so a journey never sweeps
 * another journey's rows. LOCAL gateway only.
 */
export async function runHook(fn, body = {}) {
  const r = await fetch(`${lab().urls.api}/functions/v1/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hook-secret': localHookSecret() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

/** The Home tab, with a moment for its cards to settle. */
export async function home(page) {
  await goTab(page, 'Home');
  await sleep(700);
}

/** Waits until `fn` returns truthy (a short poll for a screen or a row). */
export async function eventually(what, fn, timeoutMs = 15000) {
  return waitFor(what, fn, { timeoutMs, intervalMs: 400 }).catch(() => null);
}

/** The id of the focused element's data-fkey (the field CrudSection focuses on a deep link). */
export async function focusedFieldKey(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-fkey') || document.activeElement?.tagName || null);
}

/** PATCH through PostgREST as the member (RLS applies), e.g. `profiles?id=eq.<id>`. */
export async function restAsPatch(user, pathname, body) {
  return restAs(user, pathname, { method: 'PATCH', body });
}

/**
 * Waits until the lab has a public founding place free. Several authors run
 * journeys against one lab at once and every paid journey takes a place;
 * when fewer than `minLeft` are left, this frees the places journeys took
 * more than 15 minutes ago (npm run qa:founding-reset's default, which the
 * README documents as safe while journeys run) and polls until one is free.
 */
export async function waitForFoundingPlace({ minLeft = 2, timeoutMs = 12 * 60 * 1000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const left = foundingPlaces()?.live?.left ?? 0;
    if (left >= minLeft) return left;
    try { resetFoundingPlaces(); } catch { /* another runner holds the lock; poll again */ }
    if ((foundingPlaces()?.live?.left ?? 0) >= minLeft) return foundingPlaces().live.left;
    if (Date.now() > until) throw new Error(`no founding place came free in ${Math.round(timeoutMs / 60000)} minutes (the shared lab is full)`);
    await sleep(20000);
  }
}

/**
 * newMember() from support/lab.mjs, patient with a shared lab: it waits for a
 * founding place before paying, and when the gate still answers "Founding
 * checkout is temporarily unavailable" (another journey took the last place
 * between the look and the tap) it waits for the next place and pays again
 * as the same physician, as a member retrying later would.
 */
export async function memberWithPlace(page, opts = {}) {
  const user = await createPhysician(opts);
  await signIn(page, user);
  const where = await landing(page);
  if (where !== 'gate') throw new Error(`a new physician should land on the membership gate, landed on: ${where}`);
  let payment = null;
  for (let attempt = 1; !payment; attempt++) {
    await waitForFoundingPlace();
    try {
      payment = await payForMembership(page);
    } catch (e) {
      const full = await page.getByText(/Founding checkout is temporarily unavailable/).first().isVisible().catch(() => false);
      if (!full || attempt >= 4) throw e;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await landing(page);
    }
  }
  await waitForProfile(user.id, (p) => p.access_status === 'active', 90000);
  await waitForMemberApp(page);
  await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  await dismissInterruptions(page);
  return { user, payment, profile: profileOf(user.id) };
}

/**
 * The text a PDF's content streams draw (each FlateDecode stream inflated), to
 * read what a generated transcript says without a PDF library.
 */
export function pdfText(buffer) {
  const s = Buffer.from(buffer).toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const chunk = Buffer.from(s.slice(start, end), 'latin1');
    try { out.push(inflateSync(chunk).toString('latin1')); } catch { out.push(chunk.toString('latin1')); }
    re.lastIndex = end;
  }
  return out.join('\n');
}

/**
 * A screenshot of one captured email on the mock Resend's inbox page (a page
 * on this machine), for a bug's evidence. Returns the file, or null.
 */
export async function mailShot(context, emailId, to, name) {
  if (!emailId) return null;
  const p = await context.newPage();
  try {
    await p.goto(`${lab().urls.inbox}?id=${encodeURIComponent(emailId)}&to=${encodeURIComponent(to)}`, { waitUntil: 'load' });
    await sleep(800);
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `home-notify mail ${name}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) + '.png');
    await p.screenshot({ path: file, fullPage: true });
    return file;
  } catch { return null; } finally { await p.close().catch(() => {}); }
}
