// Documents journeys (Smart Scan):
//   * DOCS-003  a file that reads as a patient record is refused after reading
//               and never stored ("was not uploaded"), also on a slow connection;
//   * DOCS-005  the camera: a photo taken enters the review queue and is kept,
//               Cancel stores nothing, a refused permission says so;
//   * DOCS-006  a receipt filed as an agency expense, another as a deduction,
//               each with the receipt linked;
//   * DOCS-007  a document that fits no section: a new category, an existing
//               one, "Keep as plain document", and "Delete this file" on a
//               recognised card;
//   * DOCS-010  a stored image opens in the lightbox and becomes the profile
//               photo (downscaled); a stored PDF opens in a new tab.
// The mock AI answers each file's scan with a scripted reading, matched to
// that file's own bytes, so parallel journeys never take each other's answers.
import { test } from './support/fixtures.mjs';
import {
  base64Marker, chooseFiles, newMember, profileOf, row, rows, scriptAi, sleep, syntheticPdf, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { noisyPng, openDocuments, pageText } from './support/sync-docs-intake-helpers.mjs';

const upload = (page) => page.getByRole('button', { name: 'Upload' }).first();
const scanAs = (buffer, json) => scriptAi('gemini', { json }, base64Marker(buffer));
const docRow = (pid, name) => row(`select * from public.documents where user_id = '${pid}' and name = '${name}'`);

test('a document that reads as a patient record is removed after reading, even while its upload is still in flight', { tag: ['@DOCS-003'] }, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Petra', lastName: 'Phiguard' });
  const chart = (tag) => ({ documentType: 'other', confidence: 'high', extracted: {
    title: 'Operative note', notes: `Operative note. Patient name: Test Patient ${tag}. MRN QA000${tag}. Date of birth 01/01/1970. Chief complaint: headache.`,
  } });

  for (const [tag, slow] of [['1', false], ['2', true]]) {
    await qa.feature('DOCS-003', slow ? 'The same, with the upload still in flight when the reading ends' : 'Upload a synthetic operative note: removed after reading', async () => {
      const name = `qa-op-note-${tag}.pdf`;
      const pdf = syntheticPdf(`QA synthetic operative note ${tag} for the patient-record check`);
      await scanAs(pdf, chart(tag));
      let release = null;
      if (slow) {
        // The file upload to Storage takes 6 seconds (a slow connection); the reading comes back first.
        await page.route('**/storage/v1/object/documents/**', async (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          await sleep(6000);
          return route.fallback();
        });
        release = () => page.unroute('**/storage/v1/object/documents/**');
      }
      await openDocuments(page);
      await chooseFiles(page, upload(page), [{ name, mimeType: 'application/pdf', buffer: pdf }]);
      // Since 3f5bce24 a scannable file is read BEFORE it is stored, and a patient record is
      // refused there: "<name>" was not uploaded (it never reaches the bucket or the table).
      const msg = page.getByText(new RegExp(`"${name.replace(/\./g, '\\.')}" was not uploaded\\.`));
      const said = await msg.first().waitFor({ timeout: 60000 }).then(() => true, () => false);
      const text = await pageText(page);
      await qa.shot(`patient record ${tag}`);
      qa.check(`"${name}" was not uploaded. is shown`, said);
      qa.check('with the patient-record warning', /This looks like a patient record\. It contains/.test(text), (text.match(/This looks like a patient record[^.]*\./) || [''])[0]);
      await sleep(slow ? 12000 : 5000);
      if (release) await release();
      const left = docRow(profile.id, name);
      const objects = row(`select count(*)::int as n from storage.objects where bucket_id = 'documents' and name like '${user.id}/%'`).n;
      qa.check('no documents row remains', !left, left ? `row ${left.id} (tombstoned: ${!!row(`select 1 as x from public.deleted_items where item_id = '${left.id}'`)})` : 'none');
      qa.check('no Storage object remains for the account', objects === 0, `${objects} object(s)`);
      await page.reload();
      await waitForMemberApp(page);
      await openDocuments(page);
      qa.check('it does not appear in Documents after a reload', !(await pageText(page)).includes(name));
      if (slow && (left || objects)) {
        qa.bug({
          title: 'A patient record removed after reading stays on the server when its upload finishes after the reading',
          step: 'Documents > Upload a synthetic operative note on a slow connection (the Storage upload finishes after the AI reading)',
          expected: 'No documents row and no Storage object for it (the app says it was removed)',
          actual: `documents row ${left ? 'present' : 'absent'}, ${objects} Storage object(s) left. DocumentsSection handleFiles calls addItem (insertItem uploads the file, then inserts the row) without waiting, and deleteItemCtx runs as soon as the reading returns: the delete removes nothing, and the upload and row land afterwards, hidden only by the tombstone (patient data kept in the cloud)`,
          severity: 'high',
        });
      }
    });
  }
});

