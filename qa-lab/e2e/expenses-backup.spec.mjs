// Practice expenses billed to an agency with their receipts, the JSON backup
// exported and restored (a deleted record comes back, a bad file is refused),
// and a session ended from elsewhere (the lab ends it through the mock Clerk,
// as revoking it on Clerk's account page would).
import { readFileSync } from 'node:fs';
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, chooseFiles, clerkId, emailBody, emails, field, goTab, landing, mockApi, newMember, openCredentials, openMore, pendingOps,
  recordButtons, row, rows, signIn, sleep, stamp, syntheticPng, tombstones, waitFor, waitForMemberApp,
} from './support/lab.mjs';

test('expenses: log two with receipts, invoice them to the agency with the receipts attached', {
  tag: ['@PRAC-019', '@PRAC-007'],
}, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Ellis', lastName: 'Expenses' });
  const tab = (name) => page.getByRole('button', { name, exact: true }).first().click();

  await qa.feature('PRAC-019', 'Log travel expenses with receipts', async () => {
    await goTab(page, 'Practice');
    await tab('Exp.');
    for (const [amount, cat, vendor] of [['412.50', 'Airfare', 'QA Airways'], ['189.00', 'Hotel', 'QA Suites']]) {
      await page.getByRole('button', { name: '+ Expense' }).click();
      const d = page.getByRole('dialog', { name: 'New expense' });
      await d.getByRole('spinbutton', { name: '$ amount' }).fill(amount);
      await d.getByRole('button', { name: cat, exact: true }).click();
      await d.getByPlaceholder('Vendor (e.g. United, Marriott, Hertz)').fill(vendor);
      await d.getByRole('textbox', { name: 'Bill to agency', exact: true }).fill('QA Locum Agency');
      await chooseFiles(page, d.getByRole('button', { name: 'Upload' }), [{ name: `qa-${cat.toLowerCase()}-receipt.png`, mimeType: 'image/png', buffer: syntheticPng() }]);
      await sleep(1500);
      await d.getByRole('button', { name: 'Add expense' }).click();
      await d.waitFor({ state: 'detached', timeout: 20000 });
    }
    await sleep(2500);
    const exp = rows(`select id, category, vendor, amount, agency, invoice_id from public.travel_expenses where user_id = '${profile.id}' order by amount desc`);
    await qa.shot('expenses');
    qa.check('two travel_expenses rows with amount, category, vendor and agency', exp.length === 2 && Number(exp[0].amount) === 412.5 && exp[0].agency === 'QA Locum Agency', exp);
    const receipts = rows(`select name, linked_to from public.documents where user_id = '${profile.id}' and name like 'qa-%-receipt.png'`);
    qa.check('each receipt is stored and linked to its expense', receipts.length === 2 && receipts.every((r) => exp.some((e) => (r.linked_to || '').includes(e.id))), receipts);
  }, { soft: true });

  await qa.feature('PRAC-007', 'Invoice the expenses with receipts (the share sheet)', async () => {
    // The app hands the invoice PDF and the receipts to the device's share sheet (navigator.share).
    // The lab stands in for the sheet: it records what was shared.
    await page.evaluate(() => {
      window.__qaShared = [];
      navigator.canShare = () => true;
      navigator.share = async (data) => { window.__qaShared.push({ title: data.title || '', text: data.text || '', files: (data.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) }); };
    });
    await page.getByRole('button', { name: /^Invoice \d+ expenses/ }).click();
    const d = page.getByRole('dialog', { name: 'Invoice expenses' });
    await d.waitFor();
    await qa.shot('invoice expenses');
    const text = (await d.innerText()).replace(/\s+/g, ' ');
    qa.check('both expenses are ticked and the total is $601.50', /Total \$601\.50/.test(text) && (await d.getByRole('checkbox').count()) === 2, text.match(/Total \$[\d.,]+/)?.[0]);
    qa.check('it says both receipts will be attached', /2 receipts will be attached/.test(text));
    await d.getByRole('button', { name: 'Create & send with receipts' }).click();
    await sleep(4000);
    const shared = await page.evaluate(() => window.__qaShared || []);
    const inv = row(`select kind, total_amount from public.invoices where user_id = '${profile.id}' order by created_at desc limit 1`);
    qa.check('an expense invoice for $601.50', /expense/.test(inv?.kind || '') && Number(inv.total_amount) === 601.5, inv);
    const billed = rows(`select invoice_id from public.travel_expenses where user_id = '${profile.id}'`);
    qa.check('both expenses marked billed', billed.length === 2 && billed.every((e) => !!e.invoice_id), billed);
    const files = shared.flatMap((x) => x.files);
    qa.check('the share carries the invoice PDF and both receipts', files.some((f) => /pdf/.test(f.type)) && files.filter((f) => /image|receipt/i.test(`${f.type} ${f.name}`)).length === 2, JSON.stringify(files));
    await goTab(page, 'Practice');
    await tab('Exp.');
    const list = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('both expenses show their invoice number and nothing is left to invoice', (list.match(/EXP-\d{8}-\d{2} · owed/g) || []).length === 2 && !(await page.getByRole('button', { name: /^Invoice \d+ expenses/ }).count()), list.match(/Travel expenses.{0,300}/)?.[0]);
  }, { soft: true });
});

