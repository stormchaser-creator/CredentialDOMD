// Case Logs and Peer References: the case-log summary by academic year with
// its PDF and CSV reports and Vera's Excel export, a dictated case (the
// browser's speech engine stood in for by the lab, the mock AI building the
// draft), references imported from a phone's contact picker, a .vcf card and
// a pasted signature, several references sent at once, and the heads-up
// drafts to a reference.
import { test } from './support/fixtures.mjs';
import {
  chooseFiles, field, newMember, openCredentials, openMore, recordButtons, row, rows, scriptAi, sleep, syncWarnings,
  waitForMemberApp,
} from './support/lab.mjs';
import {
  allowClipboard, clipboardText, day, dbWait, download, fakeContactPicker, fakeSpeech, fillForm, monthsFrom, openAdd, pdfText,
  saveDialog, shareSheet, shared, sheetRows,
} from './support/cred-helpers.mjs';

// Academic year (Jul 1 - Jun 30) of an ISO date, as the app spells it: "2025-26".
const academicYear = (iso) => { const [y, m] = iso.split('-').map(Number); const s = m >= 7 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
const ayRange = (ay) => { const s = Number(ay.slice(0, 4)); return [`${s}-07-01`, `${s + 1}-06-30`]; };

const CASES = [
  { title: 'QA Retrosigmoid Craniotomy', category: 'Cranial: Tumor General', date: day(-20), cpt: '61510' },
  { title: 'QA Depressed Skull Fracture Repair', category: 'Cranial: Trauma/Other', date: day(-150) },
  { title: 'QA Aneurysm Clipping', category: 'Cranial: Vascular Open', date: day(-400) },
  { title: 'QA Chronic Subdural Evacuation', category: 'Cranial: Trauma/Other', date: day(-800) },
];

/** window.open stood in for the device's mail and messages apps: calls are recorded, nothing opens. */
async function recordOpens(page) {
  await page.evaluate(() => { window.__qaOpened = []; window.open = (url, target) => { window.__qaOpened.push({ url: String(url), target: target || '' }); return null; }; });
}
const opens = (page) => page.evaluate(() => window.__qaOpened || []);

test('case logs: summary, reports, Vera export, dictation; references: contacts, several at once, heads-up', {
  tag: ['@CRED-035', '@CRED-036', '@CRED-042', '@CRED-043', '@CRED-044'],
}, async ({ page, context, qa }) => {
  test.setTimeout(16 * 60 * 1000);
  await fakeSpeech(context);
  await fakeContactPicker(context, { name: 'Quincy Picker, MD', email: 'quincy.picker@qa.credentialdomd.test', tel: '(555) 010-4411' });
  await allowClipboard(context);
  const { profile } = await newMember(page, { firstName: 'Casey', lastName: 'Casebook' });
  const pid = profile.id;
  const dbCases = (where = '') => rows(`select id, date, w_rvu from public.case_logs where user_id = '${pid}' ${where}`);

  for (const c of CASES) {
    const dlg = await openAdd(page, 'Case Logs');
    await fillForm(dlg, [['Category', c.category], ['Description', c.title], ['Date', c.date], ['Role', 'Primary Surgeon']]);
    if (c.cpt) await field(dlg, 'CPT Code(s)').fill(c.cpt);
    const r = await saveDialog(dlg);
    qa.check(`setup: case "${c.title}" saved`, r.closed, r.refusal);
  }
  await sleep(2500);
  qa.check('setup: four case_logs rows', dbCases().length === 4, dbCases().length);

  await qa.feature('CRED-035', 'Case log summary: academic years, last 12 months, career; PDF and CSV; Vera\'s Excel export', async () => {
    await openCredentials(page, 'Case Logs');
    const headline = async () => ((await page.locator('main, body').first().innerText()).match(/(Career|Last 12 Months|PGY \d+|\d{4}-\d{2})\s*\n?\s*(Jul [^\n]*|Rolling window[^\n]*)\s*\n?\s*(\d+) cases\s*\n?\s*([\d.]+) wRVU/) || []);
    const cards = async () => page.getByRole('button', { name: /(Add to|Remove from) Favorites/ }).count();
    const years = [...new Set(CASES.map((c) => academicYear(c.date)))].sort().reverse();
    const chipTexts = await page.getByRole('button').filter({ hasText: /^(PGY \d+|\d{4}-\d{2}|Last 12 mo|Career)$/ }).allInnerTexts();
    await qa.shot('case log summary');
    qa.check(`one chip per academic year with cases (${years.join(', ')}), then Last 12 mo and Career`, chipTexts.length === years.length + 2 && chipTexts.at(-2) === 'Last 12 mo' && chipTexts.at(-1) === 'Career', chipTexts);
    const pgy = chipTexts.filter((t) => /^PGY \d+$/.test(t));
    qa.check('the year chips name academic years (this physician entered no training dates)', pgy.length === 0, chipTexts);
    if (pgy.length) {
      qa.bug({
        title: 'Case Logs: every physician\'s academic years are labelled as PGY years counted from July 2018',
        step: 'Credentials > Case Logs with cases in 2024-25, 2025-26 and 2026-27 (no residency dates anywhere in the account)',
        expected: 'Chips read as academic years (or PGY years from the physician\'s own residency start)',
        actual: `Chips read ${chipTexts.join(', ')} and Career says "Jul 2018 - present": PGY_ANCHOR = 2018 is fixed in src/utils/caseLogReport.js:12 (pgyLabelOf) and the Career detail in src/components/features/CaseLogSummary.jsx:23; the same labels go into the PDF. Fixed on fix/qa-cred-home (58c77c04)`,
        severity: 'low',
      });
    }
    for (let i = 0; i < years.length; i++) {
      const [from, to] = ayRange(years[i]);
      const expected = dbCases(`and date between '${from}' and '${to}'`).length;
      await page.getByRole('button').filter({ hasText: /^(PGY \d+|\d{4}-\d{2})$/ }).nth(i).click();
      await sleep(400);
      const h = await headline();
      qa.check(`${years[i]}: headline and list show its ${expected} case(s)`, Number(h[3]) === expected && (await cards()) === expected, { headline: h[0], cards: await cards() });
    }
    const last12From = monthsFrom(-12);
    await page.getByRole('button', { name: 'Last 12 mo', exact: true }).click();
    await sleep(400);
    let h = await headline();
    const n12 = dbCases(`and date >= '${last12From}' and date <= current_date`).length;
    qa.check(`Last 12 mo: ${n12} cases, as the database has since ${last12From}`, h[1] === 'Last 12 Months' && Number(h[3]) === n12 && (await cards()) === n12, h[0]);
    // CSV of the last 12 months.
    const csv = await download(page, page.getByRole('button', { name: 'CSV', exact: true }));
    const lines = csv.buffer.toString('utf8').trim().split(/\r?\n/);
    qa.check(`the CSV for the last 12 months has ${n12} rows under its header`, lines.length === n12 + 1 && /^Date,Academic Year,Category,Procedure/.test(lines[0]), { name: csv.name, lines: lines.length });
    const dbW = Number(row(`select coalesce(sum(w_rvu), 0) as w from public.case_logs where user_id = '${pid}' and date >= '${last12From}'`).w);
    const csvW = lines.slice(1).reduce((s, l) => s + (parseFloat(l.split(',')[8]) || 0), 0);
    qa.check('its wRVU column adds up to the database\'s wRVU for the range', Math.abs(csvW - dbW) < 0.01 && Math.abs(Number(h[4]) - dbW) < 0.01, { csv: csvW, db: dbW, headline: h[4] });
    // Career PDF.
    await page.getByRole('button', { name: 'Career', exact: true }).click();
    await sleep(400);
    h = await headline();
    qa.check('Career: every case (4)', h[1] === 'Career' && Number(h[3]) === 4 && (await cards()) === 4, h[0]);
    const pdf = await download(page, page.getByRole('button', { name: 'Report PDF' }));
    const t = (await pdfText(pdf.buffer)).text;
    qa.check('the Career PDF says 4 cases and lists each', /4 cases/.test(t) && CASES.every((c) => t.includes(c.title)), t.slice(0, 300));

    // Vera: "Excel of my case logs from the last 12 months", approved.
    const question = `QA Excel of my case logs from the last 12 months ${Date.now()}`;
    await scriptAi('gemini', { json: { reply: 'QA lab: here is the Excel export of your case logs from the last 12 months.', actions: [
      { kind: 'export_data', summary: 'Excel of the last 12 months of case logs', section: 'caseLogs', format: 'xlsx', dateFrom: last12From, dateTo: day(0) },
    ] } }, question);
    await openMore(page, 'Vera');
    await page.getByRole('textbox', { name: /Ask Vera anything/ }).fill(question);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const approve = page.getByRole('button', { name: 'Approve', exact: true }).last();
    const proposed = await approve.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('vera export proposal');
    qa.check('Vera proposes the export as an action to approve', proposed);
    if (proposed) {
      const xl = await download(page, approve);
      const data = await sheetRows(xl.buffer);
      qa.check(`the approved .xlsx holds the ${n12} cases of the last 12 months`, /\.xlsx$/.test(xl.name) && data.length === n12, { name: xl.name, rows: data.length, first: data[0] });
    }
  }, { soft: true });

  await qa.feature('CRED-036', 'Dictate a case: the add form opens prefilled; Cancel discards', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Case Logs');
    const before = rows(`select id from public.ai_usage where user_id = '${pid}'`).length;
    // Cancel first: nothing is built.
    await page.getByRole('button', { name: /Dictate a case/ }).click();
    await page.getByText('Listening…').waitFor({ timeout: 10000 });
    await page.evaluate(() => window.__qaSay('QA cancelled dictation, right craniotomy'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await sleep(1500);
    qa.check('Cancel discards: no form opens and nothing is sent to the AI', !(await page.getByRole('dialog', { name: 'Add' }).count()) && rows(`select id from public.ai_usage where user_id = '${pid}'`).length === before);
    // The case, dictated.
    const words = `QA dictation ${Date.now()} suboccipital craniotomy for tumor at QA Mercy Hospital today, no complications`;
    await scriptAi('gemini', { json: { date: day(0), category: 'Cranial: Tumor General', title: 'QA dictated suboccipital craniotomy for tumor', facility: 'QA Mercy Hospital', role: 'Primary Surgeon', attending: '', cptCodes: '61520', complication: '', notes: '' } }, words.slice(0, 40));
    await page.getByRole('button', { name: /Dictate a case/ }).click();
    await page.getByText('Listening…').waitFor({ timeout: 10000 });
    await page.evaluate((w) => window.__qaSay(w), words);
    qa.check('the words appear while listening', await page.getByText(/QA dictation \d+ suboccipital/).first().waitFor({ timeout: 5000 }).then(() => true, () => false));
    await page.getByRole('button', { name: 'Done, build the case' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    const opened = await dlg.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('dictated case form');
    qa.check('"Done, build the case" opens the Add form', opened);
    if (!opened) return;
    const cat = await field(dlg, 'Category').inputValue();
    const title = await field(dlg, 'Description').inputValue();
    const text = await dlg.innerText();
    qa.check('prefilled with category, description and CPT code', cat === 'Cranial: Tumor General' && title === 'QA dictated suboccipital craniotomy for tumor' && /61520/.test(text + (await dlg.locator('input').evaluateAll((els) => els.map((e) => e.value).join(' ')))), { cat, title });
    qa.check('nothing is saved before the surgeon taps Add', !row(`select id from public.case_logs where user_id = '${pid}' and title = 'QA dictated suboccipital craniotomy for tumor'`));
    const r = await saveDialog(dlg);
    qa.check('the dictated case saves', r.closed, r.refusal);
    const saved = await dbWait('the dictated case', () => row(`select category, title, cpt_codes, date from public.case_logs where user_id = '${pid}' and title = 'QA dictated suboccipital craniotomy for tumor'`));
    qa.check('case_logs row with the dictated category, description and codes', saved?.category === 'Cranial: Tumor General' && /61520/.test(saved.cpt_codes || '') && saved.date === day(0), saved);
    const usage = rows(`select provider, ok from public.ai_usage where user_id = '${pid}'`);
    qa.check('the build went through ai-proxy (one more ai_usage row)', usage.length === before + 1, usage.length - before);
  }, { soft: true });

  await qa.feature('CRED-042', 'Import a reference: the phone\'s contact picker, a .vcf card, a pasted signature; bad input says so', async () => {
    const mark = qa.report.console.length;
    await openCredentials(page, 'Peer References');
    // The page's own "Import from Contacts" banner (shown where the picker exists).
    const banner = page.getByRole('button', { name: 'Import', exact: true });
    if (await banner.isVisible().catch(() => false)) {
      await banner.click();
      await sleep(3000);
      const saved = row(`select name, relationship from public.peer_references where user_id = '${pid}' and name = 'Quincy Picker, MD'`);
      const onScreen = /Quincy Picker/.test(await page.locator('main, body').first().innerText());
      const warn = syncWarnings(qa.report, mark);
      qa.check('the page\'s Import from Contacts banner leads to a reviewed form (or a reference that reaches the cloud)', !!saved || !onScreen, { saved, onScreen, warn: warn.slice(0, 2) });
      if (onScreen && !saved) {
        qa.bug({
          title: 'Peer References: the page\'s "Import from Contacts" banner saves the contact at once, with no Relationship, and the database refuses it',
          step: 'On a device with the Contact Picker (Chrome on Android): Credentials > Peer References > Import (the banner above the list), pick a contact',
          expected: 'The contact opens in the Add form ("Read from your contacts. Check it before saving.") and Relationship is asked, as the form\'s own Import from Contacts button does',
          actual: `The reference appears at once without review; peer_references.relationship is NOT NULL, so the insert is refused (${warn[0] || 'a sync warning'}) and the reference lives on this device only, queued for a replay that cannot succeed (src/App.jsx:2347-2360, handleContactImport). Fixed on fix/qa-cloud-writes (a0331652: the banner is removed)`,
          severity: 'medium',
        });
        // Leave the device-only copy out of what follows.
        await recordButtons(page, 'Quincy Picker').remove.click().catch(() => {});
        await sleep(1500);
      }
    }
    // The form's picker button.
    let dlg = await openAdd(page, 'Peer References');
    await dlg.getByRole('button', { name: /Import from Contacts/ }).click();
    await dlg.getByText(/Read from your contacts\. Check it before saving\./).waitFor({ timeout: 10000 });
    qa.check('the picker fills name, email and phone and says to check them', (await field(dlg, 'Full Name').inputValue()) === 'Quincy Picker, MD' && (await field(dlg, 'Email').inputValue()) === 'quincy.picker@qa.credentialdomd.test' && (await field(dlg, 'Phone').inputValue()) === '(555) 010-4411');
    let res = await saveDialog(dlg, { timeout: 3000 });
    qa.check('Relationship is still required', !res.closed && /Required:.*Relationship/.test(res.refusal), res.refusal);
    await fillForm(dlg, [[/^Relationship/, 'Colleague/Peer']]);
    res = await saveDialog(dlg);
    qa.check('with a relationship it saves', res.closed, res.refusal);
    const picked = await dbWait('the picked reference', () => row(`select name, email, phone, relationship from public.peer_references where user_id = '${pid}' and email = 'quincy.picker@qa.credentialdomd.test'`));
    qa.check('peer_references row from the picker', picked?.relationship === 'Colleague/Peer' && picked.phone === '(555) 010-4411', picked);

    // A .vcf card.
    dlg = await openAdd(page, 'Peer References');
    const vcf = Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Vance;Violet;;Dr.;MD\r\nFN:Violet Vance\\, MD\r\nORG:QA Valley Medical Center\r\nEMAIL;TYPE=work:violet.vance@qa.credentialdomd.test\r\nTEL;TYPE=cell:+1 555 010 7788\r\nEND:VCARD\r\n');
    await chooseFiles(page, dlg.getByRole('button', { name: /Import a saved contact file/ }), [{ name: 'qa-violet.vcf', mimeType: 'text/vcard', buffer: vcf }]);
    await dlg.getByText(/Read from the contact card\. Check it before saving\./).waitFor({ timeout: 10000 });
    qa.check('the .vcf fills name, email, phone and institution', (await field(dlg, 'Full Name').inputValue()) === 'Violet Vance, MD' && (await field(dlg, 'Email').inputValue()) === 'violet.vance@qa.credentialdomd.test' && (await field(dlg, 'Institution/Hospital').inputValue()) === 'QA Valley Medical Center',
      { name: await field(dlg, 'Full Name').inputValue(), inst: await field(dlg, 'Institution/Hospital').inputValue() });
    await fillForm(dlg, [[/^Relationship/, 'Supervisor/Chair']]);
    res = await saveDialog(dlg);
    qa.check('the .vcf reference saves', res.closed, res.refusal);
    // A malformed card.
    dlg = await openAdd(page, 'Peer References');
    await chooseFiles(page, dlg.getByRole('button', { name: /Import a saved contact file/ }), [{ name: 'qa-broken.vcf', mimeType: 'text/vcard', buffer: Buffer.from('this is not a contact card') }]);
    qa.check('a malformed .vcf says so', await dlg.getByText("That file doesn't look like a contact card (.vcf).").waitFor({ timeout: 10000 }).then(() => true, () => false));
    // A pasted signature (the clipboard is empty, so the paste box opens).
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await dlg.getByRole('button', { name: /Paste a contact/ }).click();
    const box = dlg.locator('textarea').first();
    await box.waitFor({ timeout: 10000 });
    await box.fill('hello there');
    await dlg.getByRole('button', { name: 'Read it' }).click();
    qa.check('pasted text with no contact in it says so', await dlg.getByText(/Nothing to import from that/).waitFor({ timeout: 5000 }).then(() => true, () => false));
    await box.fill('Wendell Wu, DO\nQA Northside Hospital\nwendell.wu@qa.credentialdomd.test\n(555) 010-9922');
    await dlg.getByRole('button', { name: 'Read it' }).click();
    await dlg.getByText(/Read from what you pasted\. Check it before saving\./).waitFor({ timeout: 10000 });
    qa.check('a pasted signature fills name, email and phone', /Wendell Wu/.test(await field(dlg, 'Full Name').inputValue()) && (await field(dlg, 'Email').inputValue()) === 'wendell.wu@qa.credentialdomd.test' && /010-9922|0109922/.test(await field(dlg, 'Phone').inputValue()),
      { name: await field(dlg, 'Full Name').inputValue(), phone: await field(dlg, 'Phone').inputValue() });
    await fillForm(dlg, [[/^Relationship/, 'Partner/Co-Physician']]);
    res = await saveDialog(dlg);
    qa.check('the pasted reference saves', res.closed, res.refusal);
    await sleep(2500);
    const refs = rows(`select name, relationship from public.peer_references where user_id = '${pid}' order by created_at`);
    qa.check('three references in the database, each with its relationship', refs.length === 3 && refs.every((x) => x.relationship), refs);
  }, { soft: true });

  await qa.feature('CRED-043', 'Send several references at once: one share (or a copy on a desk browser), logged as "Peer references (2)"', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Peer References');
    const pick = async () => {
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      for (const n of ['Violet Vance', 'Wendell Wu']) await page.getByText(n, { exact: false }).first().click();
      const send = page.getByRole('button', { name: /^Send \(2\)$/ });
      qa.check('"2 selected" and "Send (2)"', await send.isVisible() && /2 selected/.test(await page.locator('main, body').first().innerText()));
      return send;
    };
    // A desk browser without a share sheet: the list goes to the clipboard.
    await shareSheet(page, { absent: true });
    const mark = qa.report.console.length;
    const dialogsBefore = qa.report.dialogs.length;
    await (await pick()).click();
    await sleep(3000);
    const clip = await clipboardText(page);
    const said = qa.report.dialogs.slice(dialogsBefore).join(' | ');
    qa.check('without a share sheet the formatted list is copied and it says so', /Violet Vance/.test(clip) && /Wendell Wu/.test(clip) && !/Quincy Picker/.test(clip) && /reference list has been copied/i.test(said), { said, clip: clip.slice(0, 200) });
    let log = row(`select item_name, section, method, item_id, sent_at from public.share_log where user_id = '${pid}' order by created_at desc limit 1`);
    const warn = syncWarnings(qa.report, mark);
    qa.check('share_log records it: "Peer references (2)", section peerReferences, no item id, sent_at', log?.item_name === 'Peer references (2)' && log.section === 'peerReferences' && log.item_id === null && !!log.sent_at, { log, warn: warn.slice(0, 2) });
    if (!log) {
      qa.bug({
        title: 'Peer References: sending several references from a desk browser is never logged (share_log refuses method "copy")',
        step: 'Credentials > Peer References > Select > tick two > Send (2), on a browser with no share sheet (desk Chrome)',
        expected: 'A share_log row "Peer references (2)", section peerReferences, method clipboard',
        actual: `The app writes method "copy", which share_log_method_check does not allow (email, text, clipboard, share): ${warn[0] || 'the insert is refused'}; the row is queued for a replay that cannot succeed (src/App.jsx:514). Fixed on fix/qa-cloud-writes (5a3d4b8d)`,
        severity: 'low',
      });
    }
    // A device with a share sheet: one share carrying the list.
    await shareSheet(page);
    await (await pick()).click();
    await sleep(3000);
    const sh = await shared(page);
    qa.check('with a share sheet: one share with the formatted list of the two', sh.length === 1 && /Violet Vance/.test(sh[0].text) && /Wendell Wu/.test(sh[0].text) && /Peer references/.test(sh[0].title), sh);
    log = await dbWait('the share log row', () => row(`select item_name, section, method, item_id from public.share_log where user_id = '${pid}' and method = 'share' order by created_at desc limit 1`));
    qa.check('and share_log records it with method share', log?.item_name === 'Peer references (2)' && log.section === 'peerReferences' && log.item_id === null, log);
  }, { soft: true });

  await qa.feature('CRED-044', 'Heads-up to a reference: email and text drafts with the physician\'s details; copy works', async () => {
    // A reference with no email and no phone gets the drafts on screen.
    const dlg = await openAdd(page, 'Peer References');
    await fillForm(dlg, [['Full Name', 'Harriet Holt, MD'], [/^Relationship/, 'Colleague/Peer'], ['Institution/Hospital', 'QA Harbor Hospital']]);
    const r = await saveDialog(dlg);
    qa.check('a reference without email or phone saves', r.closed, r.refusal);
    await sleep(1500);
    const card = page.locator('div').filter({ hasText: 'Harriet Holt' }).filter({ has: page.getByRole('button', { name: /Email Heads-Up/ }) }).last();
    await card.getByRole('button', { name: /Email Heads-Up/ }).click();
    const email = page.getByRole('dialog', { name: 'Email Draft' });
    await email.waitFor({ timeout: 10000 });
    const et = await email.innerText();
    qa.check('the email draft greets the reference and is signed with the physician\'s name', /Dear Dr\. Holt/.test(et) && /Casey Casebook/.test(et) && /Upcoming Reference Request from Casey Casebook/.test(et) && /No email on file/.test(et), et.slice(0, 200));
    // (Twice in about ten runs an open dialog closed by itself just after a full-page screenshot;
    // not reproduced on demand. The draft is reopened once if that happens, and the note says so.)
    if (!(await email.isVisible().catch(() => false))) {
      qa.report.console.push('qa-note: the Email Draft closed by itself; reopened');
      await card.getByRole('button', { name: /Email Heads-Up/ }).click();
      await email.waitFor({ timeout: 10000 });
    }
    await email.getByRole('button', { name: 'Copy to Clipboard' }).click();
    await sleep(500);
    const clip = await clipboardText(page);
    qa.check('Copy to Clipboard copies the email body', /^Dear Dr\. Holt,/.test(clip) && /With sincere gratitude,\s*Casey Casebook/.test(clip), clip.slice(0, 120));
    qa.check('the draft closes after copying', !(await email.count()));
    await qa.shot('heads-up drafted');
    await card.getByRole('button', { name: /Text Heads-Up/ }).click();
    const text = page.getByRole('dialog', { name: 'Text Draft' });
    await text.waitFor({ timeout: 10000 });
    qa.check('the text draft names the physician', /Hi, this is Casey Casebook/.test(await text.innerText()));
    await text.getByRole('button', { name: 'Close', exact: true }).click();
    qa.check('Close closes it', !(await text.count()));
    // A reference with an email and a phone goes to the device's mail and messages apps.
    await recordOpens(page);
    const vance = page.locator('div').filter({ hasText: 'Violet Vance' }).filter({ has: page.getByRole('button', { name: /Email Heads-Up/ }) }).last();
    await vance.getByRole('button', { name: /Email Heads-Up/ }).click();
    await vance.getByRole('button', { name: /Text Heads-Up/ }).click();
    await sleep(500);
    const o = await opens(page);
    qa.check('with an email on file, the mail app opens addressed to the reference with the draft', o.some((x) => /^mailto:violet\.vance%40qa\.credentialdomd\.test\?subject=Upcoming%20Reference%20Request/.test(x.url) && /Dear%20Dr\.%20Vance/.test(x.url)), o.map((x) => x.url.slice(0, 90)));
    qa.check('with a phone on file, the messages app opens with the text', o.some((x) => /^sms:\+?15550107788\?body=Hi%2C%20this%20is%20Casey%20Casebook/.test(x.url)), o.map((x) => x.url.slice(0, 90)));
  }, { soft: true });
});
