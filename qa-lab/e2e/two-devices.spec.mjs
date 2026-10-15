// Two-device journeys: a delete made on one browser stays deleted on another
// that held a stale copy while offline (no zombie re-upload), and Delete All
// My Data on one browser wipes the account (which stays open and empty, the
// owner's decision), after which the other browser drops its stale cache
// instead of re-uploading it, and the account's own sign-in address routes
// mail to docs@ again once a sign-in has reopened it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from './support/fixtures.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import {
  LAB_EMAIL_DOMAIN, field, landing, lit, mockApi, newMember, openCredentials, openMore, profileOf, recordButtons, row, rows, signIn, sleep, stamp,
  syntheticPdf, tombstones, waitFor, waitForMemberApp,
} from './support/lab.mjs';

async function addPublication(page, label, citation) {
  await openCredentials(page, 'Publications');
  await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
  const dlg = page.getByRole('dialog').last();
  await field(dlg, 'Short Label').fill(label);
  await field(dlg, 'Full Citation (as it should read on the CV)').fill(citation);
  await field(dlg, 'Year').fill('2024');
  await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
  await dlg.waitFor({ state: 'detached', timeout: 15000 });
}

test('a delete on device A stays deleted on device B that was offline with a stale copy', { tag: ['@SYNC-011'] }, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Avery', lastName: 'Devices' });
  await addPublication(page, 'QA zombie check paper', 'Devices A. A synthetic zombie study. QA Journal. 2024;1:1.');
  await sleep(2500);
  const pub = row(`select id from public.publications where user_id = '${profile.id}'`);

  await qa.feature('SYNC-011', 'Delete on A while B is offline; B reconnects and reloads', async () => {
    const b = await secondBrowser();
    await signIn(b.page, user);
    await landing(b.page);
    await openCredentials(b.page, 'Publications');
    qa.check('B shows the publication', /QA zombie check paper/.test(await b.page.locator('body').innerText()));
    await b.context.setOffline(true);
    await openCredentials(page, 'Publications');
    await recordButtons(page, 'QA zombie check paper').remove.click();
    await sleep(2500);
    qa.check('A deleted it: row gone and tombstoned', !row(`select id from public.publications where id = '${pub.id}'`) && tombstones(profile.id).some((t) => t.item_id === pub.id));
    await b.context.setOffline(false);
    await b.page.reload();
    await waitForMemberApp(b.page);
    await sleep(4000);
    await openCredentials(b.page, 'Publications');
    await qa.shot('device B after reconnect', b.page);
    qa.check('B no longer shows it', !/QA zombie check paper/.test(await b.page.locator('body').innerText()));
    await sleep(2000);
    qa.check('B did not re-upload it (no zombie row)', !row(`select id from public.publications where id = '${pub.id}'`));
    const zombies = rows(`select t.id from public.publications t join public.deleted_items d on d.item_id = t.id where t.user_id = '${profile.id}'`);
    qa.check('no row whose id is also tombstoned', zombies.length === 0, zombies);
  });
});

