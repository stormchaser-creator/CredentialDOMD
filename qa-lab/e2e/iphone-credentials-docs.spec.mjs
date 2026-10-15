// Credentials, Documents, Vera and CV import on the owner's installed iPhone
// app, judged by OUTCOME.
//
// Every journey here runs in Playwright's WebKit (Safari's engine) as an
// iPhone 15 home-screen app (393 x 852, touch, an iOS 18.7 Safari user agent,
// navigator.standalone), whatever the run's configuration (the iPad one turns
// a 768 x 1024 tablet across 1024 px). The iOS behaviour model is
// support/ios.mjs: the share sheet that never settles while the page goes to
// Mail and back, the page discarded and reloaded while hidden, pageshow from
// the back-forward cache, window.Clerk.session replaced on every return to the
// front, the first API requests after a launch timing out, localStorage
// nearly full.
//
// A check marked OUTCOME asks what the owner would ask (is the packet he sent
// recorded as sent, is the record he saved on the server, is what he typed
// still there), not whether the app's own screens behaved as designed.
// Synthetic values only; nothing leaves this machine.
//
//   QA_E2E_RESULTS=qa-lab/.generated/runs/<name>.json QA_E2E_NO_RESTART=1 \
//     npm run qa:e2e -- iphone-credentials-docs.spec.mjs
import { test } from './support/fixtures.mjs';
import {
  base64Marker, field, lab, pendingOps, recordButtons, row, rows, scriptAi, sleep, stamp, syntheticPdf, syntheticPng, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import {
  backButton, credentialsRow, newPhoneMember, phoneCredentials, phoneMore, phoneTab,
} from './support/phone-helpers.mjs';
import {
  clerkReplacesSessionOnFocus, flakyLaunch, hangingShare, iosModelInitScript, returnToApp, sessionReplacements, sharedOnIos, tightStorage, toBackground,
} from './support/ios.mjs';
import { IPHONE_15_APP } from './webkit.config.mjs';

test.describe.configure({ mode: 'parallel' });
test.use({ ...IPHONE_15_APP, browserName: 'webkit' });

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const bodyText = async (page) => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
const shareLog = (pid) => rows(`select item_id, item_name, section, method, recipient, sent_at from public.share_log where user_id = '${pid}' order by created_at`);

/** The installed app (standalone), the iOS model, and a clipboard that answers (WebKit grants none). */
async function installIphone(context) {
  await context.addInitScript(() => {
    try { Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true }); } catch { /* read-only */ }
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      const r = mm(q);
      if (!/display-mode:\s*standalone/.test(String(q))) return r;
      return { matches: true, media: r.media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
    };
    const clip = { writeText: async () => {}, write: async () => {}, readText: async () => '' };
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clip }); } catch { /* none */ }
  });
  await context.addInitScript(iosModelInitScript);
}

/**
 * A second navigator.share while the first is still pending: WebKit rejects it with
 * InvalidStateError ("An earlier share has not yet completed"), as the Web Share spec says
 * ([[sharePromise]] not null). The hanging sheet of support/ios.mjs keeps the first one pending.
 */
async function secondShareRefused(page) {
  await page.evaluate(() => {
    const first = navigator.share;
    let pending = window.__ios?.sharePending || 0;  // the shares still open (support/ios.mjs counts them)
    navigator.share = (data) => {
      pending += 1;
      if (pending > 1) return Promise.reject(new DOMException('An earlier share has not yet completed.', 'InvalidStateError'));
      return first(data);
    };
  });
}

/** Uploads `files` ({name, buffer, type}) from Documents (+ tab) > Upload, each read by the mock AI as `kind`. */
async function uploadFromFiles(page, files, { kind = 'unknown', via = 'Upload' } = {}) {
  for (const f of files) await scriptAi('gemini', { json: { documentType: kind, confidence: 'high', extracted: {} } }, base64Marker(f.buffer));
  await phoneTab(page, '+');
  await sleep(600);
  const button = page.getByRole('button', { name: via, exact: true }).first();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), button.tap()]);
  await chooser.setFiles(files.map((f) => ({ name: f.name, mimeType: f.type || 'application/pdf', buffer: f.buffer })));
}

const docRow = (pid, name) => row(`select d.id, d.storage_path, (select count(*) from storage.objects o where o.bucket_id = 'documents' and o.name = d.storage_path)::int as stored
  from public.documents d where d.user_id = '${pid}' and d.name = '${name.replace(/'/g, "''")}'`);

async function waitForDoc(pid, name, timeoutMs = 45000) {
  return waitFor(`document ${name}`, async () => { const r = docRow(pid, name); return r?.stored ? r : null; }, { timeoutMs }).catch(() => docRow(pid, name));
}

/** Types into a field of `scope` found by its label, as a thumb would (tap, keyboard); dates and selects are set. */
async function typeInto(page, scope, label, value) {
  const control = field(scope, label);
  await control.scrollIntoViewIfNeeded();
  const [tag, type] = await control.evaluate((e) => [e.tagName, e.type]);
  if (tag === 'SELECT') {
    if (value && typeof value === 'object' && 'index' in value) return control.selectOption({ index: value.index });
    const labels = await control.locator('option').allInnerTexts();
    const pick = labels.find((l) => l.trim() === value.label) || labels.find((l) => l.includes(value.label));
    return control.selectOption({ label: pick });
  }
  if (type === 'date' || type === 'month' || type === 'number') return control.fill(String(value));
  await control.tap();
  await page.keyboard.type(String(value));
}

/** Credentials > section > Add on the phone; returns the open form. */
async function openPhoneAdd(page, section) {
  await phoneCredentials(page, section);
  await sleep(600);
  await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().tap();
  const dlg = page.getByRole('dialog').last();
  await dlg.waitFor({ timeout: 15000 });
  return dlg;
}

/** Back to the member app after a reload (a discard): the bottom bar. */
async function backInApp(page) {
  await waitForMemberApp(page);
  await sleep(1200);
}

// ── Documents: Select to send ─────────────────────────────────────────────────

