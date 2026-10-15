// Saves made before the page load's first membership answer (fix/no-answer-settings).
//
// The member app opens from the loaded profile before billing-entitlements has
// answered. Until 4c5883bb the Setup board's own stamps (started, the score)
// were refused then: "Save refused (no_answer, settings)" in client_errors, a
// native "Reconnecting, try again in a moment." on a load where nobody typed,
// and the stamp dropped; a member's own settings edit in that window was refused
// the same way and never retried. This journey reopens /app/ with every
// billing-entitlements request held 8 s in the member's own browser (Playwright
// routing; the request then goes to the lab's function unchanged) and checks:
//   - an active member: no native dialog, no "Save refused (no_answer" report,
//     the Setup board's stamps and the member's phone edit reach the profile only
//     after the answer, and nothing is left queued;
//   - the same member once the membership has ended (the subscription canceled
//     while the app was closed, so this browser still remembers an active
//     answer): the same edit is taken back with the app's read-only message and
//     never reaches the profile;
//   - and once this browser has seen the ended membership: the edit is refused
//     at once, reported read_only (never no_answer) and never reaches the profile.
// The same three for records (fix/no-answer-settings 433deb40..340bbb8d): an
// active member adds a license and edits another before the answer (no native
// dialog, both saved after it, nothing left queued); with the membership ended
// and this browser still remembering it active, both are taken back after the
// answer with the read-only message; once the browser knows it ended,
// Credentials opens as the read-only archive during the held check (no Add, no
// Edit), so nothing is written ahead and nothing is reported no_answer.
// Nothing leaves this machine.
import { test } from './support/fixtures.mjs';
import {
  accessSnapshot, labExec, lab, mockApi, newMember, openCredentials, pendingOps, profileOf, recordButtons, row, rows, sleep, stripeFor, waitFor,
  waitForMemberApp,
} from './support/lab.mjs';
import { openSettings } from './support/settings-auth-helpers.mjs';
import { addLicense, day, fillField } from './support/cred-helpers.mjs';

const HOLD_MS = 8000;
const PHONE = '(555) 123-4567';
// src/utils/limitedLaunchAccess.js READ_ONLY_AFTER_CHECK_MESSAGE
const READ_ONLY_AFTER_CHECK = 'Your membership no longer allows changes here, so your last change was not kept. Your saved records and exports are still available.';
const sqlNow = () => row('select clock_timestamp() as at').at;
const isEntitlementsPost = (r) => r.url().includes('/functions/v1/billing-entitlements') && r.method() === 'POST';

/**
 * Holds every billing-entitlements POST of `page` until HOLD_MS after the first one,
 * then lets it go on to the lab's function unchanged (preflights pass at once).
 * Returns { releasedAt(), answered: Promise<{ status, at }> } and an `unroute`.
 */
async function holdEntitlements(page) {
  let firstAt = null;
  let releaseAt = null;
  // Only a request this hold saw counts as its answer: a check the page sent before the hold
  // was installed can answer after it (2026-10-01: an answer 310 ms before the first held POST).
  const held = new WeakSet();
  const handler = async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    held.add(route.request());
    firstAt ??= Date.now();
    releaseAt ??= firstAt + HOLD_MS;
    const wait = releaseAt - Date.now();
    if (wait > 0) await sleep(wait);
    return route.fallback();
  };
  await page.route('**/functions/v1/billing-entitlements', handler);
  const answered = page.waitForResponse((r) => isEntitlementsPost(r.request()) && held.has(r.request()), { timeout: 90000 })
    .then((r) => ({ status: r.status(), at: Date.now() }), () => ({ status: null, at: Date.now() }));
  return {
    releaseAt: () => releaseAt,
    firstAt: () => firstAt,
    answered,
    unroute: () => page.unroute('**/functions/v1/billing-entitlements', handler).catch(() => {}),
  };
}

/**
 * Waits until the app has sent the membership check this hold keeps, so what the journey does
 * next happens before the first answer with a check in flight. On a quick open the member app
 * and Settings were up 1.1 s after the load, 70 ms before the app sent its first
 * billing-entitlements POST (2026-10-01, full regression pass 2): the edit came before any check.
 */
const checkHeld = (hold) => waitFor('the held membership check', async () => hold.firstAt() || null, { timeoutMs: 20000, intervalMs: 50 }).catch(() => null);

