// CME on Home, as a member renewing in Texas reads it: the state card and its
// math (what counted, what did not and why, the rule it comes from), Find CME,
// the renewal packet (the share sheet and the download, and the explanation
// when a state has nothing to send), the board certification cards with a
// subspecialty that follows its primary board, and "Rules changed?" (Cancel
// sends nothing, Send lands in the owner's review queue).
import { readFileSync } from 'node:fs';
import { test } from './support/fixtures.mjs';
import { openMore, pendingOps, profileOf, rows, sleep, syncWarnings } from './support/lab.mjs';
import {
  bodyText, day, home, memberWithPlace, pageTitle, pdfText, recordShares, reloadApp, seed, shared,
} from './support/home-notify-helpers.mjs';

/** The Home state card for `st` (the card's first line is the state code). */
const stateCard = (page, st) => page.locator('div[style*="cursor: pointer"]').filter({ has: page.getByText(new RegExp(`^${st}$`)) }).filter({ has: page.getByRole('button', { name: /Renewal packet/ }) }).last();

test('CME on Home: math, Find CME, renewal packet, boards, rules changed', {
  tag: ['@HOME-016', '@HOME-017', '@HOME-018', '@HOME-024'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await memberWithPlace(page, { firstName: 'Casey', lastName: 'Credits' });
  // Texas renews in 200 days (its two-year window runs back from there). New Mexico's
  // license carries a CME cycle start 30 days ago, so no entry falls in its window.
  await seed(user, profile.id, 'licenses', [
    { type: 'State Medical License', name: 'QA CME Texas', license_number: 'QA-CME-TX', state: 'TX', expiration_date: day(200) },
    { type: 'State Medical License', name: 'QA CME New Mexico', license_number: 'QA-CME-NM', state: 'NM', expiration_date: day(300), cme_cycle_start: day(-30) },
  ]);
  await seed(user, profile.id, 'cme', [
    { title: 'QA ethics in practice', category: 'AMA PRA Category 1', hours: 2, date: day(-100), topics: ['Ethics'] },
    { title: 'QA neurosurgery update', category: 'AMA PRA Category 1', hours: 10, date: day(-60) },
    { title: 'QA journal club', category: 'AMA PRA Category 2', hours: 3, date: day(-40) },
    { title: 'QA old conference', category: 'AMA PRA Category 1', hours: 12, date: '2015-03-01' },
    { title: 'QA undated webinar', category: 'AMA PRA Category 1', hours: 1 },
  ]);
  await reloadApp(page);
  await openMore(page, 'Profile & settings');
  await page.getByRole('button', { name: /^MD Doctor of Medicine$/ }).click();
  await sleep(1500);

  await qa.feature('HOME-016', 'State card: the math shows the window, the scoreboard, counted and excluded entries with reasons, the source; Find CME', async () => {
    await home(page);
    const card = stateCard(page, 'TX');
    const ct = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('tx card');
    qa.check('the TX card shows the hours in window, the renewal date and its days', /15\/48h|15 ?\/ ?48/.test(ct) && /License renews/.test(ct) && /\b200 days\b|\b199 days\b|\b201 days\b/.test(ct), ct.slice(0, 260));
    await card.getByText(/^TX$/).click();
    const math = page.getByRole('dialog', { name: 'TX CME: the math', exact: true });
    await math.waitFor({ timeout: 10000 });
    const mt = (await math.innerText()).replace(/\s+/g, ' ');
    await qa.shot('tx math');
    qa.check('the window and the days left', /Only hours dated inside this window count toward this renewal/.test(mt) && /\d+ days left/.test(mt), mt.slice(0, 200));
    qa.check('the scoreboard: total 15 of 48, Category 1 12 of 24', /Total logged hours 15 \/ 48/.test(mt) && /12 \/ 24/.test(mt), (mt.match(/Total logged hours.{0,160}/) || [''])[0]);
    qa.check('Ethics is scored as a required topic (2 of 2 hours recorded)', /Ethics.{0,40}2 \/ 2h recorded|Ethics.{0,30}recorded/.test(mt), (mt.match(/Ethics.{0,60}/) || [''])[0]);
    qa.check('"Counted this cycle (3)" lists the three dated entries in the window', /Counted this cycle \(3\)/i.test(mt) && /QA ethics in practice/.test(mt) && /QA neurosurgery update/.test(mt) && /QA journal club/.test(mt));
    qa.check('the Category 2 entry is tagged as not counting toward Cat 1, the Cat 1 ones as counting', /QA journal club 3h .{0,30}AMA PRA Category 2(?! · counts)/.test(mt) && /AMA PRA Category 1 · counts as Cat 1/.test(mt), (mt.match(/QA journal club.{0,80}/) || [''])[0]);
    // e5f020a3 lists from the engine's own window test and says which side of it an entry falls.
    qa.check('"Not counting toward this renewal (2)" gives each reason: before the cycle opened, no date', /Not counting toward this renewal \(2\)/i.test(mt) && /2015-03-01, before this cycle opened/.test(mt) && /QA undated webinar 1h No date on the entry\. Add one so it can count\./.test(mt), (mt.match(/Not counting.{0,300}/i) || [''])[0]);
    qa.check('the source citation is shown', /Source: Tex\. Admin\. Code tit\. 22, § 161\.35/.test(mt), (mt.match(/Source:.{0,120}/) || [''])[0]);
    await page.keyboard.press('Escape');
    await math.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    const findOnCard = card.getByRole('button', { name: 'Find CME →' });
    qa.check('a card with unmet topics offers "Find CME →"', await findOnCard.isVisible().catch(() => false));
    if (await findOnCard.isVisible().catch(() => false)) {
      await findOnCard.click();
      await sleep(900);
      qa.check('"Find CME →" opens Credentials > Find CME', (await pageTitle(page)) === 'Credentials' && await page.locator('[data-desk-search]').count() > 0, (await bodyText(page)).slice(0, 120));
    }
    await home(page);
    await page.getByRole('button', { name: 'Find CME', exact: true }).click();
    await sleep(900);
    qa.check('the section header\'s "Find CME" opens Credentials > Find CME', (await pageTitle(page)) === 'Credentials' && await page.locator('[data-desk-search]').count() > 0);
  }, { soft: true });

  await qa.feature('HOME-017', 'Renewal packet: a board-ready PDF to the share sheet or a download; an empty state explains', async () => {
    await home(page);
    // A desk browser without a share sheet downloads the PDF.
    const consoleMark = qa.report.console.length;
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
      stateCard(page, 'TX').getByRole('button', { name: /Renewal packet/ }).click(),
    ]);
    const name = dl?.suggestedFilename() || '';
    const path = dl ? await dl.path().catch(() => null) : null;
    const head = path ? readFileSync(path).subarray(0, 5).toString('latin1') : '';
    qa.check('without a share sheet the transcript PDF downloads', /^CME-Transcript-TX-\d{4}-\d{2}-\d{2}\.pdf$/.test(name) && head === '%PDF-', `${name} ${head}`);
    const pdf = path ? pdfText(readFileSync(path)) : '';
    qa.check('the transcript lists the in-window activities for Texas and leaves out the rest', /CME Transcript/.test(pdf) && /Texas/.test(pdf) && /QA ethics in practice/.test(pdf) && /QA neurosurgery update/.test(pdf) && !/QA old conference/.test(pdf) && !/QA undated webinar/.test(pdf), `${pdf.length} chars of drawn text; ${['CME Transcript', 'Texas', 'QA ethics in practice', 'QA neurosurgery update', 'QA old conference', 'QA undated webinar'].map((w) => `${w}: ${pdf.includes(w)}`).join(', ')}`);
    await sleep(2000);
    let logs = rows(`select item_name, section, method from public.share_log where user_id = '${profile.id}' order by sent_at`);
    const queued = await pendingOps(page);
    const refused = syncWarnings(qa.report, consoleMark);
    qa.check('the download leaves no refused write behind (share_log accepts what the app logs)', !queued.some((o) => JSON.stringify(o).includes('renewal packet')) && !refused.length, `${JSON.stringify(queued).slice(0, 200)} ${refused.join(' | ').slice(0, 200)}`);
    if (queued.some((o) => JSON.stringify(o).includes('renewal packet')) || refused.length) {
      qa.bug({
        title: 'A downloaded renewal packet is logged with method "download", which share_log refuses; the write is queued and retried on every load',
        step: 'Home, a state CME card, "Renewal packet" on a desk browser (no share sheet): the PDF downloads',
        expected: 'The download is either logged in a shape share_log accepts or not logged; nothing is left pending',
        actual: `share_log_method_check allows email, text, clipboard, share; App.jsx:480 adds { method: "download" } (the return of shareTranscriptPdf, cmeTranscriptPdf.js:567), the insert is refused and stays in the pending-ops queue (${queued.length} queued; console: ${refused[0]?.slice(0, 120) || 'none'}). share_log has no row for it (${JSON.stringify(logs)}). Fixed on fix/qa-docs-vera-intake c2e5c7ad (a download is no longer logged; a legacy "download" row lands as "share")`,
        severity: 'low',
      });
    }
    // A phone hands it to the share sheet (the lab records what the sheet receives).
    await recordShares(page);
    await stateCard(page, 'TX').getByRole('button', { name: /Renewal packet/ }).click();
    await sleep(3000);
    const got = await shared(page);
    const files = got.flatMap((s) => s.files);
    qa.check('with a share sheet the PDF is shared', files.length === 1 && files[0].type === 'application/pdf' && /^CME-Transcript-TX-/.test(files[0].name), JSON.stringify(got));
    logs = rows(`select item_name, method from public.share_log where user_id = '${profile.id}' order by sent_at`);
    qa.check('share_log records the share', logs.some((l) => l.item_name === 'TX renewal packet' && l.method === 'share'), logs);
    // New Mexico: nothing in its window.
    const before = qa.report.dialogs.length;
    const errors = qa.report.pageErrors.length;
    await stateCard(page, 'NM').getByRole('button', { name: /Renewal packet/ }).click();
    await sleep(1500);
    const said = qa.report.dialogs.slice(before).join(' | ');
    qa.check('an empty window explains itself instead of failing', /No CME entries fall inside the New Mexico cycle window/.test(said) && qa.report.pageErrors.length === errors, said.slice(0, 240));
    qa.check('nothing is logged for the state with nothing to send', !rows(`select 1 from public.share_log where user_id = '${profile.id}' and item_name = 'NM renewal packet'`).length);
  }, { soft: true });

  await qa.feature('HOME-018', 'Board cards: earned/required in the window, the math with reasons, a subspecialty that follows its board, Find CME', async () => {
    await openMore(page, 'Profile & settings');
    await page.getByRole('button', { name: /^(\d+ certifications? selected|Select board certifications\.\.\.)/ }).click();
    const search = page.getByPlaceholder('Search boards, subspecialties...');
    await search.fill('Neurological Surgery');
    await page.getByRole('button', { name: /^Neurological Surgery ABMS · ABNS/ }).first().click();
    await search.fill('Autonomic');
    await page.getByRole('button', { name: /^Autonomic Disorders UCNS/ }).first().click();
    await sleep(2500);
    const specs = profileOf(user.id).specialties || [];
    qa.check('profiles.specialties holds both picks', specs.includes('ABMS:ABNS') && specs.some((s) => /^UCNS:Autonomic Disorders/.test(s)), JSON.stringify(specs));
    await reloadApp(page);
    await home(page);
    const text = await bodyText(page);
    const card = page.locator('div[style*="cursor: pointer"]').filter({ hasText: /^Neurological Surgery, ABMS ABNS/ }).last();
    const ct = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('board cards');
    qa.check('the ABNS card shows 12 of 20 Category 1 hours this year', /Board Certification/.test(text) && /12\/20 hrs/.test(ct), ct.slice(0, 200));
    qa.check('the subspecialty says its CME follows the primary board', /Autonomic Disorders(:| —| \\u2014) CME follows the primary board above/.test(text), (text.match(/Autonomic Disorders.{0,60}/) || [''])[0]);
    const raw = [...new Set(text.match(/\\u[0-9a-fA-F]{4}/g) || [])];
    qa.check('the board cards print no raw escape codes', raw.length === 0, `${raw.join(', ')}: ${(text.match(/.{0,50}\\u[0-9a-fA-F]{4}.{0,30}/) || [''])[0]}`);
    if (raw.length) {
      qa.bug({
        title: 'Home Board Certification: the card and the subspecialty note print raw escape codes ("\\u00b7", "\\u2014") instead of a dot and a dash',
        step: 'Settings: pick Neurological Surgery (ABMS) and the UCNS Autonomic Disorders certification; view Home, Board Certification',
        expected: '"AMA PRA Cat 1/year · 2026 (no carryover) · N days left" and "Autonomic Disorders: CME follows the primary board above"',
        actual: `The page reads "${(text.match(/AMA PRA Cat 1\/year.{0,40}/) || [''])[0]}" and "${(text.match(/Autonomic Disorders \\u2014.{0,20}/) || [''])[0]}". App.jsx:1890 and App.jsx:1928 put \\u00b7 and \\u2014 in JSX text, where escapes are not processed (the same card's \` \\u00b7 \${b.daysLeft}\` inside a template literal renders correctly)`,
        severity: 'low',
      });
    }
    await card.getByText(/^Neurological Surgery, ABMS ABNS/).click();
    const math = page.getByRole('dialog', { name: /Neurological Surgery.*: the math$/ });
    await math.waitFor({ timeout: 10000 });
    const mt = (await math.innerText()).replace(/\s+/g, ' ');
    await qa.shot('board math');
    qa.check('the math counts the two Category 1 entries of this year', /Counted this cycle \(2\)/i.test(mt) && /QA ethics in practice/.test(mt) && /QA neurosurgery update/.test(mt), mt.slice(0, 300));
    qa.check('...and excludes the rest with reasons (category, window, no date)', /Not counting \(3\)/i.test(mt) && /category doesn't count for this board, which needs AMA PRA Category 1/.test(mt) && /outside this cycle window/.test(mt) && /no date on the entry/.test(mt), (mt.match(/Not counting.{0,400}/i) || [''])[0]);
    await page.keyboard.press('Escape');
    await math.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    const find = card.getByRole('button', { name: 'Find CME →' });
    qa.check('the unmet board card offers "Find CME →"', await find.isVisible().catch(() => false));
    if (await find.isVisible().catch(() => false)) {
      await find.click();
      await sleep(900);
      qa.check('it opens Credentials > Find CME', (await pageTitle(page)) === 'Credentials' && await page.locator('[data-desk-search]').count() > 0);
    }
  }, { soft: true });

  await qa.feature('HOME-024', 'Rules changed?: Cancel sends nothing; a report lands in the review queue and says "Sent. Thank you."', async () => {
    const proposals = () => rows(`select section, label, sample, status from public.field_proposals where user_id = '${profile.id}' order by created_at`);
    const tickets = () => rows(`select id from public.support_tickets where user_id = '${profile.id}'`).length;
    const ticketsBefore = tickets();
    await home(page);
    await stateCard(page, 'TX').getByText(/^TX$/).click();
    const math = page.getByRole('dialog', { name: 'TX CME: the math', exact: true });
    await math.waitFor({ timeout: 10000 });
    await math.getByRole('button', { name: 'Rules changed?' }).click();
    let report = page.getByRole('dialog', { name: /^Report a rule change: TX/ });
    await report.waitFor({ timeout: 10000 });
    await report.locator('textarea').fill('QA lab note that should not be sent');
    await report.getByRole('button', { name: 'Cancel' }).click();
    await report.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await sleep(1500);
    qa.check('Cancel sends nothing (no field_proposals row, no ticket)', proposals().length === 0 && tickets() === ticketsBefore, proposals());
    // A report, then the same report again: the review queue keeps one row per
    // (section, wording) (unique index field_proposals_key), so the repeat goes in
    // as a support ticket through create-ticket, as RuleProvenance.jsx's fallback says.
    const note = `QA LAB TEST ${Date.now().toString(36)}, please ignore: Texas ethics hours changed`;
    const send = async () => {
      await math.getByRole('button', { name: 'Rules changed?' }).click();
      const r = page.getByRole('dialog', { name: /^Report a rule change: TX/ });
      await r.waitFor({ timeout: 10000 });
      await r.locator('textarea').fill(note);
      await r.getByPlaceholder('https://').fill('https://qa.credentialdomd.test/rule-notice');
      await r.getByRole('button', { name: 'Send' }).click();
      const ok = await r.getByText('Sent. Thank you.').waitFor({ timeout: 20000 }).then(() => true, () => false);
      await r.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      return ok;
    };
    const sent = await send();
    await qa.shot('rule change sent');
    qa.check('it says "Sent. Thank you."', sent);
    await sleep(1500);
    const p = proposals();
    qa.check('one field_proposals row: rule_change:TX, the note, the link and the citation on file, pending', p.length === 1 && p[0].section === 'rule_change:TX' && p[0].label.includes(note.slice(0, 40)) && /qa\.credentialdomd\.test\/rule-notice/.test(p[0].sample) && /161\.35/.test(p[0].sample) && p[0].status === 'pending', p);
    qa.check('no support ticket was needed (the queue insert succeeded)', tickets() === ticketsBefore);
    const again = await send();
    await sleep(2000);
    const t = rows(`select subject, category, body from public.support_tickets where user_id = '${profile.id}' order by created_at desc limit 1`)[0];
    qa.check('the same report again still says "Sent. Thank you." and lands as a support ticket ("[Rule change] TX", compliance)', again && proposals().length === 1 && tickets() === ticketsBefore + 1 && t?.subject === '[Rule change] TX' && t.category === 'compliance', t ? { subject: t.subject, category: t.category } : 'no ticket');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }, { soft: true });
});
