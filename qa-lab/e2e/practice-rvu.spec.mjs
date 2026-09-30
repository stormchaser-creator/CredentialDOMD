// RVUs and CPT codes, the way a surgeon uses them after a case: look a code
// up (and ask the AI), bill it straight into the RVU log; describe the day's
// work and let the coder turn it into CPT codes (the mock AI answers with a
// scripted coding for exactly that description), adjust, save, see the
// operative codes reach the case log, edit and delete; then slice the RVU log
// by agreement, period and code. A member with Credential only is told billing
// is part of Practice and gets no Bill it.
import { test } from './support/fixtures.mjs';
import { accessSnapshot, goTab, newMember, openMore, row, rows, scriptAi, sleep, stamp, tombstones, waitFor } from './support/lab.mjs';
import { addAgreement, credentialOnlyMember, localDay, subTab, watchAiRequests } from './support/practice-helpers.mjs';

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');
const wr = (codes) => Math.round(codes.reduce((t, c) => t + (Number(c.wRVU) || 0) * (Number(c.units) || 1), 0) * 100) / 100;

/** A code's × button, named "Remove <code>" (43341dc1). */
const removeCode = (code) => ({ name: `Remove ${code}`, exact: true });
/** A review chip (or encounter modal line) for one code: the innermost block holding the code and its × button. */
const codeLine = (scope, code) => {
  const root = typeof scope.page === 'function' ? scope.page() : scope; // `has` is matched inside each candidate, so it is built from the page
  return scope.locator('div').filter({ hasText: new RegExp(`^${code}(?!\\d)`) }).filter({ has: root.getByRole('button', removeCode(code)) }).last();
};

