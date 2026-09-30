// CME Credits: importing a transcript (a generic CSV mapped by hand, an Excel
// export read by its column names, pasted text read as columns, line by line
// and by the lab's mock AI, the same transcript again, a sheet with a patient
// column), a CME entry's certificate opened on this browser, on a clean one
// and after its file is gone, and the CME Passport panel with the forwarding
// hint.
import { test } from './support/fixtures.mjs';
import {
  base64Marker, chooseFiles, field, goTab, landing, lab, newMember, openCredentials, profileOf, row, rows, scriptAi, signIn, sleep,
  syntheticPdf, waitForMemberApp,
} from './support/lab.mjs';
import { supabaseStatus } from '../lib/local-db.mjs';
import {
  addLicense, allowClipboard, clipboardText, day, dbWait, fillForm, makeXlsx, openAdd, saveDialog, stubExternalPages,
} from './support/cred-helpers.mjs';

const importDialog = (page) => page.getByRole('dialog', { name: 'Import CME transcript' });

async function openImport(page) {
  await openCredentials(page, 'CME Credits');
  const dlg = importDialog(page);
  if (!(await dlg.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Import transcript' }).first().click();
  await dlg.waitFor({ timeout: 15000 });
  return dlg;
}
/** The review step's headline, e.g. "2 of 3 rows selected · 3.5 hours". */
async function reviewLine(dlg) {
  return ((await dlg.innerText()).match(/\d+ of \d+ rows? selected[^\n]*/) || [''])[0];
}
/** Maps a field of the column-mapping step to a column index. */
async function mapColumn(dlg, fieldLabel, index) {
  await dlg.locator('label').filter({ hasText: new RegExp(`^${fieldLabel}`, 'i') }).locator('select').selectOption(String(index));
}
/** The review rows, as the physician sees them: title, ticked, topic chips. */
async function reviewRows(dlg) {
  // A review row is the box around one checkbox that also holds its topic "+ topic" picker.
  return dlg.locator('div').filter({ has: dlg.page().locator('input[type=checkbox]') }).filter({ has: dlg.page().getByPlaceholder('Activity title') }).evaluateAll((els) => {
    const own = els.filter((e) => e.querySelectorAll('input[type=checkbox]').length === 1 && e.querySelectorAll('input[placeholder="Activity title"]').length === 1)
      .filter((e) => !e.parentElement || e.parentElement.querySelectorAll('input[type=checkbox]').length > 1);
    return own.map((e) => ({
      title: e.querySelector('input[placeholder="Activity title"]').value,
      ticked: e.querySelector('input[type=checkbox]').checked,
      topics: [...e.querySelectorAll('button[title="Remove topic"]')].map((b) => b.innerText.replace(/\s*×\s*$/, '').trim()),
      dup: /already in your log/i.test(e.innerText),
    }));
  });
}

test('CME import, certificates and the CME Passport panel', {
  tag: ['@CRED-010', '@CRED-031', '@CRED-032'],
}, async ({ page, context, qa, secondBrowser }) => {
  test.setTimeout(14 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Carmen', lastName: 'Transcript' });
  const pid = profile.id;
  const started = new Date(Date.now() - 5000).toISOString();
  const cmeCount = () => rows(`select id from public.cme where user_id = '${pid}' and created_at > '${started}'`).length;
  const byTitle = (t) => rows(`select id, title, hours, date, category, topics from public.cme where user_id = '${pid}' and title = '${t.replace(/'/g, "''")}'`);

  await qa.feature('CRED-010', 'Import a CME transcript: CSV mapped by hand, Excel by name, pasted text three ways, the same file again, a patient sheet refused', async () => {
    // 1. A generic CSV: its date and hours columns have names no tracker uses, so the physician maps them.
    const csv = Buffer.from([
      'When,Course,Sponsor,Amount,Kind,Area',
      '2026-03-11,QA Opioid Prescribing Update,QA Medical Society,2,AMA PRA Category 1,Opioids',
      '2026-04-02,QA Neurosurgical Ethics Forum,QA Neuro Society,1.5,AMA PRA Category 1,Ethics',
      '2026-05-20,QA Spine Imaging Review,QA Radiology Group,3,AMA PRA Category 1,',
    ].join('\n'));
    let dlg;
    // Once, in one run, the importer closed by itself while the columns were being mapped (no
    // reload, no request but the CME page's own mount-time read). It did not happen again in
    // four tries; if it does, the step is taken again and the evidence says so.
    const vanished = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      dlg = await openImport(page);
      await chooseFiles(page, dlg.getByRole('button', { name: /Choose transcript file/ }), [{ name: 'qa-cme-tracker.csv', mimeType: 'text/csv', buffer: csv }]);
      const mapStep = await dlg.getByRole('button', { name: 'Continue to review' }).waitFor({ timeout: 20000 }).then(() => true, () => false);
      if (attempt === 1) qa.check('a generic CSV asks for the column mapping', mapStep && /Generic CSV/.test(await dlg.innerText()), (await dlg.innerText()).slice(0, 200));
      await mapColumn(dlg, 'Date completed', 0);
      await mapColumn(dlg, 'Hours / credits', 3);
      await mapColumn(dlg, 'Credit type', 4);
      await mapColumn(dlg, 'Subject / topic', 5);
      if (attempt === 1) await qa.shot('cme import mapping');
      const still = await dlg.getByRole('button', { name: 'Continue to review' }).isVisible().catch(() => false);
      if (still) break;
      vanished.push(`attempt ${attempt}: the importer closed while mapping; open dialogs ${await page.getByRole('dialog').count()}`);
    }
    if (vanished.length) qa.report.console.push(`qa-note: ${vanished.join('; ')}`);
    qa.check('the importer stays open through the column mapping', vanished.length < 2, vanished.join('; ') || 'stayed open');
    await dlg.getByRole('button', { name: 'Continue to review' }).click();
    await dlg.getByText(/rows? selected/).first().waitFor({ timeout: 15000 });
    qa.check('review: 3 rows with their hours (6.5)', /^3 of 3 rows selected · 6\.5 hours/.test(await reviewLine(dlg)), await reviewLine(dlg));
    let rs = await reviewRows(dlg);
    const opioid = rs.find((r) => /Opioid/.test(r.title));
    qa.check('a topic is guessed from the title and subject ("Opioid Prescribing")', opioid?.topics.includes('Opioid Prescribing'), opioid);
    // Remove that topic chip, untick the third row.
    await dlg.getByRole('button', { name: /^Opioid Prescribing\s*×$/ }).first().click();
    // One checkbox and one title box per row, in the same order.
    const titles = await dlg.locator('input[placeholder="Activity title"]').evaluateAll((els) => els.map((e) => e.value));
    await dlg.locator('input[type=checkbox]').nth(titles.indexOf('QA Spine Imaging Review')).uncheck();
    rs = await reviewRows(dlg);
    qa.check('the chip is gone and the row unticked', !rs.find((r) => /Opioid/.test(r.title))?.topics.includes('Opioid Prescribing') && rs.find((r) => /Spine/.test(r.title))?.ticked === false, rs);
    qa.check('the headline follows: 2 of 3, 3.5 hours', /^2 of 3 rows selected · 3\.5 hours/.test(await reviewLine(dlg)), await reviewLine(dlg));
    await dlg.getByRole('button', { name: /^Add 2 to CME log/ }).click();
    const done = await dlg.getByText('Added 2 CME entries to your log.').waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('"Added 2 CME entries", "1 unticked row was left out"', done && /1 unticked row was left out/.test(await dlg.innerText()));
    await sleep(3000);
    qa.check('the database has exactly the 2 ticked rows', cmeCount() === 2 && byTitle('QA Spine Imaging Review').length === 0, cmeCount());
    const op = byTitle('QA Opioid Prescribing Update')[0];
    qa.check('dates, hours and category parsed; the removed topic is not saved', op?.date === '2026-03-11' && Number(op.hours) === 2 && op.category === 'AMA PRA Category 1' && !(op.topics || []).includes('Opioid Prescribing'), op);

    // 2. An Excel export whose column names are known: straight to review.
    const xlsx = await makeXlsx([
      ['Completion Date', 'Activity Title', 'Provider', 'Credits Earned', 'Credit Type', 'Subject Areas Covered'],
      ['2026-06-03', 'QA Cerebrovascular Symposium', 'QA Stroke Society', 4, 'AMA PRA Category 1', 'Patient Safety'],
      ['2026-06-18', 'QA Infection Control in the OR', 'QA Hospital CME Office', 1, 'AMA PRA Category 1', 'Infection Control'],
    ]);
    await dlg.getByRole('button', { name: 'Import another' }).click();
    await chooseFiles(page, dlg.getByRole('button', { name: /Choose transcript file/ }), [{ name: 'qa-cme-export.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx }]);
    const straight = await dlg.getByText(/rows? selected/).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('an Excel export with known column names goes straight to review (2 rows, 5 hours)', straight && /^2 of 2 rows selected · 5 hours/.test(await reviewLine(dlg)), await reviewLine(dlg));
    await dlg.getByRole('button', { name: /^Add 2 to CME log/ }).click();
    await dlg.getByText('Added 2 CME entries to your log.').waitFor({ timeout: 15000 });

    // 3. Pasted text, read as columns (mapped), line by line, and by the AI.
    const pasteAndRead = async (text) => {
      await dlg.getByRole('button', { name: 'Import another' }).click();
      await dlg.getByRole('button', { name: 'Paste text instead' }).click();
      await dlg.locator('textarea').first().fill(text);
      await dlg.getByRole('button', { name: 'Read pasted text' }).click();
      return dlg.getByRole('button', { name: 'Read as columns' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    };
    let textStep = await pasteAndRead([
      '06/22/2026   QA Stroke Protocols Refresher   QA Stroke Network   1.5',
      '06/25/2026   QA Pediatric Head Injury Course   QA Childrens Hospital   2',
    ].join('\n'));
    qa.check('pasted text with no header opens the text step (the mock AI found no rows in it)', textStep);
    await dlg.getByRole('button', { name: 'Read as columns' }).click();
    await dlg.getByRole('button', { name: 'Continue to review' }).waitFor({ timeout: 15000 });
    qa.check('"Read as columns" asks for the mapping (no header row, numbered columns)', /No header row found; columns are numbered/.test(await dlg.innerText()));
    await mapColumn(dlg, 'Date completed', 0);
    await mapColumn(dlg, 'Activity / title', 1);
    await mapColumn(dlg, 'Provider', 2);
    await mapColumn(dlg, 'Hours / credits', 3);
    await dlg.getByRole('button', { name: 'Continue to review' }).click();
    await dlg.getByText(/rows? selected/).first().waitFor({ timeout: 15000 });
    qa.check('read as columns: 2 rows, 3.5 hours', /^2 of 2 rows selected · 3\.5 hours/.test(await reviewLine(dlg)), await reviewLine(dlg));
    await dlg.getByRole('button', { name: /^Add 2 to CME log/ }).click();
    await dlg.getByText('Added 2 CME entries to your log.').waitFor({ timeout: 15000 });

    textStep = await pasteAndRead('07/01/2026 QA Skull Base Anatomy Workshop 3 hours\n07/09/2026 QA Neuro Oncology Grand Rounds 1 hour');
    await dlg.getByRole('button', { name: 'Read line by line' }).click();
    await dlg.getByText(/rows? selected/).first().waitFor({ timeout: 15000 }).catch(() => {});
    const lines = await reviewLine(dlg);
    qa.check('read line by line: each dated line is a row with its hours (2 rows, 4 hours)', textStep && /^2 of 2 rows selected · 4 hours/.test(lines), lines || (await dlg.innerText()).slice(0, 300));
    if (lines) {
      await dlg.getByRole('button', { name: /^Add 2 to CME log/ }).click();
      await dlg.getByText('Added 2 CME entries to your log.').waitFor({ timeout: 15000 });
    }

    const aiText = `QA transcript for AI ${Date.now()}\nCompleted the QA Spinal Cord Injury Webinar on July 14 2026 for two and a half credits from QA Spine Academy.`;
    textStep = await pasteAndRead(aiText);
    await scriptAi('gemini', { json: [{ date: '2026-07-14', title: 'QA Spinal Cord Injury Webinar', provider: 'QA Spine Academy', hours: 2.5, creditType: 'AMA PRA Category 1', subjects: '', certificateNumber: 'QA-CERT-7714' }] }, aiText.split('\n')[0]);
    await dlg.getByRole('button', { name: 'Have AI read it' }).click();
    await dlg.getByText(/rows? selected/).first().waitFor({ timeout: 30000 }).catch(() => {});
    const ai = await reviewLine(dlg);
    qa.check('"Have AI read it": the rows the model returned, labelled as AI-structured (1 row, 2.5 hours)', /^1 of 1 row selected · 2\.5 hours/.test(ai) && /AI-structured transcript/.test(await dlg.innerText()), ai || (await dlg.innerText()).slice(0, 300));
    if (ai) {
      await dlg.getByRole('button', { name: /^Add 1 to CME log/ }).click();
      await dlg.getByText('Added 1 CME entry to your log.').waitFor({ timeout: 15000 });
    }
    await dlg.getByRole('button', { name: 'Done', exact: true }).click();
    qa.check('"Done" closes the importer', await dlg.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false));
    await sleep(3000);
    const afterPaste = cmeCount();
    qa.check('the database holds every added row (2 + 2 + 2 + 2 + 1 = 9)', afterPaste === 9, afterPaste);

    // 4. The same Excel file again: every row is already in the log.
    dlg = await openImport(page);
    await chooseFiles(page, dlg.getByRole('button', { name: /Choose transcript file/ }), [{ name: 'qa-cme-export.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx }]);
    await dlg.getByText(/rows? selected/).first().waitFor({ timeout: 20000 });
    const again = await reviewLine(dlg);
    rs = await reviewRows(dlg);
    await qa.shot('cme import duplicates');
    qa.check('importing the same transcript again: both rows marked "already in your log" and unticked', /^0 of 2 rows selected/.test(again) && rs.every((r) => r.dup && !r.ticked), { again, rs });
    qa.check('nothing can be added', await dlg.getByRole('button', { name: /^Add 0 to CME log/ }).isDisabled());
    // 5. A sheet with a patient-identifier column is refused.
    await dlg.getByRole('button', { name: 'Columns' }).click();
    await dlg.getByRole('button', { name: 'Back' }).click();
    const phi = Buffer.from('Completion Date,Activity Title,Credits Earned,Patient Name\n2026-06-01,QA Case Conference,1,Test Patient One\n');
    await chooseFiles(page, dlg.getByRole('button', { name: /Choose transcript file/ }), [{ name: 'qa-conference-log.csv', mimeType: 'text/csv', buffer: phi }]);
    await sleep(2000);
    const refusal = (await dlg.innerText()).match(/[^\n]*(patient|identifier)[^\n]*/i)?.[0] || '';
    qa.check('a sheet with a patient-identifier header is refused with a reason', /patient/i.test(refusal) && !(await dlg.getByText(/rows? selected/).count()), refusal);
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await sleep(1500);
    qa.check('still 9 imported rows, no duplicates', cmeCount() === 9 && rows(`select title, count(*) as n from public.cme where user_id = '${pid}' group by title having count(*) > 1`).length === 0, cmeCount());
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'CME Credits');
    qa.check('the list shows 9 entries after a reload', /9 entries/.test(await page.locator('main, body').first().innerText()));
  }, { soft: true });

  let certDoc = null;
  await qa.feature('CRED-031', 'Open a CME entry\'s certificate: on this browser, on a clean browser, and after its file is gone', async () => {
    // A certificate scanned in the CME form: the lab's mock AI reads exactly this file.
    const pdf = syntheticPdf(`QA synthetic CME certificate ${Date.now()}`);
    await scriptAi('gemini', { json: { documentType: 'cme', confidence: 'high', extracted: { title: 'QA Certified Skull Base Workshop', hours: 6, date: day(-12), provider: 'QA Skull Base Society', category: 'AMA PRA Category 1' } } }, base64Marker(pdf));
    const dlg = await openAdd(page, 'CME Credits', 'Add CME');
    await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }).first(), [{ name: 'qa-skull-base-certificate.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    await dlg.getByText(/fields auto-filled|no fields could be read|attached/i).first().waitFor({ timeout: 60000 }).catch(() => {});
    const filled = await field(dlg, 'Activity / Title').inputValue().catch(() => '');
    qa.check('the certificate scan fills the CME form', filled === 'QA Certified Skull Base Workshop', filled);
    if (!filled) await fillForm(dlg, [['Activity / Title', 'QA Certified Skull Base Workshop'], ['Hours', '6'], ['Date Completed', day(-12)], ['Credit Category', { label: 'AMA PRA Category 1' }]]);
    const res = await saveDialog(dlg);
    qa.check('the entry saves', res.closed, res.refusal);
    await sleep(3000);
    const entry = byTitle('QA Certified Skull Base Workshop')[0];
    certDoc = entry ? await dbWait('the linked certificate', () => row(`select id, name, storage_path from public.documents where linked_to = 'cme:${entry.id}'`), 30000) : null;
    qa.check('documents row linked "cme:<id>" with its file in Storage', !!certDoc?.storage_path, certDoc);

    // The app opens the file with window.open(blob:). A headless browser has no PDF viewer, so
    // the new tab hands the blob to a download instead; either one is the file opening.
    const openCert = async (p) => {
      const btn = p.getByRole('row').filter({ hasText: 'QA Certified Skull Base Workshop' }).getByRole('button', { name: 'Open certificate' });
      await btn.waitFor({ timeout: 20000 });
      const seen = [];
      const onPage = (np) => seen.push(`tab ${np.url()}`);
      const onDownload = (d) => seen.push(`file ${d.url()}`);
      p.context().on('page', onPage);
      p.context().pages().forEach((x) => x.on('download', onDownload));
      p.on('download', onDownload);
      await btn.click();
      for (let i = 0; i < 20 && !seen.some((x) => /blob:/.test(x)); i++) await sleep(500);
      p.context().off('page', onPage);
      p.off('download', onDownload);
      for (const x of p.context().pages()) if (x !== p) await x.close().catch(() => {});
      return seen.find((x) => /blob:/.test(x)) || '';
    };
    await openCredentials(page, 'CME Credits');
    const here = await openCert(page);
    qa.check('the certificate opens on this browser (a new tab with the file)', /blob:/.test(here), here);

    const other = await secondBrowser();
    const downloads = [];
    other.page.on('response', (r) => { if (/\/storage\/v1\/object\//.test(r.url())) downloads.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await signIn(other.page, user);
    qa.check('a clean browser opens the member app', (await landing(other.page)) === 'member');
    await openCredentials(other.page, 'CME Credits');
    const there = await openCert(other.page);
    qa.check('on a clean browser the file is fetched from Storage and opens', /blob:/.test(there) && downloads.some((d) => d.startsWith('200') && d.includes(certDoc.storage_path)), { there, downloads });

    // The file is gone from Storage (lab setup: removed with the local service key), the row remains.
    const st = supabaseStatus();
    const del = await fetch(`${lab().urls.api}/storage/v1/object/documents/${certDoc.storage_path}`, { method: 'DELETE', headers: { apikey: st.SERVICE_ROLE_KEY, Authorization: `Bearer ${st.SERVICE_ROLE_KEY}` } });
    qa.check('lab setup: the certificate\'s Storage object is removed', del.ok, del.status);
    await other.page.reload();
    await waitForMemberApp(other.page);
    await openCredentials(other.page, 'CME Credits');
    const before = qa.report.dialogs.length;
    const missing = await openCert(other.page);
    await sleep(2000);
    const alert = qa.report.dialogs.slice(before).find((d) => /^alert:/.test(d)) || '';
    await other.page.screenshot({ path: (await qa.shot('certificate missing')).replace(/\.png$/, '-b.png') });
    qa.check('a certificate whose file is gone opens nothing and says so', !missing && /^alert: /.test(alert), { missing, alert });
    const clear = /not found|missing|no longer|deleted|upload it again/i.test(alert);
    qa.check('the alert is clear about what happened (the file is missing)', clear, alert);
    if (!clear) {
      qa.bug({
        title: 'CME: opening a certificate whose file is gone says "Could not open that document: {}"',
        step: 'CME Credits (desk table) > Open certificate on an entry whose linked document row remains but whose Storage file is missing, on a browser that does not hold the file',
        expected: 'A clear alert that the certificate file is missing (and how to attach it again)',
        actual: `"${alert.replace(/^alert: /, '')}". supabase.storage.download fails with a StorageUnknownError whose message is the response body "{}", and openSourceDoc prints it as is (src/components/features/CMESection.jsx:252,261). Not changed on any wave-1 fix branch`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('CRED-032', 'CME Passport panel and the certificate-email hint', async () => {
    await allowClipboard(context);
    await openCredentials(page, 'CME Credits');
    const p = profileOf(user.id);
    const hint = (await page.locator('main, body').first().innerText()).match(/Forward certificate emails to[^\n]*/)?.[0] || '';
    qa.check('the hint names cme@ and only the confirmed address (the verified sign-in address)', /cme@credentialdomd\.com from /.test(hint) && hint.endsWith(p.email) && (hint.match(/@/g) || []).length === 2, { hint, verified: p.verified_email });
    qa.check('with a confirmed address there is no "Open Settings, Email" link', !(await page.getByText('Open Settings, Email').count()));

    const panelBtn = page.getByRole('button', { name: /ACCME CME Passport/ });
    await panelBtn.click();
    let panelText = await page.locator('main, body').first().innerText();
    qa.check('the panel lists what a CME provider needs and what is missing', /Birth month and day/.test(panelText) && /details? missing before a CME provider can report your credit/.test(panelText), panelText.match(/\d+ details? missing[^\n]*/)?.[0]);
    // Open Settings from the panel and add the birth month and day, then a license number.
    await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
    const bday = page.locator('input[name="birthMonthDay"]');
    const inSettings = await bday.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('"Open Settings" opens Settings', inSettings);
    await bday.fill('7/25');
    await bday.blur();
    await sleep(1500);
    const lic = await addLicense(page, { name: 'QA Oregon License', number: 'QA-OR-6060', state: 'OR', expires: day(500) });
    qa.check('a state license with its number is added', lic.closed, lic.refusal);
    await openCredentials(page, 'CME Credits');
    if (!(await page.getByRole('button', { name: 'Copy reporting details' }).isVisible().catch(() => false))) await page.getByRole('button', { name: /ACCME CME Passport/ }).click();
    panelText = await page.locator('main, body').first().innerText();
    qa.check('with birth month and day and a license number the details are ready', /Your reporting details are ready/.test(panelText) && /July 25/.test(panelText), panelText.match(/Birth month and day[^\n]*\n?[^\n]*/)?.[0]);
    await page.getByRole('button', { name: 'Copy reporting details' }).click();
    await sleep(500);
    const copied = await clipboardText(page);
    qa.check('Copy puts the reporting details and the permission sentence on the clipboard (month and day, never a year)', /QA-OR-6060/.test(copied) && /Birth month and day: July 25/.test(copied) && /I give permission to report this CME credit to the ACCME\./.test(copied) && !/\b(19|20)\d\d\b.*July|July 25, \d{4}/.test(copied), copied);
    // The links open in new tabs; the lab answers for cmepassport.org.
    const links = await page.getByRole('link', { name: /CME Passport/ }).evaluateAll((as) => as.map((a) => ({ text: a.innerText.trim(), href: a.href, target: a.target })));
    const opened = await stubExternalPages(context, [...new Set(links.map((l) => new URL(l.href).hostname))]);
    for (const l of links) {
      const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), page.getByRole('link', { name: l.text, exact: true }).click()]);
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      qa.check(`"${l.text}" opens ${l.href} in a new tab`, l.target === '_blank' && popup.url() === l.href, popup.url());
      await popup.close();
    }
    qa.check('both CME Passport links were answered by the lab placeholder (login and search)', links.length === 2 && opened.length === 2, links);
    await page.getByRole('button', { name: 'Import transcript' }).last().click();
    qa.check('"Import transcript" in the panel opens the importer', await importDialog(page).waitFor({ timeout: 10000 }).then(() => true, () => false));
    await page.keyboard.press('Escape');
    // Survives the next online load? (SETTINGS-008 says the birthday did not.)
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'CME Credits');
    await page.getByRole('button', { name: /ACCME CME Passport/ }).click();
    panelText = await page.locator('main, body').first().innerText();
    const kept = /Your reporting details are ready/.test(panelText);
    qa.check('after a reload the birth month and day is still there, so the details stay ready', kept, panelText.match(/\d+ details? missing[^\n]*|Your reporting details are ready[^\n]*/)?.[0]);
    if (!kept) {
      qa.bug({
        title: 'CME Passport: the birth month and day is lost on the next load, so the reporting details go back to "missing"',
        step: 'Settings > Birth Month and Day "7/25"; CME Credits > ACCME CME Passport shows the details ready; reload',
        expected: 'The birth month and day is kept (on the device or the account) and the details stay ready to copy',
        actual: 'After a reload the panel says a detail is missing and Birth month and day reads "not on file": birthMonthDay has no profile column (SETTINGS_TO_PROFILE, src/lib/supabase.js:274-322, drops it) and every online load rebuilds settings from the profile row. Same cause as SETTINGS-008; fixed on fix/qa-auth-bill-settings (93bf0bb9) and fix/qa-cred-home (7a506440)',
        severity: 'medium',
      });
    }
    await goTab(page, 'Home');
  }, { soft: true });
});
