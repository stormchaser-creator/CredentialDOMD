// Practice expenses billed to an agency with their receipts, the JSON backup
// exported and restored (a deleted record comes back, a bad file is refused),
// and a session ended from elsewhere (the lab ends it through the mock Clerk,
// as revoking it on Clerk's account page would).
import { readFileSync } from 'node:fs';
import { test, expect } from './support/fixtures.mjs';
import { checkNoUnexpectedRecovery } from './support/recovery-acceptance.mjs';
import {
  LAB_EMAIL_DOMAIN, chooseFiles, clerkId, emailBody, emails, field, goTab, landing, mockApi, newMember, openCredentials, openMore, pendingOps,
  recordButtons, row, rows, signIn, sleep, stamp, syntheticPng, tombstones, waitFor, waitForMemberApp, offlineCopy,
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
    // Visibility alone includes the first transparent frame of Modal's fade.
    // The saved evidence must show the actual settled invoice dialog.
    await expect(d).toHaveCSS('opacity', '1');
    await expect(d).toBeInViewport();
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
  const { user, profile } = await newMember(page, { firstName: 'Sloane', lastName: 'Session' });
  const identityLabel = `QA device-only record ${stamp()}`;
  const paperName = `QA queued paper ${stamp()}`;
  await qa.feature('AUTH-006', 'Revoke this browser\'s session from elsewhere, then sign in again', async () => {
    // Device-only: a Protected Identity record (no SSN, so no lock code needed).
    await openCredentials(page, 'Protected Identity');
    await page.getByRole('button', { name: 'Add record' }).click();
    const d = page.getByRole('dialog', { name: 'Add protected identity' });
    await d.getByPlaceholder('e.g. Liability application 2026').fill(identityLabel);
    await field(d, 'Legal first name').fill('Sloane');
    await d.getByRole('button', { name: 'Save on this device' }).click();
    await d.waitFor({ state: 'detached', timeout: 10000 });
    // One change queued while offline. The connection drops once the account load has settled:
    // the member app opens before the load's profile is read again, and a read cut off by going
    // offline stops the account ("identity could not be verified ... ID-PROFILE-UNKNOWN"; 2026-10-01,
    // full regression pass 2: offline 1.2 s after the app opened, during that read).
    await openCredentials(page, 'Publications');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await context.setOffline(true);
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const p = page.getByRole('dialog').last();
    await field(p, 'Short Label').fill(paperName);
    await field(p, 'Full Citation (as it should read on the CV)').fill('Session S. Queued. QA Journal. 2024;1:1.');
    await p.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await sleep(2000);
    const queued = (await pendingOps(page)).filter(op => op.collectionKey === 'publications' && op.payload?.name === paperName);
    const paperId = queued[0]?.payload?.id;
    const savedPaper = () => typeof paperId === 'string' && /^[0-9a-f-]{36}$/i.test(paperId)
      ? row(`select id, name, citation from public.publications where user_id = '${profile.id}' and id = '${paperId}'`) : null;
    await context.setOffline(false);
    qa.check('this publication is queued on this device', queued.length === 1 && !!paperId, { matches: queued.length, hasId: !!paperId });
    // End the session from "elsewhere" (the mock Clerk revokes it).
    const sid = await page.evaluate(() => window.Clerk?.session?.id);
    await mockApi(`/qa/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    const cid = await clerkId(page);
    await page.reload();
    await page.locator(`[data-testid="qa-signin-as"][data-user-id="${user.id}"]`).waitFor({ timeout: 15000 });
    await qa.shot('after revoke');
    // The file may live only in IndexedDB. Read its content under the exact
    // signed-out account, rather than guessing retention from key names.
    const copy = await offlineCopy(page, cid, { text: true });
    let saved = null;
    try { saved = JSON.parse(copy.text || 'null'); } catch { /* fails the content check */ }
    qa.check('the signed-out account retains its exact Protected Identity record',
      Array.isArray(saved?.identityVault) && saved.identityVault.some(item => item.label === identityLabel && item.legalFirstName === 'Sloane'),
      { store: copy.where, parses: copy.parses, identityCount: saved?.identityVault?.length ?? 0 });
    const remaining = await page.evaluate(id => {
      try { return JSON.parse(localStorage.getItem(`credentialdomd-pending-ops:${id}`) || '[]'); } catch { return null; }
    }, cid);
    // Reconnecting may acknowledge the queued save before the session is
    // revoked. Either outcome must identify this account's exact publication.
    const cloudBeforeSignIn = savedPaper();
    const keptPaper = Array.isArray(remaining) && remaining.some(op => op.collectionKey === 'publications' && op.payload?.id === paperId && op.payload?.name === paperName);
    qa.check('the exact publication is still queued or acknowledged for this account', keptPaper || cloudBeforeSignIn?.name === paperName,
      { queued: keptPaper, acknowledged: cloudBeforeSignIn?.name === paperName });
    await signIn(page, user);
    await landing(page);
    await openCredentials(page, 'Protected Identity');
    qa.check('the Protected Identity record is still on this device after signing in again', (await page.locator('body').innerText()).includes(identityLabel));
    const cloud = await waitFor("this account's exact queued publication", async () => {
      const item = savedPaper();
      return item?.name === paperName && item.citation === 'Session S. Queued. QA Journal. 2024;1:1.' ? item : null;
    }, { timeoutMs: 15000 }).catch(() => null);
    qa.check('the exact queued publication reached this account after signing in again', !!cloud);
    await checkNoUnexpectedRecovery(page, qa, 'restored session with unchanged queued publication');
  }, { soft: true });

  await qa.feature('AUTH-006', 'Identical concurrent inserts during queued replay do not create a false conflict', async () => {
    const name = `QA controlled insert race ${stamp()}`;
    await openCredentials(page, 'Publications');
    await context.setOffline(true);
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const form = page.getByRole('dialog').last();
    await field(form, 'Short Label').fill(name);
    await field(form, 'Full Citation (as it should read on the CV)').fill('Identical I. Concurrent replay. QA Journal. 2026;1:1.');
    await form.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await form.waitFor({ state: 'detached' });
    // Closing the form updates the local view before sbInsert's rejected
    // offline request has persisted its queue entry. Keep the connection off
    // until the exact owned insert is durably queued; never invent its row.
    const queued = await waitFor('the exact publication queued before the controlled race', async () => {
      const entries = (await pendingOps(page)).filter(op => op.collectionKey === 'publications' && op.payload?.name === name);
      return entries.length === 1 ? entries : null;
    }, { timeoutMs: 10000, intervalMs: 100 });
    qa.check('one exact synthetic publication is queued before the controlled race', queued.length === 1);
    const itemId = queued[0]?.payload?.id;
    if (!itemId) { await context.setOffline(false); return; }
    let intercepted = false, outcomes = [], raceError = '';
    const pattern = '**/rest/v1/publications*';
    const race = async route => {
      const request = route.request();
      let body; try { body = request.postDataJSON(); } catch { /* another read */ }
      if (intercepted || request.method() !== 'POST' || body?.id !== itemId || body?.user_id !== profile.id) return route.continue();
      intercepted = true;
      try {
        // Two real identical owned inserts, deliberately overlapping. Return
        // the actual losing response to exercise the app's duplicate branch.
        // No invented success, direct SQL insert, or overwrite of the winner.
        const answers = await Promise.all([route.fetch(), route.fetch()]);
        outcomes = await Promise.all(answers.map(async answer => ({ status: answer.status(), body: await answer.json() })));
        const loser = answers.find(answer => answer.status() === 409);
        await route.fulfill({ response: loser || answers[0] });
      } catch (error) { raceError = String(error); await route.abort('failed'); }
    };
    await context.route(pattern, race);
    try {
      await context.setOffline(false);
      const saved = await waitFor('the controlled publication and an acknowledged queue', async () => {
        const own = rows(`select id, name, citation from public.publications where user_id = '${profile.id}' and id = '${itemId}'`);
        const pending = (await pendingOps(page)).some(op => op.payload?.id === itemId);
        return own.length === 1 && !pending ? own[0] : null;
      }, { timeoutMs: 20000 }).catch(() => null);
      qa.check('both real inserts completed: one created row and one duplicate-key refusal', intercepted && !raceError && outcomes.length === 2 && outcomes.some(o => o.status === 201) && outcomes.some(o => o.status === 409 && o.body?.code === '23505'), { statuses: outcomes.map(o => o.status), raceError });
      qa.check('the exact publication is saved once and its queued operation is acknowledged', saved?.name === name && saved?.citation === 'Identical I. Concurrent replay. QA Journal. 2026;1:1.');
      await checkNoUnexpectedRecovery(page, qa, 'identical concurrent insert replay');
      await qa.shot('identical insert replay without false warning');
      await page.reload();
      await waitForMemberApp(page);
      await openCredentials(page, 'Publications');
      qa.check('the controlled publication is still visible after reload', (await page.locator('body').innerText()).includes(name));
      await checkNoUnexpectedRecovery(page, qa, 'identical insert replay after reload');
    } finally {
      await context.setOffline(false);
      await context.unroute(pattern, race);
    }
  }, { soft: true });
});
