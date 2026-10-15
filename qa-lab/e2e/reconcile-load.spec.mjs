// A record added while the app's second account load is reading stays: on
// screen, in the device's offline copy and in the account, and once after a
// reload.
//
// Every app open loads the account twice: the first load, then, once the
// membership answer opens writes, the reconcile load (src/context/AppContext.jsx,
// reconciledAccess). The member app is already on screen and taking edits while
// that second load reads every table, then the device copy, then the deletion
// ledger, and then replaces the records on screen and the device copy with what
// it read. A save that reached the account after its table was read was in
// neither read, so it vanished from the screen and from the device copy (the
// row stayed; the next load showed it again). Seen in this lab on 2026-09-30 for
// a custom category and a license; fixed by fix/reconcile-load-race
// (src/utils/loadRebase.js: the changes made since the load began are laid over
// what it read).
//
// The journey holds the reconcile load's deletion-ledger read (the open's second
// ledger read), as a slow connection would, makes the change while it is held,
// then lets the load finish and watches what it does to the record.
//
// Since release/goal4 (e1f4b4c9) an open loads the account once, and the
// membership answer reads it again only when the load owes it
// (utils/loadOwes.js, AppContext settleFirstAnswer). The journey checks a plain
// open sends one ledger read, then makes each open owe the second load as a
// weak network does (the answer's read of the deletion stamp fails:
// deletionSinceLoad "unread"), so the race this journey guards is still run.
import { test } from './support/fixtures.mjs';
import {
  clerkId, lab, newMember, offlineCopy, openCredentials, pendingOps, row, sleep, stamp, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { addLicense, monthsFrom } from './support/cred-helpers.mjs';

const LEDGER_READ = /\/rest\/v1\/deleted_items\?select=item_id/;
// The membership answer's read of the deletion stamp (AppContext deletionSinceLoad), one per open.
const STAMP_READ = /\/rest\/v1\/profiles\?select=deleted_at(%2C|,)data_deleted_at/;
const HOLD_MAX_MS = 60000;      // a held read is let go after this whatever the journey is doing
const WATCH_MS = 6000;          // how long the screen is watched once the load has finished
const GONE = /This category no longer exists/;

const rail = (page) => page.getByRole('navigation').filter({ hasText: 'Active Credentials' });
const at = (t, zero) => (t ? `+${((t - zero) / 1000).toFixed(2)} s` : 'never');

/**
 * Holds the second GET of the deletion ledger from now on (the reconcile load's; the first is the
 * first load's) until `release()`, and notes when each ledger read and each GET of `table` was
 * sent, so the journey can prove the change landed inside the window the bug needed.
 * Only reads the new document sends count: the page being left can still send one (its own
 * reconcile load, still running when the journey navigates), and counted as "the first" it made
 * the new page's first load the one held, so nothing could be saved until the hold ran out
 * (2026-10-01 02:45 UTC: ledger reads at +0.01 s, +0.67 s, +60.77 s; the save at +60.97 s).
 */
async function holdReconcileLedgerRead(page, table) {
  const s = { zero: Date.now(), ledger: [], tableReads: [], heldAt: 0, releasedAt: 0, finishedAt: 0, heldUrl: null, navigatedAt: 0, ignored: [] };
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const tableRead = new RegExp(`/rest/v1/${table}\\?`);
  let documentRequested = false;
  const onRequest = (req) => {
    if (req.resourceType() === 'document' && req.frame() === page.mainFrame()) documentRequested = true;
    if (req.method() === 'GET' && tableRead.test(req.url())) s.tableReads.push(Date.now());
  };
  const onFinished = (req) => { if (s.heldUrl && req.url() === s.heldUrl && !s.finishedAt) s.finishedAt = Date.now(); };
  // The new document's commit (a same-document navigation of the page being left does not count).
  const onNavigated = (frame) => { if (frame === page.mainFrame() && documentRequested && !s.navigatedAt) s.navigatedAt = Date.now(); };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('framenavigated', onNavigated);
  const handler = async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (!s.navigatedAt) { s.ignored.push(Date.now()); return route.fallback(); }
    const n = s.ledger.push(Date.now());
    if (n === 2) {
      s.heldAt = Date.now();
      s.heldUrl = route.request().url();
      await Promise.race([released, sleep(HOLD_MAX_MS)]);
      s.releasedAt = Date.now();
    }
    return route.fallback();
  };
  await page.route(LEDGER_READ, handler);
  // The answer's deletion-stamp read fails once (the new document's), so it owes the second load.
  s.stampFailed = 0;
  const stampHandler = (route) => {
    if (route.request().method() !== 'GET' || !s.navigatedAt || s.stampFailed) return route.fallback();
    s.stampFailed += 1;
    return route.abort('failed');
  };
  await page.route(STAMP_READ, stampHandler);
  return {
    s,
    release: () => release(),
    held: () => waitFor('the reconcile load\'s ledger read', async () => s.heldAt || null, { timeoutMs: 90000, intervalMs: 100 }),
    finished: () => waitFor('the held ledger read to finish', async () => s.finishedAt || null, { timeoutMs: 30000, intervalMs: 100 }),
    dispose: async () => {
      release();
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('framenavigated', onNavigated);
      await page.unroute(LEDGER_READ, handler).catch(() => {});
      await page.unroute(STAMP_READ, stampHandler).catch(() => {});
    },
  };
}