test('iPhone: Documents, Select to send: a packet handed to Mail from the share sheet (which never answers) shows as sent, after a return and after a discard', {
  tag: ['@iphone', '@SHARE-004'],
}, async ({ page, context, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  await installIphone(context);
  const { profile } = await newPhoneMember(page, { firstName: 'Ivy', lastName: 'Packet' });
  const pid = profile.id;
  const tag = stamp('pk').toLowerCase();
  const names = [`qa-ios-dea-${tag}.pdf`, `qa-ios-board-${tag}.pdf`, `qa-ios-acls-${tag}.pdf`];
  await uploadFromFiles(page, names.map((n) => ({ name: n, buffer: syntheticPdf(`QA synthetic ${n}`) })));
  const stored = [];
  for (const n of names) stored.push(await waitForDoc(pid, n));
  qa.check('setup: the three PDFs are stored (documents rows with their files in Storage)', stored.every((d) => d?.stored), JSON.stringify(stored));
  // The device's copies of stored documents are downloaded again after a load, as on the phone.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await backInApp(page);
  await clerkReplacesSessionOnFocus(page);

  const sendPacket = async (pick) => {
    await phoneTab(page, '+');
    await sleep(5000);
    await page.getByRole('button', { name: 'Select to send' }).tap();
    for (const n of pick) await page.getByText(n, { exact: true }).last().tap();
    const send = page.getByRole('button', { name: new RegExp(`^Send ${pick.length} documents as one packet$`) });
    await send.waitFor({ timeout: 10000 });
    return send;
  };

  await qa.feature('SHARE-004', 'Packet to Mail, the share sheet never answers, back to the app (same page, session replaced)', async () => {
    await hangingShare(page);
    const send = await sendPacket(names.slice(0, 2));
    await send.tap();
    await sleep(2500);
    const handed = await sharedOnIos(page);
    qa.check('setup: the share sheet was handed the two PDFs', handed.length === 1 && handed[0].files.length === 2, JSON.stringify(handed));
    await returnToApp(page, { awayMs: 4000 });
    await sleep(2500);
    qa.check('setup: Clerk replaced the session object on the return', (await sessionReplacements(page)) >= 1);
    const text = await bodyText(page);
    await qa.shot('packet after return');
    const logged = shareLog(pid).filter((r) => /^Packet \(2 documents\)/.test(r.item_name || ''));
    const ok = qa.check('OUTCOME: the packet sharing request is recorded (share_log "Packet (2 documents)")', logged.length === 1, JSON.stringify(shareLog(pid)));
    const told = /Sharing requested for 2 documents as one packet/.test(text);
    qa.check('OUTCOME: the screen records the sharing request without claiming delivery', told || /record/i.test(text.match(/.{0,120}packet.{0,120}/i)?.[0] || ''), text.match(/.{0,160}(packet|Send 2|Select).{0,160}/i)?.[0] || text.slice(0, 200));
    qa.check('the screen does not stay in Select with the two still ticked', !(await page.getByRole('button', { name: /^Send 2 documents as one packet$/ }).isVisible().catch(() => false)));
    if (!ok) {
      qa.bug({
        title: 'iPhone app: a packet sent from Documents > Select to send is never recorded as sent (the share sheet that hands over to Mail never answers)',
        step: 'Installed iPhone app: Documents > Select to send > tick 2 > Send 2 documents as one packet > Mail > send > back to the app',
        expected: 'The packet is in the send history (share_log "Packet (2 documents)") and the screen says it was sent, as on a desk browser',
        actual: `share_log has no packet row and the screen stays in Select with both ticked, "Send 2 documents as one packet" still offered. DocumentsSection.jsx:264-283 records the share (addItem("shareLog")) and shows "Sent N documents" only after await navigator.share() resolves; in the installed iPhone app that promise never settles once the sheet hands over to Mail (the same cause as the invoice ticket, fixed for invoices on fix/invoice-ios-record), so nothing after the await runs.`,
        severity: 'high',
      });
    }
  }, { soft: true });

  await qa.feature('SHARE-004', 'He taps Send again because nothing said it went', async () => {
    await secondShareRefused(page);
    const again = page.getByRole('button', { name: /^Send 2 documents as one packet$/ });
    if (!(await again.isVisible().catch(() => false))) { qa.check('the Send button is not offered again (nothing to check)', true); return; }
    await again.tap();
    await sleep(1500);
    const text = await bodyText(page);
    const msg = text.match(/Sharing failed[^.]*\.|[^.]*(earlier share|already)[^.]*\./i)?.[0] || '';
    await qa.shot('packet second tap');
    const misleading = /Try fewer or smaller files/.test(text);
    qa.check('OUTCOME: the second tap does not tell him the files are too many or too large (they went the first time)', !misleading, msg || text.slice(0, 200));
    if (misleading) {
      qa.bug({
        title: 'iPhone app: tapping Send again on a packet already handed to Mail says "Sharing failed. Try fewer or smaller files."',
        step: 'After the packet above went to Mail (share sheet never answered), back in the app tap "Send 2 documents as one packet" again',
        expected: 'Nothing misleading: the app knows the packet went to the share sheet, or says a share is still open',
        actual: 'WebKit refuses a second navigator.share while the first is pending (InvalidStateError); DocumentsSection.jsx:267-270 turns every non-Abort error into "Sharing failed. Try fewer or smaller files." The owner is told to resend smaller files that already went out.',
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('SHARE-004', 'Packet to Mail, then iOS discards the app while Mail is in front; he opens it again', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backInApp(page);
    await hangingShare(page);
    const before = shareLog(pid).length;
    const send = await sendPacket([names[2]].concat(names[0]));
    await send.tap();
    await sleep(2000);
    qa.check('setup: the share sheet was handed the two PDFs', (await sharedOnIos(page)).some((s) => s.files.length === 2));
    await returnToApp(page, { awayMs: 2000, discard: true });
    await backInApp(page);
    await phoneTab(page, '+');
    await sleep(3000);
    const text = await bodyText(page);
    await qa.shot('packet after discard');
    const logged = shareLog(pid).slice(before);
    qa.check('OUTCOME: after the discard the packet sharing request is recorded, or the app asks him to record it', logged.some((r) => /^Packet/.test(r.item_name || '')) || /went to the share sheet|not recorded|Record it/i.test(text), `${JSON.stringify(logged)} ${text.slice(0, 200)}`);
  }, { soft: true });
});

// ── Send a record from its card ───────────────────────────────────────────────

test('iPhone: a license share requested from its card is in its sharing activity even if the share sheet never answers, after a return and after a discard', {
  tag: ['@iphone', '@SHARE-002'],
}, async ({ page, context, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  await installIphone(context);
  const { profile } = await newPhoneMember(page, { firstName: 'Lee', lastName: 'Sender' });
  const pid = profile.id;
  const number = `QA-IOSL-${stamp('').slice(-5)}`;
  const dlg = await openPhoneAdd(page, 'Licenses');
  const dateBounds = await dlg.locator('input[type="date"]').evaluateAll(inputs => inputs.map(input => {
    const field = input.parentElement.getBoundingClientRect();
    const box = input.getBoundingClientRect();
    return { type: input.type, left: box.left, right: box.right, height: box.height, fieldLeft: field.left, fieldRight: field.right };
  }));
  qa.check('Native date controls fit their phone form columns with usable tap targets', dateBounds.length >= 2 && dateBounds.every(b => b.height >= 44 && b.left >= b.fieldLeft - 1 && b.right <= b.fieldRight + 1), JSON.stringify(dateBounds));
  for (const [l, v] of [['Type', { label: 'State Medical License' }], ['Display Name', 'QA iPhone CO License'], ['License #', number], ['State', { label: 'CO' }], [/^Expires/, day(300)]]) await typeInto(page, dlg, l, v);
  await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().tap();
  await dlg.waitFor({ state: 'detached', timeout: 15000 });
  const lic = await waitFor('the license', async () => row(`select id from public.licenses where user_id = '${pid}' and license_number = '${number}'`), { timeoutMs: 20000 }).catch(() => null);
  qa.check('setup: the license is on the server', !!lic);
  await clerkReplacesSessionOnFocus(page);

  const openSend = async () => {
    await phoneCredentials(page, 'Licenses');
    await sleep(800);
    await recordButtons(page, number).share.tap();
    const d = page.getByRole('dialog', { name: 'Send Credential' });
    await d.waitFor({ timeout: 10000 });
    return d;
  };

  await qa.feature('SHARE-002', 'Open the share sheet from the license card; its answer stays pending; back to the app', async () => {
    await hangingShare(page);
    const d = await openSend();
    await typeInto(page, d, 'Email', `medstaff-${number.toLowerCase()}@qa.credentialdomd.test`);
    await d.getByRole('button', { name: /Send via Mail, Messages, AirDrop/ }).tap();
    await sleep(1500);
    qa.check('setup: the share sheet was handed the letter', (await sharedOnIos(page)).length === 1);
    await returnToApp(page, { awayMs: 3000 });
    await sleep(2500);
    const logged = shareLog(pid).filter((r) => r.item_id === lic?.id && r.method === 'share');
    const hist = ((await d.innerText().catch(() => '')).split(/Sharing activity/i)[1] || '').replace(/\s+/g, ' ');
    await qa.shot('license send after return');
    const ok = qa.check('OUTCOME: the request is in the license\'s sharing activity (share_log, method share)', logged.length === 1, JSON.stringify(shareLog(pid)));
    qa.check('OUTCOME: the sheet\'s Sharing activity lists the request', /Device share requested/.test(hist), hist.slice(0, 200) || 'no Sharing activity on the sheet');
    if (!ok) {
      qa.bug({
        title: 'iPhone app: a credential sent from its card through the share sheet never reaches its Send history',
        step: 'Installed iPhone app: Credentials > Licenses > a license > Send > "Send via Mail, Messages, AirDrop…" > Mail > send > back',
        expected: 'Sharing activity shows a device share request, without claiming completion or delivery, and share_log has the row.',
        actual: 'No share_log row and no history line. ShareModal.jsx:118-122 logs the send (log("share", email)) only after await navigator.share() resolves, which never happens in the installed iPhone app once Mail takes over. The same holds for "Send with N documents attached".',
        severity: 'high',
      });
    }
    await page.keyboard.press('Escape').catch(() => {});
    await backButton(page).tap().catch(() => {});
  }, { soft: true });

  await qa.feature('SHARE-002', 'The same, and iOS discards the app while Mail is in front', async () => {
    const before = shareLog(pid).length;
    const d = await openSend();
    await typeInto(page, d, 'Email', `office-${number.toLowerCase()}@qa.credentialdomd.test`);
    await d.getByRole('button', { name: /Send via Mail, Messages, AirDrop/ }).tap();
    await sleep(1500);
    await returnToApp(page, { awayMs: 2000, discard: true });
    await backInApp(page);
    await sleep(2000);
    const logged = shareLog(pid).slice(before);
    qa.check('OUTCOME: after the discard the request is in its history', logged.some((r) => r.item_id === lic?.id), JSON.stringify(logged));
  }, { soft: true });
});

// ── Credentials records saved as he leaves the app ───────────────────────────

const RECORDS = [
  { id: 'CRED-021', section: 'Health Records', table: 'health_records', mark: 'QA-IOSLOT-', fields: (m) => [['Category', { label: 'Vaccination' }], ['Display Name', 'QA iPhone Flu Shot'], ['Date Administered', day(-30)], ['Lot / Batch #', m], ['Administrator / Facility', 'QA Clinic']] },
  { id: 'CRED-037', section: 'Screenings', table: 'screenings', mark: 'QA-IOSSCR-', fields: (m) => [['Type', { index: 1 }], ['Display name', 'QA iPhone Background Check'], ['Screening agency', 'QA Screening Co'], ['File / report #', m], ['Ordered', day(-40)], ['Reported', day(-30)]] },
  { id: 'CRED-009', section: 'CME Credits', table: 'cme', mark: 'QA iPhone Spine Update ', fields: (m) => [['Activity / Title', m], ['Credit Category', { label: 'AMA PRA Category 1' }], ['Hours', '3'], ['Date Completed', day(-10)], ['Provider / Institution', 'QA CME Provider']] },
];

for (const away of ['resume', 'discard']) {
  test(`iPhone: health record, screening and CME saved, then straight to another app (${away === 'resume' ? 'back to the same page from the back-forward cache, session replaced' : 'discarded by iOS meanwhile'}): each is on the server`, {
    tag: ['@iphone', '@CRED-021', '@CRED-037', '@CRED-009'],
  }, async ({ page, context, qa }) => {
    test.setTimeout(9 * 60 * 1000);
    await installIphone(context);
    const { profile } = await newPhoneMember(page, { firstName: 'Hale', lastName: `Records ${away}` });
    const pid = profile.id;
    await clerkReplacesSessionOnFocus(page);
    for (const r of RECORDS) {
      await qa.feature(r.id, `${r.section}: Add, Save, and at once to another app (${away})`, async () => {
        const mark = `${r.mark}${stamp('').slice(-6)}`;
        const dlg = await openPhoneAdd(page, r.section);
        for (const [l, v] of r.fields(mark)) await typeInto(page, dlg, l, v);
        await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().tap();
        // The thumb goes straight to the home bar: the page is hidden ~150 ms after Save.
        await sleep(150);
        await toBackground(page);
        // Back to the same page restored from the back-forward cache (pageshow persisted), or discarded.
        await returnToApp(page, { awayMs: 4000, discard: away === 'discard', bfcache: away === 'resume' });
        if (away === 'discard') await backInApp(page);
        const onServer = await waitFor(`${r.table} row`, async () => row(`select id from public.${r.table} t where user_id = '${pid}' and row_to_json(t)::text like '%${mark}%'`), { timeoutMs: 30000 }).catch(() => null);
        qa.check(`OUTCOME: the ${r.section} record he saved is on the server`, !!onServer, mark);
        await phoneTab(page, 'Credentials');
        await sleep(800);
        const count = await credentialsRow(page, r.section).innerText().catch(() => '');
        qa.check('OUTCOME: the Credentials list counts it once', /\b1 item\b/.test(count), count);
        const queued = await pendingOps(page);
        qa.check('nothing is left waiting on this device', queued.length === 0, JSON.stringify(queued).slice(0, 200));
        if (!onServer) {
          qa.bug({
            title: `iPhone app: a ${r.section} record saved just before switching apps is not on the server (${away})`,
            step: `Credentials > ${r.section} > Add, fill in, Save, then at once swipe to another app${away === 'discard' ? '; iOS discards the app; open it again' : '; come back'}`,
            expected: 'The record is on the server (and on every device)',
            actual: `No ${r.table} row with ${mark} 30 s after the return.`,
            severity: 'high',
          });
        }
      }, { soft: true });
    }

    await qa.feature('CRED-021', 'A health record half typed, the app left for Mail and iOS discarding it: what he typed', async () => {
      const dlg = await openPhoneAdd(page, 'Health Records');
      await typeInto(page, dlg, 'Display Name', 'QA iPhone Hep B Titer typed');
      await typeInto(page, dlg, 'Administrator / Facility', 'QA Lab Typed');
      await toBackground(page);
      await returnToApp(page, { awayMs: 2000, discard: away === 'discard' });
      if (away === 'discard') await backInApp(page);
      await sleep(1500);
      // A kept draft is laid back once the records are on view (CrudSection restoreDraft): allowed 10 s to appear.
      await page.getByRole('dialog').last().waitFor({ timeout: 10000 }).catch(() => {});
      const open = page.getByRole('dialog').last();
      const values = await open.locator('input, textarea').evaluateAll((els) => els.map((e) => e.value)).catch(() => []);
      const kept = values.includes('QA iPhone Hep B Titer typed');
      await qa.shot('health record form after return');
      qa.check(`OUTCOME: what he typed is still in the form (${away})`, kept, values.filter(Boolean).join(' | ') || 'no form open');
    }, { soft: true });
  });
}

// ── A weak network at launch: Protected Identity, a custom category, the Answer Bank ──

test('iPhone: a launch whose first API requests time out, then Protected Identity, a custom category with a record and the Answer Bank; after a discard all of it is still there', {
  tag: ['@iphone', '@CRED-005', '@CRED-023', '@CRED-046'],
}, async ({ page, context, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  await installIphone(context);
  const { user, profile } = await newPhoneMember(page, { firstName: 'Wren', lastName: 'Weaknet' });
  const pid = profile.id;
  const weakLaunchSince = new Date().toISOString();
  const cut = await flakyLaunch(context, lab().urls.apiOrigin, { first: 4, hangMs: 8000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page, 180000);
  await sleep(1500);
  qa.check('setup: the launch\'s first API requests timed out', cut.length >= 1, cut.join(', '));
  const launchText = await bodyText(page);
  qa.check('OUTCOME: the app opened to his account with nothing to reload', !/Reload to (try again|reconnect)|could not be verified|could not load/i.test(launchText), launchText.match(/.{0,100}(Reload|could not).{0,100}/i)?.[0] || '');
  const waitingMessage = 'Account load still waiting after 15 s (account).';
  const waitingRows = rows(`select id, message, kind, auth_user_id from public.client_errors where auth_user_id = '${user.id}' and kind = 'error' and message = '${waitingMessage}' and created_at >= '${weakLaunchSince}'`);
  qa.check('the deliberately delayed launch emits at most one slow-load report', waitingRows.length <= 1);
  if (waitingRows.length) qa.intentionalClientErrors(waitingRows, { message: waitingMessage, kind: 'error', authUserId: user.id, count: 1,
    reason: 'CRED-005 deliberately delayed the first four local API requests by 8 seconds; the account subsequently opened without a reload prompt.' });
  await clerkReplacesSessionOnFocus(page);
  const SSN = '000-98-7654';
  const tag = stamp('').slice(-6);

  await qa.feature('CRED-005', 'Protected Identity on the iPhone, then the app discarded', async () => {
    const sent = [];
    page.on('request', (r) => { const b = r.postData() || ''; if (b.includes(SSN) || b.includes(SSN.replace(/-/g, ''))) sent.push(new URL(r.url()).pathname); });
    await phoneCredentials(page, 'Protected Identity');
    await sleep(600);
    await page.getByRole('button', { name: 'Add record' }).tap();
    const d = page.getByRole('dialog', { name: 'Add protected identity' });
    await d.waitFor();
    await d.getByPlaceholder('e.g. Liability application 2026').tap();
    await page.keyboard.type(`QA iPhone application ${tag}`);
    await field(d, 'Legal first name').tap();
    await page.keyboard.type('Wren');
    await field(d, 'Legal last name').tap();
    await page.keyboard.type('Weaknet');
    await d.getByPlaceholder('YYYY-MM-DD').fill('1979-05-06');
    await d.getByPlaceholder('###-##-####').tap();
    await page.keyboard.type(SSN);
    const save = d.getByRole('button', { name: 'Save on this device' });
    const lock = d.getByPlaceholder('Lock code (8+ characters)');
    if (!(await lock.isVisible().catch(() => false))) { await save.tap(); await lock.waitFor({ timeout: 5000 }).catch(() => {}); }
    if (await lock.isVisible().catch(() => false)) { await lock.tap(); await page.keyboard.type('qa-lab-lock-code'); await save.tap(); }
    const closed = await d.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
    qa.check('it saves on the iPhone', closed, closed ? '' : (await d.innerText().catch(() => '')).slice(0, 200));
    await sleep(1000);
    await toBackground(page);
    await returnToApp(page, { awayMs: 2000, discard: true });
    await backInApp(page);
    await phoneCredentials(page, 'Protected Identity');
    await sleep(1200);
    const listed = await page.getByText(`QA iPhone application ${tag}`).first().isVisible().catch(() => false);
    await qa.shot('protected identity after discard');
    qa.check('OUTCOME: after the discard the record is still on this iPhone', listed);
    qa.check('OUTCOME: the SSN never left the device', sent.length === 0, sent.join(', '));
    await backButton(page).tap().catch(() => {});
  }, { soft: true });

  await qa.feature('CRED-023', 'A custom category and a record in it, the record saved just as he leaves the app', async () => {
    await phoneCredentials(page, 'New category');
    await sleep(600);
    await page.getByPlaceholder('e.g. Hospital ID Badges').tap();
    await page.keyboard.type(`QA iPhone Badges ${tag}`);
    await page.getByPlaceholder('One emoji').fill('🪪');
    await page.getByPlaceholder('Badge number, Facility, Access level').tap();
    await page.keyboard.type('Badge number, Facility');
    await page.getByRole('button', { name: 'Create category' }).tap();
    const cat = await waitFor('the category', async () => row(`select id from public.custom_categories where user_id = '${pid}' and name = 'QA iPhone Badges ${tag}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('OUTCOME: the category is on the server', !!cat);
    await page.getByRole('heading', { name: new RegExp(`QA iPhone Badges ${tag}`) }).first().waitFor({ timeout: 10000 }).catch(() => {});
    const d = page.getByRole('dialog').filter({ hasText: 'Badge number' });
    for (let i = 0; i < 3 && !(await d.isVisible().catch(() => false)); i++) {
      if (!(await page.getByRole('dialog').count())) await page.getByRole('button', { name: 'Add', exact: true }).first().tap();
      await d.waitFor({ timeout: 10000 }).catch(() => {});
    }
    const name = d.locator('label', { hasText: /^(Name|Display Name|Title|Label)/ });
    if (await name.count()) await typeInto(page, d, /^(Name|Display Name|Title|Label)/, `QA iPhone badge ${tag}`);
    await typeInto(page, d, 'Badge number', `QA-IOSBADGE-${tag}`);
    await typeInto(page, d, 'Facility', 'QA iPhone Mercy');
    await d.getByRole('button', { name: /^(Add|Save)$/ }).last().tap();
    await sleep(150);
    await toBackground(page);
    await returnToApp(page, { awayMs: 3000, discard: true });
    await backInApp(page);
    const rec = await waitFor('the record', async () => row(`select id from public.custom_records r where user_id = '${pid}' and row_to_json(r)::text like '%QA-IOSBADGE-${tag}%'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('OUTCOME: the record in his category is on the server', !!rec);
    await phoneTab(page, 'Credentials');
    await sleep(800);
    const count = await credentialsRow(page, `QA iPhone Badges ${tag}`).innerText().catch(() => '');
    qa.check('OUTCOME: the category is listed with its one record', /\b1 item\b/.test(count), count);
  }, { soft: true });

  await qa.feature('CRED-046', 'The Answer Bank opens on the iPhone after a weak launch and a discard', async () => {
    await phoneCredentials(page, 'Answer Bank');
    await sleep(1000);
    const text = await bodyText(page);
    await qa.shot('answer bank');
    qa.check('the Answer Bank screen opens (no error, no endless loading)', /Answer Bank/i.test(text) && !/could not|failed|Loading…$/i.test(text), text.slice(0, 240));
  }, { soft: true });
});

// ── Documents: camera, photos, files with storage nearly full ────────────────

test('iPhone: with storage nearly full, a photo from the camera, an image from Photos and a PDF from Files are each stored, and the upload he left mid-way is not silently lost', {
  tag: ['@iphone', '@DOCS-001', '@DOCS-005'],
}, async ({ page, context, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  await installIphone(context);
  const { user, profile } = await newPhoneMember(page, { firstName: 'Cam', lastName: 'Uploads' });
  const pid = profile.id;
  const tag = stamp('up').toLowerCase();
  const tightStorageSince = new Date().toISOString();
  const fill = await tightStorage(page, { leave: 2000 });
  qa.check('setup: localStorage nearly full', fill.filler > 100000, JSON.stringify(fill));
  await clerkReplacesSessionOnFocus(page);

  await qa.feature('DOCS-005', 'Camera: a photo taken (camera capture), stored', async () => {
    const png = Buffer.concat([syntheticPng(), Buffer.from(tag)]);
    await scriptAi('gemini', { json: { documentType: 'unknown', confidence: 'high', extracted: {} } }, base64Marker(png));
    await phoneTab(page, '+');
    await sleep(600);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.getByRole('button', { name: 'Camera', exact: true }).first().tap()]);
    await chooser.setFiles([{ name: `IMG_${tag}.png`, mimeType: 'image/png', buffer: png }]);
    await sleep(3000);
    const any = await waitFor('a stored photo', async () => row(`select d.id, d.name, (select count(*) from storage.objects o where o.bucket_id = 'documents' and o.name = d.storage_path)::int as stored from public.documents d where d.user_id = '${pid}' and (d.name like 'camera-%' or d.name like 'IMG_%')`), { timeoutMs: 45000 }).catch(() => null);
    await qa.shot('camera photo');
    qa.check('OUTCOME: the photo is stored in his account (row and file)', any?.stored > 0, JSON.stringify(any));
  }, { soft: true });

  await qa.feature('DOCS-001', 'Photos and Files: an image and a PDF, stored', async () => {
    const pdf = syntheticPdf(`QA synthetic iPhone files ${tag}`);
    await uploadFromFiles(page, [{ name: `qa-ios-files-${tag}.pdf`, buffer: pdf }]);
    const doc = await waitForDoc(pid, `qa-ios-files-${tag}.pdf`);
    qa.check('OUTCOME: the PDF from Files is stored', doc?.stored > 0, JSON.stringify(doc));
    const img = Buffer.concat([syntheticPng(), Buffer.from(`photos-${tag}`)]);
    await uploadFromFiles(page, [{ name: `qa-ios-photo-${tag}.png`, buffer: img, type: 'image/png' }]);
    const p = await waitForDoc(pid, `qa-ios-photo-${tag}.png`);
    qa.check('OUTCOME: the image from Photos is stored', p?.stored > 0, JSON.stringify(p));
    const text = await bodyText(page);
    qa.check('the screen does not say his storage is full or a file was not saved', !/storage is full|could not be saved|not saved/i.test(text), text.match(/.{0,100}(storage|not saved).{0,100}/i)?.[0] || '');
  }, { soft: true });

  await qa.feature('DOCS-001', 'A PDF chosen from Files, then straight to Mail while it uploads; iOS discards the app', async () => {
    const big = syntheticPdf(`QA synthetic iPhone left mid-upload ${tag} ${'x'.repeat(400000)}`);
    const name = `qa-ios-midway-${tag}.pdf`;
    let held = 0;
    await context.route(/\/storage\/v1\/object\//, async (route) => {
      if (route.request().method() === 'POST' && held === 0) { held += 1; await sleep(6000); }
      return route.fallback();
    });
    await uploadFromFiles(page, [{ name, buffer: big }]);
    await sleep(400);
    await toBackground(page);
    await returnToApp(page, { awayMs: 1500, discard: true });
    await backInApp(page);
    await phoneTab(page, '+');
    await sleep(8000);
    const doc = docRow(pid, name);
    const text = await bodyText(page);
    await qa.shot('documents after a discard mid-upload');
    const saidSo = new RegExp(`${name.replace(/[.]/g, '\\.')}[^.]*(not|again|upload)|did not finish|not uploaded|upload again`, 'i').test(text);
    qa.check('OUTCOME: the file he chose is stored, or the app tells him it did not finish (nothing silently lost)', !!doc?.stored || saidSo, `${JSON.stringify(doc)} | ${text.match(/.{0,120}(qa-ios-midway|upload).{0,120}/i)?.[0] || 'nothing on screen about it'}`);
    const fullMessage = 'Pending write not kept: documents storage_full';
    const fullRows = rows(`select id, message, kind, auth_user_id from public.client_errors where auth_user_id = '${user.id}' and kind = 'error' and message = '${fullMessage}' and created_at >= '${tightStorageSince}'`);
    qa.check('the four synthetic document attempts under injected quota emit at most four exact storage reports', fullRows.length <= 4);
    if (fullRows.length) qa.intentionalClientErrors(fullRows, { message: fullMessage, kind: 'error', authUserId: user.id, count: fullRows.length,
      reason: 'DOCS-001/DOCS-005 deliberately filled this account browser storage to 2 KB remaining and submitted four synthetic documents; all completed files were verified on the server and the interrupted file was stored or visibly reported unfinished.' });

  }, { soft: true });
});

// ── Vera ──────────────────────────────────────────────────────────────────────

test('iPhone: Vera, a question asked just before switching apps is answered when he returns (session replaced), and the conversation survives a discard; a packet Vera sends through the share sheet is recorded', {
  tag: ['@iphone', '@VERA-001', '@SHARE-004'],
}, async ({ page, context, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  await installIphone(context);
  const { profile } = await newPhoneMember(page, { firstName: 'Vale', lastName: 'Asker', profession: 'MD' });
  const pid = profile.id;
  const tag = stamp('v').toLowerCase();
  await clerkReplacesSessionOnFocus(page);
  const box = page.getByRole('textbox', { name: /Ask Vera anything/ });

  await qa.feature('VERA-001', 'Ask, leave at once, come back', async () => {
    await phoneMore(page, 'Vera');
    await box.waitFor({ timeout: 30000 });
    const q = `QA iPhone question ${tag}: when does my CO license renew?`;
    const reply = `QA iPhone answer ${tag}: your Colorado license renews on its expiry date.`;
    await scriptAi('gemini', { json: { reply, actions: [] } }, q);
    await box.tap();
    await page.keyboard.type(q);
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await sleep(200);
    await toBackground(page);
    await returnToApp(page, { awayMs: 5000 });
    const answered = await page.getByText(reply.slice(0, 40)).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('vera after return');
    qa.check('OUTCOME: Vera\'s answer is on screen when he comes back', answered);
    await toBackground(page);
    await returnToApp(page, { awayMs: 1500, discard: true });
    await backInApp(page);
    await phoneMore(page, 'Vera');
    await box.waitFor({ timeout: 30000 });
    await sleep(1500);
    const t = await bodyText(page);
    qa.check('OUTCOME: after iOS discarded the app, the question and answer are still in the conversation', t.includes(`QA iPhone question ${tag}`) && t.includes(reply.slice(0, 40)), t.slice(0, 300));
  }, { soft: true });

  await qa.feature('VERA-001', 'A question sent as iOS discards the app before the answer arrives', async () => {
    const q = `QA iPhone second question ${tag}: list my CME hours`;
    await scriptAi('gemini', { json: { reply: `QA iPhone second answer ${tag}.`, actions: [] } }, q);
    await box.tap();
    await page.keyboard.type(q);
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await sleep(100);
    await toBackground(page);
    await returnToApp(page, { awayMs: 1000, discard: true });
    await backInApp(page);
    await phoneMore(page, 'Vera');
    await box.waitFor({ timeout: 30000 });
    await sleep(3000);
    const t = await bodyText(page);
    const value = await box.inputValue().catch(() => '');
    await qa.shot('vera after discard mid-answer');
    qa.check('OUTCOME: his question is not lost (in the conversation, answered, or back in the box)', t.includes(`QA iPhone second question ${tag}`) || value.includes(`second question ${tag}`), `${t.slice(0, 300)} | box: ${value}`);
  }, { soft: true });

  await qa.feature('SHARE-004', 'Vera proposes a packet; Approve; the share sheet hands over to Mail and never answers; back', async () => {
    const pdf = syntheticPdf(`QA synthetic Vera packet ${tag}`);
    const name = `qa-ios-vera-${tag}.pdf`;
    await uploadFromFiles(page, [{ name, buffer: pdf }]);
    const doc = await waitForDoc(pid, name);
    qa.check('setup: a document to send', doc?.stored > 0);
    if (!doc) return;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backInApp(page);
    await hangingShare(page);
    const q = `QA iPhone packet ${tag}: send my document to credentialing`;
    await scriptAi('gemini', { json: { reply: `QA lab: here is the packet ${tag}.`, actions: [{ kind: 'send_packet', summary: `Send 1 document to QA credentialing ${tag}`, docIds: [doc.id], coverNote: 'Please find my document attached.', missing: [] }] } }, q);
    await phoneMore(page, 'Vera');
    await box.waitFor({ timeout: 30000 });
    await box.tap();
    await page.keyboard.type(q);
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    const approve = page.getByRole('button', { name: 'Approve', exact: true }).last();
    if (!(await approve.waitFor({ timeout: 60000 }).then(() => true, () => false))) { qa.check('Vera proposes the packet', false); return; }
    await sleep(4000); // the packet's file comes down to the device first
    await approve.tap();
    await sleep(2500);
    qa.check('setup: the share sheet was handed the file', (await sharedOnIos(page)).some((s) => s.files.length === 1));
    await returnToApp(page, { awayMs: 3000 });
    await sleep(2500);
    const logged = shareLog(pid).filter((r) => /^Vera packet/.test(r.item_name || ''));
    const t = await bodyText(page);
    await qa.shot('vera packet after return');
    const ok = qa.check('OUTCOME: the packet Vera sent is recorded as sent (share_log "Vera packet (1 files)")', logged.length === 1, JSON.stringify(shareLog(pid)));
    const card = t.match(/SEND PACKET.{0,300}|Send packet.{0,300}/i)?.[0] || t.slice(-300);
    qa.check('OUTCOME: the card says it is done (not left on "Working…", not offering Approve again)', /✓\s*done/i.test(t) && !/Working…/i.test(card), card);
    if (!ok) {
      qa.bug({
        title: 'iPhone app: a packet Vera sends through the share sheet is never recorded and its card never completes',
        step: 'Installed iPhone app: Vera proposes "Send packet"; Approve; the share sheet; Mail; send; back to the app',
        expected: 'share_log "Vera packet (N files)" and the card marked done',
        actual: 'No share_log row, and the card stays on a disabled "Working…" button (with Dismiss and Reply by email) for good. AssistantSection.jsx:750-783 awaits navigator.share() and records the share (addItem("shareLog")) and the card\'s completion only after it resolves; in the installed iPhone app it never resolves once Mail takes over.',
        severity: 'high',
      });
    }
  }, { soft: true });
});

// ── CV import ─────────────────────────────────────────────────────────────────

const cvReply = (tag) => ({
  education: [{ type: 'MD', name: 'MD Diploma - QA iPhone University', institution: `QA iPhone University ${tag}`, startDate: '2000-08-01', endDate: '2004-05-15' }],
  workHistory: [{ type: 'Employment', position: 'Attending Neurosurgeon', employer: `QA iPhone Medical Center ${tag}`, city: 'Denver', state: 'CO', startDate: '2012-07-01', endDate: '' }],
  licenses: [], publications: [{ name: `QA iPhone paper ${tag}`, citation: `Physician P. QA iPhone paper ${tag}. QA Journal. 2020;1:1-2.`, year: '2020' }],
  memberships: [], certifications: [], privileges: [], references: [], awards: [],
});

test('iPhone: CV import, the app left while the CV is being read (session replaced on return), then the ticked lines saved: they are on the server', {
  tag: ['@iphone', '@CV-001'],
}, async ({ page, context, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  await installIphone(context);
  const { profile } = await newPhoneMember(page, { firstName: 'Cory', lastName: 'Vitae', profession: 'MD' });
  const pid = profile.id;
  const tag = stamp('cv').toLowerCase();
  const cv = syntheticPdf(`QA synthetic iPhone curriculum vitae ${tag}`);
  await clerkReplacesSessionOnFocus(page);

  await qa.feature('CV-001', 'Upload the CV, Read my CV, leave while it reads, come back, tick, Save', async () => {
    await scriptAi('gemini', { json: { documentType: 'cv', confidence: 'high', extracted: {} } }, base64Marker(cv));
    // The CV reader's answer is held a few seconds, so the app is in the background while it reads.
    await scriptAi('gemini', { json: cvReply(tag) }, base64Marker(cv));
    await phoneTab(page, '+');
    await sleep(600);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.getByRole('button', { name: 'Upload', exact: true }).first().tap()]);
    await chooser.setFiles([{ name: `Cory-Vitae-CV-${tag}.pdf`, mimeType: 'application/pdf', buffer: cv }]);
    const offer = page.getByRole('button', { name: 'Read my CV' });
    if (!(await offer.waitFor({ timeout: 60000 }).then(() => true, () => false))) { qa.check('Documents offers "Read my CV"', false); return; }
    await offer.tap();
    const modal = page.getByRole('dialog', { name: 'Start from your CV' });
    let held = false;
    await context.route(/\/functions\/v1\//, async (route) => {
      if (!held && route.request().method() === 'POST' && (route.request().postData() || '').includes(base64Marker(cv).slice(0, 200))) { held = true; await sleep(5000); }
      return route.fallback();
    });
    await modal.getByRole('button', { name: /^Read Cory-Vitae-CV/ }).tap();
    await sleep(500);
    await toBackground(page);
    await returnToApp(page, { awayMs: 6000 });
    const read = await modal.getByText(/lines? read from/).waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('cv after return');
    qa.check('OUTCOME: the CV was read while he was away (the review is there when he returns)', read, (await modal.innerText().catch(() => '')).slice(0, 300));
    if (!read) return;
    for (const t of ['MD Diploma - QA iPhone University', 'Attending Neurosurgeon', `QA iPhone paper ${tag}`]) {
      const b = modal.getByRole('checkbox', { name: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
      if (await b.count()) await b.tap();
    }
    const selected = Number((await modal.innerText()).match(/(\d+) selected/)?.[1] || 0);
    qa.check('setup: lines ticked', selected >= 2, `${selected} selected`);
    await modal.getByRole('button', { name: new RegExp(`^Save ${selected}$`) }).tap();
    await sleep(150);
    await toBackground(page);
    await returnToApp(page, { awayMs: 3000, discard: true });
    await backInApp(page);
    await sleep(3000);
    const c = {
      education: rows(`select id from public.education where user_id = '${pid}'`).length,
      work: rows(`select id from public.work_history where user_id = '${pid}'`).length,
      publications: rows(`select id from public.publications where user_id = '${pid}'`).length,
    };
    qa.check('OUTCOME: what he ticked and saved just before leaving is on the server', c.education + c.work + c.publications >= Math.min(selected, 3), JSON.stringify(c));
  }, { soft: true });
});

// ── iPad turned across 1024 px ───────────────────────────────────────────────

test.describe('ipad', () => {
  test.use({ viewport: { width: 768, height: 1024 }, screen: { width: 768, height: 1024 }, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test('iPad: a CME entry and a screening half typed, the iPad turned (768 to 1024 wide and back): nothing typed is lost and each saves', {
    tag: ['@ipad', '@CRED-009', '@CRED-037'],
  }, async ({ page, context, qa }) => {
    test.setTimeout(8 * 60 * 1000);
    await installIphone(context);
    const { profile } = await newPhoneMember(page, { firstName: 'Tab', lastName: 'Turner' });
    const pid = profile.id;
    const tag = stamp('').slice(-6);
    for (const r of [RECORDS[2], RECORDS[1]]) {
      await qa.feature(r.id, `${r.section}: half typed, turned to landscape and back`, async () => {
        const mark = `${r.mark}${tag}`;
        const fields = r.fields(mark);
        const desk = await page.getByRole('navigation').first().isVisible().catch(() => false);
        let dlg;
        if (desk) {
          await page.getByRole('navigation').first().getByRole('button', { name: /^(\S+ )?Credentials$/ }).first().tap().catch(() => {});
          dlg = await openPhoneAdd(page, r.section).catch(() => null);
        } else dlg = await openPhoneAdd(page, r.section);
        if (!dlg) { qa.check('the form opens', false); return; }
        for (const [l, v] of fields.slice(0, 2)) await typeInto(page, dlg, l, v);
        const first = String(fields[0][1]);
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
        await sleep(1200);
        await page.setViewportSize({ width: 1180, height: 820 });
        await sleep(800);
        const open = page.getByRole('dialog').last();
        const values = await open.locator('input, textarea, select').evaluateAll((els) => els.map((e) => e.value)).catch(() => []);
        await qa.shot(`${r.section} after turn`);
        const kept = typeof fields[0][1] === 'string' ? values.includes(first) : values.some((v) => v);
        qa.check('OUTCOME: what he typed is still in the form after the turn', kept && (await open.isVisible().catch(() => false)), values.filter(Boolean).join(' | ') || 'no form open');
        await page.setViewportSize({ width: 768, height: 1024 });
        await sleep(1200);
        const still = page.getByRole('dialog').last();
        if (!(await still.isVisible().catch(() => false))) { qa.check('OUTCOME: the form is still open after turning back', false); return; }
        for (const [l, v] of fields.slice(2)) await typeInto(page, still, l, v).catch(() => {});
        await still.getByRole('button', { name: /^(Add|Save)$/ }).last().tap();
        const saved = await waitFor(`${r.table} row`, async () => row(`select id from public.${r.table} t where user_id = '${pid}' and row_to_json(t)::text like '%${mark}%'`), { timeoutMs: 20000 }).catch(() => null);
        qa.check(`OUTCOME: the ${r.section} record is on the server`, !!saved, mark);
        await backButton(page).tap().catch(() => {});
      }, { soft: true });
    }
  });
});

// ── CME transcript, the renewal packet and peer references through the share sheet ──

test('iPhone: CME Transcript PDF, the Home renewal packet and a peer reference list sent through the share sheet (which never answers): recorded, and the next one can be made', {
  tag: ['@iphone', '@CRED-011', '@HOME-017', '@CRED-043'],
}, async ({ page, context, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  await installIphone(context);
  const { user, profile } = await newPhoneMember(page, { firstName: 'Tess', lastName: 'Transcript' });
  const pid = profile.id;
  const { seed } = await import('./support/home-notify-helpers.mjs');
  await seed(user, pid, 'licenses', [{ type: 'State Medical License', name: 'QA iPhone Texas', license_number: 'QA-IOS-TX', state: 'TX', expiration_date: day(200) }]);
  await seed(user, pid, 'cme', [
    { title: 'QA iPhone ethics', category: 'AMA PRA Category 1', hours: 2, date: day(-100), topics: ['Ethics'] },
    { title: 'QA iPhone neurosurgery update', category: 'AMA PRA Category 1', hours: 10, date: day(-60) },
  ]);
  await seed(user, pid, 'peer_references', [
    { name: 'Violet Iphoneref', relationship: 'Colleague/Peer', degree: 'MD', specialty: 'Neurosurgery', institution: 'QA Valley', email: 'violet.iphoneref@qa.credentialdomd.test' },
    { name: 'Wendell Iphoneref', relationship: 'Colleague/Peer', degree: 'MD', specialty: 'Neurology', institution: 'QA Valley', email: 'wendell.iphoneref@qa.credentialdomd.test' },
  ]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await backInApp(page);
  await phoneMore(page, 'Profile & settings');
  await page.getByRole('button', { name: /^MD\s*Doctor of Medicine/ }).first().tap().catch(() => {});
  await sleep(1500);
  await clerkReplacesSessionOnFocus(page);

  await qa.feature('CRED-011', 'CME Credits > Transcript PDF > Texas, to Mail; back; the next transcript', async () => {
    await hangingShare(page);
    await phoneCredentials(page, 'CME Credits');
    await sleep(2000);
    await page.getByRole('button', { name: 'Transcript PDF' }).tap();
    const picker = page.getByRole('dialog', { name: 'Transcript PDF' });
    if (!(await picker.waitFor({ timeout: 10000 }).then(() => true, () => false))) { qa.check('the picker opens', false); return; }
    const tx = picker.getByRole('button', { name: /^Texas \(TX\)/ });
    await waitFor('certificates ready', async () => (/getting the certificates ready/.test(await tx.innerText().catch(() => '')) ? null : true), { timeoutMs: 20000 }).catch(() => null);
    await tx.tap();
    await sleep(2500);
    qa.check('setup: the share sheet was handed the transcript PDF', (await sharedOnIos(page)).some((s) => s.files.some((f) => /^CME[- ]Transcript[-,] ?(TX|Texas)\b/.test(f.name))), JSON.stringify(await sharedOnIos(page)));
    await returnToApp(page, { awayMs: 3000 });
    await sleep(2000);
    const text = await bodyText(page);
    await qa.shot('transcript after return');
    const stuck = /Building PDF/.test(text) || await picker.isVisible().catch(() => false);
    const ok = qa.check('OUTCOME: back from Mail he can make his next transcript (no "Building PDF" left, the picker not frozen open)', !stuck, text.match(/.{0,120}(Building PDF|Transcript PDF).{0,120}/)?.[0] || '');
    if (!ok) {
      qa.bug({
        title: 'iPhone app: after a CME transcript goes to Mail, CME Credits stays on "Building PDF" until the app is reloaded',
        step: 'Installed iPhone app: Credentials > CME Credits > Transcript PDF > a state; the share sheet; Mail; send; back to the app',
        expected: 'The picker closed, "Transcript PDF in the share sheet" said, and Transcript PDF ready for the next state or the board',
        actual: 'CMESection.jsx:235-249 sets transcriptBusy before await shareTranscriptPdf() and clears it only after it returns; cmeTranscriptPdf.js:798-800 awaits navigator.share(), which never settles in the installed iPhone app once Mail takes over. The picker stays open with every state disabled and the header button reads "Building PDF" (disabled, CMESection.jsx:397-401) until he force-reloads.',
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('HOME-017', 'Home > the TX card > Renewal packet, to Mail; back', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backInApp(page);
    await hangingShare(page);
    await phoneTab(page, 'Home');
    await sleep(1500);
    const card = page.locator('div[style*="cursor: pointer"]').filter({ has: page.getByText(/^TX$/) }).filter({ has: page.getByRole('button', { name: /Renewal packet/ }) }).last();
    const button = card.getByRole('button', { name: /Renewal packet/ });
    if (!(await button.isVisible().catch(() => false))) { await button.scrollIntoViewIfNeeded().catch(() => {}); }
    await button.tap();
    await sleep(3000);
    qa.check('setup: the share sheet was handed the renewal packet', (await sharedOnIos(page)).length >= 1, JSON.stringify(await sharedOnIos(page)));
    await returnToApp(page, { awayMs: 3000 });
    await sleep(2500);
    const logged = shareLog(pid).filter((r) => /TX renewal packet/.test(r.item_name || ''));
    const ok = qa.check('OUTCOME: the renewal packet he sent is recorded as sent (share_log "TX renewal packet")', logged.length === 1, JSON.stringify(shareLog(pid)));
    if (!ok) {
      qa.bug({
        title: 'iPhone app: a Home renewal packet sent through the share sheet is never recorded as sent',
        step: 'Installed iPhone app: Home > a state card > Renewal packet; the share sheet; Mail; send; back',
        expected: 'share_log "TX renewal packet" (method share), as on any browser whose share answers',
        actual: 'App.jsx:518-532 logs the packet (and shows the certificates-not-included alert) only after await shareTranscriptPdf() returns {method: "share"}; it never returns in the installed iPhone app, so nothing is recorded and a missing certificate is never mentioned.',
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('CRED-043', 'Peer References > Select > two > Send (2), to Mail; back', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backInApp(page);
    await hangingShare(page);
    await phoneCredentials(page, 'Peer References');
    await sleep(1500);
    await page.getByRole('button', { name: 'Select', exact: true }).tap();
    for (const n of ['Violet Iphoneref', 'Wendell Iphoneref']) await page.getByText(n, { exact: false }).first().tap();
    const send = page.getByRole('button', { name: /^Send \(2\)$/ });
    if (!(await send.isVisible().catch(() => false))) { qa.check('"Send (2)" offered', false); return; }
    await send.tap();
    await sleep(2000);
    qa.check('setup: the share sheet was handed the list', (await sharedOnIos(page)).length >= 1);
    await returnToApp(page, { awayMs: 3000 });
    await sleep(2500);
    const logged = shareLog(pid).filter((r) => /^Peer references \(2\)/.test(r.item_name || ''));
    const ok = qa.check('OUTCOME: the reference list he sent is recorded as sent (share_log "Peer references (2)")', logged.length === 1, JSON.stringify(shareLog(pid)));
    if (!ok) {
      qa.bug({
        title: 'iPhone app: a peer reference list sent through the share sheet is never recorded as sent',
        step: 'Installed iPhone app: Credentials > Peer References > Select > tick two > Send (2); Mail; send; back',
        expected: 'share_log "Peer references (2)" (method share)',
        actual: 'App.jsx:547-572 awaits navigator.share() and writes the share_log row only after it resolves; in the installed iPhone app it never resolves once Mail takes over.',
        severity: 'low',
      });
    }
  }, { soft: true });
});
