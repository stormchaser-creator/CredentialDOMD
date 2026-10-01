// Sync journeys about what the app writes and what the member takes away:
//   * SYNC-002  every key the app sends to a table is a column of it (one
//               unknown key, or a value its CHECK refuses, rejects the whole
//               row): the share-log rows of the Documents packet, the peer
//               reference list and Vera's packet send, plus every other write
//               of the journey;
//   * SYNC-017  four ~3 MB documents in one session: no quota warning, and the
//               offline copy lists all four;
//   * SYNC-020  the private-notes vault: export, restore from a file, paste,
//               erase, and a file that is not a vault export;
//   * SYNC-021  the member's exit copy: Cancel Subscription > Export saved
//               records, and the full account ZIP it leads to.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from './support/fixtures.mjs';
import { readDeviceJSON } from './support/device-store.mjs';
import {
  base64Marker, chooseFiles, field, goTab, newMember, openCredentials, openMore, pendingOps, row, rows, scriptAi, sleep, syntheticPdf, waitFor,
} from './support/lab.mjs';
import {
  addLicense, bigPdf, openDocuments, pageText, readZip, unknownColumns, watchRestWrites,
} from './support/sync-docs-intake-helpers.mjs';

const tab = (page, name) => page.getByRole('button', { name, exact: true }).first().click();