test('Delete All My Data wipes the account; the other device drops its stale cache', { tag: ['@SETTINGS-005', '@SYNC-012', '@INTAKE-002'] }, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(9 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Wren', lastName: 'Wipe' });
  // The sign-in address, and the claim that routes it to this account before the wipe
  // (the user.created webhook made it; read here, checked in the last stretches).
  const signInAddress = user.email.toLowerCase();
  const claimOf = () => row(`select profile_id, proof, terminal_at from public.mailbox_claims where address = ${lit(signInAddress)}`);
  const routedBefore = await waitFor('the sign-in address claimed', async () => { const c = claimOf(); return c?.profile_id === profile.id ? c : null; }, { timeoutMs: 30000 }).catch(() => claimOf());
  await addPublication(page, 'QA wipe paper', 'Wipe W. A synthetic study to delete. QA Journal. 2024;2:3.');
  await sleep(2500);
  const b = await secondBrowser();
  await signIn(b.page, user);
  await landing(b.page);
  await openCredentials(b.page, 'Publications');
  qa.check('B has the record in its cache', /QA wipe paper/.test(await b.page.locator('body').innerText()));

  await qa.feature('SETTINGS-005', 'Delete All My Data (typed DELETE)', async () => {
    await openMore(page, 'Data Rights');
    await page.getByRole('button', { name: 'Delete All My Data' }).click();
    const confirm = page.getByRole('button', { name: 'Confirm Delete' });
    await page.getByPlaceholder('Type DELETE').fill('delete');
    qa.check('"Confirm Delete" stays disabled until DELETE is typed exactly', await confirm.isDisabled());
    await page.getByPlaceholder('Type DELETE').fill('DELETE');
    await confirm.click();
    const out = await waitFor('the account deletion', async () => row(`select mode, counts from public.account_deletions where profile_id = '${profile.id}' and mode = 'delete'`), { timeoutMs: 60000 }).catch(() => null);
    await sleep(3000);
    await qa.shot('after delete all');
    qa.check('account_deletions records it', !!out, out ? JSON.stringify(out).slice(0, 160) : 'none');
    qa.check('the publication row is gone', rows(`select id from public.publications where user_id = '${profile.id}'`).length === 0);
    const objects = row(`select count(*)::int as n from storage.objects where bucket_id = 'documents' and name like '${user.id}/%'`);
    qa.check('no storage objects left for the account', objects.n === 0, `${objects.n}`);
    // Owner decision (a2656eb8, 54331c56; migration 20260930020000): the account stays open and
    // empty. The deleting device records the stamp and reloads, and initialize_clerk_profile
    // reopens the account: deleted_at cleared, the stamp kept in data_deleted_at, the two opt-outs
    // the wipe switched off back to a new profile's defaults, the synced columns left empty.
    const p = await waitFor('the account reopened', async () => { const x = profileOf(user.id); return x && !x.deleted_at && x.data_deleted_at ? x : null; }, { timeoutMs: 60000 }).catch(() => profileOf(user.id));
    const shape = JSON.stringify({ deleted_at: p?.deleted_at, data_deleted_at: p?.data_deleted_at, backup_monthly: p?.backup_monthly, ack_requests: p?.ack_requests, name: p?.name, email: p?.email });
    qa.check('the deletion is stamped (profiles.data_deleted_at) and the account reopened (deleted_at cleared)', !!p?.data_deleted_at && !p.deleted_at, shape);
    qa.check('the reopened profile is empty, with a new profile\'s opt-outs (backup_monthly and ack_requests on)', p?.backup_monthly === true && p.ack_requests === true && !p.name && !p.email, shape);
    qa.check('account_deletions records the reopen', !!row(`select 1 as x from public.account_deletions where profile_id = '${profile.id}' and mode = 'reopen'`));
    await waitForMemberApp(page, 60000).catch(() => {});
    let text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const signedOut = (await page.getByTestId('qa-signin').count()) > 0;
    const shot = await qa.shot('after delete all, same account');
    qa.check('the app stays signed in and opens the emptied account (no sign-out: the account stays open)', !signedOut && /Credentials/.test(text) && !/could not be verified/.test(text), signedOut ? 'sign-in page' : text.slice(0, 200));
    await openCredentials(page, 'Publications').catch(() => {});
    qa.check('the deleted record is not on this device any more', !/QA wipe paper/.test(await page.locator('body').innerText()));
    // The next sign-in, on a browser that never held the account, opens the same empty account.
    const c = await secondBrowser();
    await signIn(c.page, user);
    const where = await landing(c.page);
    if (where === 'member') await waitForMemberApp(c.page).catch(() => {});
    text = (await c.page.locator('body').innerText()).replace(/\s+/g, ' ');
    const usable = where === 'member' && /Credentials/.test(text) && !/could not be verified/.test(text);
    if (usable) await openCredentials(c.page, 'Publications').catch(() => {});
    qa.check('the next sign-in opens the empty account', usable && !/QA wipe paper/.test(await c.page.locator('body').innerText()), `${where}: ${text.slice(0, 200)}`);
    await c.context.close();
    if (!usable) {
      const sub = row(`select status, membership_active from public.billing_subscriptions where profile_id = '${profile.id}'`);
      qa.bug({
        title: 'After "Delete All My Data" the next sign-in does not open the emptied account',
        step: 'More > Data Rights > Delete All My Data > type DELETE > Confirm Delete; then sign in again on another browser',
        expected: 'The sign-in account still opens with an empty file (owner decision: the account stays open and empty)',
        actual: `The next sign-in lands on "${where}": "${text.slice(0, 160)}". billing_subscriptions ${sub?.status} (membership_active ${sub?.membership_active}); profile ${shape}.`,
        severity: 'high', screenshot: shot,
      });
    }
  });

  await qa.feature('SYNC-012', 'The other device drops its stale copy and re-uploads nothing', async () => {
    await b.page.reload();
    const where = await landing(b.page);
    await sleep(4000);
    if (where === 'member') await openCredentials(b.page, 'Publications');
    await qa.shot('device B after wipe', b.page);
    qa.check('B no longer shows the deleted record', !/QA wipe paper/.test(await b.page.locator('body').innerText()), `B landed on: ${where}`);
    await sleep(2000);
    qa.check('B re-uploaded nothing', rows(`select id from public.publications where user_id = '${profile.id}'`).length === 0);
  });

  // The wipe releases every address the account routed (close_account_for_data_deletion). The
  // sign-in that reopens the account claims its own verified primary back (migration
  // 20260930051700, fix/reopen-primary-mail), so docs@ intake and email replies to a support
  // ticket route on it again without a Clerk user.updated (the webhook is off in production).
  // Three sign-ins have run by now (the deleting tab's reload, the new browser, B's reload):
  // one recorded answer for the deletion.
  // A branch that carries the fix but a lab database that lacks it (a --fresh rebuild applies
  // only DEPLOY-PLAN.md's migrations; this one was applied by hand, README "A fix branch's
  // migration") is the lab's gap, not the product's. A branch without the file runs the checks.
  const RESTORE = '20260930051700_reopen_restores_primary_mailbox';
  const labLacksRestore = existsSync(path.join(REPO_ROOT, 'supabase', 'migrations', `${RESTORE}.sql`))
    && !row(`select to_regprocedure('public.restore_reopened_mailbox(uuid,text,text,bigint,timestamptz)') is not null as x`)?.x;
  if (labLacksRestore) {
    for (const id of ['SETTINGS-005', 'INTAKE-002']) qa.blocked(id, `the branch has migration ${RESTORE} but the lab database does not: apply it (README "A fix branch's migration") to check that the reopened account's sign-in address routes mail again`);
    return;
  }

  await qa.feature('SETTINGS-005', 'After the wipe and a new sign-in, the account\'s own sign-in address is its mailbox again', async () => {
    qa.check('before the wipe the sign-in address routed to this account', routedBefore?.profile_id === profile.id && !routedBefore.terminal_at, JSON.stringify(routedBefore));
    const answers = await waitFor('the restore answer', async () => {
      const r = rows(`select requested_by, counts, error from public.account_deletions where profile_id = '${profile.id}' and mode = 'restore_mailbox' order by created_at`);
      return r.length ? r : null;
    }, { timeoutMs: 30000 }).catch(() => []);
    const answered = answers.filter((a) => !a.error);
    qa.check('account_deletions: the reopening sign-in recorded one answer for the deletion, "claimed"', answered.length === 1 && answered[0].requested_by === 'sign_in' && answered[0].counts?.outcome === 'claimed', JSON.stringify(answers));
    const deletion = row(`select data_deleted_at from public.profiles where id = '${profile.id}'`);
    qa.check('the answer is for this deletion (its stamp)', !!deletion?.data_deleted_at && String(answered[0]?.counts?.deletionMs) === String(Date.parse(deletion.data_deleted_at)), `${answered[0]?.counts?.deletionMs} vs ${deletion?.data_deleted_at}`);
    const claim = claimOf();
    qa.check('mailbox_claims: the sign-in address belongs to this account again (provider proof, not closed)', claim?.profile_id === profile.id && claim.proof === 'provider' && !claim.terminal_at, JSON.stringify(claim));
    const p = profileOf(user.id);
    qa.check('profiles.verified_email is the sign-in address again', (p?.verified_email || '').toLowerCase() === signInAddress, p?.verified_email || 'none');
  });

  await qa.feature('INTAKE-002', 'A document forwarded to docs@ from the reopened account\'s sign-in address is filed on it', async () => {
    const name = `qa-after-wipe-${stamp().toLowerCase()}.pdf`;
    const since = new Date().toISOString();
    const res = await mockApi('/qa/inbound', { method: 'POST', body: {
      from: `Wren Wipe <${user.email}>`, to: ['docs@credentialdomd.com'], subject: 'Fwd: QA synthetic letter after the wipe', text: 'Forwarding a synthetic document.',
      headers: { 'authentication-results': `mx.qa.credentialdomd.test; dmarc=pass header.from=${LAB_EMAIL_DOMAIN}; spf=pass smtp.mailfrom=${LAB_EMAIL_DOMAIN}; dkim=pass header.d=${LAB_EMAIL_DOMAIN}` },
      attachments: [{ filename: name, content_type: 'application/pdf', content: syntheticPdf(`QA synthetic letter after the wipe ${name}`).toString('base64') }],
    } });
    qa.check('email-inbound accepted the signed webhook', (res.delivery?.status || res.status) === 200, JSON.stringify(res).slice(0, 200));
    const logged = await waitFor('the inbound row', async () => row(`select route, status, profile_id from public.inbound_emails where from_addr ilike ${lit(`%${signInAddress}%`)} and created_at >= ${lit(since)} order by created_at desc limit 1`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('inbound_emails routes it to this account (not "unregistered")', logged?.profile_id === profile.id && logged.status !== 'unregistered', JSON.stringify(logged));
    const doc = await waitFor('the filed document', async () => row(`select name, storage_path from public.documents where user_id = '${profile.id}' and name = ${lit(name)}`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('the attachment is stored as a document on the reopened account', !!doc?.storage_path, JSON.stringify(doc));
    if (!doc?.storage_path || logged?.profile_id !== profile.id) {
      qa.bug({
        title: 'After "Delete All My Data" and a new sign-in, mail from the account\'s own sign-in address is not filed',
        step: 'Delete All My Data, sign in again, forward a document to docs@ from the sign-in address',
        expected: 'The reopening sign-in claims the verified primary back (20260930051700); docs@ files the document on the account',
        actual: `inbound_emails ${JSON.stringify(logged)}; mailbox_claims ${JSON.stringify(claimOf())}; document ${JSON.stringify(doc)}`,
        severity: 'high',
      });
    }
  });
});
