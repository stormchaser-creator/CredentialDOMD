// Account and settings journeys: the Setup card on Home, the physician
// profile and reminder settings persisting to the cloud (and to a second
// browser), the support-access grant, and the daily email reminder that a
// license expiring soon produces (the cron job's dispatch run by hand).
import { test } from './support/fixtures.mjs';
import {
  emailBody, emails, field, goTab, labExec, landing, newMember, openCredentials, openMore, profileOf, row, rows, signIn, sleep,
  waitFor, waitForMemberApp,
} from './support/lab.mjs';

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

test('settings: setup card, profile and reminder settings persist, support access, daily reminder email', {
  tag: ['@HOME-001', '@SETTINGS-007', '@SETTINGS-002', '@NOTIFY-004', '@SETTINGS-006', '@NOTIFY-001'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Sydney', lastName: 'Settings' });

  await qa.feature('HOME-001', 'Setup card on Home: open setup, Not now sticks across reload', async () => {
    await goTab(page, 'Home');
    const heading = page.getByRole('heading', { name: /^Setup · \d of \d$/ });
    qa.check('Home shows the Setup card with progress', await heading.isVisible(), await heading.innerText().catch(() => ''));
    await page.getByRole('button', { name: 'Open setup ›' }).click();
    const opened = await page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('setup page');
    qa.check('"Open setup" opens More > Setup', opened);
    await goTab(page, 'Home');
    await page.getByRole('button', { name: 'Not now' }).click();
    await sleep(1500);
    qa.check('"Not now" hides the card', !(await page.getByRole('heading', { name: /^Setup · / }).count()));
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Home');
    await sleep(1000);
    qa.check('it stays hidden after a reload', !(await page.getByRole('heading', { name: /^Setup · / }).count()));
    const state = profileOf(user.id).setup_state;
    qa.check('profiles.setup_state records the snooze', !!state && /snooze|notNow|hidden|until/i.test(JSON.stringify(state)), JSON.stringify(state)?.slice(0, 160));
  }, { soft: true });

  await qa.feature('SETTINGS-007', 'Physician profile fields persist to the cloud and a second browser', async () => {
    await openMore(page, 'Profile & settings');
    const set = async (placeholder, value) => { const box = page.getByPlaceholder(placeholder).first(); await box.fill(value); await box.blur(); await sleep(300); };
    await set('(555) 123-4567', '(555) 010-0199');
    await set('Street, City, ST ZIP', '1 QA Way, Denver, CO 80202');
    await set('e.g. DrYourName.com', 'qa.credentialdomd.test');
    await set('Languages beyond English', 'Spanish');
    await set('Board-certified neurosurgeon with…', 'QA synthetic professional summary.');
    await set('e.g. Author of two books', 'QA synthetic highlight');
    await page.getByRole('button', { name: /^MD Doctor of Medicine$/ }).click();
    await sleep(3000);
    await page.reload();
    await waitForMemberApp(page);
    const p = profileOf(user.id);
    qa.check('phone, address, website, languages, summary, highlights and degree are in profiles', p.phone === '(555) 010-0199' && p.address === '1 QA Way, Denver, CO 80202' && p.website === 'qa.credentialdomd.test' && p.languages === 'Spanish' && p.professional_summary === 'QA synthetic professional summary.' && p.cv_highlights === 'QA synthetic highlight' && p.degree_type === 'MD',
      JSON.stringify({ phone: p.phone, address: p.address, website: p.website, languages: p.languages, summary: p.professional_summary, highlights: p.cv_highlights, degree: p.degree_type }));
    const other = await secondBrowser();
    await signIn(other.page, user);
    await landing(other.page);
    await openMore(other.page, 'Profile & settings');
    qa.check('the second browser shows the saved address', (await other.page.getByPlaceholder('Street, City, ST ZIP').inputValue()) === '1 QA Way, Denver, CO 80202');
    await other.context.close();
  }, { soft: true });

  await qa.feature('SETTINGS-002', 'About you: name edit persists', async () => {
    await openMore(page, 'Profile & settings');
    const name = page.getByRole('textbox', { name: 'Your full name' });
    await name.fill('Sydney Quinn Settings');
    await name.blur();
    await sleep(3000);
    await page.reload();
    await waitForMemberApp(page);
    qa.check('profiles.name saved', profileOf(user.id).name === 'Sydney Quinn Settings', profileOf(user.id).name);
    qa.check('the degree choice persisted (MD)', profileOf(user.id).degree_type === 'MD');
  }, { soft: true });

  await qa.feature('NOTIFY-004', 'Reminder and request settings persist', async () => {
    await openMore(page, 'Profile & settings');
    const lead = page.locator('div').filter({ has: page.getByText('Lead time (days)', { exact: true }) }).getByRole('spinbutton').last();
    await lead.fill('60');
    await lead.blur();
    await page.getByRole('button', { name: 'Weekly', exact: true }).click();
    const ack = page.getByRole('switch', { name: 'Acknowledge document requests automatically' });
    if ((await ack.getAttribute('aria-checked')) === 'true') await ack.click();
    await sleep(3000);
    await page.reload();
    await waitForMemberApp(page);
    const p = profileOf(user.id);
    qa.check('reminder_lead_days 60, notify_freq_days 7, ack_requests off', p.reminder_lead_days === 60 && p.notify_freq_days === 7 && p.ack_requests === false, JSON.stringify({ lead: p.reminder_lead_days, freq: p.notify_freq_days, ack: p.ack_requests }));
    await openMore(page, 'Profile & settings');
    qa.check('the switch shows off after a reload', (await page.getByRole('switch', { name: 'Acknowledge document requests automatically' }).getAttribute('aria-checked')) === 'false');
  }, { soft: true });

  await qa.feature('SETTINGS-006', 'Support access grant: allow, see time left, end', async () => {
    await openMore(page, 'Profile & settings');
    await page.getByRole('button', { name: /Allow CredentialDOMD support to view my account for 24 hours/ }).click();
    const on = await page.getByRole('status').filter({ hasText: /Support access is on|until|left/i }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    await qa.shot('support access on');
    const grant = row(`select expires_at, ended_at from public.member_view_grants where profile_id = '${profile.id}' order by created_at desc limit 1`);
    qa.check('the status shows the grant with its time left', on, await page.getByRole('status').filter({ hasText: /Support access/ }).first().innerText().catch(() => ''));
    qa.check('member_view_grants row expiring in about 24 hours', !!grant && Math.abs(Date.parse(grant.expires_at) - Date.now() - 24 * 3600e3) < 10 * 60e3 && !grant.ended_at, grant);
    const end = page.getByRole('button', { name: /End support access|Turn off|Stop/i }).first();
    if (await end.count()) {
      await end.click();
      await page.getByRole('dialog').getByRole('button', { name: /End|Yes|Confirm/i }).last().click().catch(() => {});
      await sleep(2000);
      const after = row(`select ended_at from public.member_view_grants where profile_id = '${profile.id}' order by created_at desc limit 1`);
      qa.check('ending it stamps ended_at', !!after?.ended_at, after);
      qa.check('the status says support access is off', /Support access is off/.test(await page.locator('body').innerText()));
    } else qa.check('an "End support access" control is offered', false);
  }, { soft: true });

  await qa.feature('NOTIFY-001', 'Daily email reminder for a license expiring soon', async () => {
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'License #').fill('QA-REMIND-20');
    await field(dlg, 'State').selectOption('NM');
    await field(dlg, /^Expires/).fill(day(20));
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached' });
    await sleep(2500);
    qa.check('email reminders are on for the member (the default)', profileOf(user.id).notify_email === true);
    // What the send-reminders-daily cron job runs.
    labExec('select public.dispatch_daily_reminders()');
    const mail = await waitFor('the reminder email', async () => (await emails({ to: user.email })).find((m) => !/Welcome/.test(m.subject)) || null, { timeoutMs: 60000, intervalMs: 1500 }).catch(() => null);
    qa.check('one reminder email to the member', !!mail, mail?.subject || 'none');
    if (mail) {
      const full = await emailBody(mail.id);
      const text = `${full.text || ''} ${full.html || ''}`;
      qa.check('it names the expiring license', /QA-REMIND-20|New Mexico|NM/.test(text), (full.text || '').slice(0, 200));
      qa.check('it links back to the app', /credentialdomd\.com\/app/.test(text));
      // The license expires 20 calendar days after today's (UTC) date.
      const said = Number((/\(in (\d+) days?\)/.exec(full.text || '') || [])[1]);
      qa.check('the day count matches the calendar (20 days)', said === 20, `email says "in ${said} days"`);
      if (said !== 20) {
        qa.bug({
          title: 'Reminder email counts one day too few after 12:00 UTC (the daily job runs at 13:00 UTC)',
          step: 'A license expiring 20 days from today; run the daily reminder (dispatch_daily_reminders)',
          expected: '"(in 20 days)", the calendar-day count the app shows on Home',
          actual: `"(in ${said} days)". send-reminders/index.ts dayDiff = Math.round((expiry 00:00Z - now) / 1 day), so any send after 12:00 UTC rounds 19.4 down to 19; the "Due within N days" buckets shift by a day too`,
          severity: 'low',
        });
      }
    }
    const p = profileOf(user.id);
    qa.check('profiles.last_notified / reminder fingerprint recorded', !!(p.last_notified || p.reminder_emailed_at), JSON.stringify({ last: p.last_notified, emailed: p.reminder_emailed_at }));
    // Nothing changed: the next run sends nothing.
    labExec('select public.dispatch_daily_reminders()');
    await sleep(8000);
    const all = (await emails({ to: user.email })).filter((m) => !/Welcome/.test(m.subject));
    qa.check('a second run with nothing changed sends no second email', all.length === 1, `${all.length} reminder email(s)`);
  }, { soft: true });
});
