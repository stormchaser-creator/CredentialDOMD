// Home and Vera: search finds a record and opens it, Vera answers a question
// (the lab's mock AI) with the call metered, the notification center lists
// what is due, and an alert can be acknowledged without changing the counts.
import { test } from './support/fixtures.mjs';
import {
  field, goTab, homeTiles, newMember, openCredentials, openMore, row, rows, scriptAi, sleep, waitFor, waitForMemberApp,
} from './support/lab.mjs';

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

/** The top bar's icon-only buttons (bell, theme), left to right. They have no accessible names. */
async function topBarIconButtons(page) {
  const handles = await page.getByRole('button').all();
  const out = [];
  for (const h of handles) {
    const box = await h.boundingBox().catch(() => null);
    if (!box || box.y > 60 || box.x < 900) continue;
    // Icon only, or an icon with a count badge (the bell).
    if (!/^\d*$/.test((await h.innerText().catch(() => 'x')).trim())) continue;
    out.push({ h, x: box.x });
  }
  return out.sort((a, b) => a.x - b.x).map((o) => o.h);
}

test('home and Vera: search opens a record, Vera answers, notification center, acknowledge an alert', {
  tag: ['@HOME-008', '@VERA-001', '@NOTIFY-002', '@HOME-015'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Harper', lastName: 'Home' });
  await openCredentials(page, 'Licenses');
  await page.getByRole('button', { name: 'Add' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add' });
  await field(dlg, 'Type').selectOption('State Medical License');
  await field(dlg, 'License #').fill('QA-FIND-4242');
  await field(dlg, 'State').selectOption('AZ');
  await field(dlg, /^Expires/).fill(day(25));
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.waitFor({ state: 'detached' });
  await sleep(2000);

  await qa.feature('HOME-008', 'Home search finds the license and opens it', async () => {
    await goTab(page, 'Home');
    const search = page.getByRole('textbox', { name: 'Search everything, or ask Vera' });
    await search.fill('QA-FIND-4242');
    const hit = page.getByText(/State Medical License, AZ/).first();
    const found = await hit.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('search results');
    qa.check('the search lists the license by its number', found);
    qa.check('it offers to ask Vera as well', await page.getByText(/Ask Vera: "QA-FIND-4242"/).count() > 0);
    if (found) {
      await hit.click();
      await sleep(1500);
      const text = await page.locator('body').innerText();
      qa.check('choosing the result opens the license', /QA-FIND-4242/.test(text) && /Licenses/.test(text));
      await page.keyboard.press('Escape').catch(() => {});
    }
  }, { soft: true });

  await qa.feature('VERA-001', 'Ask Vera a question', async () => {
    const before = rows(`select id from public.ai_usage where user_id = '${profile.id}'`).length;
    // Vera asks Gemini for JSON ({reply, actions}); the lab's mock answers this question with one.
    await scriptAi('gemini', { json: { reply: 'QA lab: one license expires within 90 days, the Arizona license, in 25 days.', actions: [] } }, 'QA which of my licenses expire soonest?');
    await openMore(page, 'Vera');
    await page.getByRole('textbox', { name: /Ask Vera anything/ }).fill('QA which of my licenses expire soonest?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const answered = await page.getByText(/QA lab: one license expires within 90 days/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('vera answer');
    qa.check('Vera answers (the lab\'s mock model)', answered, answered ? '' : (await page.locator('body').innerText()).slice(-300));
    const usage = await waitFor('the metered call', async () => { const r = rows(`select provider, ok from public.ai_usage where user_id = '${profile.id}'`); return r.length > before ? r : null; }, { timeoutMs: 20000 }).catch(() => null);
    qa.check('the call is metered in ai_usage', !!usage, usage ? JSON.stringify(usage.slice(-1)) : 'no ai_usage row');
  }, { soft: true });

  await qa.feature('NOTIFY-002', 'Notification Center lists what is due', async () => {
    await goTab(page, 'Home');
    const [bell] = await topBarIconButtons(page);
    qa.check('the bell button exists in the top bar', !!bell);
    if (!bell) return;
    await bell.click();
    const center = page.getByRole('dialog', { name: 'Notification Center' });
    const opened = await center.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('notification center');
    qa.check('the notification center opens', opened);
    qa.check('it lists the license due in 25 days', /AZ|Arizona|State Medical License/.test(await center.innerText().catch(() => '')), (await center.innerText().catch(() => '')).slice(0, 200));
    await page.keyboard.press('Escape').catch(() => {});
  }, { soft: true });

  await qa.feature('HOME-015', 'Acknowledge an alert: it steps aside, the Expiring count stays', async () => {
    const before = await homeTiles(page);
    const ack = page.getByRole('button', { name: 'Acknowledge', exact: true }).first();
    const has = await ack.waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('Home offers "Acknowledge" on the due license (Action Required)', has);
    if (!has) return;
    await ack.click();
    const m = page.getByRole('dialog', { name: 'Acknowledge this alert' });
    await m.getByPlaceholder('e.g. waiting on the board to extend').fill('QA: renewal submitted');
    await m.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    await sleep(2500);
    const acks = rows(`select until, note from public.alert_acks where user_id = '${profile.id}'`);
    qa.check('alert_acks row with the note and a snooze date', acks.length === 1 && acks[0].note === 'QA: renewal submitted' && !!acks[0].until, acks);
    await page.reload();
    await waitForMemberApp(page);
    const after = await homeTiles(page);
    qa.check('acknowledging does not change the Expiring count', after.expiring === before.expiring, `${before.expiring} -> ${after.expiring}`);
    qa.check('the acknowledged alert is listed as acknowledged', /acknowledged/i.test(await page.locator('body').innerText()));
  }, { soft: true });
});