test('every write fits its table: share-log rows from the Documents packet, the reference list and Vera\'s packet', { tag: ['@SYNC-002'] }, async ({ page, context, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Sam', lastName: 'Schema' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const writes = watchRestWrites(page);
  // The device's share sheet: the lab stands in for it and records what it receives.
  const shareStub = () => page.evaluate(() => {
    window.__qaShared = window.__qaShared || [];
    const def = (k, v) => Object.defineProperty(navigator, k, { value: v, configurable: true, writable: true });
    def('canShare', () => true);
    def('share', async (d) => { window.__qaShared.push({ title: d.title || '', files: (d.files || []).length }); });
  });

  await qa.feature('SYNC-002', 'Records, a file, and three share-log rows; every key sent is a column; nothing refused', async () => {
    const { lic, doc } = await addLicense(page, profile.id, { name: 'QA Schema License', number: 'QA-SCHEMA-202', state: 'ID', expires: '2029-04-30',
      file: { name: 'qa-schema-license.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('QA synthetic Idaho license for the schema check') } });
    qa.check('license and its file saved', !!lic && !!doc);
    // A peer reference, then the list shared from Select (a desktop browser with no share sheet copies it).
    await openCredentials(page, 'Peer References');
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const r = page.getByRole('dialog', { name: 'Add' });
    await field(r, 'Full Name').fill('Jordan Sample, MD');
    await field(r, 'Institution/Hospital').fill('QA Teaching Hospital');
    await field(r, 'Relationship').selectOption({ index: 1 });
    await r.getByRole('button', { name: 'Add' }).click();
    await r.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(1500);
    await page.evaluate(() => { try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch { /* keep */ } });
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByText('Jordan Sample, MD').first().click();
    await page.getByRole('button', { name: /^Send \(1\)$/ }).click();
    await sleep(2500);
    await qa.shot('reference list shared');
    // The Documents packet, through the share sheet.
    await shareStub();
    await openDocuments(page);
    await page.getByRole('button', { name: 'Select to send' }).click();
    await page.getByText('qa-schema-license.pdf').first().click();
    await page.getByRole('button', { name: /^Send 1 document as one packet/ }).click();
    await sleep(2500);
    await qa.shot('documents packet sent');
    // Vera proposes a packet with that file; Approve sends it through the share sheet.
    const question = `QA schema check: send my Idaho license to credentialing ${randomUUID().slice(0, 8)}`;
    await scriptAi('gemini', { json: { reply: 'QA lab: here is a packet with your Idaho license.', actions: [{ kind: 'send_packet', summary: 'Send 1 document to QA credentialing', docIds: [doc?.id], coverNote: 'Please find my Idaho license attached.', missing: [] }] } }, question);
    await openMore(page, 'Vera');
    await page.getByRole('textbox', { name: /Ask Vera anything/ }).fill(question);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const approve = page.getByRole('button', { name: 'Approve' }).first();
    const proposed = await approve.waitFor({ timeout: 60000 }).then(() => true, () => false);
    qa.check('Vera proposes the packet', proposed);
    if (proposed) {
      await shareStub();
      await approve.click();
      await sleep(3000);
    }
    await qa.shot('after the three shares');
    const shared = await page.evaluate(() => window.__qaShared || []);
    qa.check('the share sheet received the packets', shared.length >= 1, JSON.stringify(shared));
    await sleep(3000);
    const bad = unknownColumns(writes);
    const refused = writes.filter((w) => w.status >= 400);
    qa.check(`every key the app sent is a column of its table (${writes.length} writes to ${[...new Set(writes.map((w) => w.table))].join(', ')})`, bad.length === 0,
      bad.map((w) => `${w.method} ${w.table}: ${w.unknown.join(', ')} -> ${w.status} ${w.answer.slice(0, 120)}`).join(' | '));
    qa.check('no write was refused by the database', refused.length === 0, refused.map((w) => `${w.method} ${w.table} ${w.status} ${w.answer.slice(0, 160)}`).join(' | '));
    const log = rows(`select item_name, section, method, sent_at from public.share_log where user_id = '${profile.id}' order by created_at`);
    qa.check('three share_log rows (packet, reference list, Vera packet), each with sent_at and section', log.length === 3 && log.every((l) => l.sent_at && l.section), JSON.stringify(log));
    const queue = await pendingOps(page);
    qa.check('nothing is left queued for retry', queue.length === 0, queue.map((q) => `${q.op} ${q.collectionKey} ${Object.keys(q.payload || {}).join(',')}`).join(' | '));
    const sharedAt = refused.find((w) => w.table === 'share_log' && /shared_at/.test(w.answer));
    if (sharedAt) {
      qa.bug({
        title: 'Vera\'s packet send logs a share-log row the table refuses (sharedAt, no section), retried on every load',
        step: 'Vera proposes send_packet; Approve (share sheet)',
        expected: 'A share_log row (sent_at, section documents, method share)',
        actual: `POST share_log ${sharedAt.status}: ${sharedAt.answer.slice(0, 160)}. AssistantSection.jsx:486 writes { itemName, method, sharedAt, recipient }: shared_at is not a column (share_log has sent_at) and section is NOT NULL, so the insert is refused, queued, and fails again on every load`,
        severity: 'medium',
      });
    }
    const copy = refused.find((w) => w.table === 'share_log' && /method_check|23514|violates check/.test(w.answer));
    if (copy) {
      qa.bug({
        title: 'Sharing the peer-reference list on a browser without a share sheet logs method "copy", which share_log refuses',
        step: 'Credentials > Peer References > Select > pick one > Share (desktop browser, no navigator.share)',
        expected: 'A share_log row with an allowed method (clipboard)',
        actual: `POST share_log ${copy.status}: ${copy.answer.slice(0, 160)}. App.jsx shareManyReferences sets method = "copy"; share_log_method_check allows email, text, clipboard and share, so the row is refused and retried on every load`,
        severity: 'low',
      });
    }
  });
});

test('four ~3 MB documents in one session: no quota warning, and the offline copy lists all four', { tag: ['@SYNC-017'] }, async ({ page, context, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Quincy', lastName: 'Quota' });
  const started = new Date(Date.now() - 2000).toISOString();
  const files = [1, 2, 3, 4].map((i) => ({ name: `qa-large-document-${i}.pdf`, mimeType: 'application/pdf', buffer: bigPdf(3_000_000, `QA synthetic large document number ${i}`) }));

  await qa.feature('SYNC-017', 'Upload four ~3 MB PDFs without reloading; go offline; reload', async () => {
    const mark = qa.report.console.length;
    await openDocuments(page);
    for (const f of files) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.getByRole('button', { name: 'Upload' }).first().click()]);
      await chooser.setFiles([f]);
      await waitFor(`the ${f.name} row`, async () => row(`select id from public.documents where user_id = '${profile.id}' and name = '${f.name}' and storage_path is not null`), { timeoutMs: 90000 }).catch(() => null);
      // Close any review card the scan opened so the next pick starts clean.
      for (const b of await page.getByRole('button', { name: 'Keep as plain document' }).all()) await b.click().catch(() => {});
    }
    const n = row(`select count(*)::int as n from public.documents where user_id = '${profile.id}' and uploaded_at > '${started}'`).n;
    qa.check('four documents rows, each with its file in Storage', n === 4, `${n}`);
    await sleep(3000);
    // The warning the offline copy prints when a store refused it (utils/storage.js saveText),
    // and the one older builds printed.
    const quota = qa.report.console.slice(mark).filter((l) => /offline copy was not updated|localStorage quota exceeded/i.test(l));
    qa.check('no "offline copy was not updated" warning', quota.length === 0, `${quota.length} warning(s)`);
    // Where the app keeps it: IndexedDB, or localStorage when IndexedDB refused (support/device-store.mjs).
    const uid = await page.evaluate(() => window.Clerk.user.id);
    const file = await readDeviceJSON(page, `credentialdomd-data:${uid}`);
    const cached = { docs: (file.value.documents || []).map((x) => ({ name: x.name, bytes: (x.data || '').length })), size: file.size };
    qa.check('the device copy (IndexedDB or localStorage) lists all four', files.every((f) => cached.docs.some((d) => d.name === f.name)), `${cached.docs.map((d) => `${d.name}:${d.bytes}`).join(', ')} (${cached.size} chars)`);
    await context.setOffline(true);
    await page.reload().catch(() => {});
    await page.getByText(/Offline\. Showing this device's copy/).first().waitFor({ timeout: 30000 }).catch(() => {});
    await goTab(page, 'Documents').catch(() => {});
    await sleep(1500);
    const text = await pageText(page);
    await qa.shot('offline documents');
    const listed = files.filter((f) => text.includes(f.name)).map((f) => f.name);
    qa.check('offline, Documents lists all four', listed.length === 4, `${listed.length}: ${listed.join(', ')}`);
    await context.setOffline(false);
    if (quota.length || listed.length < 4) {
      qa.bug({
        title: 'Several large uploads in one session overflow the device cache: the offline copy stops updating (a quota warning only)',
        step: 'Documents > Upload four ~3 MB PDFs one after another, no reload; go offline; reload; Documents',
        expected: 'No quota warning; the offline copy lists all four',
        actual: `${quota.length} "localStorage quota exceeded" warning(s); offline Documents lists ${listed.length} of 4. A document uploaded this session keeps its base64 bytes in the cached blob (saveData drops them only once doc.storagePath is set, and insertItem never sets it on the in-memory record), so ~16 MB of base64 goes to localStorage and every later save fails; saveData only warns.`,
        severity: 'medium',
      });
    }
  });
});

test('the private-notes vault: export, erase, restore from a file, paste, and a file that is not a vault', { tag: ['@SYNC-020'] }, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Vale', lastName: 'Vault' });
  const notes = ['QA private note: Patient Alpha callback', 'QA private note: bed 12 consult'];
  const vaultCount = () => page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem(`credentialdomd-private-vault:${window.Clerk.user.id}`) || '{}')).length; } catch { return -1; } });
  const shownCount = async () => Number((/Private notes \((\d+) on this device\)/.exec(await pageText(page)) || [])[1] ?? NaN);

  await qa.feature('SYNC-020', 'Two work entries with private notes; export, erase, restore, paste; the cloud holds none of it', async () => {
    await goTab(page, 'Practice');
    await tab(page, 'Contracts');
    await page.getByRole('button', { name: 'Add Agreement' }).first().click();
    const d = page.getByRole('dialog', { name: 'Add Agreement' });
    await d.getByPlaceholder('e.g. Riverside Community Hospital').fill('QA Vault Hospital');
    await d.getByPlaceholder('e.g. ANMG').fill('QAVH');
    await d.locator('select').first().selectOption({ label: 'CO, Colorado' });
    await d.getByPlaceholder('250').fill('200');
    await d.getByRole('button', { name: 'Add', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 15000 });
    for (const [i, note] of notes.entries()) {
      await tab(page, 'Work');
      await page.getByRole('button', { name: 'Log past time' }).click();
      const w = page.getByRole('dialog', { name: 'Log past time' });
      await w.getByRole('button', { name: i ? 'Procedure' : 'Consult', exact: true }).click();
      await w.getByRole('button', { name: 'Yesterday' }).click();
      await w.getByPlaceholder('e.g. 60').fill('30');
      await w.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).fill(`QA billing note ${i + 1}`);
      await w.getByPlaceholder('🔒 e.g. patient name / MRN reminder').fill(note);
      await w.getByRole('button', { name: 'Log it' }).click();
      const yes = page.getByRole('button', { name: 'Yes, log it here' });
      if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.click();
      await w.waitFor({ state: 'detached', timeout: 15000 });
    }
    await sleep(2000);
    qa.check('two work entries saved', rows(`select id from public.work_log where user_id = '${profile.id}'`).length === 2);
    qa.check('no private note text reached any work_log row', rows(`select id from public.work_log where user_id = '${profile.id}' and (row_to_json(work_log)::text like '%Patient Alpha%' or row_to_json(work_log)::text like '%bed 12%')`).length === 0);
    await openMore(page, 'Data & Backup');
    qa.check('Data & Backup says "Private notes (2 on this device)"', await shownCount() === 2, `${await shownCount()}`);
    // Export to a file.
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: 'Export to a file' }).click()]);
    const file = await dl.path();
    const exported = JSON.parse(readFileSync(file, 'utf8'));
    qa.check('the export holds both notes, keyed by their work entries', Object.keys(exported).length === 2 && notes.every((n) => Object.values(exported).includes(n)) && Object.keys(exported).every((k) => k.startsWith('workLog:')), JSON.stringify(Object.keys(exported)));
    qa.check('the file is named as a private vault export', /private vault/i.test(dl.suggestedFilename()), dl.suggestedFilename());
    // Erase (confirmed).
    const dialogs = qa.report.dialogs.length;
    await page.getByRole('button', { name: 'Erase from this device' }).click();
    await sleep(1000);
    qa.check('erasing asks first', /Erase all 2 private notes from this device/.test(qa.report.dialogs.slice(dialogs).join(' | ')));
    qa.check('after Erase, no private notes on this device', await vaultCount() === 0 && await shownCount() === 0, `${await vaultCount()} / ${await shownCount()}`);
    qa.check('the work entries themselves stay', rows(`select id from public.work_log where user_id = '${profile.id}'`).length === 2);
    // Restore from the file.
    await chooseFiles(page, page.getByRole('button', { name: 'Restore from a file' }), [{ name: 'vault.json', mimeType: 'application/json', buffer: readFileSync(file) }]);
    await sleep(1500);
    qa.check('Restore from a file brings both back', await vaultCount() === 2 && /restored/i.test(await pageText(page)), `${await vaultCount()}`);
    // Erase again, then Paste it in.
    await page.getByRole('button', { name: 'Erase from this device' }).click();
    await sleep(800);
    await page.getByRole('button', { name: 'Paste it in' }).click();
    await page.getByPlaceholder('Paste the vault text here, then tap Restore').fill(JSON.stringify(exported));
    await page.getByRole('button', { name: 'Restore these notes' }).click();
    await sleep(1000);
    const pasted = await pageText(page);
    // 07211659: both restore paths say how many notes came back ("2 private notes restored to this device.").
    qa.check('Paste it in + Restore these notes brings both back and says how many', await vaultCount() === 2 && /\b2 private notes restored to this device\./.test(pasted), (pasted.match(/[^.]*restored[^.]*\./i) || [''])[0]);
    // A file that is not a vault export (the JSON backup) must not go into the vault.
    const [bk] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: /Export JSON Backup/ }).click()]);
    const backupFile = await bk.path();
    const before = await vaultCount();
    await chooseFiles(page, page.getByRole('button', { name: 'Restore from a file' }), [{ name: 'backup.json', mimeType: 'application/json', buffer: readFileSync(backupFile) }]);
    await sleep(1500);
    const after = await vaultCount();
    const said = await pageText(page);
    await qa.shot('vault after a non-vault file');
    qa.check('a backup file is refused as not a vault export (the vault is unchanged)', after === before && /isn't a private vault export/.test(said), `${before} -> ${after} entries; ${(said.match(/(Private notes restored[^.]*|That file isn't[^.]*)\./) || [''])[0]}`);
    if (after !== before) {
      qa.bug({
        title: 'Private notes: "Restore from a file" takes any JSON (a full backup) into the vault',
        step: 'More > Data & Backup > Private notes > Restore from a file > pick the JSON backup file',
        expected: '"That file isn\'t a private vault export." and the vault unchanged',
        actual: `The vault went from ${before} to ${after} entries and the app said "Private notes restored to this device." importVault (src/utils/privateVault.js) merges any object's top-level keys (settings, licenses, ...) as notes; the count on screen and any export now carry the whole backup`,
        severity: 'low',
      });
    }
  });
});

