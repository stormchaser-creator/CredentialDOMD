// Documents journeys: Smart Scan upload read by AI (the lab's mock answers
// with a scripted license for exactly this file), review and file it as a
// license with the file linked, the duplicate and PHI-spreadsheet refusals,
// linking and unlinking a stored document, and deleting one.
import { test } from './support/fixtures.mjs';
import {
  base64Marker, chooseFiles, goTab, newMember, openCredentials, row, rows, scriptAi, sleep, syntheticPdf, tableRow, tombstones, waitFor, waitForMemberApp,
} from './support/lab.mjs';

const upload = (page) => page.getByRole('button', { name: 'Upload' }).first();

test('documents: smart scan files a license with its file; duplicate and PHI spreadsheet refused; link, unlink, delete', {
  tag: ['@DOCS-001', '@DOCS-002', '@DOCS-004', '@DOCS-008', '@DOCS-009'],
}, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Dana', lastName: 'Documents' });
  const tag = `${Date.now()}`;
  const pdf = syntheticPdf(`QA synthetic Colorado license QA-SCAN-${tag}`);
  const number = `QA-SCAN-${tag.slice(-5)}`;
  let doc;

  await qa.feature('DOCS-001', 'Smart Scan upload: AI reads it; a second copy is skipped', async () => {
    await scriptAi('gemini', { json: { documentType: 'license', confidence: 'high', extracted: {
      type: 'State Medical License', name: 'CO Medical License', licenseNumber: number, state: 'CO', issuedDate: '2024-06-01', expirationDate: '2028-05-31',
    } } }, base64Marker(pdf));
    await goTab(page, 'Documents');
    await chooseFiles(page, upload(page), [{ name: 'qa-scan-license.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    const ready = await page.getByText(/1 document ready for review/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('review card');
    qa.check('"1 document ready for review"', ready);
    qa.check('the review card shows the detected type and fields', /License \/ Certification/.test(await page.locator('body').innerText()) && (await page.getByRole('textbox').evaluateAll((els) => els.map((e) => e.value))).includes(number));
    doc = await waitFor('the stored document', async () => row(`select * from public.documents where user_id = '${profile.id}' and name = 'qa-scan-license.pdf'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('a documents row with its file in Storage', !!doc?.storage_path && !!row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = '${doc?.storage_path}'`), doc?.storage_path);
    // The checklist's case: the same file (same name) a second time.
    await chooseFiles(page, upload(page), [{ name: 'qa-scan-license.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    const dup = await page.getByText(/already uploaded.*Skipped duplicate/).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('the same file again is skipped as a duplicate, with a message', dup);
    qa.check('no second documents row', rows(`select id from public.documents where user_id = '${profile.id}'`).length === 1);
  });

  await qa.feature('DOCS-002', 'Review and file the scanned document as a license', async () => {
    await page.getByRole('button', { name: 'Save to License' }).click();
    const lic = await waitFor('the license row', async () => row(`select * from public.licenses where user_id = '${profile.id}' and license_number = '${number}'`), { timeoutMs: 30000 }).catch(() => null);
    await qa.shot('filed');
    qa.check('a license row with the scanned fields', lic?.state === 'CO' && lic.expiration_date === '2028-05-31', lic ? `${lic.license_number} ${lic.state} ${lic.expiration_date}` : 'none');
    const linked = lic ? await waitFor('the link', async () => row(`select linked_to from public.documents where id = '${doc.id}'`)?.linked_to || null, { timeoutMs: 15000 }).catch(() => null) : null;
    qa.check('the document is linked to the new license', !!linked && linked.includes(lic.id), linked);
    qa.check('the physician\'s own name is not used as the Display Name', lic?.name !== 'Dana Documents', lic?.name);
    // The filed banner says where it went and opens the new record's detail (1f8f469a).
    const saved = await page.getByText('Saved to Licenses & certs.', { exact: true }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('the banner says where it went ("Saved to Licenses & certs.")', saved);
    const open = page.getByRole('button', { name: 'Open License / Certification', exact: true });
    if (saved && await open.count()) {
      await open.click();
      const detail = page.getByRole('dialog', { name: 'State Medical License, CO', exact: true });
      const opened = await detail.waitFor({ timeout: 10000 }).then(() => true, () => false);
      // Read before the screenshot: a full-page shot re-lays the page out.
      const dt = opened ? (await detail.innerText({ timeout: 5000 }).catch(() => '')).replace(/\s+/g, ' ') : '';
      qa.check('the banner\'s Open shows the new license (its detail, with the scanned number)', opened && dt.includes(number), opened ? dt.slice(0, 200) : 'no detail dialog');
      if (opened && await detail.isVisible().catch(() => false)) {
        await detail.getByRole('button', { name: 'Close dialog' }).click();
        qa.check('its detail closes', await detail.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false));
      }
      await qa.shot('filed banner opened the license');
    } else qa.check('the banner offers Open', false, 'no "Open License / Certification" button');
    await openCredentials(page, 'Licenses');
    qa.check('the license appears in Credentials > Licenses', await tableRow(page, number).isVisible().catch(() => false));
  });

  await qa.feature('DOCS-001', 'The same bytes under another name, after a reload, are still recognised', async () => {
    // After a reload the device holds the stored document without its bytes (they live in
    // Storage), so a byte comparison has nothing to compare against.
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Documents');
    const before = rows(`select id from public.documents where user_id = '${profile.id}'`).length;
    await chooseFiles(page, upload(page), [{ name: 'qa-scan-license-copy.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    const dup = await page.getByText(/already uploaded|Skipped duplicate/).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    await sleep(3000);
    const after = rows(`select id from public.documents where user_id = '${profile.id}'`).length;
    qa.check('a renamed copy of a stored file is recognised as a duplicate', dup && after === before, `${before} -> ${after} documents; message ${dup}`);
    if (!dup && after > before) {
      qa.bug({
        title: 'Smart Scan stores a second copy of a file already uploaded when the copy has another name and the page was reloaded',
        step: 'Documents > Upload a PDF; reload; Upload the same PDF saved under another file name',
        expected: 'Skipped as a duplicate ("already uploaded"), as it is before the reload',
        actual: 'A second documents row and Storage object. findDuplicateDoc (src/utils/docPrefill.js) matches on identical bytes in doc.data or on the same name and size, and after a reload the stored document has no bytes on the device (they are fetched from Storage), so only the name can match',
        severity: 'low',
      });
      const extra = rows(`select id from public.documents where user_id = '${profile.id}' and name = 'qa-scan-license-copy.pdf'`)[0];
      if (extra) {
        // Remove the copy so the later stretches see one file, as a physician would.
        const card = page.locator('div').filter({ hasText: 'qa-scan-license-copy.pdf' }).filter({ has: page.getByRole('button', { name: /View PDF/ }) }).last();
        await card.getByRole('button', { name: 'Delete qa-scan-license-copy.pdf', exact: true }).click().catch(() => {});
        await sleep(1500);
      }
    }
  }, { soft: true });

  await qa.feature('DOCS-004', 'A spreadsheet with a patient identifier column is refused', async () => {
    await goTab(page, 'Documents');
    const csv = Buffer.from('MRN,Patient Name,Procedure\nQA0001,Test Patient One,Craniotomy\nQA0002,Test Patient Two,Laminectomy\n');
    await chooseFiles(page, upload(page), [{ name: 'qa-case-list.csv', mimeType: 'text/csv', buffer: csv }]);
    await sleep(3000);
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const refused = /qa-case-list\.csv.*(not|never|refus|patient|identifier)/i.test(body);
    await qa.shot('phi spreadsheet');
    qa.check('the upload is refused with a reason naming patient identifiers', refused, body.match(/[^.]*qa-case-list\.csv[^.]*\.[^.]*/)?.[0]);
    qa.check('nothing was stored', !row(`select id from public.documents where user_id = '${profile.id}' and name = 'qa-case-list.csv'`));
  });

  let loose;
  await qa.feature('DOCS-008', 'Link, relink and unlink a stored document', async () => {
    const other = syntheticPdf(`QA synthetic unrelated letter ${tag}`);
    await scriptAi('gemini', { json: { documentType: 'unknown' } }, base64Marker(other));
    await chooseFiles(page, upload(page), [{ name: 'qa-loose-letter.pdf', mimeType: 'application/pdf', buffer: other }]);
    loose = await waitFor('the loose document', async () => row(`select * from public.documents where user_id = '${profile.id}' and name = 'qa-loose-letter.pdf'`), { timeoutMs: 45000 }).catch(() => null);
    qa.check('the second document is stored unlinked', !!loose && !loose.linked_to, loose?.linked_to);
    await page.reload();
    await goTab(page, 'Documents');
    const card = page.locator('div').filter({ hasText: 'qa-loose-letter.pdf' }).filter({ has: page.locator('select') }).last();
    const select = card.locator('select').first();
    await select.waitFor({ timeout: 20000 });
    const options = await select.locator('option').allInnerTexts();
    const target = options.find((o) => o.includes(number) || /License: State Medical License, CO/.test(o));
    qa.check('the link menu lists the license', !!target, options.slice(0, 6).join(' | '));
    if (target) {
      await select.selectOption({ label: target });
      await sleep(2000);
      const lic = row(`select id from public.licenses where user_id = '${profile.id}' and license_number = '${number}'`);
      const now = row(`select linked_to from public.documents where id = '${loose.id}'`);
      qa.check('documents.linked_to points at the license', !!now?.linked_to && now.linked_to.includes(lic.id), now?.linked_to);
      await qa.shot('linked card');
      const linkedCard = page.locator('div').filter({ hasText: 'qa-loose-letter.pdf' }).filter({ has: page.getByRole('button', { name: /View PDF/ }) }).last();
      qa.check('the card shows a Linked badge', /Linked/.test(await linkedCard.innerText()));
      const control = await linkedCard.locator('select').count() + await linkedCard.getByRole('button', { name: /unlink|relink|change link|move/i }).count();
      qa.check('the linked card still offers relink / unlink', control > 0, `${control} control(s)`);
      if (!control) {
        qa.bug({
          title: 'Documents: once a document is linked, its card has no way to relink it or set it back to unlinked',
          step: 'Documents > stored document > "Link to credential..." > pick a license; then try to relink it to another record or unlink it',
          expected: 'The card keeps a link control (checklist DOCS-008: link, relink to an insurance record, set back to unlinked)',
          actual: 'The select disappears as soon as linkedTo is set (DocumentsSection.jsx renders it only when !doc.linkedTo); the card shows only a "Linked" badge, View PDF and delete',
          severity: 'medium',
        });
      }
    }
  });

  await qa.feature('DOCS-009', 'Delete a document', async () => {
    const card = page.locator('div').filter({ hasText: 'qa-loose-letter.pdf' }).filter({ has: page.getByRole('button', { name: /View PDF/ }) }).last();
    const dialogs = qa.report.dialogs.length;
    // The trash button is named for its file (43341dc1).
    await card.getByRole('button', { name: 'Delete qa-loose-letter.pdf', exact: true }).click();
    await sleep(500);
    const confirm = page.getByRole('dialog').last();
    if (await confirm.getByRole('button', { name: /^Delete/ }).count()) await confirm.getByRole('button', { name: /^Delete/ }).last().click();
    await sleep(2500);
    qa.check('a confirmation was asked', qa.report.dialogs.length > dialogs, qa.report.dialogs.slice(dialogs).join(' | '));
    qa.check('the documents row is gone', !row(`select id from public.documents where id = '${loose.id}'`));
    qa.check('it is tombstoned', tombstones(profile.id).some((t) => t.item_id === loose.id));
    const gone = await waitFor('the storage object to go', async () => !row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = '${loose.storage_path}'`), { timeoutMs: 20000 }).catch(() => false);
    qa.check('its Storage object is removed', gone);
    await page.reload();
    await goTab(page, 'Documents');
    qa.check('it does not come back after a reload', !/qa-loose-letter\.pdf/.test(await page.locator('body').innerText()));
  });
});
