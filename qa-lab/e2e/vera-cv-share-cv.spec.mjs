// A physician starts from their CV: uploaded to Documents, recognised as a CV,
// read (the lab's mock AI returns what the CV states), reviewed line by line
// (tick, Clear, tick again, Save), then read a second time from Setup, where
// what was saved is "already on file" and what was left unticked is still
// offered. Then the CV the app generates (three templates, preview, Copy, Save
// PDF), and the setup packet at the end of Setup: Download (a ZIP with the
// summary spreadsheet and the files) and Send it (the email packet sheet).
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, base64Marker, chooseFiles, emailBody, goTab, newMember, openMore, pendingOps, recordButtons, openCredentials, row, rows,
  scriptAi, sleep, syntheticPdf, waitFor, waitForEmail, waitForMemberApp, field,
} from './support/lab.mjs';
import {
  actionCard, askVera, attachToRecord, deviceLog, installDeviceStandIns, openVera, runTag, shareLog, waitForDocument,
} from './support/vera-cv-share-helpers.mjs';

/** What a model reading the synthetic CV returns (the CV import's JSON contract). */
function cvReply(tag) {
  return {
    settings: { name: 'Casey Curriculum', degreeType: 'MD', specialties: ['Neurosurgery'], professionalSummary: `QA summary ${tag}` },
    education: [
      { type: 'Doctor of Medicine (MD)', name: 'MD Diploma - QA University', institution: 'QA University School of Medicine', startDate: '2008', graduationDate: '2012' },
      { type: 'Residency Certificate', name: 'Neurosurgery Residency - QA Mercy', institution: 'QA Mercy Medical Center', fieldOfStudy: 'Neurological Surgery', startDate: '2012', graduationDate: '2019' },
      { type: 'Fellowship Certificate', name: 'Spine Fellowship - QA Mercy', institution: 'QA Mercy Medical Center', fieldOfStudy: 'Complex Spine', startDate: '2019', graduationDate: '2020' },
    ],
    workHistory: [
      { type: 'Full-Time Employed', position: 'Attending Neurosurgeon', employer: 'QA Mercy Medical Center', city: 'Denver', state: 'CO', startDate: '2020', current: 'Yes' },
      { type: 'Full-Time Employed', position: 'Assistant Professor of Neurosurgery', employer: 'QA Mercy Medical Center', city: 'Denver', state: 'CO', startDate: '2021', current: 'Yes' },
    ],
    licenses: [{ type: 'State Medical License', name: 'CO Medical License', state: 'CO', licenseNumber: `QA-CV-${tag.slice(-5)}` }],
    publications: [
      { name: `QA spine paper ${tag}`, citation: `Curriculum C, et al. QA spine outcomes ${tag}. QA J Neurosurg. 2021;1:1-5.`, year: '2021' },
      { name: `QA tumor paper ${tag}`, citation: `Curriculum C. QA tumor series ${tag}. QA Neurosurg Rev. 2023;2:10-20.`, year: '2023' },
    ],
    memberships: [{ organization: `QA Congress of Neurosurgeons ${tag}`, role: 'Member', startDate: '2012' }],
  };
}

/**
 * The checkbox of the review row whose text (label or detail) contains `text`.
 * Work-history rows are labelled by the employer, so two positions at one
 * center share a label and are told apart by their detail line.
 */
function reviewBox(page, text) {
  return page.locator('div').filter({ hasText: text }).filter({ has: page.getByRole('checkbox') }).last().getByRole('checkbox').first();
}
async function rowState(page, text) {
  const box = reviewBox(page, text);
  if (!(await box.count())) return 'absent';
  return (await box.isDisabled()) ? 'locked' : 'offered';
}