test('the member\'s exit copy: Export saved records, and the account ZIP holds every section, file and nothing secret', { tag: ['@SYNC-021'] }, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Ezra', lastName: 'Exitcopy' });
  const sentinel = `QAIDENTITY${randomUUID().slice(0, 8).toUpperCase()}`;
  const other = syntheticPdf(`QA synthetic parking permit ${randomUUID()}`);
  const pdf = syntheticPdf(`QA synthetic Nevada license ${randomUUID()}`);

  await qa.feature('SYNC-021', 'Seed Credentials, Practice, a custom category with a file and a device-only identity record; export', async () => {
    await addLicense(page, profile.id, { name: 'QA Exit License', number: 'QA-EXIT-2121', state: 'NV', expires: '2029-02-28', file: { name: 'qa-exit-license.pdf', mimeType: 'application/pdf', buffer: pdf } });
    // A file that fits no section, filed into a new category of the member's own.
    await scriptAi('gemini', { json: { documentType: 'other', confidence: 'high', extracted: { name: 'QA garage permit', issuer: 'QA Mercy Hospital', suggestedCategory: { name: 'QA Parking Permits', icon: '🅿️', fields: [] }, facts: [{ label: 'Level', value: 'P2' }] } } }, base64Marker(other));
    await openDocuments(page);
    await chooseFiles(page, page.getByRole('button', { name: 'Upload' }).first(), [{ name: 'qa-parking-permit.pdf', mimeType: 'application/pdf', buffer: other }]);
    await page.getByRole('button', { name: /Create "QA Parking Permits" and file it|File in QA Parking Permits/ }).click({ timeout: 60000 });
    await sleep(2500);
    const rec = row(`select id from public.custom_records where user_id = '${profile.id}'`);
    qa.check('the custom-category record is saved with its file linked', !!rec && !!row(`select id from public.documents where user_id = '${profile.id}' and linked_to = 'customRecords:${rec?.id}'`));
    // Practice: an agreement.
    await goTab(page, 'Practice');
    await tab(page, 'Contracts');
    await page.getByRole('button', { name: 'Add Agreement' }).first().click();
    const d = page.getByRole('dialog', { name: 'Add Agreement' });
    await d.getByPlaceholder('e.g. Riverside Community Hospital').fill('QA Exit Hospital');
    await d.getByPlaceholder('e.g. ANMG').fill('QAEX');
    await d.locator('select').first().selectOption({ label: 'NV, Nevada' }).catch(() => {});
    await d.getByPlaceholder('250').fill('210');
    await d.getByRole('button', { name: 'Add', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 15000 });
    // Device only: a Protected Identity record.
    await openCredentials(page, 'Protected Identity');
    await page.getByRole('button', { name: 'Add record' }).click();
    const pi = page.getByRole('dialog', { name: 'Add protected identity' });
    await pi.getByPlaceholder('e.g. Liability application 2026').fill(`QA exit identity ${sentinel}`);
    await field(pi, 'Legal first name').fill(sentinel);
    await pi.getByRole('button', { name: 'Save on this device' }).click();
    await pi.waitFor({ state: 'detached', timeout: 10000 });
    await sleep(2500);
  });

  await qa.feature('SYNC-021', 'Cancel Subscription > Export saved records; the ZIP it leads to', async () => {
    await openMore(page, 'Cancel Subscription');
    const direct = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.getByRole('button', { name: 'Export saved records' }).click();
    const zipNow = await direct;
    const onBackup = await page.getByRole('heading', { name: 'Data & Backup' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Export saved records opens Data & Backup (limited launch: the export options) or downloads the ZIP', !!zipNow || onBackup, zipNow ? zipNow.suggestedFilename() : 'Data & Backup');
    let zipPath = zipNow ? await zipNow.path() : null;
    if (!zipPath) {
      await page.getByRole('button', { name: 'Build a backup now' }).click();
      const ready = await page.getByText(/Backup ready:/).first().waitFor({ timeout: 120000 }).then(() => true, () => false);
      qa.check('"Build a backup now" builds the account ZIP', ready, ((await page.getByText(/Backup ready:[^.]*/).first().innerText().catch(() => '')) || (await pageText(page)).match(/(did not finish|could not)[^.]*/i)?.[0] || '').slice(0, 160));
      if (ready) {
        const onPage = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
        const onPopup = page.context().waitForEvent('page', { timeout: 60000 }).then((p) => p.waitForEvent('download', { timeout: 60000 })).catch(() => null);
        await page.getByRole('button', { name: 'Download', exact: true }).first().click();
        const dl = await Promise.race([onPage, onPopup].map((p) => p.then((x) => x || new Promise(() => {})))).catch(() => null);
        zipPath = dl ? await dl.path() : null;
      }
    }
    qa.check('a ZIP file is downloaded', !!zipPath);
    if (!zipPath) return;
    const zip = await readZip(zipPath);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    await qa.shot('export page');
    const all = (await Promise.all(names.filter((n) => /\.(json|csv|txt|html?)$/i.test(n)).map((n) => zip.files[n].async('string')))).join('\n');
    qa.check('the license\'s PDF is in the ZIP', names.some((n) => /qa-exit-license/i.test(n)), names.slice(0, 30).join(' | '));
    qa.check('the custom category\'s file is in the ZIP', names.some((n) => /qa-parking-permit/i.test(n)), names.filter((n) => /pdf$/i.test(n)).join(' | '));
    qa.check('Credential records are in it (the license number)', all.includes('QA-EXIT-2121'));
    qa.check('Practice records are in it (the agreement)', all.includes('QA Exit Hospital'));
    qa.check('custom-category records are in it', all.includes('QA garage permit') || all.includes('QA Parking Permits'));
    qa.check('no Protected Identity plaintext in any text file of the ZIP', !all.includes(sentinel));
    qa.check('no device secret (lockCode, AI keys, feed link) in it', !/lockCode|anthropicApiKey|"apiKey"\s*:\s*"[^"]+"|callsyncFeedUrl/.test(all));
    // Per-section counts against the database, where the ZIP's backup JSON carries them.
    const jsonName = names.find((n) => /\.json$/i.test(n) && /backup|records|account/i.test(n)) || names.find((n) => /\.json$/i.test(n));
    if (jsonName) {
      let data = null;
      try { data = JSON.parse(await zip.files[jsonName].async('string')); } catch { data = null; }
      const sections = { licenses: 'licenses', documents: 'documents', locumContracts: 'locum_contracts', customRecords: 'custom_records', customCategories: 'custom_categories' };
      const mismatches = [];
      for (const [key, table] of Object.entries(sections)) {
        const db = row(`select count(*)::int as n from public.${table} where user_id = '${profile.id}'`).n;
        const inZip = Array.isArray(data?.[key]) ? data[key].length : Array.isArray(data?.records?.[key]) ? data.records[key].length : Array.isArray(data?.[table]) ? data[table].length : null;
        if (inZip !== null && inZip !== db) mismatches.push(`${key}: zip ${inZip} vs db ${db}`);
      }
      qa.check(`per-section counts in ${jsonName} match the database`, mismatches.length === 0, mismatches.join(', ') || 'all match');
    }
  });
});