test('backup: export JSON, delete a record, restore it; an invalid file is refused', { tag: ['@SYNC-018', '@SYNC-015'] }, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Blake', lastName: 'Backup' });
  const addPub = async (label) => {
    await openCredentials(page, 'Publications');
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const d = page.getByRole('dialog').last();
    await field(d, 'Short Label').fill(label);
    await field(d, 'Full Citation (as it should read on the CV)').fill(`Backup B. ${label}. QA Journal. 2024;1:1.`);
    await d.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await d.waitFor({ state: 'detached' });
    await sleep(2000);
  };
  await addPub('QA paper A');
  const a = row(`select id from public.publications where user_id = '${profile.id}' and row_to_json(publications)::text like '%QA paper A%'`);
  let file;

  await qa.feature('SYNC-018', 'Export the JSON backup', async () => {
    await openMore(page, 'Data & Backup');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: /Export JSON Backup/ }).click()]);
    file = await dl.path();
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const text = JSON.stringify(json);
    qa.check('the backup holds the publication', text.includes('QA paper A'));
    qa.check('it holds no AI keys or lock code', !/sk-ant-|AIza|lockCode/.test(text));
    qa.check('the file name is credentialdomd-backup-<date>.json', /^credentialdomd-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  }, { soft: true });

  await qa.feature('SYNC-015', 'Restore from the backup; an invalid file is refused', async () => {
    await openCredentials(page, 'Publications');
    await recordButtons(page, 'QA paper A').remove.click();
    await sleep(2000);
    qa.check('A is deleted and tombstoned', !row(`select id from public.publications where id = '${a.id}'`) && tombstones(profile.id).some((t) => t.item_id === a.id));
    await addPub('QA paper B');
    await openMore(page, 'Data & Backup');
    await chooseFiles(page, page.getByRole('button', { name: 'Choose File...' }), [{ name: 'backup.json', mimeType: 'application/json', buffer: readFileSync(file) }]);
    const ok = await page.getByText('Data imported successfully!').waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('restore message');
    qa.check('the import reports success', ok);
    await sleep(3000);
    // "This will merge with your current data": B (added after the export) should still be listed.
    await openCredentials(page, 'Publications');
    const local = await page.locator('body').innerText();
    qa.check('right after the import, both A and B are listed (a merge)', /QA paper A/.test(local) && /QA paper B/.test(local), `A ${/QA paper A/.test(local)}, B ${/QA paper B/.test(local)}`);
    if (/QA paper A/.test(local) && !/QA paper B/.test(local)) {
      qa.bug({
        title: 'Restore from Backup replaces each section on the device instead of merging (a record added after the backup disappears until a reload)',
        step: 'More > Data & Backup > Export JSON Backup; add publication B; Restore from Backup with that file; open Publications',
        expected: '"This will merge with your current data": A and B both listed',
        actual: 'Only A is listed (DataExport.jsx merges with {...data, ...filtered}, which replaces each collection array); B returns only after a reload, because bulkSync upserted A without deleting B in the cloud',
        severity: 'medium',
      });
    }
    await page.reload();
    await waitForMemberApp(page);
    await sleep(3000);
    const aBack = row(`select id from public.publications where id = '${a.id}'`);
    qa.check('after a reload A is back in the database', !!aBack);
    const stillTomb = tombstones(profile.id).some((t) => t.item_id === a.id);
    qa.check('A has no tombstone any more', !stillTomb);
    if (aBack && stillTomb) {
      qa.bug({
        title: 'A restored record keeps its deletion tombstone (row and tombstone both exist)',
        step: 'Delete publication A; Restore from Backup with a file that contains A; reload',
        expected: 'A present with no deleted_items row (checklist SYNC-015)',
        actual: `publications has A (${a.id}) and deleted_items still holds it: the restore upserts the row but never clears the tombstone, so any device that honours tombstones will hide or delete A again (the lab health "zombie" check counts it)`,
        severity: 'medium',
      });
    }
    qa.check('B is still there', !!row(`select id from public.publications where user_id = '${profile.id}' and row_to_json(publications)::text like '%QA paper B%'`));
    await openMore(page, 'Data & Backup');
    const d2 = qa.report.dialogs.length;
    await chooseFiles(page, page.getByRole('button', { name: 'Choose File...' }), [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a backup') }]);
    await sleep(2000);
    const err = [...qa.report.dialogs.slice(d2), ...(await page.getByRole('alert').allInnerTexts().catch(() => []))].join(' | ') + (await page.locator('body').innerText()).match(/[^.\n]*(invalid|not a valid|could not read|error)[^.\n]*/i)?.[0];
    qa.check('an invalid file shows an error', /invalid|not a valid|could not|error|unrecogni/i.test(err), err.slice(0, 200));
  }, { soft: true });
});