test('practice CPT lookup: search, copy, ask the AI, bill it; a Credential-only member is refused', {
  tag: ['@PRAC-026'],
}, async ({ page, qa, secondBrowser }) => {
  const { profile } = await newMember(page, { firstName: 'Cora', lastName: 'Coder' });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Coding Hospital', shortName: 'QACH', hourlyRate: 250, blocks: [{ start: localDay(-10), end: localDay(30) }] });
  const contract = await waitFor('the agreement', async () => row(`select id from public.locum_contracts where user_id = '${profile.id}'`), { timeoutMs: 20000 });

  await qa.feature('PRAC-026', 'CPT Lookup: results with wRVU, copy, AI lookup, Bill it; Credential-only refused', async () => {
    await openMore(page, 'CPT Lookup');
    const search = page.getByPlaceholder("e.g. 'suboccipital crani' or '61343'");
    await search.fill('61343');
    const hit = page.getByRole('button', { name: /^61343\b/ }).first();
    await hit.waitFor({ timeout: 15000 });
    const hitText = (await hit.innerText()).replace(/\s+/g, ' ');
    await qa.shot('cpt search');
    qa.check('searching 61343 finds it with its wRVU', /61343/.test(hitText) && /31\.06 wRVU/.test(hitText), hitText);
    await hit.click();
    qa.check('tapping a result copies it and says so', /Copied to clipboard/.test(await hit.innerText()));

    const q = `decompression of a chiari malformation ${stamp('q')}`;
    await search.fill(q);
    await scriptAi('gemini', { json: { codes: [
      { code: '61343', description: 'Suboccipital craniectomy with cervical laminectomy for Chiari decompression', confidence: 'high', reasoning: 'QA scripted: posterior fossa decompression' },
      { code: '61345', description: 'Other cranial decompression, posterior fossa', confidence: 'low', reasoning: 'QA scripted alternative' },
    ], notes: '' } }, q);
    await page.getByRole('button', { name: /Ask AI to find CPT codes/ }).click();
    const aiHead = await page.getByText(/AI-Suggested Codes/i).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('cpt ai');
    qa.check('the AI\'s codes are listed with its reasoning', aiHead && /QA scripted: posterior fossa decompression/.test(await bodyText(page)));
    const aiRow = page.getByRole('button', { name: /^61343\b/ }).filter({ hasText: /QA scripted/ }).first();
    const before = rows(`select id from public.encounters where user_id = '${profile.id}'`).length;
    await aiRow.getByRole('button', { name: '+ Bill it' }).click();
    const logged = await aiRow.getByText('✓ Logged').waitFor({ timeout: 5000 }).then(() => true, () => false);
    qa.check('"+ Bill it" answers "✓ Logged"', logged);
    const enc = await waitFor('the encounter', async () => { const r = rows(`select * from public.encounters where user_id = '${profile.id}' order by created_at`); return r.length > before ? r.at(-1) : null; }, { timeoutMs: 15000 }).catch(() => null);
    qa.check('an RVU encounter for 61343 today on the one current agreement', enc?.codes?.[0]?.code === '61343' && enc.date === localDay(0) && enc.contract_id === contract.id, enc && { codes: enc.codes, date: enc.date, contract: enc.contract_id });
    if (!qa.check('with the catalog wRVU (the AI\'s answer carried none)', Number(enc?.codes?.[0]?.wRVU) === 31.06, enc?.codes)) {
      qa.bug({
        title: 'CPT Lookup: "+ Bill it" on an AI-suggested code logs it at 0 wRVU',
        step: 'More > CPT Lookup: type a procedure, tap "Ask AI to find CPT codes", tap "+ Bill it" on a suggested code that is in the catalog (61343, 31.06 wRVU)',
        expected: 'The RVU encounter carries the code\'s catalog wRVU, as "+ Bill it" on a search result does',
        actual: `The encounter is saved with wRVU ${enc?.codes?.[0]?.wRVU}: the AI rows are passed to logToBilling as the AI returned them (src/components/features/CPTLookup.jsx:282), which has no wRVU, and logToBilling writes c.wRVU || 0 (line 91). The RVU log and its totals count it as 0.00; Save changes on the encounter keeps the 0 (RVULog.jsx:707 uses c.wRVU ?? catalog)`,
        severity: 'medium',
      });
    }

    // A member whose membership is Credential only. Since b00393fa the page does not offer
    // "+ Bill it" where Practice is read-only (CPTLookup.jsx billingClosed); a note says why. A
    // bought Credential membership is told Practice is not part of it and offered support
    // (credentialOnlyMembership: purchasedOfferId "core"); the lab's member holds Credential as a
    // lifetime grant, not a purchase, and is told Practice is read-only on this account. The note
    // appears once the membership check has answered, so it is waited on first.
    const { page: b } = await secondBrowser();
    const other = await credentialOnlyMember(b, { firstName: 'Cleo', lastName: 'Credential' });
    const dialogsBefore = qa.report.dialogs.length;
    await openMore(b, 'CPT Lookup');
    const note = b.getByRole('note').filter({ hasText: /part of Practice/ });
    const noteShown = await note.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const noteText = noteShown ? (await note.innerText()).replace(/\s+/g, ' ') : '';
    await b.getByPlaceholder("e.g. 'suboccipital crani' or '61343'").fill('61343');
    const bHit = b.getByRole('button', { name: /^61343\b/ }).first();
    await bHit.waitFor({ timeout: 15000 });
    const bHitText = (await bHit.innerText()).replace(/\s+/g, ' ');
    await sleep(500);
    const billButtons = await b.getByRole('button', { name: '+ Bill it', exact: true }).count();
    qa.check('the Credential-only member can still search: 61343 is listed with its wRVU', /31\.06 wRVU/.test(bHitText), bHitText);
    if (!qa.check('there is no "+ Bill it" for a Credential-only member', billButtons === 0, `${billButtons} "+ Bill it" button(s)`)) {
      qa.bug({
        title: 'CPT Lookup offers "+ Bill it" to a Credential-only member',
        step: 'As a member whose membership is Credential only (no Practice): More > CPT Lookup, search 61343',
        expected: 'No "+ Bill it" on the result, and a note that billing is part of Practice, which a Credential membership does not include',
        actual: `${billButtons} "+ Bill it" button(s) shown; the note ${noteShown ? `reads "${noteText}"` : 'is not shown'}. CPTLookup.jsx hides the button when billingClosed (limitedLaunch enabled and practiceReadOnly)`,
        severity: 'low',
      });
    }
    const snap = accessSnapshot(other.user.id);
    qa.check('the member holds Credential without Practice (server snapshot: Credential writable, Practice read-only)', snap?.capabilities?.credential?.write === true && snap?.capabilities?.practice?.write === false,
      JSON.stringify({ purchased: snap?.purchasedOfferId, lifetime: snap?.lifetime, practiceIncluded: snap?.practiceIncluded, capabilities: snap?.capabilities }));
    const bought = snap?.purchasedOfferId === 'core' && snap.practiceIncluded !== true && snap.lifetime?.practice !== true;
    const why = bought ? /part of Practice, and your Credential membership does not include it/ : /part of Practice, which is read-only on this account/;
    qa.check(`the page says why billing is closed: ${bought ? 'the Credential membership does not include Practice' : 'Practice is read-only on this account'}`, noteShown && why.test(noteText), noteText || (await bodyText(b)).slice(0, 300));
    if (bought) qa.check('it offers "Contact support about adding Practice"', await b.getByRole('link', { name: 'Contact support about adding Practice' }).isVisible().catch(() => false));
    const said = qa.report.dialogs.slice(dialogsBefore).join(' | ');
    qa.check('no refusal alert is raised (there is nothing to refuse)', !said, said);
    qa.check('no encounter is written for that member', rows(`select id from public.encounters where user_id = '${other.profile.id}'`).length === 0);
  }, { soft: true });
});

