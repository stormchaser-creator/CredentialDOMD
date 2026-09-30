// The owner's controls on other accounts, each of which demands a reason and
// writes an audit row: pause and restore a member's app access (the member
// sees the paused screen), give free lifetime access to an unpaid account,
// view a member's account read-only after they allowed support access, and a
// message from the owner that the member reads and answers on Home.
import { test } from './support/fixtures.mjs';
import { clearRunawayRetries } from './run.mjs';
import { noRestart } from './support/run-options.mjs';
import {
  createPhysician, goTab, landing, letters, makeAdmin, newMember, openMore, profileOf, row, rows, signIn, sleep, waitFor, waitForMemberApp, accessSnapshot,
} from './support/lab.mjs';

async function openAdmin(page, section) {
  await openMore(page, 'Admin');
  await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name: new RegExp(`^${section}`) }).click();
}
async function findAccount(page, text) {
  await openAdmin(page, 'Accounts');
  await page.getByRole('searchbox', { name: 'Search loaded accounts' }).fill(text);
  await sleep(800);
}

test('owner controls: pause and restore access, lifetime grant, view as member, owner message', {
  tag: ['@ADMIN-001', '@AUTH-008', '@ADMIN-005', '@SUPPORT-003', '@ADMIN-006'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(8 * 60 * 1000);
  const admin = await newMember(page, { firstName: 'Rowan', lastName: `Owner ${letters()}` });
  await makeAdmin(admin.user);
  await page.reload();
  await waitForMemberApp(page);
  const t = await secondBrowser();
  const member = await newMember(t.page, { firstName: 'Tatum', lastName: `Target ${letters()}` });
  const memberName = `Tatum ${member.user.lastName}`;

  // "Paused" in the Admin screens is access_status 'revoked' in the database.
  await qa.feature('ADMIN-001', 'Pause a member\'s app access with a reason', async () => {
    await findAccount(page, memberName);
    await page.getByRole('button', { name: 'Pause access' }).first().click();
    const d = page.getByRole('dialog', { name: 'Pause app access' });
    const confirm = d.getByRole('button', { name: /^Confirm: pause app access/ });
    qa.check('Confirm stays disabled without a reason (10+ characters)', await confirm.isDisabled());
    await d.getByRole('textbox', { name: 'Reason for this change' }).fill('QA checklist: pause test');
    await confirm.click();
    let err = '';
    if (!(await d.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false))) {
      const full = (await d.innerText().catch(() => '')).replace(/\s+/g, ' ');
      const saving = /Saving/.test(full);
      err = saving ? 'still "Saving…" after 15 s (no answer)' : full.slice(-300);
      const shot = await qa.shot('pause stuck saving');
      if (saving) {
        qa.bug({
          title: 'Admin > Accounts: Pause / Approve hangs on "Saving…" forever when the member\'s profile changed after the list loaded',
          step: 'Admin opens Accounts while the member is using the app (their app writes profiles.updated_at), then Pause access > reason > Confirm',
          expected: 'The refusal "Account changed. Refresh and review it again" comes back at once and the dialog says to refresh',
          actual: 'The request never returns (browser shows "Saving…" with Cancel disabled; Kong logs 499 when the client gives up). admin_change_profile_access raises that refusal with errcode 40001 (serialization_failure), and PostgREST (14.14 in the lab) re-runs 40001 transactions, so the same deterministic refusal runs again and again, indefinitely (still running 15 minutes later, 2-5 PostgREST sessions, seen in pg_stat_activity). Each re-run takes the target profile FOR UPDATE, so a second Pause/Approve on that member also hangs, and the loop holds PostgREST pool connections until PostgREST restarts. A direct call with a stale p_expected_updated_at did not answer within 40 s. Production impact depends on the deployed PostgREST version; a deterministic state mismatch should not use a retryable SQLSTATE either way.',
          severity: 'medium', screenshot: shot,
        });
      }
      // An admin has no way out (the loop keeps the member's row locked). The lab restarts
      // PostgREST to end the loop (in parallel-safe mode it ends only the looping sessions,
      // since other runs share the API), then the journey reloads the list and tries again.
      await clearRunawayRetries({ action: noRestart() ? 'terminate' : 'restart' });
      await page.reload();
      await waitForMemberApp(page);
      await findAccount(page, memberName);
      await page.getByRole('button', { name: 'Pause access' }).first().click();
      await d.getByRole('textbox', { name: 'Reason for this change' }).fill('QA checklist: pause test');
      await confirm.click();
      await d.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
    }
    qa.check('the first attempt answered (no hang or stale-row refusal)', !err, err);
    const paused = await waitFor('paused', async () => profileOf(member.user.id)?.access_status === 'revoked', { timeoutMs: 15000 }).catch(() => false);
    await qa.shot('paused');
    qa.check('the member\'s access becomes paused (access_status revoked)', paused, `${profileOf(member.user.id)?.access_status} ${err}`);
    const audit = rows(`select action, reason from public.admin_operations_audit where target_profile_id = '${member.profile.id}' order by created_at`);
    qa.check('an admin_operations_audit row with the reason', audit.some((a) => a.reason === 'QA checklist: pause test'), audit);
  }, { soft: true });

  await qa.feature('AUTH-008', 'The paused member sees the "Access paused" screen', async () => {
    await t.page.reload();
    await sleep(6000);
    const seen = (await t.page.locator('body').innerText()).replace(/\s+/g, ' ');
    await t.page.screenshot({ path: (await qa.shot('member sees paused')).replace(/\.png$/, '-member.png') });
    qa.check('the member sees a paused-access screen, not the app', /paused/i.test(seen) && !/Search everything, or ask Vera/.test(seen), seen.slice(0, 200));
  }, { soft: true });

  await qa.feature('ADMIN-001', 'Restore (Approve) the paused member\'s access', async () => {
    await page.goto(page.url());
    await waitForMemberApp(page);
    await findAccount(page, memberName);
    await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
    const r = page.getByRole('dialog', { name: 'Approve app access' });
    await r.getByRole('textbox', { name: 'Reason for this change' }).fill('QA checklist: restore after test');
    await r.getByRole('button', { name: /^Confirm/ }).click();
    const back = await waitFor('active again', async () => profileOf(member.user.id)?.access_status === 'active', { timeoutMs: 20000 }).catch(() => false);
    qa.check('access_status returns to active', back, profileOf(member.user.id)?.access_status);
    await t.page.reload();
    qa.check('the member is back in the app', (await landing(t.page)) === 'member');
  }, { soft: true });

  await qa.feature('ADMIN-001', 'Give free lifetime access to an unpaid account', async () => {
    const pending = await createPhysician({ firstName: 'Parker', lastName: `Pending ${letters()}` });
    const p = await secondBrowser();
    await signIn(p.page, pending);
    qa.check('the unpaid account starts on the gate', (await landing(p.page)) === 'gate');
    await page.goto(page.url());
    await waitForMemberApp(page);
    await findAccount(page, `Parker ${pending.lastName}`);
    await page.getByRole('button', { name: 'Give free lifetime access' }).first().click();
    const d = page.getByRole('dialog', { name: 'Give free lifetime access' });
    await d.waitFor();
    const give = d.getByRole('button', { name: 'Give free lifetime access' });
    await d.getByRole('textbox').first().fill('QA checklist: lifetime grant');
    qa.check('the grant stays disabled until the confirmation box is ticked', await give.isDisabled());
    await d.getByRole('checkbox').first().check();
    await qa.shot('lifetime dialog');
    await give.click();
    const granted = await waitFor('the lifetime audit', async () => row(`select reason from public.admin_lifetime_audit where target_subject = '${pending.id}'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('admin_lifetime_audit row with the reason', granted?.reason === 'QA checklist: lifetime grant', granted);
    const snap = accessSnapshot(pending.id);
    qa.check('the account now has lifetime Credential and Practice', snap?.lifetime?.credential === true && snap?.lifetime?.practice === true, snap?.lifetime);
    await p.page.getByRole('button', { name: 'Check access again' }).click().catch(() => {});
    await sleep(3000);
    await p.page.reload();
    qa.check('the account opens the member app', (await landing(p.page)) === 'member');
  }, { soft: true });

  await qa.feature('ADMIN-006', 'View as member (read-only) after the member allowed support access', async () => {
    await openMore(t.page, 'Profile & settings');
    await t.page.getByRole('button', { name: /Allow CredentialDOMD support to view my account for 24 hours/ }).click();
    await sleep(2000);
    await page.goto(page.url());
    await waitForMemberApp(page);
    await findAccount(page, memberName);
    const view = page.getByRole('button', { name: 'View as member' }).first();
    qa.check('"View as member" is enabled once the member allowed support access', await view.isEnabled());
    await view.click();
    const d = page.getByRole('dialog').last();
    await d.getByRole('textbox').first().fill('QA checklist');
    await d.getByRole('button', { name: /^(Start|View|Open|Confirm)/ }).last().click();
    const banner = await page.getByText(/Viewing .* read-only|read-only view|member view/i).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('view as member');
    qa.check('the member\'s account opens read-only with a banner', banner);
    // The banner can show before the session row is written: wait for the row (15 s at most).
    const sessionRow = () => row(`select reason, ended_at, expires_at from public.member_view_sessions where profile_id = '${member.profile.id}' order by started_at desc limit 1`);
    const session = await waitFor('the member view session', async () => sessionRow() || null, { timeoutMs: 15000 }).catch(() => sessionRow());
    qa.check('member_view_sessions row with the reason, ending within 15 minutes', session?.reason === 'QA checklist' && Date.parse(session.expires_at) - Date.now() <= 15 * 60e3 + 5000, session);
    await page.getByRole('button', { name: /^Exit/ }).first().click().catch(() => {});
    await sleep(2000);
    const ended = row(`select ended_at from public.member_view_sessions where profile_id = '${member.profile.id}' order by started_at desc limit 1`);
    qa.check('Exit ends the view (ended_at)', !!ended?.ended_at, ended);
  }, { soft: true });

  await qa.feature('ADMIN-005', 'Owner sends a message; the member reads and answers it on Home', async () => {
    await page.goto(page.url());
    await waitForMemberApp(page);
    await openAdmin(page, 'Messages');
    await page.getByRole('button', { name: '+ New message' }).click();
    await qa.shot('new message form');
    const recipient = page.getByRole('combobox').last();
    if (await recipient.count()) {
      const options = await recipient.locator('option').allInnerTexts();
      const pick = options.find((o) => o.includes('Tatum'));
      if (pick) await recipient.selectOption({ label: pick });
    }
    await page.getByPlaceholder('Subject (optional)').fill('QA hello from the owner');
    await page.getByPlaceholder('What do you want to say?').fill('QA lab message: please confirm you can read this.');
    await page.getByRole('button', { name: /^Send/ }).last().click();
    const sent = await waitFor('the message row', async () => row(`select id from public.admin_messages where subject = 'QA hello from the owner'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('admin_messages row created', !!sent);
  }, { soft: true });

  await qa.feature('SUPPORT-003', 'The member reads the owner\'s message on Home and replies', async () => {
    await t.page.reload();
    await waitForMemberApp(t.page);
    await goTab(t.page, 'Home');
    const card = t.page.getByText('QA hello from the owner').first();
    const shown = await card.waitFor({ timeout: 20000 }).then(() => true, () => false);
    await t.page.screenshot({ path: (await qa.shot('member home message')).replace(/\.png$/, '-member.png') });
    qa.check('the message shows on Home', shown);
    if (!shown) return;
    await card.click();
    // The card opens the inbox; the message opens from there.
    const inbox = t.page.getByRole('dialog', { name: 'Messages' });
    if (await inbox.waitFor({ timeout: 5000 }).then(() => true, () => false)) await inbox.getByRole('button').filter({ hasText: 'QA hello from the owner' }).first().click();
    const box = t.page.getByPlaceholder(/^Reply to /).first();
    qa.check('the message body shows', await t.page.getByText('QA lab message: please confirm you can read this.').first().isVisible().catch(() => false));
    await box.fill('QA reply: I can read it.');
    await t.page.getByRole('button', { name: 'Send reply' }).last().click();
    const reply = await waitFor('the reply row', async () => row(`select id from public.admin_message_replies where body = 'QA reply: I can read it.'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('admin_message_replies row stored', !!reply);
    await t.page.getByRole('button', { name: /All messages/ }).click().catch(() => {});
    await t.page.keyboard.press('Escape').catch(() => {});
    await t.page.reload();
    await waitForMemberApp(t.page);
    await goTab(t.page, 'Home');
    await sleep(1500);
    qa.check('after reading, the badge no longer says "new message"', !(await t.page.getByText(/new message from/).count()));
    const seen = profileOf(member.user.id).admin_messages_seen_at;
    qa.check('profiles.admin_messages_seen_at stamped', !!seen, seen);
  }, { soft: true });
});
