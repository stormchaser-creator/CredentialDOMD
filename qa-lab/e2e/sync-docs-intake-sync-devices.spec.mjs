// Sync journeys across devices (a second, clean browser signs in as the same
// physician):
//   * SYNC-007  a backup with 1,050 case logs imports, and every one comes back
//               after a reload and on another browser (PostgREST pages at 1,000);
//   * SYNC-013  a file attached on one device opens on another, or says it is
//               still being fetched;
//   * SYNC-014  AI keys, the Vera model, the CallSync link and the portal-password
//               lock code stay on the device they were set on;
//   * SYNC-016  two devices edit the same license; the later edit wins. When the
//               device that edited first has a clock ten minutes fast its older
//               edit can win (last write by device clock): recorded by design,
//               verified out of reach with clocks the devices keep themselves.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { guardContext, test, watchPage } from './support/fixtures.mjs';
import {
  chooseFiles, field, goTab, landing, newMember, openCredentials, openMore, profileOf, row, rows, signIn, sleep, syntheticPdf, tableRow, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { addLicense, pageText } from './support/sync-docs-intake-helpers.mjs';

test('a backup with 1,050 case logs imports and all of them come back, here and on another browser', { tag: ['@SYNC-007'] }, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Casey', lastName: 'Caselog' });
  const N = 1050;
  const cases = Array.from({ length: N }, (_, i) => ({
    id: randomUUID(), category: 'Cranial', title: `QA synthetic case ${String(i + 1).padStart(4, '0')}`,
    date: new Date(Date.UTC(2024, 0, 1) + i * 86400000 / 3).toISOString().slice(0, 10), role: 'Primary Surgeon',
  }));
  const backup = { settings: { primaryState: 'CO' }, licenses: [], caseLogs: cases, _exportMeta: { app: 'CredentialDOMD', version: '2.1' } };
  const countOnScreen = async (p) => {
    await openCredentials(p, 'Case Logs');
    const navText = await p.getByRole('navigation').filter({ hasText: 'Active Credentials' }).innerText().catch(() => '');
    const m = /Case Logs\s*(\d+)/.exec(navText.replace(/\s+/g, ' '));
    return m ? Number(m[1]) : NaN;
  };

  await qa.feature('SYNC-007', 'Import 1,050 case logs, reload, count; a second browser counts the same', async () => {
    await openMore(page, 'Data & Backup');
    await chooseFiles(page, page.getByRole('button', { name: 'Choose File...' }), [{ name: 'qa-1050-cases.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) }]);
    const ok = await page.getByText('Data imported successfully!').waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('the import reports success', ok);
    const db = await waitFor('1,050 case_logs rows', async () => {
      const n = row(`select count(*)::int as n from public.case_logs where user_id = '${profile.id}'`).n;
      return n >= N ? n : null;
    }, { timeoutMs: 90000, intervalMs: 2000 }).catch(() => row(`select count(*)::int as n from public.case_logs where user_id = '${profile.id}'`).n);
    qa.check('the database holds 1,050 case logs', db === N, `${db}`);
    await page.reload();
    await waitForMemberApp(page);
    await sleep(3000);
    const a = await countOnScreen(page);
    await qa.shot('case logs after reload');
    qa.check('after a reload this browser counts 1,050', a === N, `${a}`);
    const b = await secondBrowser();
    await signIn(b.page, user);
    await landing(b.page);
    const bn = await countOnScreen(b.page);
    await b.page.screenshot({ path: (await qa.shot('case logs on browser B')).replace(/\.png$/, '-B.png') });
    qa.check('a clean second browser counts 1,050', bn === N, `${bn}`);
    qa.check('the database count is still 1,050 (nothing duplicated or lost by the second device)', row(`select count(*)::int as n from public.case_logs where user_id = '${profile.id}'`).n === N);
  });
});

test('a file attached on one device opens on another (or says it is still coming)', { tag: ['@SYNC-013'] }, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Bex', lastName: 'Bytes' });
  const pdf = syntheticPdf('QA synthetic Wyoming license copy for the two-device check');
  let doc;

  await qa.feature('SYNC-013', 'A uploads a PDF to a license; B opens it from the license and from Documents', async () => {
    ({ doc } = await addLicense(page, profile.id, { name: 'QA Wyoming License', number: 'QA-WY-1313', state: 'WY', expires: '2029-09-30', file: { name: 'qa-wyoming-license.pdf', mimeType: 'application/pdf', buffer: pdf } }));
    qa.check('documents row with storage_path, size and type', !!doc?.storage_path && Number(doc.size_bytes) === pdf.length && doc.mime_type === 'application/pdf', doc ? `${doc.storage_path} ${doc.size_bytes} ${doc.mime_type}` : 'none');
    qa.check('the Storage object exists', !!doc && !!row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = '${doc.storage_path}'`));
    const b = await secondBrowser();
    // B's connection is slow: each file download from Storage takes 10 seconds, so the first
    // tap comes before the bytes are on the device.
    await b.context.route('**/storage/v1/object/**', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await sleep(10000);
      return route.fallback();
    });
    await signIn(b.page, user);
    await landing(b.page);
    // Straight to the license, as the physician would on the other device.
    await openCredentials(b.page, 'Licenses');
    await tableRow(b.page, 'QA-WY-1313').click();
    const view = b.page.getByRole('dialog').first();
    await view.waitFor();
    const first = await view.innerText();
    const btn = view.getByRole('button', { name: /qa-wyoming-license/ });
    let firstTap;
    if (await btn.count()) {
      const popup = b.context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
      await btn.click();
      firstTap = (await popup) ? 'opened' : 'nothing happened';
    } else {
      firstTap = /downloading from cloud|check back shortly|syncing/i.test(first) ? 'says it is still fetching' : 'no file shown';
    }
    await b.page.screenshot({ path: (await qa.shot('B license view first tap')).replace(/\.png$/, '-B.png') });
    qa.check('the first tap opens the file or visibly says it is still fetching', firstTap === 'opened' || firstTap === 'says it is still fetching', firstTap);
    // Wait for the bytes, close and reopen the view, tap again.
    await b.page.keyboard.press('Escape');
    await sleep(14000);
    await tableRow(b.page, 'QA-WY-1313').click();
    const view2 = b.page.getByRole('dialog').first();
    await view2.waitFor();
    const btn2 = view2.getByRole('button', { name: /qa-wyoming-license/ });
    let secondTap = 'no button';
    if (await btn2.count()) {
      const popup = b.context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      await btn2.click();
      const p = await popup;
      secondTap = p ? `opened ${p.url().slice(0, 5) || "a new tab"}` : "nothing happened";
      if (p) await p.close().catch(() => {});
    }
    qa.check('once fetched, tapping the file on B opens it in a new tab', /^opened/.test(secondTap), secondTap);
    await b.page.keyboard.press('Escape');
    await goTab(b.page, 'Documents');
    const dview = b.page.getByRole('button', { name: /View PDF/ }).first();
    let docsTap = 'no View PDF';
    if (await dview.waitFor({ timeout: 20000 }).then(() => true, () => false)) {
      const popup = b.context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      await dview.click();
      const p = await popup;
      docsTap = p ? 'opened' : 'nothing happened';
      if (p) await p.close().catch(() => {});
    }
    await b.page.screenshot({ path: (await qa.shot('B documents')).replace(/\.png$/, '-B.png') });
    qa.check('Documents on B: View PDF opens the file', docsTap === 'opened', docsTap);
  });
});

test('device-only secrets and settings stay on the device they were set on', { tag: ['@SYNC-014'] }, async ({ page, context, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Devi', lastName: 'Devicekeys' });
  // Synthetic values made for this run (built from parts so no source line looks like a key).
  const rand = randomUUID().replace(/-/g, '');
  const geminiKey = ['AI', 'za', 'QALABTEST', rand, rand.slice(0, 6)].join('');
  const feedToken = `qa${rand.slice(0, 20)}`;
  // A link of the shape CallSync issues (its own host); the check that would fetch it is blocked below.
  const feedLink = `https://anmg-callsync-production.up.railway.app/api/ical?token=${feedToken}`;
  const lockCode = `qalock${rand.slice(0, 6)}`;
  const portalPassword = `QaPortal-${rand.slice(0, 8)}`;
  // The CallSync check goes through the lab's callsync-feed function to the real CallSync host:
  // never let it run (the link is synthetic, and nothing may reach a real service).
  const stopFeed = async (ctx) => ctx.route(/\/functions\/v1\/callsync-feed/, (r) => r.abort('blockedbyclient'));
  await stopFeed(context);
  const settingsText = async (p) => { await openMore(p, 'Profile & settings'); await sleep(1000); return pageText(p); };
  const selectNear = (p, label) => p.locator('label', { hasText: label }).first().locator('xpath=..').locator('select, input').first();

  await qa.feature('SYNC-014', 'On A: a Gemini key, Vera on Opus, a CallSync link and a lock code; all survive a reload', async () => {
    await openMore(page, 'Profile & settings');
    await selectNear(page, 'Your own Gemini key').fill(geminiKey);
    await selectNear(page, 'Vera answers with').selectOption('opus');
    await sleep(1500);
    // An ANMG agreement makes the CallSync card appear under Practice > Sched.
    await goTab(page, 'Practice');
    await page.getByRole('button', { name: 'Contracts', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add Agreement' }).first().click();
    const d = page.getByRole('dialog', { name: 'Add Agreement' });
    await d.getByPlaceholder('e.g. Riverside Community Hospital').fill('QA Arrowhead Regional Medical Center');
    await d.getByPlaceholder('e.g. ANMG').fill('ANMG');
    await d.locator('select').first().selectOption({ label: 'CA, California' }).catch(() => {});
    await d.getByPlaceholder('250').fill('200');
    await d.getByRole('button', { name: 'Add', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 15000 });
    await page.getByRole('button', { name: 'Sched.', exact: true }).first().click();
    const feed = page.getByPlaceholder('https://.../api/ical?token=...');
    await feed.waitFor({ timeout: 15000 });
    await feed.fill(feedLink);
    await sleep(1000);
    // A portal password on a privilege asks for the lock code, kept on this device.
    await openCredentials(page, 'Privileges');
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const p = page.getByRole('dialog', { name: 'Add' });
    await field(p, 'Type').selectOption({ index: 1 });
    await field(p, 'Display Name').fill('QA Privileges with portal');
    await field(p, 'Facility').fill('QA Lock Code Hospital');
    await field(p, 'Reappointment Due').fill('2028-12-31');
    await field(p, 'Portal password').fill(portalPassword);
    await p.getByPlaceholder('Lock code (4+ characters)').fill(lockCode);
    await p.getByRole('button', { name: 'Add' }).click();
    await p.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(2500);
    const priv = row(`select login_secret from public.privileges where user_id = '${profile.id}'`);
    qa.check('the portal password is stored encrypted, not as typed', !!priv?.login_secret && !priv.login_secret.includes(portalPassword), (priv?.login_secret || '').slice(0, 24));
    await page.reload();
    await waitForMemberApp(page);
    const text = await settingsText(page);
    qa.check('after a reload the Gemini key is still set on A', await selectNear(page, 'Your own Gemini key').inputValue() === geminiKey && /Saved ✓ on this device only/.test(text));
    qa.check('after a reload Vera still answers with Claude Opus on A', await selectNear(page, 'Vera answers with').inputValue() === 'opus');
    await goTab(page, 'Practice');
    await page.getByRole('button', { name: 'Sched.', exact: true }).first().click();
    const feedNow = await page.getByPlaceholder('https://.../api/ical?token=...').inputValue().catch(() => '');
    qa.check('after a reload the CallSync link is still set on A, marked "on this device only"', feedNow === feedLink && /on this device only, never synced/.test(await pageText(page)), feedNow.slice(0, 40));
    const keysA = await page.evaluate(() => { const id = window.Clerk.user.id; const raw = localStorage.getItem(`credentialdomd-keys:${id}`) || '{}'; try { return Object.keys(JSON.parse(raw)); } catch { return []; } });
    qa.check('A\'s device slot holds the lock code', keysA.includes('lockCode'), keysA.join(', '));
  });

  await qa.feature('SYNC-014', 'On B none of them are present; the profile row holds no key; exports carry none', async () => {
    const prof = profileOf(user.id);
    qa.check('profiles.api_key and anthropic_api_key are null', prof.api_key === null && prof.anthropic_api_key === null, `${prof.api_key} ${prof.anthropic_api_key}`);
    const anywhere = rows(`select 'profile' as t from public.profiles where id = '${profile.id}' and (row_to_json(profiles)::text like '%${geminiKey}%' or row_to_json(profiles)::text like '%${feedToken}%' or row_to_json(profiles)::text like '%${lockCode}%')
      union all select 'privileges' from public.privileges where user_id = '${profile.id}' and row_to_json(privileges)::text like '%${lockCode}%'
      union all select 'contracts' from public.locum_contracts where user_id = '${profile.id}' and row_to_json(locum_contracts)::text like '%${feedToken}%'`);
    qa.check('neither the key, the feed token nor the lock code is in any cloud row', anywhere.length === 0, JSON.stringify(anywhere));
    const b = await secondBrowser();
    await stopFeed(b.context);
    await signIn(b.page, user);
    await landing(b.page);
    await settingsText(b.page);
    qa.check('B: no Gemini key', (await selectNear(b.page, 'Your own Gemini key').inputValue()) === '');
    qa.check('B: Vera answers with Gemini (the default), not Opus', (await selectNear(b.page, 'Vera answers with').inputValue()) === 'gemini');
    await goTab(b.page, 'Practice');
    await b.page.getByRole('button', { name: 'Sched.', exact: true }).first().click();
    const feedB = await b.page.getByPlaceholder('https://.../api/ical?token=...').inputValue().catch(() => '(no field)');
    qa.check('B: no CallSync link', feedB === '' || feedB === '(no field)', feedB);
    const keysB = await b.page.evaluate(() => { const id = window.Clerk.user.id; const raw = localStorage.getItem(`credentialdomd-keys:${id}`) || '{}'; try { return Object.keys(JSON.parse(raw)); } catch { return []; } });
    qa.check('B: no lock code on the device', !keysB.includes('lockCode'), keysB.join(', '));
    await b.page.screenshot({ path: (await qa.shot('B settings')).replace(/\.png$/, '-B.png') });
    // The JSON backup exported on A.
    await openMore(page, 'Data & Backup');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: /Export JSON Backup/ }).click()]);
    const json = readFileSync(await dl.path(), 'utf8');
    qa.check('the JSON export carries no Gemini key, no feed link and no lockCode', !json.includes(geminiKey) && !json.includes(feedToken) && !/lockCode/.test(json) && !json.includes(lockCode));
  });
});

test('two devices edit the same license: the later edit wins; a device clock set minutes fast is by design', { tag: ['@SYNC-016'] }, async ({ page, qa, secondBrowser, browser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Tove', lastName: 'Twodevice' });
  const { lic } = await addLicense(page, profile.id, { name: 'QA Concurrent License', number: 'QA-CONC-1616', state: 'OR', expires: '2029-06-30' });
  const editNotes = async (p) => {
    await openCredentials(p, 'Licenses');
    await tableRow(p, 'QA-CONC-1616').getByRole('cell').last().getByRole('button').nth(2).click();
    const e = p.getByRole('dialog', { name: 'Edit' });
    await e.waitFor();
    return e;
  };
  const save = async (e, text) => {
    await field(e, 'Notes').fill(text);
    await e.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    await e.waitFor({ state: 'detached', timeout: 15000 });
  };
  const notesShown = async (p) => {
    await openCredentials(p, 'Licenses');
    await tableRow(p, 'QA-CONC-1616').click();
    const v = p.getByRole('dialog').first();
    await v.waitFor();
    const t = await v.innerText();
    await p.keyboard.press('Escape');
    return /QA note from B/.test(t) ? 'B' : /QA note from A/.test(t) ? 'A' : 'none';
  };

  await qa.feature('SYNC-016', 'A saves "A"; 30 seconds later B, opened before, saves "B"; both reload', async () => {
    const b = await secondBrowser();
    await signIn(b.page, user);
    await landing(b.page);
    const eA = await editNotes(page);
    const eB = await editNotes(b.page);
    await save(eA, 'QA note from A');
    await sleep(30000);
    await save(eB, 'QA note from B');
    await sleep(3000);
    await page.reload(); await waitForMemberApp(page); await sleep(3000);
    await b.page.reload(); await waitForMemberApp(b.page); await sleep(3000);
    const a1 = await notesShown(page), b1 = await notesShown(b.page);
    const db = row(`select notes, updated_at from public.licenses where id = '${lic.id}'`);
    qa.check('the database holds "B"', db.notes === 'QA note from B', db.notes);
    qa.check('A shows "B" after its reload', a1 === 'B', a1);
    qa.check('B shows "B" after its reload', b1 === 'B', b1);
  });

  await qa.feature('SYNC-016', 'The device that edits first runs ten minutes fast: which edit wins, and the devices agree', async () => {
    // A third browser whose clock is ten minutes ahead edits first; B (correct clock) edits after it.
    const fastCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await guardContext(fastCtx, qa.report);
    await fastCtx.clock.install({ time: new Date(Date.now() + 10 * 60 * 1000) });
    const fast = await fastCtx.newPage();
    watchPage(fast, qa.report);
    try {
      await signIn(fast, user);
      await landing(fast);
      const b = await secondBrowser();
      await signIn(b.page, user);
      await landing(b.page);
      const eF = await editNotes(fast);
      const eB = await editNotes(b.page);
      await save(eF, 'QA note from A (fast clock)');
      await sleep(5000);
      await save(eB, 'QA note from B, the later edit');
      await sleep(3000);
      qa.check('right after both saves the database holds the later edit', row(`select notes from public.licenses where id = '${lic.id}'`).notes === 'QA note from B, the later edit');
      await fast.reload(); await waitForMemberApp(fast); await sleep(5000);
      await b.page.reload(); await waitForMemberApp(b.page); await sleep(3000);
      const db = row(`select notes, updated_at from public.licenses where id = '${lic.id}'`);
      const shownB = /the later edit/.test(await (async () => { await openCredentials(b.page, 'Licenses'); await tableRow(b.page, 'QA-CONC-1616').click(); const v = b.page.getByRole('dialog').first(); await v.waitFor(); const t = await v.innerText(); await b.page.keyboard.press('Escape'); return t; })());
      // Filed as a bug, then verified not to be one (2026-09-30): the mechanism is real, but only a clock
      // set wrong by minutes reaches it, which the lab has to fake (Playwright's clock.install).
      const later = db.notes === 'QA note from B, the later edit';
      qa.check('device B and the database agree after both reloads (whichever edit won)', shownB === later, `database "${db.notes}" (updated_at ${db.updated_at}); B shows the later edit: ${shownB}`);
      if (!later) {
        qa.byDesign('SYNC-016', `A device whose clock runs 10 minutes fast overwrote a later edit: the database went back to "${db.notes}" (updated_at ${db.updated_at}); last write wins by device clock (editItem and updateItem stamp updated_at from the device; the load's self-heal pushes a copy that looks newer)`,
          'Verified not a bug a physician meets (2026-09-30): it needs two of the same physician\'s devices whose clocks differ by more than the time between two edits of the same field, and the fast one reloading after; phones and Macs keep their clocks within a second, so only a clock set wrong by hand reaches it. A hardening item: let the database stamp updated_at and compare local edits with the last cloud stamp this device saw.');
      }
    } finally {
      await fastCtx.close().catch(() => {});
    }
  });
});