test('practice RVU log: code a case, adjust, save to the case log, add one anyway, edit, delete; filters and totals', {
  tag: ['@PRAC-013', '@PRAC-023'],
}, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Remy', lastName: 'Rvu' });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Coding Hospital', shortName: 'QACH', hourlyRate: 250, blocks: [{ start: localDay(-10), end: localDay(30) }] });
  const qach = await waitFor('the agreement', async () => row(`select id from public.locum_contracts where user_id = '${profile.id}'`), { timeoutMs: 20000 });
  const sent = watchAiRequests(page);
  const encounters = (where = '') => rows(`select * from public.encounters where user_id = '${profile.id}' ${where} order by created_at`);
  const caseLogs = () => rows(`select * from public.case_logs where user_id = '${profile.id}' order by created_at`);
  let operative;

  await qa.feature('PRAC-013', 'Code an encounter, adjust the codes, save to the RVU and case logs, edit, delete', async () => {
    await subTab(page, 'RVUs');
    const box = page.getByPlaceholder(/New ED consult for acute subdural/);
    const tag = stamp('rvu');
    await box.fill(`${tag}: craniotomy for evacuation of an acute subdural hematoma, after a high complexity inpatient consult`);
    await scriptAi('gemini', { json: { encounters: [
      { code: '61312', units: 1, why: 'craniotomy for subdural' },
      { code: '99223', units: 1, why: 'initial inpatient consult, high' },
      { code: '61154', units: 1, why: 'burr hole evacuation (the coder\'s guess)' },
    ], questions: [], confidence: 'high' } }, tag);
    const usageBefore = rows(`select id from public.ai_usage where user_id = '${profile.id}'`).length;
    await page.getByRole('button', { name: 'Code it' }).click();
    const reviewed = await codeLine(page, '61312').waitFor({ timeout: 45000 }).then(() => true, () => false);
    await qa.shot('coded');
    qa.check('the AI returns CPT codes with wRVU for review', reviewed && /29\.42 wRVU × 1/.test(await codeLine(page, '61312').innerText()));
    await codeLine(page, '99223').getByRole('button', { name: 'More units of 99223', exact: true }).click();
    qa.check('+ adds a unit', /3\.50 wRVU × 2/.test(await codeLine(page, '99223').innerText()));
    await codeLine(page, '99223').getByRole('button', { name: 'Fewer units of 99223', exact: true }).click();
    await codeLine(page, '61154').getByRole('button', removeCode('61154')).click();
    qa.check('× removes a code', !(await codeLine(page, '61154').isVisible().catch(() => false)));
    await page.getByPlaceholder('Type a CPT code (e.g. 61312) or name to add it').fill('62223');
    await page.getByRole('button', { name: /^62223\b/ }).first().click();
    qa.check('a code typed in is added', await codeLine(page, '62223').isVisible());
    await page.locator('label', { hasText: /Case log category/ }).locator('xpath=..').locator('select').selectOption('Cranial: Trauma/Other');
    const saveBtn = page.getByRole('button', { name: /^Save [\d.]+ wRVU$/ });
    qa.check('the save button totals 46.62 wRVU (61312 + 99223 + 62223)', /46\.62/.test(await saveBtn.innerText()), await saveBtn.innerText());
    await saveBtn.click();
    operative = await waitFor('the encounter', async () => encounters()[0] || null, { timeoutMs: 20000 }).catch(() => null);
    qa.check('an encounters row today on the agreement with the three codes', operative?.date === localDay(0) && operative.contract_id === qach.id && (operative.codes || []).map((c) => c.code).join() === '61312,99223,62223' && wr(operative.codes) === 46.62, operative && { date: operative.date, codes: operative.codes.map((c) => `${c.code}x${c.units}@${c.wRVU}`) });
    const cl = await waitFor('the case log', async () => caseLogs()[0] || null, { timeoutMs: 15000 }).catch(() => null);
    qa.check('the operative codes land in the case log, with the category, wRVU and a link to the encounter', cl?.cpt_codes === '61312, 62223' && Number(cl.w_rvu) === 43.12 && cl.category === 'Cranial: Trauma/Other' && cl.custom_fields?.['From RVU entry'] === operative?.id, cl && { cpt: cl.cpt_codes, w_rvu: cl.w_rvu, category: cl.category, from: cl.custom_fields });
    qa.check('the note says the operative codes went to the case log', /2 operative codes also went to your case log/.test(await bodyText(page)));
    const usage = rows(`select provider, ok from public.ai_usage where user_id = '${profile.id}'`);
    qa.check('the coder call is metered (ai_usage)', usage.length > usageBefore, usage.slice(-1));

    // Evaluation and management only: saved, then added to the case log anyway.
    const tag2 = stamp('em');
    await box.fill(`${tag2}: high complexity inpatient consult for a synthetic spine patient`);
    await scriptAi('gemini', { json: { encounters: [{ code: '99223', units: 1, why: 'initial inpatient consult, high' }], questions: [], confidence: 'high' } }, tag2);
    await page.getByRole('button', { name: 'Code it' }).click();
    await codeLine(page, '99223').waitFor({ timeout: 45000 });
    await page.getByRole('button', { name: /^Save 3\.50 wRVU$/ }).click();
    const note = await page.getByText(/evaluation and management codes, so nothing went to the career case log/).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('an E/M-only save says nothing went to the case log', note);
    await page.getByRole('button', { name: 'Add it to my case log anyway' }).click();
    const anyway = await waitFor('the added case log', async () => caseLogs().find((c) => c.cpt_codes === '99223') || null, { timeoutMs: 15000 }).catch(() => null);
    qa.check('"Add it to my case log anyway" adds it', !!anyway && /Added to your case log/.test(await bodyText(page)), anyway && { cpt: anyway.cpt_codes, w_rvu: anyway.w_rvu });

    // Identifiers in the dictation.
    const tag3 = stamp('phi');
    const withId = `${tag3}: MRN 4455667 DOB 3/4/1950, burr hole evacuation of a chronic subdural`;
    await box.fill(withId);
    await scriptAi('gemini', { json: { encounters: [{ code: '61154', units: 1, why: 'burr hole' }], questions: [], confidence: 'high' } }, tag3);
    await page.getByRole('button', { name: 'Code it' }).click();
    const coded = await codeLine(page, '61154').waitFor({ timeout: 20000 }).then(() => true, () => false);
    const reached = sent.some((b) => b.includes('MRN 4455667'));
    let stored = null;
    if (coded) {
      await page.getByRole('button', { name: /^Save [\d.]+ wRVU$/ }).click();
      stored = await waitFor('the encounter with the dictation', async () => encounters(`and spoken_text like '%${tag3}%'`)[0] || null, { timeoutMs: 15000 }).catch(() => null);
    }
    await qa.shot('dictation with an identifier');
    const shielded = qa.check('a dictation naming an MRN and a date of birth is refused before it reaches the AI or the cloud', !reached && !stored, { sentToAi: reached, spoken_text: stored?.spoken_text });
    if (!shielded) {
      qa.bug({
        title: 'RVU log: a dictation with a patient\'s MRN and date of birth goes to the AI coder and is stored in encounters.spoken_text',
        step: 'Practice > RVUs: type "MRN 4455667 DOB 3/4/1950, burr hole evacuation of a chronic subdural"; Code it; Save',
        expected: 'Refused with the reason before anything leaves the device (the app\'s rule: no patient identifiers in synced data or AI requests), the text kept to edit',
        actual: `The words went to ai-proxy (${reached ? 'seen in the request body' : 'not seen'}) and the saved encounter's spoken_text is ${JSON.stringify(stored?.spoken_text || null)}: runCoder (src/components/features/locum/RVULog.jsx:151) sends the text as typed and save (line 198) writes it to spokenText with no identifier check`,
        severity: 'high',
      });
    }
    if (stored) {
      // Delete the encounter that carries the (synthetic) identifier, as the physician would.
      await page.getByRole('button').filter({ hasText: /61154/ }).last().getByRole('button', { name: 'Delete encounter', exact: true }).click();
      await waitFor('the identifier encounter deleted', async () => (!row(`select id from public.encounters where id = '${stored.id}'`) ? true : null), { timeoutMs: 15000 }).catch(() => null);
    }

    // Edit the operative encounter's codes: 62223 out, 61313 in; save; reload.
    await page.getByRole('button').filter({ hasText: /61312/ }).filter({ hasText: /62223/ }).last().click();
    const m = page.getByRole('dialog', { name: 'Encounter' });
    await m.waitFor();
    await codeLine(m, '62223').getByRole('button', removeCode('62223')).click();
    await m.getByRole('textbox', { name: 'Add a code', exact: true }).fill('61313');
    await m.getByRole('button', { name: /^61313\b/ }).first().click();
    await m.getByRole('button', { name: 'Save changes' }).click();
    await m.waitFor({ state: 'detached', timeout: 10000 });
    const edited = await waitFor('the edit', async () => { const r = row(`select * from public.encounters where id = '${operative.id}'`); return (r?.codes || []).some((c) => c.code === '61313') ? r : null; }, { timeoutMs: 15000 }).catch(() => row(`select * from public.encounters where id = '${operative.id}'`));
    qa.check('the edit persists: 61312, 99223, 61313', (edited?.codes || []).map((c) => c.code).join() === '61312,99223,61313' && wr(edited.codes) === 60.31, edited?.codes?.map((c) => c.code));
    const clAfter = row(`select cpt_codes, w_rvu from public.case_logs where custom_fields->>'From RVU entry' = '${operative.id}'`);
    if (!qa.check('the case log it created follows the edit (61312, 61313)', clAfter?.cpt_codes === '61312, 61313' && Number(clAfter.w_rvu) === 56.81, clAfter)) {
      qa.bug({
        title: 'RVU log: editing an encounter\'s codes leaves the case log it created at the old codes and wRVU',
        step: 'Practice > RVUs: save an operative encounter (it lands in Case Logs); open it; replace a code; Save changes',
        expected: 'The linked case log shows the new codes and wRVU (the encounter and its case record agree)',
        actual: `The case log still reads ${clAfter?.cpt_codes} at ${clAfter?.w_rvu} wRVU: Save changes (src/components/features/locum/RVULog.jsx:707-719) rewrites the linked case log only when the contract changed, and then only its facility and date`,
        severity: 'medium',
      });
    }

    // Delete it, confirmed.
    const card = page.getByRole('button').filter({ hasText: /61313/ }).last();
    await card.getByRole('button', { name: 'Delete encounter', exact: true }).click();
    await sleep(1500);
    qa.check('the delete asks "Delete this encounter?"', qa.report.dialogs.some((d) => /Delete this encounter\?/.test(d)));
    qa.check('the encounter is gone and tombstoned', !row(`select id from public.encounters where id = '${operative.id}'`) && tombstones(profile.id).some((t) => t.item_id === operative.id));
  }, { soft: true });

  await qa.feature('PRAC-023', 'Review and filter encounters: stat tiles, agreement chips, period, code text', async () => {
    // A second agreement, and an encounter under it 40 days ago, added by code.
    await subTab(page, 'Contracts');
    await addAgreement(page, { facility: 'QA Filter Hospital', shortName: 'QAFH', hourlyRate: 250, blocks: [{ start: localDay(-45), end: localDay(-35) }] });
    const qafh = await waitFor('the second agreement', async () => row(`select id from public.locum_contracts where user_id = '${profile.id}' and short_name = 'QAFH'`), { timeoutMs: 20000 });
    await subTab(page, 'RVUs');
    await page.getByPlaceholder('Type a CPT code (e.g. 61312) or name to add it').fill('61154');
    await page.getByRole('button', { name: /^61154\b/ }).first().click();
    await codeLine(page, '61154').waitFor();
    const dateInput = page.locator('input[type="date"]').first();
    await dateInput.fill(localDay(-40));
    await sleep(300);
    const picked = await page.locator('select').filter({ has: page.locator('option', { hasText: 'QAFH' }) }).first().inputValue().catch(() => null);
    qa.check('dating it 40 days ago picks the agreement in force then', picked === qafh.id, picked);
    await page.getByRole('button', { name: /^Save 16\.64 wRVU$/ }).click();
    await waitFor('the dated encounter', async () => encounters(`and date = '${localDay(-40)}'`)[0] || null, { timeoutMs: 15000 });
    await sleep(1000);
    const all = encounters();
    const summary = async () => {
      const t = await bodyText(page);
      const m = /(\d+) encounters? · (\d+) days?\s*\n?\s*([\d.]+) wRVU/.exec(t);
      return m ? { n: Number(m[1]), days: Number(m[2]), total: Number(m[3]) } : { raw: t.match(/\d+ encounters?[^\n]*/)?.[0] };
    };
    const expect = (list) => ({ n: list.length, days: new Set(list.map((e) => e.date)).size, total: wr(list.flatMap((e) => e.codes || [])) });
    const recent = all.filter((e) => e.date >= localDay(-30));
    let s = await summary();
    await qa.shot('rvu filters default');
    qa.check('the default slice (30 days, all agreements) counts and totals the recent encounters', JSON.stringify(s) === JSON.stringify(expect(recent)), { shown: s, db: expect(recent) });
    await page.locator('select').filter({ has: page.locator('option', { hasText: '90 days' }) }).first().selectOption('90d');
    s = await summary();
    qa.check('90 days brings in the older one', JSON.stringify(s) === JSON.stringify(expect(all)), { shown: s, db: expect(all) });
    await page.getByRole('button', { name: 'QAFH', exact: true }).click();
    s = await summary();
    qa.check('the QAFH chip shows only that agreement\'s encounter', JSON.stringify(s) === JSON.stringify(expect(all.filter((e) => e.contract_id === qafh.id))), s);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByPlaceholder('Filter by code or description').fill('99223');
    s = await summary();
    qa.check('code text 99223 keeps only encounters with that code', JSON.stringify(s) === JSON.stringify(expect(all.filter((e) => (e.codes || []).some((c) => c.code === '99223')))), s);
    await page.getByPlaceholder('Filter by code or description').fill('');
    // The stat tiles.
    const monthKey = localDay(0).slice(0, 7);
    const monthList = all.filter((e) => (e.date || '').startsWith(monthKey));
    await page.getByRole('button', { name: /^This month/ }).click();
    const dm = page.getByRole('dialog', { name: 'This month' });
    await dm.waitFor();
    const dmText = (await dm.innerText()).replace(/\s+/g, ' ');
    await qa.shot('rvu this month');
    const older = all.filter((e) => !(e.date || '').startsWith(monthKey));
    qa.check('"This month" lists every encounter behind its total and none from another month', monthList.every((e) => (e.codes || []).every((c) => dmText.includes(c.code))) && older.every((e) => (e.codes || []).every((c) => monthList.some((x) => (x.codes || []).some((y) => y.code === c.code)) || !dmText.includes(c.code))), dmText.slice(0, 400));
    await page.keyboard.press('Escape');
    const tile = (await page.getByRole('button', { name: /^All time/ }).innerText()).replace(/\s+/g, ' ');
    qa.check('the All time tile totals every encounter', tile.includes(wr(all.flatMap((e) => e.codes || [])).toFixed(2)), { tile, db: wr(all.flatMap((e) => e.codes || [])) });
  }, { soft: true });
});