/** Samples `present()` every 250 ms for `ms`; returns the samples that failed. */
async function watch(page, ms, present) {
  const misses = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await present();
    if (!r.ok) misses.push(r.why);
    await sleep(250);
  }
  return misses;
}

/** The window checks both records share: the change landed after its table was read and while the ledger read was held. */
function checkWindow(qa, hold, savedAt, table) {
  const { s } = hold;
  qa.check('the answer\'s deletion-stamp read failed, so the open owed a second load (release/goal4)', s.stampFailed === 1, `${s.stampFailed} failed`);
  qa.check('the reconcile load\'s ledger read was held (the open\'s second, after the first load\'s had been sent)',
    s.heldAt > 0 && s.ledger.length >= 2 && s.ledger[0] < s.heldAt, `ledger reads at ${s.ledger.map((t) => at(t, s.zero)).join(', ')}${s.ignored.length ? `; the page being left sent ${s.ignored.length} (not counted)` : ''}`);
  const readBeforeSave = s.tableReads.filter((t) => t > s.ledger[0] && t < savedAt);
  qa.check(`the reconcile load read ${table} before the save landed (the bug's window)`, readBeforeSave.length > 0,
    `${table} reads at ${s.tableReads.map((t) => at(t, s.zero)).join(', ')}; saved ${at(savedAt, s.zero)}`);
  qa.check('the save landed while the ledger read was held, before the load replaced the records',
    savedAt > s.heldAt && s.releasedAt > 0 && savedAt < s.releasedAt, `held ${at(s.heldAt, s.zero)}, saved ${at(savedAt, s.zero)}, released ${at(s.releasedAt, s.zero)}`);
}