/** Every report-error body this page sends, from now on. */
function watchReports(page) {
  const sent = [];
  const onRequest = (r) => { if (r.url().includes('/functions/v1/report-error') && r.method() === 'POST') sent.push(r.postData() || ''); };
  page.on('request', onRequest);
  return { sent, stop: () => page.off('request', onRequest) };
}

const ACCESS_ANSWER_KEY = 'credentialdomd-access-answer';
/** The access answers this browser remembers (src/utils/limitedLaunchAccess.js deviceAnswers), by key. */
const rememberedAnswers = (page) => page.evaluate((base) => Object.fromEntries(Object.keys(localStorage)
  .filter((k) => k === base || k.startsWith(`${base}:`)).map((k) => [k, localStorage.getItem(k)])), ACCESS_ANSWER_KEY);

/**
 * Credentials > Licenses: adds `add` (a CO medical license with that number) and changes the
 * License # of the record showing `editFrom` to `editTo`, as a member would. Returns what each
 * form did and when each was done.
 */
async function licenseWork(page, { add, editFrom, editTo }) {
  const out = { add: null, edit: null, addAt: null, editAt: null };
  out.add = await addLicense(page, { name: `QA First Answer ${add}`, number: add, state: 'CO', issued: '2022-03-01', expires: day(500) })
    .catch((e) => ({ closed: false, refusal: `error: ${String(e?.message || e).slice(0, 160)}` }));
  out.addAt = Date.now();
  // A refused form may stay open: close it so the list is reachable.
  for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape').catch(() => {});
  try {
    await openCredentials(page, 'Licenses');
    await recordButtons(page, editFrom).edit.click({ timeout: 8000 });
    const dlg = page.getByRole('dialog', { name: 'Edit' });
    await dlg.waitFor({ timeout: 8000 });
    await fillField(dlg, 'License #', editTo);
    await dlg.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    const closed = await dlg.waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false);
    out.edit = { closed, refusal: closed ? '' : ((await dlg.innerText().catch(() => '')).slice(0, 160) || 'the form stayed open') };
  } catch (e) {
    out.edit = { closed: false, refusal: `error: ${String(e?.message || e).slice(0, 160)}` };
  }
  out.editAt = Date.now();
  for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape').catch(() => {});
  return out;
}

const clientErrors = (subject, since, until = sqlNow()) => rows(`select id, kind, message, auth_user_id, created_at from public.client_errors
  where auth_user_id = '${subject}' and created_at >= '${since}' and created_at <= '${until}' order by created_at`);

// Claim only persisted rows belonging to the exact deliberate edit's account and
// bounded database window. Extra or unrelated reports remain health failures.
function claimReadOnlyEdit(qa, stored, subject, collection, reason) {
  const message = `Save refused (read_only, ${collection})`;
  const reports = stored.filter(r => r.message === message);
  if (reports.length) qa.intentionalClientErrors(reports, {
    message, kind: 'error', authUserId: subject, count: 1, reason,
  });
}