test('a session ended elsewhere: device-only data and queued work are not lost silently', { tag: ['@AUTH-006'] }, async ({ page, context, qa }) => {
  const { user } = await newMember(page, { firstName: 'Sloane', lastName: 'Session' });
  await qa.feature('AUTH-006', 'Revoke this browser\'s session from elsewhere, then sign in again', async () => {
    // Device-only: a Protected Identity record (no SSN, so no lock code needed).
    await openCredentials(page, 'Protected Identity');
    await page.getByRole('button', { name: 'Add record' }).click();
    const d = page.getByRole('dialog', { name: 'Add protected identity' });
    await d.getByPlaceholder('e.g. Liability application 2026').fill('QA device-only record');
    await field(d, 'Legal first name').fill('Sloane');
    await d.getByRole('button', { name: 'Save on this device' }).click();
    await d.waitFor({ state: 'detached', timeout: 10000 });
    // One change queued while offline.
    await openCredentials(page, 'Publications');
    await context.setOffline(true);
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const p = page.getByRole('dialog').last();
    await field(p, 'Short Label').fill('QA queued paper');
    await field(p, 'Full Citation (as it should read on the CV)').fill('Session S. Queued. QA Journal. 2024;1:1.');
    await p.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await sleep(2000);
    const queued = (await pendingOps(page)).length;
    await context.setOffline(false);
    qa.check('one change is queued on this device', queued >= 1, `${queued}`);
    // End the session from "elsewhere" (the mock Clerk revokes it).
    const sid = await page.evaluate(() => window.Clerk?.session?.id);
    await mockApi(`/qa/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    const cid = await clerkId(page);
    await page.reload();
    const warned = qa.report.dialogs.join(' | ');
    await sleep(3000);
    await qa.shot('after revoke');
    const keys = await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.includes(id)), cid);
    qa.check('after the involuntary sign-out, device-only data and the queue are kept (or the user was warned)', keys.some((k) => /pending-ops|vault|protected|data/i.test(k)) || /unsynced|not synced|discard/i.test(warned), `keys: ${keys.join(', ')}; dialogs: ${warned.slice(0, 160)}`);
    await signIn(page, user);
    await landing(page);
    await openCredentials(page, 'Protected Identity');
    qa.check('the Protected Identity record is still on this device after signing in again', /QA device-only record/.test(await page.locator('body').innerText()));
    await sleep(3000);
    qa.check('the queued change reached the cloud after signing in again', !!rows(`select id from public.publications where row_to_json(publications)::text like '%QA queued paper%'`).length);
  }, { soft: true });
});