test('a record added while the reconcile load reads stays on screen, in the offline copy and after a reload', {
  tag: ['@CRED-023', '@CRED-001'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { profile, user } = await newMember(page, { firstName: 'Rhea', lastName: 'Reconcile' });
  const pid = profile.id;
  const cid = (await clerkId(page)) || user.id;
  const tag = stamp('rc');

  await qa.feature('CRED-023', 'One account load per open (release/goal4): a plain reopen sends one ledger read and reads licenses once', async () => {
    const reads = { ledger: 0, licenses: 0 };
    const onReq = (r) => {
      if (r.method() !== 'GET') return;
      if (LEDGER_READ.test(r.url())) reads.ledger += 1;
      if (/\/rest\/v1\/licenses\?/.test(r.url())) reads.licenses += 1;
    };
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await sleep(1000);
    page.on('request', onReq);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await sleep(6000);
    page.off('request', onReq);
    qa.check('one ledger read and one licenses read for the reopen', reads.ledger === 1 && reads.licenses === 1, JSON.stringify(reads));
  });

  await qa.feature('CRED-023', 'A category created while the reconcile load reads stays on screen and in the offline copy', async () => {
    const name = `QA Race Category ${tag.slice(-4)}`;
    const hold = await holdReconcileLedgerRead(page, 'custom_categories');
    try {
      await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
      await waitForMemberApp(page);
      await hold.held();
      const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /\/rest\/v1\/custom_categories\b/.test(r.url()), { timeout: 30000 });
      await openCredentials(page, 'New category');
      await page.getByPlaceholder('e.g. Hospital ID Badges').fill(name);
      await page.getByPlaceholder('One emoji').fill('🅿️');
      await page.getByPlaceholder('Badge number, Facility, Access level').fill('Permit number');
      await page.getByRole('button', { name: 'Create category' }).click();
      const res = await saved;
      const savedAt = Date.now();
      qa.check('the category reached the account (POST custom_categories 201)', res.status() === 201, `${res.status()}`);
      const shown = await page.getByRole('heading', { name: new RegExp(name) }).waitFor({ timeout: 15000 }).then(() => true, () => false);
      qa.check('the new category is shown', shown);
      await sleep(800);   // the device copy's write (300 ms after a change) lands before the load goes on
      hold.release();
      await hold.finished();
      checkWindow(qa, hold, savedAt, 'custom_categories');
      const misses = await watch(page, WATCH_MS, async () => {
        const body = await page.locator('body').innerText().catch(() => '');
        if (GONE.test(body)) return { ok: false, why: 'the screen says "This category no longer exists"' };
        if (!(await rail(page).getByRole('button', { name: new RegExp(name) }).count())) return { ok: false, why: 'the Credentials menu no longer lists it' };
        return { ok: true };
      });
      await qa.shot('category after the reconcile load');
      qa.check('once the load has finished, the category stays on screen (heading and Credentials menu, sampled for 6 s)', misses.length === 0, [...new Set(misses)].join('; '));
      qa.check('the heading still names it', await page.getByRole('heading', { name: new RegExp(name) }).isVisible().catch(() => false));
      const db = row(`select count(*)::int as n, bool_and(archived_at is null) as live from public.custom_categories where user_id = '${pid}' and name = '${name}'`);
      qa.check('the account holds it once, not archived', db?.n === 1 && db.live === true, db);
      const copy = await waitFor('the offline copy', async () => { const c = await offlineCopy(page, cid, { find: [name] }); return c.found[name] ? c : null; }, { timeoutMs: 10000, intervalMs: 500 })
        .catch(async () => offlineCopy(page, cid, { find: [name] }));
      qa.check('the device\'s offline copy (IndexedDB) holds it', copy.found[name] === true && copy.where === 'offline' && copy.parses, JSON.stringify({ where: copy.where, parses: copy.parses, found: copy.found }));
      if (misses.length || !copy.found[name]) {
        qa.bug({
          title: 'A category created while the reconcile load reads vanishes from the screen and the device copy',
          step: 'Open the app; while its second (reconcile) account load waits on the deletion ledger, create a custom category; let the load finish',
          expected: 'The category stays in the Credentials menu and in the device\'s offline copy',
          actual: `${[...new Set(misses)].join('; ') || 'shown'}; offline copy ${copy.found[name] ? 'holds it' : 'does not hold it'}; the account row ${db?.n === 1 ? 'is there' : 'is missing'}`,
          severity: 'high',
        });
      }
    } finally { await hold.dispose(); }
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page);
    await sleep(3000);
    qa.check('after a reload the Credentials menu lists it once', (await rail(page).getByRole('button', { name: new RegExp(name) }).count()) === 1);
    const after = await offlineCopy(page, cid, { find: [name] });
    qa.check('after a reload the offline copy still holds it', after.found[name] === true, JSON.stringify(after.found));
  });

  await qa.feature('CRED-001', 'A license added while the reconcile load reads stays on screen and in the offline copy', async () => {
    const number = `QA-RC-${tag.slice(-4).toUpperCase()}`;
    let shownTimes = 0;   // how many places Licenses names the number right after the save
    const hold = await holdReconcileLedgerRead(page, 'licenses');
    try {
      await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
      await waitForMemberApp(page);
      await hold.held();
      const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /\/rest\/v1\/licenses\b/.test(r.url()), { timeout: 45000 });
      const r = await addLicense(page, { number, state: 'CO', expires: monthsFrom(24) });
      qa.check('the license form saved and closed', r.closed, r.refusal);
      const res = await saved;
      const savedAt = Date.now();
      qa.check('the license reached the account (POST licenses 201)', res.status() === 201, `${res.status()}`);
      const shown = await page.getByText(number).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      qa.check('the new license is shown under Licenses', shown);
      shownTimes = await page.getByText(number).count();
      await sleep(800);
      hold.release();
      await hold.finished();
      checkWindow(qa, hold, savedAt, 'licenses');
      const misses = await watch(page, WATCH_MS, async () => (
        (await page.getByText(number).count()) ? { ok: true } : { ok: false, why: 'Licenses no longer lists it' }));
      await qa.shot('license after the reconcile load');
      qa.check('once the load has finished, the license stays under Licenses (sampled for 6 s)', misses.length === 0, [...new Set(misses)].join('; '));
      const db = row(`select count(*)::int as n from public.licenses where user_id = '${pid}' and license_number = '${number}'`);
      qa.check('the account holds it once', db?.n === 1, db);
      const copy = await waitFor('the offline copy', async () => { const c = await offlineCopy(page, cid, { find: [number] }); return c.found[number] ? c : null; }, { timeoutMs: 10000, intervalMs: 500 })
        .catch(async () => offlineCopy(page, cid, { find: [number] }));
      qa.check('the device\'s offline copy (IndexedDB) holds it', copy.found[number] === true && copy.where === 'offline' && copy.parses, JSON.stringify({ where: copy.where, parses: copy.parses, found: copy.found }));
      if (misses.length || !copy.found[number]) {
        qa.bug({
          title: 'A license added while the reconcile load reads vanishes from the screen and the device copy',
          step: 'Open the app; while its second (reconcile) account load waits on the deletion ledger, add a license; let the load finish',
          expected: 'The license stays under Licenses and in the device\'s offline copy',
          actual: `${[...new Set(misses)].join('; ') || 'shown'}; offline copy ${copy.found[number] ? 'holds it' : 'does not hold it'}; the account row ${db?.n === 1 ? 'is there' : 'is missing'}`,
          severity: 'high',
        });
      }
    } finally { await hold.dispose(); }
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Licenses');
    await sleep(3000);
    const again = await page.getByText(number).count();
    qa.check('after a reload Licenses lists it as it did after the save (no second copy)', shownTimes > 0 && again === shownTimes, `${again} now, ${shownTimes} after the save`);
    const after = await offlineCopy(page, cid, { find: [number] });
    qa.check('after a reload the offline copy still holds it', after.found[number] === true, JSON.stringify(after.found));
    const queued = await pendingOps(page);
    qa.check('no write is left queued', queued.length === 0, JSON.stringify(queued).slice(0, 300));
  });
});