test('a save before the first membership answer: kept and sent once it allows, taken back once it refuses', {
  tag: ['@AUTH-009'],
}, async ({ page, qa }) => {
  test.setTimeout(12 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Fay', lastName: 'Firstanswer' });
  const pid = profile.id;
  const subject = user.id;
  // The first case is an active member whose browser already knows it. Under load the pages
  // after payment were left before any membership answer landed (2026-10-01: the last request
  // was cut off by the next navigation), so the browser still remembered the unpaid account's
  // read-only answer and refused the held-check edit as read_only, as designed for that answer.
  // Wait until this browser remembers the paid membership (credential write true).
  const knowsActive = async () => Object.values(await rememberedAnswers(page).catch(() => ({})))
    .some((v) => { try { return JSON.parse(v)?.credential === true; } catch { return false; } });
  for (let i = 0; i < 3 && !(await knowsActive()); i++) {
    await waitFor('the active answer remembered', async () => (await knowsActive()) || null, { timeoutMs: 20000, intervalMs: 500 }).catch(() => null);
    if (!(await knowsActive())) { await page.reload(); await waitForMemberApp(page); }
  }
  const journeyStart = sqlNow();
  // Synthetic license numbers (QA- prefix): one added during each held check, one edited.
  const KEEP = 'QA-FA-KEEP-1';
  const KEEP_EDITED = 'QA-FA-KEEP-1E';
  const lic = (number) => row(`select id, license_number, name from public.licenses where user_id = '${pid}' and license_number = '${number}'`);
  const licQueued = (ops) => ops.filter((op) => op?.collectionKey === 'licenses');
  labExec(`insert into public.licenses (user_id, type, name, license_number, state, issued_date, expiration_date)
    values ('${pid}', 'State Medical License', 'QA First Answer kept license', '${KEEP}', 'ND', date '2021-01-01', date '2029-06-30')`);

  await qa.feature('AUTH-009', 'Active member reopens /app/ with billing-entitlements held 8 s: no dialog, no no_answer report; board stamps and the phone edit are saved after the answer', async () => {
    // The board stamps on a load only what the stored copy lacks (firstRenderPatch: startedAt;
    // the score). Clearing the stored copy makes this load stamp both, as a member whose last
    // stamp was lost would see (the next load stamps it again).
    labExec(`update public.profiles set setup_state = null where id = '${pid}'`);
    const phoneBefore = profileOf(subject).phone ?? null;
    const since = sqlNow();
    const dialogsBefore = qa.report.dialogs.length;
    const reports = watchReports(page);
    const hold = await holdEntitlements(page);
    const opened = Date.now();
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await checkHeld(hold);
    const appAt = Date.now();
    await openSettings(page);
    const phoneField = page.getByPlaceholder(PHONE);
    const typed = '(555) 010-0177';
    await phoneField.fill(typed);
    await phoneField.blur();
    const editAt = Date.now();
    const releaseAt = hold.releaseAt();
    qa.check('the member app opened and the edit was made while the check was held', !!releaseAt && editAt < releaseAt,
      JSON.stringify({ appMs: appAt - opened, editMs: editAt - opened, releaseMs: releaseAt ? releaseAt - opened : null }));
    // Still inside the hold: nothing has gone up yet.
    if (releaseAt && releaseAt - Date.now() > 1500) await sleep(Math.max(0, releaseAt - Date.now() - 1200));
    const midProfile = row(`select phone, setup_state from public.profiles where id = '${pid}'`);
    const midQueued = await pendingOps(page);
    const inHold = !!releaseAt && Date.now() < releaseAt;
    await qa.shot('edit during the held check');
    qa.check('before the answer the profile is unchanged (no phone, no board stamp)', inHold && (midProfile?.phone ?? null) === phoneBefore && midProfile?.setup_state == null,
      JSON.stringify({ inHold, phone: midProfile?.phone ?? null, setup: midProfile?.setup_state ?? null }));
    qa.check('the edit is written ahead on this device while the answer is awaited', midQueued.some((op) => op?.awaitingAccess === true && JSON.stringify(op).includes('0177')),
      JSON.stringify(midQueued).slice(0, 300));
    qa.check('the field keeps the edit', (await phoneField.inputValue()) === typed);

    const answer = await hold.answered;
    qa.check('billing-entitlements answers 200 once released', answer.status === 200 && answer.at >= (releaseAt || 0),
      // sinceFirstPostMs over the app's 9 s request timeout (src/utils/limitedLaunchClient.js) means the
      // app gave up on that request ("Membership check failed", "Save kept on device awaiting
      // membership check (no_answer, ...)") and a later check decided the saves: a loaded lab.
      JSON.stringify({ status: answer.status, afterOpenMs: answer.at - opened, sinceFirstPostMs: hold.firstAt() ? answer.at - hold.firstAt() : null }));
    const saved = await waitFor('the phone edit on the profile', async () => (profileOf(subject).phone === typed ? true : null), { timeoutMs: 30000 }).catch(() => false);
    qa.check('the member\'s edit reaches the profile after the answer', saved, JSON.stringify({ before: phoneBefore, now: profileOf(subject).phone }));
    const stamped = await waitFor('the board stamps', async () => {
      const st = row(`select setup_state from public.profiles where id = '${pid}'`)?.setup_state;
      return st?.startedAt && st?.progress ? st : null;
    }, { timeoutMs: 30000 }).catch(() => row(`select setup_state from public.profiles where id = '${pid}'`)?.setup_state ?? null);
    qa.check('the Setup board stamps (startedAt, the score) reach the profile after the answer', !!stamped?.startedAt && !!stamped?.progress,
      JSON.stringify(stamped && { startedAt: stamped.startedAt, progress: stamped.progress }));
    await sleep(3000);
    const left = await pendingOps(page);
    qa.check('nothing is left queued', !left.some((op) => op?.awaitingAccess === true) && left.length === 0, JSON.stringify(left).slice(0, 300));
    const said = qa.report.dialogs.slice(dialogsBefore);
    qa.check('no native dialog during the load, the edit or the answer', said.length === 0, said.join(' | '));
    reports.stop();
    const noAnswerSent = reports.sent.filter((b) => b.includes('Save refused (no_answer'));
    qa.check('the browser sent no "Save refused (no_answer" report', noAnswerSent.length === 0, noAnswerSent.join(' | ').slice(0, 300));
    const stored = clientErrors(subject, since);
    qa.check('client_errors has no "Save refused (no_answer" row for this member', !stored.some((r) => r.message.startsWith('Save refused (no_answer')),
      JSON.stringify(stored).slice(0, 400));
    await hold.unroute();
  }, { soft: true });

  await qa.feature('AUTH-009', 'Active member reopens /app/ with billing-entitlements held 8 s, adds a license and edits another: no dialog, both saved after the answer, nothing left queued', async () => {
    const NEW = 'QA-FA-NEW-1';
    const since = sqlNow();
    const dialogsBefore = qa.report.dialogs.length;
    const reports = watchReports(page);
    const hold = await holdEntitlements(page);
    const opened = Date.now();
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await checkHeld(hold);
    const work = await licenseWork(page, { add: NEW, editFrom: KEEP, editTo: KEEP_EDITED });
    const releaseAt = hold.releaseAt();
    qa.check('the license was added and the other edited while the check was held (both forms closed)',
      !!releaseAt && work.editAt < releaseAt && work.add?.closed && work.edit?.closed,
      JSON.stringify({ addMs: work.addAt - opened, editMs: work.editAt - opened, releaseMs: releaseAt ? releaseAt - opened : null, add: work.add, edit: work.edit }));
    const midQueued = await pendingOps(page);
    const inHold = !!releaseAt && Date.now() < releaseAt;
    const midNew = lic(NEW);
    const midEdited = lic(KEEP_EDITED);
    await qa.shot('license added and edited during the held check');
    qa.check('before the answer neither change is in the database', inHold && !midNew && !midEdited && !!lic(KEEP),
      JSON.stringify({ inHold, added: !!midNew, edited: !!midEdited }));
    const heldLic = licQueued(midQueued).filter((op) => op?.awaitingAccess === true);
    qa.check('both changes are written ahead on this device while the answer is awaited',
      heldLic.some((op) => JSON.stringify(op).includes(NEW)) && heldLic.some((op) => JSON.stringify(op).includes(KEEP_EDITED)),
      JSON.stringify(midQueued).slice(0, 400));
    const shown = await page.getByText(NEW).first().isVisible().catch(() => false);
    qa.check('the new license shows at once', shown);

    const answer = await hold.answered;
    qa.check('billing-entitlements answers 200 once released', answer.status === 200 && answer.at >= (releaseAt || 0),
      // sinceFirstPostMs over the app's 9 s request timeout (src/utils/limitedLaunchClient.js) means the
      // app gave up on that request ("Membership check failed", "Save kept on device awaiting
      // membership check (no_answer, ...)") and a later check decided the saves: a loaded lab.
      JSON.stringify({ status: answer.status, afterOpenMs: answer.at - opened, sinceFirstPostMs: hold.firstAt() ? answer.at - hold.firstAt() : null }));
    const added = await waitFor('the new license in the database', async () => lic(NEW) || null, { timeoutMs: 30000 }).catch(() => null);
    const edited = await waitFor('the edited license in the database', async () => lic(KEEP_EDITED) || null, { timeoutMs: 30000 }).catch(() => null);
    qa.check('the added license reaches the database after the answer', !!added, JSON.stringify(added));
    qa.check('the edited license reaches the database after the answer (one row, the old number gone)', !!edited && !lic(KEEP),
      JSON.stringify({ edited, old: lic(KEEP) }));
    await sleep(3000);
    const left = await pendingOps(page);
    qa.check('nothing is left queued', left.length === 0, JSON.stringify(left).slice(0, 300));
    const said = qa.report.dialogs.slice(dialogsBefore);
    qa.check('no native dialog during the load, the two changes or the answer', said.length === 0, said.join(' | '));
    reports.stop();
    const refusedSent = reports.sent.filter((b) => b.includes('Save refused'));
    qa.check('the browser sent no "Save refused" report', refusedSent.length === 0, refusedSent.join(' | ').slice(0, 300));
    const stored = clientErrors(subject, since);
    qa.check('client_errors has no "Save refused" row for this member', !stored.some((r) => r.message.startsWith('Save refused')),
      JSON.stringify(stored).slice(0, 400));
    await hold.unroute();
  }, { soft: true });

  // The answer this browser remembers while the membership is still active, for the
  // records stretch below (a reopen after the ended membership's answer replaces it).
  let activeAnswers = {};

  await qa.feature('AUTH-009', 'The membership ended while the app was closed: the same edit during the held check is taken back with the read-only message', async () => {
    // Close the app first, so this browser still remembers the active answer.
    activeAnswers = await rememberedAnswers(page).catch(() => ({}));
    await page.goto('about:blank');
    const sub = (await stripeFor(subject)).sessions.map((s) => s.subscription).find(Boolean);
    const cancel = await mockApi(`/qa/stripe/subscriptions/${encodeURIComponent(sub)}/cancel`, { method: 'POST', body: { atPeriodEnd: false } });
    const ended = await waitFor('the membership to end', async () => {
      const snap = accessSnapshot(subject);
      return snap?.capabilities?.credential?.write === false ? snap : null;
    }, { timeoutMs: 60000, intervalMs: 1500 }).catch(() => null);
    qa.check('the subscription is canceled and credential writes end', !!ended, JSON.stringify(cancel?.delivery && { status: cancel.delivery.status }));
    const phoneBefore = profileOf(subject).phone ?? null;
    const since = sqlNow();
    const dialogsBefore = qa.report.dialogs.length;
    const reports = watchReports(page);
    const hold = await holdEntitlements(page);
    const opened = Date.now();
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await checkHeld(hold);
    await openSettings(page);
    const phoneField = page.getByPlaceholder(PHONE);
    const typed = '(555) 010-0188';
    await phoneField.fill(typed);
    await phoneField.blur();
    const editAt = Date.now();
    const releaseAt = hold.releaseAt();
    qa.check('the edit was made while the check was held', !!releaseAt && editAt < releaseAt, JSON.stringify({ editMs: editAt - opened, releaseMs: releaseAt ? releaseAt - opened : null }));
    const answer = await hold.answered;
    qa.check('billing-entitlements answers 200 once released', answer.status === 200, `status ${answer.status}`);
    const told = await waitFor('the read-only message', async () => qa.report.dialogs.slice(dialogsBefore).find((d) => d.includes(READ_ONLY_AFTER_CHECK)) || null, { timeoutMs: 20000 }).catch(() => null);
    await sleep(2000);
    await qa.shot('edit taken back after a read-only answer');
    const said = qa.report.dialogs.slice(dialogsBefore);
    qa.check('the member is told the change was not kept (the app\'s read-only message), once', !!told && said.length === 1, said.join(' | '));
    qa.check('the field shows the saved phone again', (await phoneField.inputValue()) === (phoneBefore || ''), JSON.stringify({ field: await phoneField.inputValue(), saved: phoneBefore }));
    await sleep(3000);
    qa.check('the edit never reaches the profile', (profileOf(subject).phone ?? null) === phoneBefore, JSON.stringify({ before: phoneBefore, now: profileOf(subject).phone }));
    const left = await pendingOps(page);
    qa.check('nothing is left queued', left.length === 0, JSON.stringify(left).slice(0, 300));
    reports.stop();
    const stored = clientErrors(subject, since);
    const sent = reports.sent.filter((b) => b.includes('Save refused'));
    // report-error keeps 30 rows per address per 10 minutes and every lab browser shares one:
    // the body the browser sent counts when a parallel run used the cap up.
    qa.check('the refusal is reported as read_only, never no_answer',
      (stored.some((r) => r.message === 'Save refused (read_only, settings)') || sent.some((b) => b.includes('Save refused (read_only, settings)')))
      && !stored.some((r) => r.message.startsWith('Save refused (no_answer')) && !sent.some((b) => b.includes('Save refused (no_answer')),
      JSON.stringify({ stored: stored.map((r) => r.message), sent: sent.map((b) => b.slice(0, 120)) }).slice(0, 400));
    claimReadOnlyEdit(qa, stored, subject, 'settings', 'AUTH-009 deliberately edits this ended member\'s phone during the held first check; the read-only answer restores the field, leaves the database unchanged and empties the queue.');
    await hold.unroute();
  }, { soft: true });

  await qa.feature('AUTH-009', 'The membership ended while the app was closed: a license added and another edited during the held check are taken back with the read-only message', async () => {
    const NEW = 'QA-FA-NEW-2';
    const TRY = 'QA-FA-KEEP-1X';
    // The reopen above taught this browser the ended membership. Put back the answer it
    // remembered while the membership was active (from a page on the app's origin that is
    // not the app, so nothing reads it first): the same state as a membership that ended
    // while the app was closed.
    const restore = Object.entries(activeAnswers);
    await page.goto(new URL('/qa-lab-blank', lab().urls.appOrigin).href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate((entries) => { for (const [k, v] of entries) localStorage.setItem(k, v); }, restore);
    const remembered = Object.values(await rememberedAnswers(page)).map((v) => { try { return JSON.parse(v); } catch { return null; } });
    qa.check('this browser remembers the membership as active again (credential write true)', restore.length > 0 && remembered.some((v) => v?.credential === true),
      JSON.stringify({ keys: restore.map(([k]) => k.replace(/:.*/, ':<id>')), remembered }));
    const since = sqlNow();
    const dialogsBefore = qa.report.dialogs.length;
    const reports = watchReports(page);
    const hold = await holdEntitlements(page);
    const opened = Date.now();
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await checkHeld(hold);
    const work = await licenseWork(page, { add: NEW, editFrom: KEEP_EDITED, editTo: TRY });
    const releaseAt = hold.releaseAt();
    qa.check('the license was added and the other edited while the check was held (both forms closed)',
      !!releaseAt && work.editAt < releaseAt && work.add?.closed && work.edit?.closed,
      JSON.stringify({ addMs: work.addAt - opened, editMs: work.editAt - opened, releaseMs: releaseAt ? releaseAt - opened : null, add: work.add, edit: work.edit }));
    const midQueued = licQueued(await pendingOps(page)).filter((op) => op?.awaitingAccess === true);
    qa.check('both changes are written ahead while the answer is awaited', midQueued.some((op) => JSON.stringify(op).includes(NEW)) && midQueued.some((op) => JSON.stringify(op).includes(TRY)),
      JSON.stringify(midQueued).slice(0, 300));
    const answer = await hold.answered;
    qa.check('billing-entitlements answers 200 once released', answer.status === 200, `status ${answer.status}`);
    const told = await waitFor('the read-only message', async () => qa.report.dialogs.slice(dialogsBefore).find((d) => d.includes(READ_ONLY_AFTER_CHECK)) || null, { timeoutMs: 20000 }).catch(() => null);
    await sleep(3000);
    await openCredentials(page, 'Licenses').catch(() => {});
    await sleep(800);
    await qa.shot('license add and edit taken back after a read-only answer');
    const said = qa.report.dialogs.slice(dialogsBefore);
    qa.check('the member is told the changes were not kept (the app\'s read-only message), and nothing else', !!told && said.every((d) => d.includes(READ_ONLY_AFTER_CHECK)),
      JSON.stringify({ count: said.length, said }).slice(0, 400));
    const listNew = await page.getByText(NEW).count();
    const listTry = await page.getByText(TRY).count();
    const listKept = await page.getByText(KEEP_EDITED).count();
    qa.check('the screen no longer shows the added license and shows the saved number again', listNew === 0 && listTry === 0 && listKept > 0,
      JSON.stringify({ added: listNew, edited: listTry, saved: listKept }));
    qa.check('neither change reaches the database', !lic(NEW) && !lic(TRY) && !!lic(KEEP_EDITED),
      JSON.stringify({ added: !!lic(NEW), edited: !!lic(TRY), saved: !!lic(KEEP_EDITED) }));
    const left = await pendingOps(page);
    qa.check('nothing is left queued', left.length === 0, JSON.stringify(left).slice(0, 300));
    reports.stop();
    const stored = clientErrors(subject, since);
    const sent = reports.sent.filter((b) => b.includes('Save refused'));
    qa.check('the refusals are reported as read_only (licenses), never no_answer',
      (stored.some((r) => r.message === 'Save refused (read_only, licenses)') || sent.some((b) => b.includes('Save refused (read_only, licenses)')))
      && !stored.some((r) => r.message.startsWith('Save refused (no_answer')) && !sent.some((b) => b.includes('Save refused (no_answer')),
      JSON.stringify({ stored: stored.map((r) => r.message), sent: sent.map((b) => b.slice(0, 120)) }).slice(0, 400));
    claimReadOnlyEdit(qa, stored, subject, 'licenses', 'AUTH-009 deliberately adds and edits licenses for this ended member during the held first check; the answer restores the saved list, leaves both changes out of the database and empties the queue.');
    await hold.unroute();
  }, { soft: true });

  await qa.feature('AUTH-009', 'This browser has seen the ended membership: the same edit during the held check is refused at once and never saved', async () => {
    const phoneBefore = profileOf(subject).phone ?? null;
    const since = sqlNow();
    const dialogsBefore = qa.report.dialogs.length;
    const reports = watchReports(page);
    const hold = await holdEntitlements(page);
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await checkHeld(hold);
    await openSettings(page);
    const phoneField = page.getByPlaceholder(PHONE);
    const editable = await phoneField.isEditable().catch(() => false);
    if (editable) {
      await phoneField.fill('(555) 010-0199');
      await phoneField.blur();
    }
    const releaseAt = hold.releaseAt();
    const inHold = !!releaseAt && Date.now() < releaseAt;
    await sleep(1000);
    const midQueued = await pendingOps(page);
    const page1 = (await page.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('read-only member edits during the held check');
    qa.check('nothing is written ahead for a membership this device knows has ended', inHold && midQueued.length === 0, JSON.stringify({ inHold, queued: midQueued }).slice(0, 300));
    const answer = await hold.answered;
    qa.check('billing-entitlements answers 200 once released', answer.status === 200, `status ${answer.status}`);
    await sleep(4000);
    qa.check('the edit never reaches the profile', (profileOf(subject).phone ?? null) === phoneBefore, JSON.stringify({ before: phoneBefore, now: profileOf(subject).phone }));
    qa.check('the field shows the saved phone', (await phoneField.inputValue()) === (phoneBefore || ''), await phoneField.inputValue());
    const said = qa.report.dialogs.slice(dialogsBefore);
    reports.stop();
    const stored = clientErrors(subject, since);
    const sent = reports.sent.filter((b) => b.includes('Save refused'));
    // Recorded for the run's report: what the member saw and what was reported.
    qa.check('observed (always passes): the dialogs, the page and the reports', true, JSON.stringify({ editable, dialogs: said, stored: stored.map((r) => r.message), sent: sent.map((b) => b.slice(0, 160)), page: page1.slice(0, 300) }));
    const misreported = stored.some((r) => r.message.startsWith('Save refused (no_answer')) || sent.some((b) => b.includes('Save refused (no_answer'));
    qa.check('no "Save refused (no_answer" report for a membership the device knows is read-only', !misreported,
      JSON.stringify({ stored: stored.map((r) => r.message), sent: sent.map((b) => b.slice(0, 120)) }).slice(0, 400));
    qa.check('the refusal is reported as read_only (settings)', !editable
      || stored.some((r) => r.message === 'Save refused (read_only, settings)') || sent.some((b) => b.includes('Save refused (read_only, settings)')),
      JSON.stringify({ editable, stored: stored.map((r) => r.message), sent: sent.map((b) => b.slice(0, 120)) }).slice(0, 400));
    if (editable) claimReadOnlyEdit(qa, stored, subject, 'settings', 'AUTH-009 deliberately edits this member\'s phone with a remembered ended membership; it is refused without queued work and the saved field and database remain unchanged.');
    if (misreported) {
      qa.bug({
        title: 'A read-only member\'s settings edit before the first membership answer is reported as "Save refused (no_answer, settings)"',
        severity: 'low',
        step: 'An ended membership this browser already knows (remembered answer: credential write false); reopen /app/ with billing-entitlements held 8 s; Profile & settings > Phone > edit > blur',
        expected: 'Refused (it is), and reported as read_only: the device remembered a read-only answer, so nothing is waiting on an answer',
        actual: 'Reported as "Save refused (no_answer, settings)". fix/no-answer-settings 433deb40 made writeStatus refuse read_only when the remembered answer denies the scope (src/utils/limitedLaunchAccess.js, the `ours && remembered?.[scope] === false` branch of writeStatus); this report means that branch was not reached.',
      });
    }
    await hold.unroute();
  }, { soft: true });

  await qa.feature('AUTH-009', 'This browser has seen the ended membership: during the held check Credentials is the read-only archive (no add, no edit), nothing is written or reported no_answer', async () => {
    // Once the device remembers the ended membership, Credentials opens as the saved-records
    // archive (src/components/features/ReadOnlyRecords.jsx) before the answer: there is no
    // Add or Edit to tap, so a record change is refused by not being offered. The settings
    // edit above is the one a read-only member can still make, and it is reported read_only.
    const remembered = Object.values(await rememberedAnswers(page).catch(() => ({}))).map((v) => { try { return JSON.parse(v); } catch { return null; } });
    qa.check('this browser remembers the ended membership (credential write false)', remembered.some((v) => v?.credential === false), JSON.stringify(remembered));
    const since = sqlNow();
    const dialogsBefore = qa.report.dialogs.length;
    const reports = watchReports(page);
    const hold = await holdEntitlements(page);
    const opened = Date.now();
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await checkHeld(hold);
    await openCredentials(page);
    const archive = page.getByText('These records are read-only', { exact: false }).first();
    const shownArchive = await archive.waitFor({ timeout: 5000 }).then(() => true, () => false);
    const addButtons = await page.getByRole('button', { name: /^(\+ )?Add( a license)?$/ }).count();
    const editButtons = await page.getByRole('button', { name: /^Edit\b/ }).count();
    const listsKept = await page.getByText(KEEP_EDITED).first().isVisible().catch(() => false);
    const shownAt = Date.now();
    const releaseAt = hold.releaseAt();
    const midQueued = await pendingOps(page);
    await qa.shot('read-only member opens Credentials during the held check');
    // Before the held check is even sent (no releaseAt yet: under load the app's first
    // entitlements request came 0.3 s after the archive showed, 2026-10-01) is before its answer too.
    qa.check('during the held check Credentials is the read-only archive, listing the saved licenses', (releaseAt === null || shownAt < releaseAt) && shownArchive && listsKept,
      JSON.stringify({ shownMs: shownAt - opened, releaseMs: releaseAt ? releaseAt - opened : null, shownArchive, listsKept }));
    qa.check('the archive offers no Add and no Edit', addButtons === 0 && editButtons === 0, JSON.stringify({ addButtons, editButtons }));
    qa.check('nothing is written ahead', midQueued.length === 0, JSON.stringify(midQueued).slice(0, 300));
    const answer = await hold.answered;
    qa.check('billing-entitlements answers 200 once released', answer.status === 200, `status ${answer.status}`);
    await sleep(3000);
    qa.check('after the answer Credentials is still the archive', await archive.isVisible().catch(() => false));
    const licenses = rows(`select license_number from public.licenses where user_id = '${pid}' order by license_number`).map((r) => r.license_number);
    qa.check('the licenses in the database are the two saved while active', JSON.stringify(licenses) === JSON.stringify([KEEP_EDITED, 'QA-FA-NEW-1']), JSON.stringify(licenses));
    const left = await pendingOps(page);
    qa.check('nothing is queued after the answer either', left.length === 0, JSON.stringify(left).slice(0, 300));
    reports.stop();
    const said = qa.report.dialogs.slice(dialogsBefore);
    const stored = clientErrors(subject, since);
    const sent = reports.sent.filter((b) => b.includes('Save refused'));
    qa.check('no native dialog', said.length === 0, said.join(' | '));
    qa.check('no "Save refused" report (nothing was attempted), and never no_answer', sent.length === 0 && !stored.some((r) => r.message.startsWith('Save refused')),
      JSON.stringify({ stored: stored.map((r) => r.message), sent: sent.map((b) => b.slice(0, 120)) }).slice(0, 400));
    await hold.unroute();
  }, { soft: true });

  const all = clientErrors(subject, journeyStart);
  qa.check('client_errors rows of this journey (listed)', true, JSON.stringify(all.map((r) => r.message)));
});
