// The device's offline copy of a large account (fix/offline-cache-idb).
//
// Owner ticket "Storage issue" (iPhone, installed web app): "This device's
// storage is full, so its offline copy of your records could not be updated."
// The app kept the whole per-account file in localStorage, about 5 MB per
// origin, and a 1,553-case-log account outgrew it; every cache write threw
// and what opened offline went stale. The file, the Vera transcript and its
// archives now live in IndexedDB (database credentialdomd-offline, store kv,
// the same scoped keys), and a copy the previous build left in localStorage
// moves there on the first load.
//
//   * SYNC-007  an account with 2,000 case logs (and a typical rest: licenses,
//               CME, privileges, insurance, education, a contract with 400 work
//               entries, publications, expenses) loads every row;
//   * SYNC-017  its offline copy, larger than this browser's localStorage can
//               hold, is kept whole in IndexedDB; localStorage stays small; no
//               "storage is full" notice, no quota warning, no storage report;
//   * SYNC-005  the offline copy is current: a license added this session opens
//               offline after a reload, beside all 2,000 case logs;
//   * AUTH-005  Sign out leaves nothing of the account in IndexedDB;
//   * SETTINGS-005  Delete All My Data leaves none of the old file there;
//   * SYNC-017  a device that ran the previous build: its localStorage copy (the
//               file with a device-only Answer Bank record, and a Vera
//               transcript) moves into IndexedDB on the first load, keeps what
//               only that device held, and serves the next offline launch.
//   * SYNC-017, CRED-046, CRED-005, CRED-020, SYNC-005  the owner's upgrade
//               (release/offline-fix): the previous build's localStorage full
//               to within 24 characters (a 1,450-case-log file of 4.86 million
//               characters with two Protected Identity and three Answer Bank
//               records, and a Vera transcript filling the rest), so not even
//               the IndexedDB home record fits before the move. The new build
//               moves all of it into IndexedDB, shows no storage-full notice,
//               keeps a case log and a Protected Identity record added after
//               the upgrade (the Answer Bank editor is paused, so its three
//               moved records are the ones checked), across a reload and an
//               offline launch.
//
// The constrained quota. Chromium has no setting for localStorage's quota; its
// own is fixed at 10 MiB counted in UTF-16, 5,242,880 characters for the whole
// origin (measured with this Chromium, 2026-09-30), which is a 5 MB
// localStorage however a browser counts it (Safari's is 5 MB). The account
// here is seeded past it (about 6.6 million characters), so the browser itself
// refuses a copy of that size in localStorage: the journey proves it with a
// probe write, and then asserts the copy lives in IndexedDB and localStorage
// stays small. The previous build, which wrote the file to localStorage, could
// not have kept it.
import { randomUUID } from 'node:crypto';
import { test } from './support/fixtures.mjs';
import {
  OFFLINE_BASES, clerkId, field, goTab, labExec, landing, lab, lit, localStorageUse, newMember, offlineCopy, offlineKeysFor, openCredentials, openMore, row, signIn, sleep,
  waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { fillForm, openAdd, saveDialog } from './support/cred-helpers.mjs';
import { addLicense, pageText } from './support/sync-docs-intake-helpers.mjs';
import { openVera } from './support/vera-cv-share-helpers.mjs';

// Chromium's localStorage quota in characters (10 MiB of UTF-16), measured.
const CHROMIUM_LOCALSTORAGE_CHARS = 5_242_880;
const CASES = 2000;
const WORK = 400;
const SMALL_LOCALSTORAGE_CHARS = 200_000;
const NOTICE = /storage is full|offline storage could not be (opened|read)/i;
const OFFLINE_BANNER = /Offline\. Showing this device's copy of your records\./;

/**
 * Seeds `pid` with a large synthetic career: `cases` case logs (default CASES), each with an operative summary of
 * about 2,600 characters (a dictated summary's length; no patient, no real procedure), and a
 * typical rest of the file. Written straight into the local lab database, as the account's
 * other devices would have put it there over the years.
 */
function seedLargeAccount(pid, cases = CASES) {
  const sentence = 'Synthetic narrative for the offline storage load test; it describes no patient and no real procedure. ';
  labExec(`
    insert into public.case_logs (user_id, category, title, date, facility, role, attending, cpt_codes, notes, w_rvu, complication, source)
    select '${pid}',
      (array['Cranial: Tumor General','Cranial: Vascular Open','Cranial: Trauma/Other','Spinal: Anterior Cervical','Cranial: CSF Diversion/ETV/Other'])[1 + i % 5],
      'QA synthetic case ' || lpad(i::text, 4, '0'),
      date '2016-07-01' + (i * 3650 / ${cases}),
      (array['QA Synthetic University Hospital','QA Synthetic Regional Medical Center','QA Synthetic Community Hospital'])[1 + i % 3],
      (array['Primary Surgeon','Primary Surgeon','Co-Surgeon','Teaching/Supervising','First Assist'])[1 + i % 5],
      'QA Synthetic Attending ' || (1 + i % 7),
      (array['61510, 61781','63081, 22551, 22845','63047, 63048','61697','62223'])[1 + i % 5],
      'QA synthetic operative summary ' || i || '. ' || repeat('${sentence}', 26),
      (10 + i % 40)::numeric,
      case when i % 50 = 0 then 'QA synthetic minor complication' end,
      'manual'
    from generate_series(1, ${cases}) i;
    insert into public.licenses (user_id, type, name, license_number, state, issued_date, expiration_date)
    select '${pid}', t, 'QA ' || t || ' ' || s, 'QA-BIG-' || i, s, date '2018-01-01', date '2028-06-30'
    from (values (1, 'State Medical License', 'CO'), (2, 'State Medical License', 'ND'), (3, 'State Medical License', 'WA'),
                 (4, 'DEA Registration', 'CO'), (5, 'BLS Certification', null), (6, 'ACLS Certification', null)) v(i, t, s);
    insert into public.cme (user_id, title, category, hours, date, provider, notes)
    select '${pid}', 'QA synthetic CME activity ' || i, (array['AMA PRA Category 1','AMA PRA Category 2','Self-Assessment'])[1 + i % 3],
      (1 + i % 4)::numeric, date '2023-01-01' + i * 4, 'QA Synthetic CME Provider', 'QA synthetic CME note ' || i
    from generate_series(1, 150) i;
    insert into public.education (user_id, type, name, institution, graduation_date, field_of_study)
    values ('${pid}', 'Doctor of Medicine (MD)', 'QA Medical School', 'QA Synthetic University', '2010-05-15', 'Medicine'),
           ('${pid}', 'Residency Certificate', 'QA Neurosurgery Residency', 'QA Synthetic University Hospital', '2017-06-30', 'Neurological Surgery'),
           ('${pid}', 'Fellowship Certificate', 'QA Spine Fellowship', 'QA Synthetic Regional Medical Center', '2018-06-30', 'Spine'),
           ('${pid}', 'Bachelor of Science (BS)', 'QA College', 'QA Synthetic College', '2006-05-15', 'Biology');
    insert into public.privileges (user_id, type, name, facility, state, appointment_date, expiration_date)
    select '${pid}', (array['Surgical Privileges','Full Admitting Privileges','Courtesy Privileges'])[1 + i % 3], 'QA privileges ' || i,
      'QA Synthetic Hospital ' || i, 'CO', date '2024-01-01', date '2027-12-31'
    from generate_series(1, 5) i;
    insert into public.insurance (user_id, type, name, provider, policy_number, coverage_per_claim, coverage_aggregate, effective_date, expiration_date)
    select '${pid}', 'Medical Malpractice (Claims-Made)', 'QA malpractice ' || i, 'QA Synthetic Insurer', 'QA-POL-' || i, '1,000,000', '3,000,000',
      date '2024-01-01' + (i - 1) * 365, date '2025-01-01' + (i - 1) * 365
    from generate_series(1, 3) i;
    with c as (
      insert into public.locum_contracts (id, user_id, facility, agency, bill_to, start_date, end_date, hourly_rate, call_hourly_rate, increment_minutes, work_state, short_name)
      values (gen_random_uuid(), '${pid}', 'QA Synthetic Regional Medical Center', 'QA Synthetic Locums', 'QA Synthetic Locums', '2025-01-01', '2026-12-31', 250, 150, 15, 'CO', 'QASRMC')
      returning id
    )
    insert into public.work_log (id, user_id, contract_id, type, date, start_time, end_time, duration_min, billed_min, description)
    select gen_random_uuid(), '${pid}', c.id, (array['Call','Consult','Rounding','Procedure','FU visit','Preop','Postop'])[1 + i % 7],
      to_char(date '2025-01-02' + (i / 2), 'YYYY-MM-DD'),
      (date '2025-01-02' + (i / 2)) + time '08:00' + (i % 2) * interval '6 hours',
      (date '2025-01-02' + (i / 2)) + time '08:00' + (i % 2) * interval '6 hours' + (30 + (i % 8) * 15) * interval '1 minute',
      30 + (i % 8) * 15, 30 + (i % 8) * 15, 'QA synthetic work entry ' || i
    from c, generate_series(1, ${WORK}) i;
    insert into public.publications (user_id, name, citation, year, sort_order)
    select '${pid}', 'QA synthetic paper ' || i, 'Synthetic A, Synthetic B. QA synthetic study number ' || i || '. QA Journal. 2020;' || i || ':1-9.', (2012 + i % 12)::text, i
    from generate_series(1, 40) i;
    insert into public.travel_expenses (id, user_id, date, category, vendor, amount, notes)
    select gen_random_uuid(), '${pid}', date '2025-01-05' + i * 5, (array['Airfare','Lodging','Meals','Mileage'])[1 + i % 4], 'QA Synthetic Vendor ' || (1 + i % 6), (40 + i * 3)::numeric, 'QA synthetic expense ' || i
    from generate_series(1, 60) i;
  `);
  return row(`select
    (select count(*) from public.case_logs where user_id = '${pid}')::int as "caseLogs",
    (select count(*) from public.licenses where user_id = '${pid}')::int as licenses,
    (select count(*) from public.cme where user_id = '${pid}')::int as cme,
    (select count(*) from public.education where user_id = '${pid}')::int as education,
    (select count(*) from public.privileges where user_id = '${pid}')::int as privileges,
    (select count(*) from public.insurance where user_id = '${pid}')::int as insurance,
    (select count(*) from public.locum_contracts where user_id = '${pid}')::int as "locumContracts",
    (select count(*) from public.work_log where user_id = '${pid}')::int as "workLog",
    (select count(*) from public.publications where user_id = '${pid}')::int as publications,
    (select count(*) from public.travel_expenses where user_id = '${pid}')::int as "travelExpenses"`);
}

/** The Case Logs count the Credentials rail shows. */
async function caseLogCount(page) {
  await openCredentials(page, 'Case Logs');
  const nav = await page.getByRole('navigation').filter({ hasText: 'Active Credentials' }).innerText().catch(() => '');
  const m = /Case Logs\s*(\d[\d,]*)/.exec(nav.replace(/\s+/g, ' '));
  return m ? Number(m[1].replace(/,/g, '')) : NaN;
}

/**
 * Offline, Credentials is the read-only archive ("Credential saved records"): one card list per
 * section under a heading with its count, e.g. "Case Logs (2000)". Returns the page text and the
 * count shown for `section`.
 */
async function offlineArchive(page, section) {
  await goTab(page, 'Credentials').catch(() => {});
  await page.getByText(/These records are read-only/).first().waitFor({ timeout: 15000 }).catch(() => {});
  const text = await pageText(page);
  const m = new RegExp(`${section} \\((\\d[\\d,]*)\\)`, 'i').exec(text);
  return { text, count: m ? Number(m[1].replace(/,/g, '')) : NaN };
}

/** Storage reports (client_errors) the app sent for this account since `since`. */
const storageReports = (cid, pid, since) => row(`select count(*)::int as n, coalesce(string_agg(distinct message, ' | '), '') as messages from public.client_errors
  where (auth_user_id = '${cid}' or profile_id::text = '${pid}') and created_at > '${since}' and message ilike 'Offline copy not saved%'`);

/** Waits until the account's offline copy satisfies `ok` (polls the page), and returns the last copy read. */
async function copyWhen(page, cid, ok, opts = {}, timeoutMs = 60000) {
  let last = null;
  await waitFor('the offline copy', async () => { last = await offlineCopy(page, cid, opts); return ok(last) ? last : null; }, { timeoutMs, intervalMs: 1000 }).catch(() => null);
  return last;
}

test('a 2,000-case-log account: its offline copy lives in IndexedDB, stays current offline, and Sign out and Delete All My Data purge it',
  { tag: ['@SYNC-007', '@SYNC-017', '@SYNC-005', '@AUTH-005', '@SETTINGS-005'] }, async ({ page, context, qa }) => {
    test.setTimeout(12 * 60 * 1000);
    const started = new Date(Date.now() - 2000).toISOString();
    const { user, profile } = await newMember(page, { firstName: 'Lara', lastName: 'Largefile' });
    const cid = await clerkId(page);
    const seeded = seedLargeAccount(profile.id);
    const latest = `QA-IDB-${randomUUID().slice(0, 8).toUpperCase()}`;
    const mark = qa.report.console.length;

    // The member's next visit, with the whole career in the account.
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    const full = await copyWhen(page, cid, (c) => c.sections.caseLogs === CASES && c.sections.workLog === WORK, {}, 90000);

    await qa.feature('SYNC-007', 'An account with 2,000 case logs loads every row (past PostgREST\'s 1,000)', async () => {
      qa.check('the database holds the seeded account', seeded.caseLogs === CASES && seeded.workLog === WORK, JSON.stringify(seeded));
      const n = await caseLogCount(page);
      await qa.shot('case logs 2000');
      qa.check('the Credentials rail counts 2,000 case logs', n === CASES, `${n}`);
      qa.check('the device file holds all 2,000 case logs and all 400 work entries', full?.sections.caseLogs === CASES && full?.sections.workLog === WORK, JSON.stringify(full?.sections));
      const others = ['licenses', 'cme', 'education', 'privileges', 'insurance', 'locumContracts', 'publications', 'travelExpenses'];
      const off = others.filter((k) => full?.sections[k] !== seeded[k]);
      qa.check('every other seeded section is in the device file with the database\'s count', off.length === 0, off.map((k) => `${k}: file ${full?.sections[k]} db ${seeded[k]}`).join(', ') || 'all match');
    });

    await qa.feature('SYNC-017', 'The offline copy of an account too large for localStorage is kept whole in IndexedDB', async () => {
      qa.check('the offline file is larger than this browser\'s localStorage quota', (full?.chars || 0) > CHROMIUM_LOCALSTORAGE_CHARS, `${full?.chars} characters; Chromium's quota ${CHROMIUM_LOCALSTORAGE_CHARS}`);
      // The control: a write of the file's size to localStorage is refused by the browser itself,
      // so the previous build (localStorage only) could not have kept this copy.
      const probe = await page.evaluate((n) => {
        try { localStorage.setItem('qa-lab-quota-probe', 'x'.repeat(n)); localStorage.removeItem('qa-lab-quota-probe'); return 'stored'; }
        catch (e) { return `${e.name} (code ${e.code})`; }
      }, full?.chars || 0);
      qa.check('control: localStorage refuses a write of the offline file\'s size (QuotaExceededError)', /^QuotaExceededError/.test(probe), probe);
      qa.check('the file is in IndexedDB (credentialdomd-offline / kv), not in localStorage', full?.where === 'offline' && !full.inLocal && full.parses, JSON.stringify({ where: full?.where, inLocal: full?.inLocal, parses: full?.parses }));
      const use = await localStorageUse(page);
      qa.check(`localStorage stays small (under ${SMALL_LOCALSTORAGE_CHARS.toLocaleString('en-US')} characters)`, use.chars < SMALL_LOCALSTORAGE_CHARS, `${use.chars} characters in ${use.keys} keys; largest ${use.largest.map((e) => `${e.key} ${e.chars}`).join(', ')}`);
      const keys = await offlineKeysFor(page, cid);
      qa.check('the account\'s IndexedDB home record is set', keys.local.some((k) => k.key === `credentialdomd-offline-home:${cid}`), keys.local.map((k) => k.key).join(', '));
      await sleep(3000);
      const text = await pageText(page);
      await qa.shot('no storage notice');
      qa.check('no "storage is full" (or offline storage) notice', !NOTICE.test(text), text.match(/[^.]*(storage is full|offline storage)[^.]*/i)?.[0]);
      const quota = qa.report.console.slice(mark).filter((l) => /quota/i.test(l));
      qa.check('no quota warning in the console', quota.length === 0, quota.slice(0, 3).join(' | '));
      const reports = storageReports(cid, profile.id, started);
      qa.check('the app reported no storage refusal (client_errors "Offline copy not saved")', reports.n === 0, reports.messages);
    });

    await qa.feature('SYNC-005', 'The offline copy is current: a license added now opens offline after a reload', async () => {
      await addLicense(page, profile.id, { number: latest, state: 'CO', expires: '2029-03-31' });
      const current = await copyWhen(page, cid, (c) => c.found[latest] && c.sections.caseLogs === CASES, { find: [latest] }, 30000);
      qa.check('the new license reached the offline copy in IndexedDB', !!current?.found[latest] && current.where === 'offline', JSON.stringify({ where: current?.where, found: current?.found }));
      qa.check('no notice after the save', !NOTICE.test(await pageText(page)));
      await context.setOffline(true);
      await page.reload().catch(() => {});
      const shown = await page.getByText(OFFLINE_BANNER).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      qa.check('offline, the app opens on this device\'s copy (the offline banner)', shown);
      const archive = await offlineArchive(page, 'Case Logs');
      await qa.shot('offline archive');
      qa.check('offline, the saved records list the license added this session', archive.text.includes(latest), latest);
      qa.check('offline, the saved records hold all 2,000 case logs', archive.count === CASES, `${archive.count}`);
      qa.check('offline, no storage notice', !NOTICE.test(archive.text));
      await context.setOffline(false);
      await page.reload();
      await waitForMemberApp(page);
      qa.check('back online, the app opens normally', !(await page.getByText(OFFLINE_BANNER).count()));
    });

    await qa.feature('AUTH-005', 'Sign out leaves nothing of the account in IndexedDB', async () => {
      const before = await offlineKeysFor(page, cid);
      qa.check('before sign-out, IndexedDB holds the account\'s file', before.idb.some((k) => k.key === `${OFFLINE_BASES.data}:${cid}` && k.chars > CHROMIUM_LOCALSTORAGE_CHARS), before.idb.map((k) => `${k.key} ${k.chars}`).join(', '));
      await openMore(page, 'Sign Out');
      await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
      let after = null;
      await waitFor('the purge', async () => { after = await offlineKeysFor(page, cid); return after.idb.length === 0 && after.local.length === 0 ? after : null; }, { timeoutMs: 20000 }).catch(() => null);
      qa.check('no IndexedDB entry of the account remains', after?.idb.length === 0, after?.idb.map((k) => `${k.key} ${k.chars}`).join(', '));
      qa.check('no localStorage key of the account remains (no purge left owed)', after?.local.length === 0, after?.local.map((k) => k.key).join(', '));
      qa.check('the cloud rows are untouched', row(`select count(*)::int as n from public.case_logs where user_id = '${profile.id}'`).n === CASES);
    });

    await qa.feature('SETTINGS-005', 'Delete All My Data leaves none of the old file in IndexedDB', async () => {
      await signIn(page, user);
      const where = await landing(page);
      qa.check('signing back in opens the member app', where === 'member', where);
      await waitForMemberApp(page);
      const rebuilt = await copyWhen(page, cid, (c) => c.sections.caseLogs === CASES && c.found[latest], { find: [latest] }, 90000);
      qa.check('the offline copy is rebuilt in IndexedDB from the cloud', rebuilt?.where === 'offline' && rebuilt.sections.caseLogs === CASES, JSON.stringify({ where: rebuilt?.where, caseLogs: rebuilt?.sections.caseLogs }));
      await openMore(page, 'Data Rights');
      await page.getByRole('button', { name: 'Delete All My Data' }).click();
      await page.getByPlaceholder('Type DELETE').fill('DELETE');
      await page.getByRole('button', { name: 'Confirm Delete' }).click();
      const del = await waitFor('the account deletion', async () => row(`select mode from public.account_deletions where profile_id = '${profile.id}' and mode = 'delete'`), { timeoutMs: 90000 }).catch(() => null);
      qa.check('account_deletions records it', !!del);
      await waitFor('the account reopened', async () => { const p = row(`select deleted_at, data_deleted_at from public.profiles where id = '${profile.id}'`); return p && !p.deleted_at && p.data_deleted_at ? p : null; }, { timeoutMs: 90000 }).catch(() => null);
      await waitForMemberApp(page, 90000).catch(() => {});
      await sleep(3000);
      const needles = ['QA synthetic case 0001', 'QA synthetic operative summary', latest];
      let keys = null;
      await waitFor('no old records on the device', async () => { keys = await offlineKeysFor(page, cid, { find: needles }); return [...keys.idb, ...keys.local].every((k) => k.found.length === 0) ? keys : null; }, { timeoutMs: 30000 }).catch(() => null);
      const held = [...(keys?.idb || []), ...(keys?.local || [])].filter((k) => k.found.length);
      await qa.shot('after delete all');
      qa.check('no IndexedDB or localStorage entry of the account holds any deleted record', held.length === 0, held.map((k) => `${k.key}: ${k.found.join(', ')}`).join(' | ') || `entries now: ${(keys?.idb || []).map((k) => `${k.key} ${k.chars}`).join(', ')}`);
      const now = await offlineCopy(page, cid);
      qa.check('the account\'s offline file, if any, has no case logs', !now.inIdb && !now.inLocal ? true : (now.sections.caseLogs || 0) === 0, JSON.stringify({ where: now.where, chars: now.chars, caseLogs: now.sections.caseLogs }));
      qa.check('the database holds no case logs for the account', row(`select count(*)::int as n from public.case_logs where user_id = '${profile.id}'`).n === 0);
      const reports = storageReports(cid, profile.id, started);
      qa.check('no storage refusal was reported during the whole journey', reports.n === 0, reports.messages);
    });
  });

test('a device that ran the previous build: its localStorage copy moves into IndexedDB on the first load, device-only records kept',
  { tag: ['@SYNC-017'] }, async ({ page, qa, secondBrowser }) => {
    test.setTimeout(8 * 60 * 1000);
    const { user, profile } = await newMember(page, { firstName: 'Milo', lastName: 'Migrate' });
    const cid = await clerkId(page);
    const number = `QA-MIG-${randomUUID().slice(0, 8).toUpperCase()}`;
    await addLicense(page, profile.id, { number, state: 'WA', expires: '2029-08-31' });
    const source = await copyWhen(page, cid, (c) => c.found[number], { find: [number], text: true }, 30000);

    await qa.feature('SYNC-017', 'The previous build\'s localStorage copy (file and Vera transcript) moves into IndexedDB and keeps what only that device held', async () => {
      qa.check('lab setup: the account\'s file, as the app writes it', !!source?.text && source.found[number], JSON.stringify({ where: source?.where, chars: source?.chars }));
      // The previous build kept the file in localStorage as this same JSON text (the move copies it
      // byte for byte), with what only that device held: an Answer Bank record, and a Vera transcript.
      const file = JSON.parse(source.text);
      const answer = `QA synthetic answer bank reply kept by the previous build ${randomUUID().slice(0, 6)}`;
      file.answerBank = [{ id: randomUUID(), question: 'QA synthetic question: hospital affiliations', answer, createdAt: new Date().toISOString() }];
      const said = `QA synthetic Vera answer kept by the previous build ${randomUUID().slice(0, 6)}`;
      const transcript = [{ id: randomUUID(), role: 'user', text: 'QA synthetic question kept on this device' }, { id: randomUUID(), role: 'model', text: said }];
      const b = await secondBrowser();
      await b.page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
      await b.page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
      const legacy = await b.page.evaluate(({ cid, fileText, chatText, bases }) => {
        localStorage.setItem(`${bases.data}:${cid}`, fileText);
        localStorage.setItem(`${bases.chat}:${cid}`, chatText);
        return { data: localStorage.getItem(`${bases.data}:${cid}`)?.length, chat: localStorage.getItem(`${bases.chat}:${cid}`)?.length };
      }, { cid, fileText: JSON.stringify(file), chatText: JSON.stringify(transcript), bases: OFFLINE_BASES });
      const pre = await offlineKeysFor(b.page, cid);
      qa.check('lab setup: the device holds the previous build\'s localStorage copies and nothing of the account in IndexedDB', legacy.data > 0 && legacy.chat > 0 && pre.idb.length === 0, JSON.stringify({ legacy, idb: pre.idb.length, dbExists: pre.dbExists }));

      await signIn(b.page, user);
      // A first sign-in in a second browser: on a loaded lab its identity step can stop on a
      // transient ID-INIT-UNAVAILABLE-H503 (Kong: PostgREST closed the reused connection on
      // initialize_clerk_profile, 2026-10-01 04:46:16); Reload, as the screen asks, as newMember does.
      const first = await landing(b.page);
      qa.check('the first load opens the member app', first === 'member', first);
      await waitForMemberApp(b.page);
      const moved = await copyWhen(b.page, cid, (c) => c.where === 'offline' && c.found[answer], { find: [answer, number] }, 30000);
      qa.check('the file moved to IndexedDB and left localStorage', moved?.where === 'offline' && !moved.inLocal, JSON.stringify({ where: moved?.where, inLocal: moved?.inLocal }));
      qa.check('the moved file keeps the device-only Answer Bank record and the license', !!moved?.found[answer] && !!moved.found[number], JSON.stringify(moved?.found));
      const chat = await copyWhen(b.page, cid, (c) => c.where === 'offline', { base: OFFLINE_BASES.chat, find: [said] }, 30000);
      qa.check('the Vera transcript moved to IndexedDB, whole, and left localStorage', chat?.where === 'offline' && !chat.inLocal && chat.messages === 2 && chat.found[said], JSON.stringify({ where: chat?.where, inLocal: chat?.inLocal, messages: chat?.messages }));
      await openCredentials(b.page, 'Answer Bank');
      const bank = await pageText(b.page);
      qa.check('the Answer Bank shows the record only this device held', /This browser has 1 saved record\./.test(bank), bank.match(/This browser has[^.]*\./)?.[0]);
      await openVera(b.page);
      const vera = await b.page.getByText(said).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      await qa.shot('migrated transcript', b.page);
      qa.check('Vera opens on the migrated transcript', vera);
      // The next launch is offline: it reads the moved copy.
      await b.context.setOffline(true);
      await b.page.reload().catch(() => {});
      const offline = await b.page.getByText(OFFLINE_BANNER).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      qa.check('offline, the app opens on the moved copy', offline);
      const archive = await offlineArchive(b.page, 'Answer Bank');
      await qa.shot('offline after the move', b.page);
      qa.check('offline, the saved records list the license from the moved copy', archive.text.includes(number), number);
      qa.check('offline, the saved records hold the device-only Answer Bank record', archive.count === 1 && archive.text.includes(answer), `${archive.count}`);
      await b.context.setOffline(false);
      await b.page.reload();
      await waitForMemberApp(b.page);
      const again = await copyWhen(b.page, cid, (c) => c.where === 'offline' && c.found[answer], { find: [answer] }, 20000);
      qa.check('after another online load the Answer Bank record is still in the IndexedDB copy', !!again?.found[answer] && again.where === 'offline', JSON.stringify({ where: again?.where, found: again?.found }));
      qa.check('no storage notice on the migrated device', !NOTICE.test(await pageText(b.page)));
    });
  });

// The owner's upgrade (release/offline-fix). The owner's iPhone ran the
// previous build with a 1,553-case-log account: the whole file in localStorage,
// near the 5 MB quota, with Protected Identity and Answer Bank records that
// exist only on that device, and "This device's storage is full" on screen
// once the file outgrew the room left. The new build opens on that device.
const UPGRADE_CASES = 1450;
// Room left in localStorage once the previous build's copies are in place:
// less than the new build's IndexedDB home record needs, so nothing but the
// move itself can make room (storageScope.js moveToOfflineStore, markLater).
const UPGRADE_FREE_CHARS = 24;

test('the owner\'s upgrade: a previous build\'s localStorage copy near the quota, with Protected Identity and the Answer Bank, moves to IndexedDB, and new records survive a reload and an offline launch',
  { tag: ['@SYNC-017', '@SYNC-005', '@CRED-005', '@CRED-046', '@CRED-020'] }, async ({ page, qa, secondBrowser }) => {
    test.setTimeout(14 * 60 * 1000);
    const started = new Date(Date.now() - 2000).toISOString();
    const { user, profile } = await newMember(page, { firstName: 'Owen', lastName: 'Upgrade' });
    const cid = await clerkId(page);
    const seeded = seedLargeAccount(profile.id, UPGRADE_CASES);
    const tag = randomUUID().slice(0, 6).toUpperCase();
    // The account's file as the app writes it (built here by a first browser; the owner's phone
    // had the same file from the previous build).
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    const source = await copyWhen(page, cid, (c) => c.sections.caseLogs === UPGRADE_CASES && c.sections.workLog === WORK, { text: true }, 90000);
    // The first browser has done its part; the upgraded device is a second, clean browser.
    await page.goto('about:blank').catch(() => {});

    const identities = [1, 2].map((i) => ({
      id: randomUUID(), label: `QA owner identity ${i} ${tag}`, legalFirstName: 'Owen', legalLastName: `Upgrade${i}`, source: 'QA synthetic source',
      verifiedDate: '2025-06-01', notes: `QA synthetic identity note ${i}`, createdAt: '2025-06-01T12:00:00.000Z', updatedAt: '2025-06-01T12:00:00.000Z',
    }));
    const answers = [1, 2, 3].map((i) => ({
      id: randomUUID(), question: `QA synthetic question ${i}: hospital affiliations`, questionVersion: '1', answer: `QA owner answer ${i} ${tag}`,
      scope: 'all', confirmationDate: '2025-06-01', source: 'QA synthetic source', createdAt: '2025-06-01T12:00:00.000Z',
    }));
    const newCase = `QA upgrade case ${tag}`;
    const newIdentity = `QA upgrade identity ${tag}`;
    const b = await secondBrowser();

    await qa.feature('SYNC-017', 'The owner\'s upgrade: a localStorage copy near the quota (Protected Identity, Answer Bank, a transcript) moves into IndexedDB whole; the storage-full notice is gone', async () => {
      qa.check('lab setup: the database holds the seeded account', seeded.caseLogs === UPGRADE_CASES && seeded.workLog === WORK, JSON.stringify(seeded));
      qa.check('lab setup: the account\'s file, as the app writes it', !!source?.text && source.sections.caseLogs === UPGRADE_CASES, JSON.stringify({ where: source?.where, chars: source?.chars }));
      const file = JSON.parse(source.text);
      file.identityVault = identities;
      file.answerBank = answers;
      const fileText = JSON.stringify(file);
      await b.page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
      await b.page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
      // The previous build's localStorage: the file, and a long Vera transcript filling the rest
      // but UPGRADE_FREE_CHARS (the owner's phone had no room left: the next save of the file failed).
      const legacy = await b.page.evaluate(({ cid, fileText, bases, leave, tag }) => {
        // What localStorage can still take (key plus value, as the browser counts it), found by
        // writing a probe key of growing size.
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
        const dataKey = `${bases.data}:${cid}`;
        const chatKey = `${bases.chat}:${cid}`;
        try { localStorage.setItem(dataKey, fileText); } catch (e) { return { wrote: false, error: `file: ${e.name}`, data: fileText.length }; }
        const room = free() - chatKey.length - leave;
        const filler = 'QA synthetic Vera transcript text kept by the previous build; it names no patient. ';
        const msgs = [];
        let size = 2;
        for (let n = 1; ; n += 1) {
          const m = { id: `qa-${tag}-${n}`, role: n % 2 ? 'user' : 'model', text: `QA transcript ${n} ${tag}. ${filler.repeat(28)}` };
          const add = JSON.stringify(m).length + 1;
          if (size + add + 400 > room) break;
          msgs.push(m);
          size += add;
        }
        const last = { id: `qa-${tag}-last`, role: 'model', text: `QA transcript last ${tag}. ` };
        msgs.push(last);
        last.text += 'x'.repeat(Math.max(0, room - JSON.stringify(msgs).length));
        let chatText = JSON.stringify(msgs);
        let wrote = false;
        for (let i = 0; i < 64 && !wrote; i++) {
          try { localStorage.setItem(chatKey, chatText); wrote = true; } catch { last.text = last.text.slice(0, -1); chatText = JSON.stringify(msgs); }
        }
        return { wrote, data: fileText.length, chat: chatText.length, messages: msgs.length, free: free() };
      }, { cid, fileText, bases: OFFLINE_BASES, leave: UPGRADE_FREE_CHARS, tag });
      const use = await localStorageUse(b.page);
      qa.check(`lab setup: localStorage holds the previous build's file and transcript and is full (under ${UPGRADE_FREE_CHARS + 16} characters free)`,
        legacy.wrote && legacy.free <= UPGRADE_FREE_CHARS + 16 && use.chars > CHROMIUM_LOCALSTORAGE_CHARS - 200,
        JSON.stringify({ ...legacy, used: use.chars }));
      const homeKey = `credentialdomd-offline-home:${cid}`;
      qa.check('lab setup: the IndexedDB home record would not fit in what is left', legacy.free < homeKey.length + 1, `${legacy.free} free; the record needs ${homeKey.length + 1}`);

      await signIn(b.page, user);
      const opened = await landing(b.page);
      qa.check('the new build opens the member app', opened === 'member', opened);
      await waitForMemberApp(b.page);
      const moved = await copyWhen(b.page, cid, (c) => c.where === 'offline' && c.sections.caseLogs === UPGRADE_CASES && c.sections.identityVault === 2 && c.sections.answerBank === 3,
        { find: [identities[0].label, identities[1].label, ...answers.map((a) => a.answer)] }, 90000);
      qa.check('the file is in IndexedDB and left localStorage', moved?.where === 'offline' && !moved.inLocal, JSON.stringify({ where: moved?.where, inLocal: moved?.inLocal, chars: moved?.chars }));
      qa.check(`the moved file holds every case log (${UPGRADE_CASES}), both Protected Identity records and all three Answer Bank records`,
        moved?.sections.caseLogs === UPGRADE_CASES && moved.sections.identityVault === 2 && moved.sections.answerBank === 3 && Object.values(moved.found).every(Boolean),
        JSON.stringify({ caseLogs: moved?.sections.caseLogs, identityVault: moved?.sections.identityVault, answerBank: moved?.sections.answerBank, found: moved?.found }));
      const chat = await copyWhen(b.page, cid, (c) => c.where === 'offline' && !c.inLocal, { base: OFFLINE_BASES.chat, find: [`QA transcript last ${tag}`] }, 30000);
      qa.check('the Vera transcript is in IndexedDB, whole, and left localStorage', chat?.where === 'offline' && !chat.inLocal && chat.messages === legacy.messages && chat.found[`QA transcript last ${tag}`],
        JSON.stringify({ where: chat?.where, inLocal: chat?.inLocal, messages: chat?.messages, expected: legacy.messages }));
      const keys = await offlineKeysFor(b.page, cid);
      qa.check('the account\'s IndexedDB home record is set', keys.local.some((k) => k.key === homeKey), keys.local.map((k) => k.key).join(', '));
      const after = await localStorageUse(b.page);
      qa.check(`localStorage is small again (under ${SMALL_LOCALSTORAGE_CHARS.toLocaleString('en-US')} characters)`, after.chars < SMALL_LOCALSTORAGE_CHARS, `${after.chars} characters in ${after.keys} keys; largest ${after.largest.map((e) => `${e.key} ${e.chars}`).join(', ')}`);
      await sleep(3000);
      const text = await pageText(b.page);
      await qa.shot('upgrade no storage notice', b.page);
      qa.check('no "storage is full" (or offline storage) notice', !NOTICE.test(text), text.match(/[^.]*(storage is full|offline storage)[^.]*/i)?.[0]);
      qa.check('no Protected Identity or Answer Bank change is held aside', !/is not in this device.s offline copy yet|on this screen only/.test(text));
      const reports = storageReports(cid, profile.id, started);
      qa.check('the app reported no storage refusal (client_errors "Offline copy not saved")', reports.n === 0, reports.messages);
    });

    await qa.feature('CRED-046', 'The Answer Bank keeps the records only this device held; its editor stays paused', async () => {
      await openCredentials(b.page, 'Answer Bank');
      const bank = await pageText(b.page);
      qa.check('the Answer Bank shows the three records this device held', /This browser has 3 saved records\./.test(bank), bank.match(/This browser has[^.]*\./)?.[0]);
      qa.check('the Answer Bank editor is paused (no new entry can be added in the app)', /New entries, edits and sharing are paused/.test(bank) && !(await b.page.getByRole('button', { name: /^(\+ )?Add$/ }).count()));
    }, { soft: true });

    await qa.feature('CRED-005', 'Protected Identity: the moved records are listed, and one added on the upgraded device is kept', async () => {
      await openCredentials(b.page, 'Protected Identity');
      const listed = await pageText(b.page);
      qa.check('both moved Protected Identity records are listed', identities.every((r) => listed.includes(r.label)), identities.map((r) => `${r.label}: ${listed.includes(r.label)}`).join(', '));
      await b.page.getByRole('button', { name: 'Add record' }).click();
      const d = b.page.getByRole('dialog', { name: 'Add protected identity' });
      await d.getByPlaceholder('e.g. Liability application 2026').fill(newIdentity);
      await field(d, 'Legal first name').fill('Owen');
      await field(d, 'Legal last name').fill('Upgrade');
      // Synthetic identifiers only: SSN area 000 is never issued.
      await d.getByPlaceholder('YYYY-MM-DD').fill('1979-04-05');
      await d.getByPlaceholder('###-##-####').fill('000-45-6789');
      const lock = d.getByPlaceholder('Lock code (8+ characters)');
      if (!(await lock.isVisible().catch(() => false))) {
        await d.getByRole('button', { name: 'Save on this device' }).click();
        await lock.waitFor({ timeout: 5000 }).catch(() => {});
      }
      if (await lock.isVisible().catch(() => false)) {
        await lock.fill('qa-lab-lock-code');
        await d.getByRole('button', { name: 'Save on this device' }).click();
      }
      const closed = await d.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
      qa.check('the new Protected Identity record saves (lock code stored on this device)', closed, closed ? '' : (await d.innerText().catch(() => '')).slice(0, 300));
      const copy = await copyWhen(b.page, cid, (c) => c.found[newIdentity] && c.sections.identityVault === 3, { find: [newIdentity] }, 30000);
      qa.check('it reached the IndexedDB copy beside the two moved records', copy?.where === 'offline' && copy.sections.identityVault === 3, JSON.stringify({ where: copy?.where, identityVault: copy?.sections.identityVault, found: copy?.found }));
    });

    await qa.feature('CRED-020', 'A case log added on the upgraded device is saved to the account and the IndexedDB copy', async () => {
      const dlg = await openAdd(b.page, 'Case Logs');
      await fillForm(dlg, [['Category', { index: 1 }], ['Description', newCase], ['Date', new Date().toISOString().slice(0, 10)], ['Role', { index: 1 }]]);
      const r = await saveDialog(dlg);
      qa.check('the case log form saves', r.closed, r.refusal);
      const saved = await waitFor('the case_logs row', async () => row(`select id from public.case_logs where user_id = '${profile.id}' and title = ${lit(newCase)}`), { timeoutMs: 30000 }).catch(() => null);
      qa.check('the account holds the new case log', !!saved);
      const copy = await copyWhen(b.page, cid, (c) => c.found[newCase] && c.sections.caseLogs === UPGRADE_CASES + 1, { find: [newCase] }, 30000);
      qa.check(`the IndexedDB copy holds it beside the ${UPGRADE_CASES} others`, copy?.where === 'offline' && copy.sections.caseLogs === UPGRADE_CASES + 1, JSON.stringify({ where: copy?.where, caseLogs: copy?.sections.caseLogs }));
    });

    await qa.feature('SYNC-005', 'After the upgrade, the new records survive a reload, and an offline launch opens on them', async () => {
      const needles = [newCase, newIdentity, ...identities.map((r) => r.label), ...answers.map((a) => a.answer)];
      await b.page.reload();
      await waitForMemberApp(b.page);
      await openCredentials(b.page, 'Protected Identity');
      const ids = await pageText(b.page);
      qa.check('after a reload, Protected Identity lists the new record and both moved ones', [newIdentity, ...identities.map((r) => r.label)].every((l) => ids.includes(l)), [newIdentity, ...identities.map((r) => r.label)].map((l) => `${l}: ${ids.includes(l)}`).join(', '));
      await openCredentials(b.page, 'Answer Bank');
      qa.check('after a reload, the Answer Bank still has its three records', /This browser has 3 saved records\./.test(await pageText(b.page)));
      const n = await caseLogCount(b.page);
      qa.check(`after a reload, the Credentials rail counts ${UPGRADE_CASES + 1} case logs`, n === UPGRADE_CASES + 1, `${n}`);
      const reloaded = await copyWhen(b.page, cid, (c) => c.where === 'offline' && needles.every((x) => c.found[x]), { find: needles }, 30000);
      qa.check('after a reload, the IndexedDB copy holds the new case log, the new identity and every moved device-only record', reloaded?.where === 'offline' && !reloaded.inLocal && needles.every((x) => reloaded.found[x]),
        JSON.stringify({ where: reloaded?.where, inLocal: reloaded?.inLocal, missing: needles.filter((x) => !reloaded?.found[x]) }));
      qa.check('after a reload, no storage notice', !NOTICE.test(await pageText(b.page)));

      await b.context.setOffline(true);
      await b.page.reload().catch(() => {});
      const offline = await b.page.getByText(OFFLINE_BANNER).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      qa.check('offline, the app opens on this device\'s copy (the offline banner)', offline);
      const cases = await offlineArchive(b.page, 'Case Logs');
      await qa.shot('upgrade offline archive', b.page);
      qa.check('offline, the saved records list the case log added after the upgrade', cases.text.includes(newCase), newCase);
      qa.check(`offline, the saved records hold all ${UPGRADE_CASES + 1} case logs`, cases.count === UPGRADE_CASES + 1, `${cases.count}`);
      const bank = await offlineArchive(b.page, 'Answer Bank');
      qa.check('offline, the saved records hold the three Answer Bank records', bank.count === 3 && answers.every((a) => bank.text.includes(a.answer)), `${bank.count}`);
      qa.check('offline, Protected Identity stays out of the read-only view (by decision) but is in the device copy',
        !bank.text.includes(newIdentity), newIdentity);
      const off = await offlineCopy(b.page, cid, { find: needles });
      qa.check('offline, the device copy read holds every new and moved record', needles.every((x) => off.found[x]), JSON.stringify({ missing: needles.filter((x) => !off.found[x]) }));
      qa.check('offline, no storage notice', !NOTICE.test(bank.text));
      await b.context.setOffline(false);
      await b.page.reload();
      await waitForMemberApp(b.page);
      await openCredentials(b.page, 'Protected Identity');
      const back = await pageText(b.page);
      qa.check('back online, Protected Identity still lists all three records', [newIdentity, ...identities.map((r) => r.label)].every((l) => back.includes(l)));
      const reports = storageReports(cid, profile.id, started);
      qa.check('no storage refusal was reported during the whole journey', reports.n === 0, reports.messages);
    });
  });