test('the camera: a photo is taken into the review queue and kept; Cancel stores nothing; a refused permission says so', { tag: ['@DOCS-005'] }, async ({ page, qa }) => {
  // A camera stand-in: getUserMedia returns a canvas stream (a synthetic card) or refuses, as the
  // physician's browser would once asked. Set before the app loads.
  await page.addInitScript(() => {
    window.__qaCamera = 'allow';
    // The photo's scan: when a journey sets __qaCameraReading, the JPEG the app makes from the
    // camera frame is scripted on the mock AI (matched to its own bytes) as it is made, through
    // the lab's mock endpoint on the app's origin.
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const url = toDataURL.apply(this, args);
      try {
        if (args[0] === 'image/jpeg' && window.__qaCameraReading) {
          const x = new XMLHttpRequest();
          x.open('POST', '/__qa/mock/qa/ai/next', false);
          x.setRequestHeader('Content-Type', 'application/json');
          x.send(JSON.stringify({ provider: 'gemini', response: { json: window.__qaCameraReading }, match: url.split(',')[1] }));
        }
      } catch { /* the scan then gets the default answer */ }
      return url;
    };
    const md = navigator.mediaDevices || (navigator.mediaDevices = {});
    md.getUserMedia = async () => {
      if (window.__qaCamera === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 400;
      const ctx = cv.getContext('2d');
      let n = 0;
      const draw = () => { ctx.fillStyle = '#e8eef7'; ctx.fillRect(0, 0, 640, 400); ctx.fillStyle = '#123'; ctx.font = '28px sans-serif'; ctx.fillText('QA SYNTHETIC CARD', 40, 120); ctx.fillText(`frame ${n++}`, 40, 200); };
      draw();
      setInterval(draw, 100);
      return cv.captureStream(10);
    };
  });
  const { profile } = await newMember(page, { firstName: 'Cam', lastName: 'Camera' });
  const cameraDocs = () => rows(`select name, type from public.documents where user_id = '${profile.id}' and name like 'camera-%'`);

  await qa.feature('DOCS-005', 'Camera > Take Photo: a camera-<time>.jpg is read and kept', async () => {
    await openDocuments(page);
    // Exact name: a stored photo's delete button is "Delete camera-<time>.jpg" (43341dc1).
    await page.getByRole('button', { name: 'Camera', exact: true }).click();
    const take = page.getByRole('button', { name: 'Take Photo' });
    await take.waitFor({ timeout: 15000 });
    await sleep(1500);
    await qa.shot('camera open');
    await page.evaluate(() => { window.__qaCameraReading = { documentType: 'license', confidence: 'high', extracted: { type: 'State Medical License', name: 'QA Camera License', licenseNumber: 'QA-CAM-505', state: 'AZ', expirationDate: '2029-10-31' } }; });
    await take.click();
    const doc = await waitFor('the camera document', async () => cameraDocs()[0] || null, { timeoutMs: 45000 }).catch(() => null);
    qa.check('a camera-<time>.jpg documents row (image/jpeg)', !!doc && /^camera-\d+\.jpg$/.test(doc.name) && doc.type === 'image/jpeg', doc ? `${doc.name} ${doc.type}` : 'none');
    const card = await page.getByText(/document(s)? ready for review/).first().waitFor({ timeout: 45000 }).then(() => true, () => false);
    await qa.shot('camera review card');
    qa.check('the photo enters the review queue', card);
    await page.evaluate(() => { window.__qaCameraReading = null; });
    const save = page.getByRole('button', { name: 'Save to License' });
    if (await save.isVisible().catch(() => false)) await save.click();
    const lic = await waitFor('the license', async () => row(`select id from public.licenses where user_id = '${profile.id}' and license_number = 'QA-CAM-505'`), { timeoutMs: 20000 }).catch(() => null);
    const linked = lic ? await waitFor('the link', async () => rows(`select linked_to from public.documents where user_id = '${profile.id}' and name like 'camera-%'`)[0]?.linked_to === `licenses:${lic.id}` || null, { timeoutMs: 15000 }).catch(() => false) : false;
    qa.check('filed from its review card: a license with the photo linked', !!lic && !!linked, lic ? `license ${lic.id}, linked ${linked}` : 'no license');
    await page.reload();
    await waitForMemberApp(page);
    await openDocuments(page);
    qa.check('the photo is kept in Documents after a reload', doc ? (await pageText(page)).includes(doc.name) : false);
  });

  await qa.feature('DOCS-005', 'Camera > Cancel stores nothing', async () => {
    const before = cameraDocs().length;
    await page.getByRole('button', { name: 'Camera', exact: true }).click();
    await page.getByRole('button', { name: 'Take Photo' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await sleep(3000);
    qa.check('the camera view closes', !(await page.getByRole('button', { name: 'Take Photo' }).isVisible().catch(() => false)));
    qa.check('no document was added', cameraDocs().length === before, `${before} -> ${cameraDocs().length}`);
  });

  await qa.feature('DOCS-005', 'A refused camera permission shows a dismissible message', async () => {
    await page.evaluate(() => { window.__qaCamera = 'deny'; });
    await page.getByRole('button', { name: 'Camera', exact: true }).click();
    const msg = page.getByText('Could not access camera. Check browser permissions.');
    const shown = await msg.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('camera refused');
    qa.check('"Could not access camera" is shown', shown);
    // Since a4c693fc (DOCS-002) the message and its 32 x 32 "Dismiss notice" x sit side by side
    // in the notice, no longer the x inside the message's own text.
    const notice = page.locator('div').filter({ has: msg }).filter({ has: page.getByRole('button', { name: 'Dismiss notice' }) }).last();
    const close = notice.getByRole('button', { name: 'Dismiss notice' });
    qa.check('the message has one "Dismiss notice" button', shown && (await close.count()) === 1, `${await close.count()} button(s)`);
    if (shown) await close.click().catch(() => {});
    await sleep(500);
    qa.check('the message can be dismissed', !(await msg.isVisible().catch(() => false)));
    qa.blocked('DOCS-005', 'Phone capture (the native camera input an iPhone or Android opens) is not covered: the lab runs a desk browser, which takes the getUserMedia path');
  });
});

test('receipts: one filed as an agency expense, one as a deduction, each with its receipt linked', { tag: ['@DOCS-006'] }, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Rory', lastName: 'Receipt' });
  const ride = syntheticPdf('QA synthetic rideshare receipt 42.50');
  const fee = syntheticPdf('QA synthetic license fee receipt 150.00');
  let expense, deduction;

  await qa.feature('DOCS-006', 'A rideshare receipt billed to an agency (Practice > Expenses)', async () => {
    await scanAs(ride, { documentType: 'receipt', confidence: 'high', extracted: { merchant: 'QA Rideshare Co', date: '2026-09-20', total: 42.5, currency: 'USD', category: 'Rideshare / Taxi', description: 'QA ride to the hospital' } });
    await openDocuments(page);
    await chooseFiles(page, upload(page), [{ name: 'qa-ride-receipt.pdf', mimeType: 'application/pdf', buffer: ride }]);
    await page.getByRole('button', { name: /Save to (Expenses|Deductions)/ }).waitFor({ timeout: 60000 });
    const exp = page.getByRole('button', { name: /Bill to agency/ });
    if (await exp.isVisible().catch(() => false)) await exp.click();
    await page.getByRole('textbox', { name: 'Bill to agency', exact: true }).fill('QA Locum Agency');
    await qa.shot('receipt card expense');
    await page.getByRole('button', { name: 'Save to Expenses' }).click();
    expense = await waitFor('the expense row', async () => row(`select id, date, amount, vendor, agency, category from public.travel_expenses where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('travel_expenses row: date, amount, vendor, agency', expense?.date === '2026-09-20' && Number(expense.amount) === 42.5 && expense.vendor === 'QA Rideshare Co' && expense.agency === 'QA Locum Agency', JSON.stringify(expense));
    const linked = await waitFor('the receipt link', async () => docRow(profile.id, 'qa-ride-receipt.pdf')?.linked_to === `travelExpenses:${expense?.id}` || null, { timeoutMs: 15000 }).catch(() => false);
    qa.check('the receipt is linked to the expense', !!linked, docRow(profile.id, 'qa-ride-receipt.pdf')?.linked_to);
    const said = await pageText(page);
    // The notice names Practice > Expenses since 2dc41002 (receipt and statement copy).
    qa.check('the app says where it went ("Practice > Expenses, billable to QA Locum Agency")', /to Practice > Expenses, billable to QA Locum Agency/.test(said), said.match(/Saved .{0,160}/)?.[0] || said.slice(0, 200));
    await page.getByRole('button', { name: 'Open Expenses' }).click().catch(() => {});
    await sleep(1500);
    const exText = await pageText(page);
    await qa.shot('open expenses');
    const onExpenses = /QA Rideshare Co/.test(exText) && /\$42\.50/.test(exText);
    qa.check('"Open Expenses" lands on Practice > Exp. with the expense', onExpenses, exText.slice(0, 200));
    if (!onExpenses) {
      qa.bug({
        title: 'Smart Scan: "Open Expenses" after filing a receipt opens Practice on Work, not on Expenses',
        step: 'Documents > Upload a receipt > Bill to agency > Save to Expenses > Open Expenses',
        expected: 'Practice > Exp. showing the new expense',
        actual: `Practice opens on its Work tab ("${exText.slice(0, 80)}..."). The banner calls navigate("locum", "expenses"), which sets only subPage; App.jsx renders LocumDashboard with initialSub={locumSeed?.sub || (subPage === "todo" ? "todo" : undefined)}, so any sub-page other than "todo" is dropped (Home search works because it sets locumSeed)`,
        severity: 'low',
      });
    }
  });

  await qa.feature('DOCS-006', 'A license-fee receipt to the deduction ledger (Finance > Deductions)', async () => {
    await scanAs(fee, { documentType: 'receipt', confidence: 'high', extracted: { merchant: 'QA State Medical Board', date: '2026-08-15', total: 150, currency: 'USD', category: 'License / registration fee', description: 'QA license renewal fee' } });
    await openDocuments(page);
    await chooseFiles(page, upload(page), [{ name: 'qa-fee-receipt.pdf', mimeType: 'application/pdf', buffer: fee }]);
    await page.getByRole('button', { name: /Save to (Expenses|Deductions)/ }).waitFor({ timeout: 60000 });
    const ded = page.getByRole('button', { name: /Tax deduction/ });
    if (await ded.isVisible().catch(() => false)) await ded.click();
    await page.getByRole('button', { name: 'Save to Deductions' }).click();
    deduction = await waitFor('the deduction row', async () => row(`select id, date, amount, merchant, source, tax_year from public.deductibles where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('deductibles row: date, amount, merchant, source, tax year', deduction?.date === '2026-08-15' && Number(deduction.amount) === 150 && deduction.merchant === 'QA State Medical Board' && deduction.source === 'receipt scan' && String(deduction.tax_year) === '2026', JSON.stringify(deduction));
    const linked = await waitFor('the receipt link', async () => docRow(profile.id, 'qa-fee-receipt.pdf')?.linked_to === `deductibles:${deduction?.id}` || null, { timeoutMs: 15000 }).catch(() => false);
    qa.check('the receipt is linked to the deduction', !!linked, docRow(profile.id, 'qa-fee-receipt.pdf')?.linked_to);
    await page.getByRole('button', { name: 'Open Deductions' }).click().catch(() => {});
    await sleep(1500);
    const text = await pageText(page);
    await qa.shot('open deductions');
    const onLedger = /QA State Medical Board/.test(text) && /\$150/.test(text);
    qa.check('"Open Deductions" lands on the deduction ledger showing it', onLedger, text.slice(0, 200));
    if (!onLedger) {
      qa.bug({
        title: 'Smart Scan: "Open Deductions" after filing a receipt does not land on the deduction ledger',
        step: 'Documents > Upload a receipt > Tax deduction (ledger) > Save to Deductions > Open Deductions',
        expected: 'More > Finance > Deductions with the new line',
        actual: `The page shown does not list the deduction (${text.slice(0, 120)}). DocumentsSection sets the banner's target to tab "more", sub "finance", which opens Finance on its first tab, not the Deductions ledger`,
        severity: 'low',
      });
    }
    await page.reload();
    await waitForMemberApp(page);
    qa.check('both rows survive a reload', !!row(`select id from public.travel_expenses where id = '${expense?.id}'`) && !!row(`select id from public.deductibles where id = '${deduction?.id}'`));
  });
});

test('documents that fit no section: a new category, an existing one, kept plain, and Discard on a recognised card', { tag: ['@DOCS-007'] }, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Otis', lastName: 'Other' });
  const badge1 = syntheticPdf('QA synthetic hospital ID badge one');
  const badge2 = syntheticPdf('QA synthetic hospital ID badge two');
  const plain = syntheticPdf('QA synthetic meeting agenda to keep plain');
  const lic = syntheticPdf('QA synthetic Kansas license to discard');
  const other = (name, facility) => ({ documentType: 'other', confidence: 'high', extracted: {
    name, issuer: facility, suggestedCategory: { name: 'QA ID Badges', icon: '🪪', fields: [] }, facts: [{ label: 'Access level', value: 'OR and ICU' }, { label: 'Badge color', value: 'Blue' }],
  } });
  let category;

  await qa.feature('DOCS-007', 'New category: add and remove a detail, file it', async () => {
    await scanAs(badge1, other('QA badge Mercy', 'QA Mercy Hospital'));
    await openDocuments(page);
    await chooseFiles(page, upload(page), [{ name: 'qa-badge-1.pdf', mimeType: 'application/pdf', buffer: badge1 }]);
    const create = page.getByRole('button', { name: /Create "QA ID Badges" and file it/ });
    await create.waitFor({ timeout: 60000 });
    // Remove "Badge color", add "Parking" = "P2".
    const colorRow = page.locator('div').filter({ has: page.locator('input[value="Badge color"]') }).last();
    await colorRow.getByRole('button', { name: 'Remove this detail' }).click();
    await page.getByRole('button', { name: '+ Add a detail' }).click();
    const inputs = page.locator('input');
    const n = await inputs.count();
    await inputs.nth(n - 2).fill('Parking');
    await inputs.nth(n - 1).fill('P2');
    await qa.shot('other review');
    await create.click();
    await sleep(2500);
    category = row(`select * from public.custom_categories where user_id = '${profile.id}' and name = 'QA ID Badges'`);
    const rec = rows(`select id, row_to_json(r)::text as j from public.custom_records r where user_id = '${profile.id}'`);
    qa.check('a custom_categories row "QA ID Badges" (origin uploader)', !!category && category.origin === 'uploader', category ? `${category.name} ${category.origin}` : 'none');
    qa.check('one custom_records row holding the kept details, not the removed one', rec.length === 1 && /OR and ICU/.test(rec[0].j) && /P2/.test(rec[0].j) && !/Blue/.test(rec[0].j), rec[0]?.j.slice(0, 260));
    qa.check('the file is linked to the record', docRow(profile.id, 'qa-badge-1.pdf')?.linked_to === `customRecords:${rec[0]?.id}`);
    qa.check('the app says "Filed in QA ID Badges."', /Filed in QA ID Badges\./.test(await pageText(page)));
  });

  await qa.feature('DOCS-007', 'An existing category', async () => {
    await scanAs(badge2, { ...other('QA badge General', 'QA General Hospital'), extracted: { ...other('QA badge General', 'QA General Hospital').extracted, suggestedCategory: { name: 'Something Else', icon: '', fields: [] } } });
    await chooseFiles(page, upload(page), [{ name: 'qa-badge-2.pdf', mimeType: 'application/pdf', buffer: badge2 }]);
    await page.getByRole('button', { name: 'One of your categories' }).click({ timeout: 60000 });
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'QA ID Badges' }) }).last().selectOption({ label: '🪪 QA ID Badges' }).catch(async () => {
      await page.locator('select').filter({ has: page.locator('option', { hasText: 'QA ID Badges' }) }).last().selectOption({ index: 0 });
    });
    await page.getByRole('button', { name: 'File in QA ID Badges' }).click();
    await sleep(2500);
    const cats = rows(`select id from public.custom_categories where user_id = '${profile.id}'`);
    const recs = rows(`select id, category_id from public.custom_records where user_id = '${profile.id}'`);
    qa.check('no second category was created', cats.length === 1, `${cats.length}`);
    qa.check('the second record is in QA ID Badges', recs.length === 2 && recs.every((r) => r.category_id === category?.id), JSON.stringify(recs));
  });

  await qa.feature('DOCS-007', '"Keep as plain document" keeps the file unlinked', async () => {
    await scanAs(plain, { documentType: 'other', confidence: 'low', extracted: { name: 'QA meeting agenda', suggestedCategory: { name: 'QA Agendas', icon: '', fields: [] } } });
    await chooseFiles(page, upload(page), [{ name: 'qa-agenda.pdf', mimeType: 'application/pdf', buffer: plain }]);
    await page.getByRole('button', { name: 'Keep as plain document' }).first().click({ timeout: 60000 });
    await sleep(2000);
    const d = docRow(profile.id, 'qa-agenda.pdf');
    qa.check('the file stays in Documents, unlinked', !!d && !d.linked_to, d ? `linked_to "${d.linked_to}"` : 'none');
    qa.check('no category or record was made for it', !rows(`select id from public.custom_categories where user_id = '${profile.id}' and name = 'QA Agendas'`).length);
  });

  // b9e593af: the recognised card's Discard only dropped the card and kept the file; it now reads
  // "Keep as plain document" (as on the other cards), and "Delete this file" removes it, asked first.
  await qa.feature('DOCS-007', 'Delete this file on a recognised card removes the pending file (asked first)', async () => {
    await scanAs(lic, { documentType: 'license', confidence: 'high', extracted: { type: 'State Medical License', name: 'KS Medical License', licenseNumber: 'QA-KS-7007', state: 'KS', expirationDate: '2029-01-31' } });
    await chooseFiles(page, upload(page), [{ name: 'qa-discard-license.pdf', mimeType: 'application/pdf', buffer: lic }]);
    const card = page.locator('div').filter({ hasText: 'qa-discard-license.pdf' }).filter({ has: page.getByRole('button', { name: 'Save to License' }) }).last();
    const del = card.getByRole('button', { name: 'Delete this file', exact: true });
    const has = await del.waitFor({ timeout: 60000 }).then(() => true, () => false);
    const keep = await card.getByRole('button', { name: 'Keep as plain document', exact: true }).count();
    const discard = await card.getByRole('button', { name: /^Discard$/ }).count();
    await qa.shot('recognised card actions');
    qa.check('a recognised card offers "Keep as plain document" and "Delete this file", and no Discard that keeps the file', has && keep === 1 && discard === 0, `delete ${has}, keep ${keep}, discard ${discard}`);
    if (!has) return;
    const stored = await waitFor('the stored file', async () => docRow(profile.id, 'qa-discard-license.pdf'), { timeoutMs: 30000 }).catch(() => null);
    const dialogs = qa.report.dialogs.length;
    await del.click();
    await sleep(1000);
    qa.check('Delete this file asks first', qa.report.dialogs.slice(dialogs).some((x) => /Delete this document\? This cannot be undone\./.test(x)), qa.report.dialogs.slice(dialogs).join(' | '));
    const d = await waitFor('the row to go', async () => (docRow(profile.id, 'qa-discard-license.pdf') ? null : true), { timeoutMs: 20000 }).then(() => null, () => docRow(profile.id, 'qa-discard-license.pdf'));
    const obj = stored?.storage_path ? await waitFor('the object to go', async () => (row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = '${stored.storage_path}'`) ? null : true), { timeoutMs: 20000 }).then(() => false, () => true) : false;
    await qa.shot('after delete this file');
    qa.check('the file was stored before the card was answered', !!stored?.storage_path, stored?.storage_path || 'no row');
    qa.check('the deleted file is gone (no documents row, no Storage object)', !d && !obj, d ? `row ${d.id} still there, object ${obj}` : obj ? 'Storage object still there' : 'gone');
    qa.check('it is tombstoned', !!stored && !!row(`select 1 as x from public.deleted_items where item_id = '${stored.id}'`));
    qa.check('the review card is gone', !(await card.isVisible().catch(() => false)));
    qa.check('no license was created', !rows(`select id from public.licenses where user_id = '${profile.id}'`).length);
  });
});

test('stored documents: an image becomes the profile photo (downscaled, kept after a reload); a PDF opens in a new tab', { tag: ['@DOCS-010'] }, async ({ page, context, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Iris', lastName: 'Imageview' });
  const png = noisyPng(700, 700, 11);
  const pdf = syntheticPdf('QA synthetic stored PDF to open');

  await qa.feature('DOCS-010', 'Open an image, set it as the profile photo; open a PDF; reload', async () => {
    await scanAs(png, { documentType: 'unknown' });
    await scanAs(pdf, { documentType: 'unknown' });
    await openDocuments(page);
    await chooseFiles(page, upload(page), [{ name: 'qa-headshot.png', mimeType: 'image/png', buffer: png }]);
    await waitFor('the image row', async () => docRow(profile.id, 'qa-headshot.png')?.storage_path || null, { timeoutMs: 45000 });
    await chooseFiles(page, upload(page), [{ name: 'qa-stored.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    await waitFor('the pdf row', async () => docRow(profile.id, 'qa-stored.pdf')?.storage_path || null, { timeoutMs: 45000 });
    for (const b of await page.getByRole('button', { name: 'Keep as plain document' }).all()) await b.click().catch(() => {});
    await sleep(1000);
    await page.getByAltText('qa-headshot.png').first().click();
    const setPhoto = page.getByRole('button', { name: 'Set as my profile photo' });
    await setPhoto.waitFor({ timeout: 10000 });
    await qa.shot('lightbox');
    await setPhoto.click();
    const saved = await waitFor('profile_photo', async () => profileOf(user.id)?.profile_photo || null, { timeoutMs: 20000 }).catch(() => null);
    qa.check('profiles.profile_photo is a JPEG data URL', !!saved && saved.startsWith('data:image/jpeg'), (saved || '').slice(0, 30));
    const dims = saved ? await page.evaluate((src) => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res([0, 0]); i.src = src; }), saved) : [0, 0];
    qa.check('it is downscaled (at most 512 px, far smaller than the 700 px original)', Math.max(...dims) <= 512 && Math.max(...dims) > 0, `${dims.join('x')}, ${saved?.length || 0} chars vs ${png.length} bytes`);
    qa.check('it is small enough for every profile load (under 300 KB)', (saved?.length || Infinity) < 300000, `${saved?.length}`);
    const topbar = page.locator('img[src^="data:image/jpeg"]').first();
    qa.check('the top bar / side nav shows the photo', await topbar.isVisible().catch(() => false));
    // The PDF opens in a new tab.
    const popup = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    await page.locator('div').filter({ hasText: 'qa-stored.pdf' }).getByRole('button', { name: /View PDF/ }).last().click();
    const tab = await popup;
    qa.check('View PDF opens a new tab', !!tab, tab ? tab.url().slice(0, 20) : 'no tab');
    if (tab) await tab.close().catch(() => {});
    await page.reload();
    await waitForMemberApp(page);
    await sleep(1500);
    qa.check('the profile photo persists after a reload', await page.locator('img[src^="data:image/jpeg"]').first().isVisible().catch(() => false));
  });
});