test('CV: read my CV, tick and save, read it again; generate the CV; the setup packet downloads and sends', {
  tag: ['@CV-001', '@CV-002', '@SHARE-005'],
}, async ({ page, context, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  await installDeviceStandIns(context);
  const { profile, user } = await newMember(page, { firstName: 'Casey', lastName: 'Curriculum' });
  const pid = profile.id;
  const tag = runTag();
  const cv = syntheticPdf(`QA synthetic curriculum vitae ${tag}`);
  const reply = cvReply(tag);
  const counts = () => ({
    education: rows(`select id from public.education where user_id = '${pid}'`).length,
    work: rows(`select id from public.work_history where user_id = '${pid}'`).length,
    licenses: rows(`select id from public.licenses where user_id = '${pid}'`).length,
    publications: rows(`select id from public.publications where user_id = '${pid}'`).length,
    memberships: rows(`select id from public.professional_memberships where user_id = '${pid}'`).length,
  });

  await qa.feature('CV-001', 'Start from your CV: read, tick, Clear, save only what is ticked; a second read proposes no duplicates', async () => {
    // The upload is classified as a CV by the scan, then read by the CV reader: two model calls on the same file.
    await scriptAi('gemini', { json: { documentType: 'cv', confidence: 'high', extracted: {} } }, base64Marker(cv));
    await scriptAi('gemini', { json: reply }, base64Marker(cv));
    await goTab(page, 'Documents');
    await chooseFiles(page, page.getByRole('button', { name: 'Upload' }).first(), [{ name: `Casey-Curriculum-CV-${tag}.pdf`, mimeType: 'application/pdf', buffer: cv }]);
    const offer = page.getByRole('button', { name: 'Read my CV' });
    const offered = await offer.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('cv offer');
    qa.check('Documents offers "Read my CV" for the uploaded CV', offered);
    if (!offered) return;
    qa.check('the CV file itself is kept in Files', !!await waitForDocument(pid, `Casey-Curriculum-CV-${tag}.pdf`));
    await offer.click();
    const modal = page.getByRole('dialog', { name: 'Start from your CV' });
    await modal.getByRole('button', { name: new RegExp(`^Read Casey-Curriculum-CV`) }).click();
    const read = await modal.getByText(/lines? read from/).waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('cv review');
    qa.check('the review lists what the CV states', read, (await modal.innerText().catch(() => '')).slice(0, 300));
    if (!read) return;
    const text = await modal.innerText();
    qa.check('nothing starts ticked', /\b0 selected\b/.test(text), text.match(/\d+ selected/)?.[0]);
    // Tick a group and some items, then Clear, then tick again.
    const tickAll = modal.getByRole('button', { name: /^Tick all \d+ here$/ }).first();
    if (await tickAll.count()) await tickAll.click();
    const afterGroup = Number((await modal.innerText()).match(/(\d+) selected/)?.[1] || 0);
    qa.check('"Tick all" ticks a whole group', afterGroup >= 2, `${afterGroup} selected`);
    await modal.getByRole('button', { name: 'Clear', exact: true }).click();
    qa.check('Clear unticks everything', /\b0 selected\b/.test(await modal.innerText()));
    const pick = ['MD Diploma - QA University', 'Neurosurgery Residency - QA Mercy', 'Attending Neurosurgeon', `QA spine paper ${tag}`, `QA Congress of Neurosurgeons ${tag}`, 'State Medical License - CO'];
    const missing = [];
    for (const text of pick) {
      const box = reviewBox(page, text);
      if (await box.count()) await box.check(); else missing.push(text);
    }
    const labels = await modal.getByRole('checkbox').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    qa.check('each chosen line has its own checkbox', missing.length === 0, `missing ${missing.join(', ')}; rows: ${labels.join(' | ').slice(0, 400)}`);
    const selected = Number((await modal.innerText()).match(/(\d+) selected/)?.[1] || 0);
    await modal.getByRole('button', { name: new RegExp(`^Save ${selected}$`) }).click();
    const saved = await modal.getByText(/Saved \d+ items? from your CV/).waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('cv saved');
    qa.check('the saved screen says how many were saved', saved, (await modal.innerText()).slice(0, 200));
    await sleep(3000);
    const c = counts();
    qa.check('education: the MD and the residency only (the fellowship was not ticked)', c.education === 2, JSON.stringify(c));
    qa.check('work history: the attending post only', c.work === 1, JSON.stringify(c));
    qa.check('licenses: the CO license', c.licenses === 1, JSON.stringify(c));
    qa.check('publications: the spine paper only', c.publications === 1 && !!row(`select id from public.publications where user_id = '${pid}' and name = 'QA spine paper ${tag}'`), JSON.stringify(c));
    qa.check('memberships: the society', c.memberships === 1, JSON.stringify(c));
    const wh = row(`select type, position, employer, start_date from public.work_history where user_id = '${pid}'`);
    qa.check('the saved rows carry what the CV said', wh?.employer === 'QA Mercy Medical Center' && wh?.position === 'Attending Neurosurgeon', JSON.stringify(wh));
    qa.check('nothing is queued', (await pendingOps(page)).length === 0, JSON.stringify(await pendingOps(page)).slice(0, 300));
    await modal.getByRole('button', { name: 'Back to the list' }).click();
    qa.check('"Back to the list" returns to the review', await modal.getByText(/lines? read from/).isVisible().catch(() => false));
    await modal.getByRole('button', { name: 'Close' }).last().click().catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});

    // Run it again on the same CV, from Setup > Start from your CV.
    await page.reload();
    await waitForMemberApp(page);
    await scriptAi('gemini', { json: reply }, base64Marker(cv));
    await openMore(page, 'Setup');
    await page.getByRole('button', { name: /Start from your CV/ }).first().click();
    await page.getByRole('button', { name: 'Upload my CV' }).click();
    const again = page.getByRole('button', { name: new RegExp(`^Casey-Curriculum-CV-${tag}`) });
    const listed = await again.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Setup\'s CV reader offers the CV already in Files', listed);
    if (!listed) return;
    await again.click();
    await page.getByText(/lines? read from|Nothing new in this one/).first().waitFor({ timeout: 60000 });
    await qa.shot('cv second read');
    const states = {};
    for (const text of [...pick, 'Spine Fellowship - QA Mercy', 'Assistant Professor of Neurosurgery', `QA tumor paper ${tag}`]) states[text] = await rowState(page, text);
    const reoffered = pick.filter((p) => states[p] === 'offered');
    qa.check('everything saved the first time is "already on file" and cannot be ticked again', reoffered.length === 0, JSON.stringify(states));
    const stillOffered = ['Spine Fellowship - QA Mercy', 'Assistant Professor of Neurosurgery', `QA tumor paper ${tag}`];
    const notOffered = stillOffered.filter((p) => states[p] !== 'offered');
    qa.check('what was left unticked is still offered (the fellowship and second position at the same center, the other paper)', notOffered.length === 0, JSON.stringify(states));
    if (notOffered.some((p) => /Fellowship|Assistant Professor/.test(p))) {
      qa.bug({
        title: 'CV import: a second program or position at the same institution is marked "already on file" and cannot be imported',
        step: 'Start from your CV: save the residency and the attending post at QA Mercy (leave the fellowship and the assistant professorship there unticked); read the same CV again',
        expected: 'The fellowship and the assistant professorship are still offered (they are not on file)',
        actual: `Locked as already on file: ${notOffered.join(', ')}. markAlreadyOnFile (src/utils/publicRecord.js) keys education on the institution and work history on the employer alone. Fixed on fix/qa-cred-home (e4f9e6cc), not on release/qa1`,
        severity: 'medium',
      });
    }
    // Save the other paper this time, so the CV below has two, then Done.
    const other = reviewBox(page, `QA tumor paper ${tag}`);
    if (await other.isEnabled().catch(() => false)) {
      await other.check();
      await page.getByRole('button', { name: /^Save 1$/ }).click();
      await page.getByText(/Saved 1 item from your CV/).waitFor({ timeout: 15000 }).catch(() => {});
      await page.getByRole('button', { name: 'Done' }).click().catch(() => {});
    }
    await sleep(2000);
    qa.check('the second read created no duplicates (only the one newly ticked paper was added)', counts().publications === 2 && counts().education === 2 && counts().work === 1 && counts().licenses === 1, JSON.stringify(counts()));
  }, { soft: true });

  await qa.feature('CV-002', 'Generate CV: templates, preview in set order, Copy, Save PDF', async () => {
    // The tumor paper (saved on the second read) goes first on the CV (Order on CV = 1).
    const twoPapers = !!row(`select id from public.publications where user_id = '${pid}' and name = 'QA tumor paper ${tag}'`);
    if (twoPapers) {
      await openCredentials(page, 'Publications');
      await recordButtons(page, `QA tumor paper ${tag}`).edit.click();
      const edit = page.getByRole('dialog').last();
      await field(edit, 'Order on CV').fill('1');
      await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
      await edit.waitFor({ state: 'detached', timeout: 15000 });
      await sleep(1500);
    }
    await openMore(page, 'Generate CV');
    await page.getByRole('heading', { name: 'CV Generator' }).waitFor({ timeout: 15000 });
    const previews = {};
    for (const name of ['Clinical CV', 'Academic CV', 'Locum Tenens']) {
      await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await sleep(400);
      previews[name] = (await page.locator('main, body').first().innerText()).replace(/\s+/g, ' ');
    }
    await qa.shot('cv preview academic last');
    const academic = previews['Academic CV'];
    qa.check('the preview has the name from the profile', /Casey Curriculum/.test(academic));
    qa.check('it lists education, work, publications and memberships', /QA University School of Medicine/.test(academic) && /Attending Neurosurgeon/.test(academic) && academic.includes(`QA spine outcomes ${tag}`) && academic.includes(`QA Congress of Neurosurgeons ${tag}`), academic.slice(0, 600));
    const iTumor = academic.indexOf(`QA tumor series ${tag}`), iSpine = academic.indexOf(`QA spine outcomes ${tag}`);
    if (twoPapers) qa.check('publications follow the set order (Order on CV 1 first)', iTumor >= 0 && iSpine >= 0 && iTumor < iSpine, `tumor at ${iTumor}, spine at ${iSpine}`);
    // Academic adds CME and Clinical adds insurance and references (none on file here), so those two
    // read the same for this record. Locum Tenens is a compact format of its own (f09af0be, b586ee46):
    // licences, experience and training first; publications and organizations stay on the full CV.
    const base = (t) => t.replace(/Clinical CV.*?Locum Tenens Compact format for locum assignments/, '');
    qa.check('each template renders the CV (header and sections)', Object.values(previews).every((t) => /Casey Curriculum/.test(t) && /Education|Training/i.test(t)));
    const locumSame = base(previews['Locum Tenens']) === base(previews['Clinical CV']);
    qa.check('"Locum Tenens" ("Compact format for locum assignments") differs from the Clinical CV', !locumSame, locumSame ? 'identical preview text' : '');
    if (locumSame) {
      qa.bug({
        title: 'Generate CV: the "Locum Tenens" template ("Compact format for locum assignments") is not a format of its own',
        step: 'More > Generate CV: pick Clinical CV, then Locum Tenens, and compare the previews (a record with education, work, a license, publications and a membership)',
        expected: 'A compact CV for locum assignments, as the template card says',
        actual: 'The same preview, Copy text and PDF as the Clinical CV (Clinical only adds liability insurance and references when there are any). buildCvContent (src/utils/cvContent.js) branches only on "academic" (~line 291) and "clinical" (~line 309); no code reads "locum", in cvContent.js, cvPdf.js or shareText.js. Not changed on any wave-1 fix branch',
        severity: 'low',
      });
    }
    const locum = previews['Locum Tenens'];
    qa.check('the Locum Tenens CV keeps the experience and leaves out publications and organizations', /Attending Neurosurgeon/.test(locum) && !locum.includes(`QA spine outcomes ${tag}`) && !locum.includes(`QA Congress of Neurosurgeons ${tag}`), locum.slice(0, 600));
    // The loop ends on Locum Tenens; Copy and Save PDF below are checked on the full CV, so pick
    // Academic CV again and wait for its publications to be in the preview.
    const academicCard = page.getByRole('button', { name: /^Academic CV/ });
    await academicCard.click();
    const spine = page.getByText(`QA spine outcomes ${tag}`).first();
    const spineShown = await spine.waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('Academic CV is picked again and its preview lists the publications', spineShown && (await academicCard.getAttribute('aria-pressed')) === 'true');
    await page.getByRole('button', { name: /Hide Preview/ }).click();
    qa.check('the preview can be hidden', spineShown && !(await spine.isVisible().catch(() => false)));
    await page.getByRole('button', { name: /Show Preview/ }).click();
    await page.getByRole('button', { name: 'Copy to Clipboard' }).click();
    const copyNote = await page.getByText(/Copied\. Paste it anywhere\./).waitFor({ timeout: 5000 }).then(() => true, () => false);
    const clip = (await deviceLog(page)).clipboard.at(-1) || '';
    qa.check('Copy confirms and the clipboard holds the Academic CV text (with its publications)', copyNote && clip.includes('Casey Curriculum') && clip.includes(`QA spine outcomes ${tag}`), clip.slice(0, 200));
    await page.getByRole('button', { name: 'Save PDF' }).click();
    const pdfNote = await page.getByText(/PDF ready in the share sheet\.|PDF downloaded\./).waitFor({ timeout: 20000 }).then(() => true, () => false);
    const shared = (await deviceLog(page)).shared.at(-1);
    qa.check('Save PDF hands a PDF to the share sheet and says so', pdfNote && shared?.files?.[0]?.type === 'application/pdf' && shared.files[0].head === '%PDF-', JSON.stringify(shared?.files));
  }, { soft: true });

  await qa.feature('SHARE-005', 'Setup packet: Download the packet (ZIP) and Send it', async () => {
    // The packet needs a copy of the license, then every other packet row done or declared not applicable.
    // The CV gave no expiration date, and a license will not save without one (or "not yet known").
    await attachToRecord(page, 'Licenses', `QA-CV-${tag.slice(-5)}`, { name: `qa-co-license-copy-${tag}.pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic CO license copy ${tag}`) }, { fill: { Expires: '2028-04-30' } });
    const lic = row(`select id from public.licenses where user_id = '${pid}'`);
    qa.check('the license copy is stored', !!await waitForDocument(pid, `qa-co-license-copy-${tag}.pdf`, { linked: lic?.id }));
    // A file in one of the physician's own categories (a hospital badge, filed by Vera): the
    // checklist's risk is that the packet leaves such files out.
    const badge = syntheticPdf(`QA synthetic hospital badge ${tag}`);
    await scriptAi('gemini', { json: {
      reply: `QA ${tag}: this is a hospital ID badge; here is a new category with it filed.`,
      actions: [{ kind: 'create_category', summary: `New category QA Hospital Badges ${tag}, with this badge`,
        category: { name: `QA Hospital Badges ${tag}`, icon: '🪪', description: 'Hospital ID badges', fields: [{ label: 'Facility', type: 'text' }] },
        records: [{ name: `QA Mercy badge ${tag}`, number: `B-${tag.slice(-4)}`, values: { Facility: 'QA Mercy Medical Center' } }] }],
    } }, base64Marker(badge));
    await openVera(page);
    await askVera(page, `QA ${tag} file my hospital badge`, null, { attach: { name: `qa-badge-${tag}.pdf`, mimeType: 'application/pdf', buffer: badge }, expectText: `QA ${tag}: this is a hospital ID badge` });
    await actionCard(page, `New category QA Hospital Badges ${tag}`).approve.click().catch(() => {});
    const badgeDoc = await waitForDocument(pid, `qa-badge-${tag}.pdf`, { linked: 'customRecords:' });
    qa.check('a badge file is filed in the physician\'s own category', !!badgeDoc, badgeDoc?.linked_to);
    let badgeLeftOut = false;
    await openMore(page, 'Setup');
    await sleep(1500);
    const tier2 = ['Board certification', 'BLS, ACLS or ATLS', 'CME for the current cycle', 'Photo ID', 'Headshot', 'Hospital privileges', 'Malpractice certificate of insurance', 'Three peer references'];
    const header = page.getByRole('button', { name: /items · \d+ done/ }).first();
    if (await header.isVisible().catch(() => false) && !(await page.getByRole('button', { name: 'More for Board certification' }).isVisible().catch(() => false))) await header.click();
    const marked = [];
    for (const label of tier2) {
      const more = page.getByRole('button', { name: `More for ${label}` }).first();
      if (!(await more.isVisible().catch(() => false))) continue;
      await more.click();
      const na = page.getByRole('button', { name: 'Does not apply to me' }).first();
      if (await na.isVisible().catch(() => false)) { await na.click(); marked.push(label); await sleep(400); }
      else await more.click();
    }
    await sleep(2000);
    const ending = page.getByText('Your packet is assembled.');
    const assembled = await ending.waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('packet assembled');
    qa.check('with every packet row done or not applicable, "Your packet is assembled." appears', assembled, `marked not applicable: ${marked.join(', ')}; ${(await page.locator('body').innerText()).match(/Credentialing packet[^\n]*|\d+ items · \d+ done/)?.[0] || ''}`);
    if (!assembled) return;
    const card = page.locator('div').filter({ has: ending }).filter({ has: page.getByRole('button', { name: 'Send it' }) }).last();
    qa.check('the card names the line items and documents', /\d+ (line items?|records?).*\d+ documents?|documents?/i.test(await card.innerText()), (await card.innerText()).slice(0, 300));
    const download = card.getByRole('button', { name: /Download the packet|Building the file/ });
    await waitFor('the packet download to be enabled', async () => (await download.isEnabled() ? true : null), { timeoutMs: 30000 }).catch(() => {});
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), download.click()]);
    qa.check('Download the packet downloads a ZIP', !!dl && /\.zip$/.test(dl.suggestedFilename()), dl?.suggestedFilename());
    if (dl) {
      const zip = await JSZip.loadAsync(readFileSync(await dl.path()));
      const names = Object.keys(zip.files);
      qa.check('the ZIP holds credentials_summary.xlsx', names.some((n) => /credentials_summary\.xlsx$/.test(n)), names.join(' | '));
      qa.check('the ZIP holds the linked license copy', names.some((n) => n.includes(`qa-co-license-copy-${tag}`)), names.join(' | '));
      // The checklist's risk: a file in one of the physician's own categories is not in the ZIP. Filed
      // as a bug, then verified by design (2026-09-30); Send it below must still offer it.
      badgeLeftOut = !!badgeDoc && !names.some((n) => n.includes(`qa-badge-${tag}`));
      if (badgeLeftOut) {
        qa.byDesign('SHARE-005', 'The packet ZIP leaves out a file filed in the physician\'s own category (the checklist\'s risk)',
          'By design (verified 2026-09-30): the packet is exactly the credentialing sections that have a folder and a row in credentials_summary.xlsx (PACKET_SECTIONS in src/utils/credentialExport.js, whose docblock names a custom category among what is left out), so nothing outside those sections goes to a credentialing office. Send it lists every document and preselects the packet ones, so such a file can be ticked by hand.');
      }
      const xlsxName = names.find((n) => /credentials_summary\.xlsx$/.test(n));
      if (xlsxName) {
        const wb = XLSX.read(await zip.file(xlsxName).async('nodebuffer'));
        const all = wb.SheetNames.map((s) => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n');
        qa.check('the summary spreadsheet lists the license and the training', all.includes(`QA-CV-${tag.slice(-5)}`) && /QA Mercy Medical Center/.test(all), wb.SheetNames.join(', '));
      }
    }
    // Send it: the email packet sheet, preselected with the packet's files.
    await card.getByRole('button', { name: 'Send it' }).click();
    const sheet = page.getByRole('dialog', { name: 'Email with attachments' });
    await sheet.waitFor({ timeout: 10000 });
    const recipient = `packet-${tag.toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
    await sheet.locator('label', { hasText: /^To$/ }).first().locator('xpath=..').locator('input').fill(recipient);
    const sheetText = await sheet.innerText();
    const n = Number(sheetText.match(/(\d+) of \d+ selected/)?.[1] || 0);
    qa.check('the sheet opens with the packet files ticked', n >= 1, sheetText.match(/\d+ of \d+ selected[^\n]*/)?.[0]);
    if (badgeLeftOut) qa.check('the sheet still lists the custom-category file, so it can be ticked by hand', sheetText.includes(`qa-badge-${tag}`), sheetText.slice(0, 400));
    const since = new Date().toISOString();
    await sheet.getByRole('button', { name: /^Send \d+ documents?$/ }).click();
    const ok = await sheet.getByText(/Sent to .* with \d+ attachments?/).waitFor({ timeout: 30000 }).then(() => true, () => false);
    const mail = await waitForEmail({ to: recipient, since }, 30000).catch(() => null);
    const full = mail ? await emailBody(mail.id) : null;
    qa.check('the packet email is sent with its attachments', ok && (full?.attachments || []).length === n, `${(full?.attachments || []).length} attachments for ${n} ticked`);
    qa.check('a share_log row records the send', shareLog(pid).some((r) => r.method === 'email' && r.recipient === recipient));
    await sheet.getByRole('button', { name: 'Done' }).click().catch(() => {});
    void user;
  }, { soft: true });
});
