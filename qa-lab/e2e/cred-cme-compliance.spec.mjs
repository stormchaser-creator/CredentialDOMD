// CME Credits against the rules: the transcript PDF (one state, then a picker
// with two states and a board), the compliance cards against the database,
// the desk table grouped by each state's cycle against Home, a conditional
// topic answered on the license, a CME cycle start set on a license (and one
// that falls on the renewal date), and Find CME's search, filters and links.
import { test } from './support/fixtures.mjs';
import {
  chooseFiles, goTab, newMember, openCredentials, openMore, row, sleep, syntheticPng, tableRow, waitForMemberApp,
} from './support/lab.mjs';
import {
  addCme, addLicense, day, dbWait, download, fillField, openAdd, pdfText, saveDialog, stubExternalPages,
} from './support/cred-helpers.mjs';
import { CME_PROVIDERS } from '../../src/constants/cmeProviders.js';

const OH_EXP = day(300);
const CO_EXP = day(100);
const QUESTION = 'Do you own or provide care at an Ohio pain management clinic covered by this rule?';

/** A date string minus whole years (the engine's cycle start: setFullYear - N). */
const yearsBack = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };

/** Home's CME Progress cards: state -> "Total logged: x/yh" and the card's text. */
async function homeCmeCards(page) {
  await goTab(page, 'Home');
  await page.getByText('CME Progress').first().waitFor({ timeout: 20000 }).catch(() => {});
  return page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('span')) {
      if (!/^Total logged: [\d.]+\/\d+h$/.test(el.textContent.trim())) continue;
      let card = el;
      for (let i = 0; i < 6 && card; i++) { card = card.parentElement; if (card && /^[A-Z]{2}\b/.test(card.innerText.trim()) && card.innerText.includes('Counting CME dated')) break; }
      if (!card) continue;
      const st = card.innerText.trim().slice(0, 2);
      out[st] = { total: el.textContent.trim(), text: card.innerText };
    }
    return out;
  });
}

/** The CME Compliance card of one state (CME Credits, desk width): its text. */
async function complianceCard(page, st) {
  return page.evaluate((state) => {
    const bars = [...document.querySelectorAll('div')].filter((d) => d.children.length && /^Total logged hours/.test(d.innerText.trim()));
    for (const b of bars) {
      let card = b;
      for (let i = 0; i < 6 && card; i++) { card = card.parentElement; if (card && new RegExp(`^${state}\\b`).test(card.innerText.trim())) return card.innerText; }
    }
    return '';
  }, st);
}

/** The desk table's group subtotal rows (CME Credits): label and hours text. */
async function cmeSubtotals(page) {
  return page.evaluate(() => [...document.querySelectorAll('tr.cmd-desk-subtotal')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
}

test('CME against the rules: transcript PDF, compliance cards, cycle grouping, conditional topic, cycle start, Find CME', {
  tag: ['@CRED-011', '@CRED-012', '@CRED-033', '@CRED-029', '@CRED-013', '@CRED-034'],
}, async ({ page, context, qa }) => {
  test.setTimeout(18 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Olive', lastName: 'Compliance' });
  const pid = profile.id;
  const dbHours = (from, to) => Number(row(`select coalesce(sum(hours), 0) as h from public.cme where user_id = '${pid}' and date between '${from}' and '${to}'`).h);

  // The physician's degree, an Ohio license and four CME entries (one dated before any window, one undated).
  await openMore(page, 'Profile & settings');
  await page.getByRole('button', { name: /^MD\s*Doctor of Medicine/ }).click();
  await sleep(1500);
  let r = await addLicense(page, { name: 'QA Ohio License', number: 'QA-OH-4401', state: 'OH', issued: '2024-01-15', expires: OH_EXP });
  qa.check('setup: Ohio license saved', r.closed, r.refusal);
  for (const e of [
    { title: 'QA Neurosurgery Board Review', hours: 10, date: day(-100), provider: 'QA Board Review Course' },
    { title: 'QA Spine Trauma Update', hours: 2, date: day(-30), provider: 'QA Trauma Society' },
    { title: 'QA Older Skull Base Course', hours: 4, date: day(-600), provider: 'QA Skull Base Society' },
    { title: 'QA Undated Grand Rounds', hours: 1, date: '' },
  ]) {
    r = await addCme(page, e);
    qa.check(`setup: CME "${e.title}" saved`, r.closed, r.refusal);
  }
  // A certificate image on the trauma entry (edit, Upload).
  await openCredentials(page, 'CME Credits');
  await tableRow(page, 'QA Spine Trauma Update').getByRole('cell').nth(1).click();
  const edit = page.getByRole('dialog', { name: 'Edit CME' });
  await edit.waitFor({ timeout: 15000 });
  await chooseFiles(page, edit.getByRole('button', { name: 'Upload' }).first(), [{ name: 'qa-trauma-certificate.png', mimeType: 'image/png', buffer: syntheticPng() }]);
  await edit.getByText('qa-trauma-certificate.png').first().waitFor({ timeout: 30000 }).catch(() => {});
  await sleep(1500);
  r = await saveDialog(edit, { name: /^Save$/ });
  qa.check('setup: certificate attached to the trauma entry', r.closed, r.refusal);
  await sleep(3000);
  const trauma = row(`select id from public.cme where user_id = '${pid}' and title = 'QA Spine Trauma Update'`);
  const cert = await dbWait('the certificate row', () => row(`select name, storage_path from public.documents where linked_to = 'cme:${trauma?.id}'`), 30000);
  qa.check('setup: the certificate is stored and linked "cme:<id>"', !!cert?.storage_path, cert);

  await qa.feature('CRED-011', 'Transcript PDF with one state and no board: built straight away, window, requirements, entries, certificate', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'CME Credits');
    await sleep(3000);
    const { name, buffer } = await download(page, page.getByRole('button', { name: 'Transcript PDF' }));
    qa.check('no picker: one state and no board builds the PDF at once', !(await page.getByRole('dialog', { name: 'Transcript PDF' }).count()), name);
    const pdf = await pdfText(buffer);
    const t = pdf.text;
    qa.check('the file is the Ohio transcript', /^CME-Transcript-OH-\d{4}-\d{2}-\d{2}\.pdf$/.test(name) && /Ohio medical license renewal/.test(t), name);
    qa.check('it prints the cycle window and the requirements', /REQUIREMENTS/.test(t) && /2-year cycle ending at license expiration/.test(t) && /50/.test(t), t.slice(0, 400));
    qa.check('every entry in the window is listed (2), none outside it', /CME ACTIVITIES IN WINDOW \(2\)/.test(t) && /QA Neurosurgery Board Review/.test(t) && /QA Spine Trauma Update/.test(t) && !/QA Older Skull Base Course/.test(t) && !/QA Undated Grand Rounds/.test(t), t.match(/CME ACTIVITIES IN WINDOW \(\d+\)/)?.[0]);
    const embedded = /File: qa-trauma-certificate\.png/.test(t);
    const noted = (t.match(/Cert 1 = qa-trauma-certificate\.png \(([^)]*)\)/) || [])[1] || '';
    qa.check('the linked certificate is embedded as a page (after a reload, as a physician opens the app)', embedded, noted || `pages ${pdf.pages}`);
    if (!embedded && /not on this device/.test(noted)) {
      qa.bug({
        title: 'CME transcript PDF: an attached certificate is left out ("on file in cloud storage; not on this device") after the app is reopened',
        step: 'Attach a certificate image to a CME entry; reload the app; CME Credits > Transcript PDF',
        expected: 'The certificate is embedded as a page, as the picker and the checklist promise ("linked certificates as pages")',
        actual: `The PDF's note says "Cert 1 = qa-trauma-certificate.png (${noted})" and no certificate page follows: after a load the document has no bytes on the device (they live in Storage) and assignCertificates marks it "remote" without fetching it (src/utils/cmeTranscriptPdf.js:92). Fixed on fix/qa-cred-home (7047ba2c, da0341e0: certificates fetched before the PDF is built)`,
        severity: 'medium',
      });
    }
  }, { soft: true });

  // A second state (its window reaches the older course) and a board certification.
  r = await addLicense(page, { name: 'QA Colorado License', number: 'QA-CO-5502', state: 'CO', issued: '2022-01-10', expires: CO_EXP });
  qa.check('setup: Colorado license saved', r.closed, r.refusal);
  {
    const dlg = await openAdd(page, 'Licenses');
    await fillField(dlg, 'Type', 'Board Certification (ABMS)');
    await fillField(dlg, /^(Display Name|What Is It In\?)/, 'ABNS Neurological Surgery');
    await fillField(dlg, 'License #', 'QA-ABNS-900');
    await dlg.getByRole('checkbox', { name: 'This certificate does not expire' }).check();
    r = await saveDialog(dlg);
    qa.check('setup: board certification (ABNS) saved', r.closed, r.refusal);
  }
  const ohStart = yearsBack(OH_EXP, 2);
  const coStart = yearsBack(CO_EXP, 2);

  await qa.feature('CRED-012', 'Compliance cards: state and board totals match the database; Find CME and a topic\'s Find', async () => {
    await openCredentials(page, 'CME Credits');
    const oh = await complianceCard(page, 'OH');
    const co = await complianceCard(page, 'CO');
    await qa.shot('compliance cards');
    const ohDb = dbHours(ohStart, OH_EXP);
    const coDb = dbHours(coStart, CO_EXP);
    qa.check(`Ohio card total equals the database sum in its window (${ohDb} of 50)`, new RegExp(`Total logged hours\\s*${ohDb}/50 hrs`).test(oh), oh.match(/Total logged hours\s*[^\n]*\n?[^\n]*/)?.[0]);
    qa.check(`Colorado card total equals the database sum in its window (${coDb} of 30)`, new RegExp(`Total logged hours\\s*${coDb}/30 hrs`).test(co), co.match(/Total logged hours\s*[^\n]*\n?[^\n]*/)?.[0]);
    qa.check('the cards print their counting windows', /Counting CME dated/.test(oh) && /Counting CME dated/.test(co));
    qa.check('Ohio shows its Ethics topic bar (0 of 1)', /Ethics\s*0\/1 hrs/.test(oh), oh.match(/Ethics[^\n]*\n?[^\n]*/)?.[0]);
    const body = await page.locator('main, body').first().innerText();
    const board = body.match(/Neurological Surgery, ABMS ABNS\s*([\d.]+)\/(\d+) hrs/);
    qa.check('a Board MOC card for ABNS (from the board certification record) with a progress bar', !!board, body.match(/Board MOC[\s\S]{0,200}/)?.[0]);
    qa.check('no AOA card for an MD', !/AOA National/.test(body));
    // The Compliance button hides and shows the cards.
    await page.getByRole('button', { name: 'Compliance', exact: true }).click();
    const hidden = !(await complianceCard(page, 'OH'));
    await page.getByRole('button', { name: 'Compliance', exact: true }).click();
    qa.check('"Compliance" hides the cards and shows them again', hidden && !!(await complianceCard(page, 'OH')));
    // Find CME Courses (total not met) and the topic's Find button.
    await page.getByRole('button', { name: /Find CME Courses/ }).first().click();
    qa.check('"Find CME Courses" opens Find CME', await page.getByRole('heading', { name: 'Find CME Courses' }).waitFor({ timeout: 10000 }).then(() => true, () => false));
    await openCredentials(page, 'CME Credits');
    await page.getByRole('button', { name: /Find CME for Ethics/ }).click();
    await page.getByRole('heading', { name: 'Find CME Courses' }).waitFor({ timeout: 10000 });
    const count = Number(((await page.locator('main, body').first().innerText()).match(/(\d+) providers?/) || [])[1]);
    const ethics = CME_PROVIDERS.filter((p) => p.topics.includes('Ethics')).length;
    await qa.shot('find cme ethics');
    qa.check(`the topic's Find opens Find CME filtered to Ethics (${ethics} providers)`, count === ethics && /All Providers/.test(await page.locator('main, body').first().innerText()), `${count} shown`);
  }, { soft: true });

  await qa.feature('CRED-033', 'CME desk table grouped by each state\'s cycle: in-window subtotal equals the Home card', async () => {
    const home = await homeCmeCards(page);
    await openCredentials(page, 'CME Credits');
    const chips = page.locator('button[title^="Group entries by the"]');
    qa.check('two tracked states give two Cycle chips', (await chips.count()) === 2, await chips.allInnerTexts());
    for (const [st, name, homeKey] of [['OH', 'Ohio', 'OH'], ['CO', 'Colorado', 'CO']]) {
      await page.locator(`button[title="Group entries by the ${name} renewal cycle"]`).click();
      await sleep(400);
      const subs = await cmeSubtotals(page);
      const inWin = subs.find((x) => x.startsWith(`In the ${st} cycle window`)) || '';
      const hrs = (inWin.match(/ ([\d.]+) of (\d+) required/) || [])[1];
      const homeTotal = (home[homeKey]?.total.match(/Total logged: ([\d.]+)\//) || [])[1];
      await qa.shot(`cme grouped ${st}`);
      const outside = dbHours('1900-01-01', '2999-12-31') - Number(hrs || 0) - 1; // every dated hour not in this window (the undated hour aside)
      qa.check(`${st}: rows grouped in-window${outside > 0 ? ', outside the window' : ''} and undated`, !!inWin && subs.some((x) => /^No date · 1 entry/.test(x)) && (outside > 0) === subs.some((x) => /^(Before|After) the .* cycle window/.test(x)), subs);
      qa.check(`${st}: the in-window subtotal (${hrs}) equals the Home card total (${homeTotal})`, !!hrs && hrs === homeTotal, { inWin, home: home[homeKey]?.total });
    }
  }, { soft: true });

  await qa.feature('CRED-011', 'Transcript PDF picker: each state and the board, with their entries', async () => {
    await openCredentials(page, 'CME Credits');
    await page.getByRole('button', { name: 'Transcript PDF' }).click();
    const picker = page.getByRole('dialog', { name: 'Transcript PDF' });
    const opened = await picker.waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('with two states the picker opens', opened);
    if (!opened) return;
    const text = await picker.innerText();
    await qa.shot('transcript picker');
    qa.check('the picker lists each state with its window and entry count', /Ohio \(OH\)[\s\S]*2 entries in window/.test(text) && /Colorado \(CO\)[\s\S]*3 entries in window/.test(text), text.slice(0, 500));
    const boardListed = /Board continuing certification/i.test(text) && /Neurological Surgery/.test(text);
    qa.check('the picker lists the board the CME page shows a Board MOC card for (ABNS)', boardListed, text.slice(0, 600));
    if (!boardListed) {
      qa.bug({
        title: 'CME transcript PDF: a board recorded as a Board Certification license gets a Board MOC card but no board transcript',
        step: 'Licenses: add "Board Certification (ABMS)" named "ABNS Neurological Surgery"; CME Credits shows a Board MOC card for it; tap Transcript PDF',
        expected: 'The picker offers the ABNS board transcript beside the state renewals',
        actual: 'Only the state renewals are listed. The CME page merges boards from license records (boardIdsFromLicenses, src/components/features/CMESection.jsx:220-221), but boardTranscriptOptions calls computeBoardCompliance(data), which reads settings.specialties only (src/utils/cmeTranscriptPdf.js:177-178, src/utils/boardCompliance.js:41). Fixed on fix/qa-cred-home (6f180604)',
        severity: 'medium',
      });
    }
    const { name, buffer } = await download(page, picker.getByRole('button', { name: /Colorado \(CO\)/ }));
    const t = (await pdfText(buffer)).text;
    qa.check('picking Colorado builds its transcript with its 3 entries in window', /CME-Transcript-CO-/.test(name) && /Colorado medical license renewal/.test(t) && /CME ACTIVITIES IN WINDOW \(3\)/.test(t) && /QA Older Skull Base Course/.test(t), t.match(/CME ACTIVITIES IN WINDOW \(\d+\)/)?.[0]);
    if (boardListed) {
      await page.getByRole('button', { name: 'Transcript PDF' }).click();
      await picker.waitFor({ timeout: 10000 });
      const b = await download(page, picker.getByRole('button', { name: /Neurological Surgery/ }).first());
      const bt = (await pdfText(b.buffer)).text;
      qa.check('picking the board builds the board transcript', /Neurological Surgery/.test(bt), b.name);
    }
    await page.keyboard.press('Escape').catch(() => {});
  }, { soft: true });

  await qa.feature('CRED-029', 'Answer a conditional CME topic (Ohio pain clinic): the answer persists and changes the requirement', async () => {
    await openCredentials(page, 'CME Credits');
    let oh = await complianceCard(page, 'OH');
    qa.check('before answering, the conditional pain-clinic rule is shown as awaiting confirmation and not counted', /Pain Management: confirm applicability/.test(oh) && !/Pain Management\s*\d+\/20 hrs/.test(oh), oh.match(/Pain Management[^\n]*/)?.[0]);
    await page.getByRole('combobox', { name: QUESTION }).first().selectOption('Yes');
    await sleep(2500);
    oh = await complianceCard(page, 'OH');
    qa.check('answering Yes adds the 20-hour Pain Management requirement', /Pain Management: applies per your selection/.test(oh) && /Pain Management\s*0\/20 hrs/.test(oh), oh.match(/Pain Management[^\n]*\n?[^\n]*/g));
    const lic = row(`select custom_fields from public.licenses where user_id = '${pid}' and license_number = 'QA-OH-4401'`);
    qa.check('the answer is saved on the Ohio license (licenses.custom_fields)', lic?.custom_fields?.['Ohio pain clinic CME applies'] === 'Yes', lic?.custom_fields);
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'CME Credits');
    const sel = page.getByRole('combobox', { name: QUESTION }).first();
    qa.check('after a reload the answer is still Yes and the requirement still shown', (await sel.inputValue()) === 'Yes' && /Pain Management\s*0\/20 hrs/.test(await complianceCard(page, 'OH')));
    await qa.shot('conditional topic answered');
  }, { soft: true });

  await qa.feature('CRED-013', 'CME Cycle Start on a license: the window starts there ("Start set on this license"); one on the renewal date is ignored with a warning', async () => {
    const setStart = async (value) => {
      await openCredentials(page, 'Licenses');
      await tableRow(page, 'QA-OH-4401').getByRole('cell').last().getByRole('button').nth(2).click();
      const dlg = page.getByRole('dialog', { name: 'Edit' });
      await dlg.waitFor({ timeout: 15000 });
      await fillField(dlg, /CME Cycle Start/, value);
      return saveDialog(dlg, { name: /^Save$/ });
    };
    const start = day(-60);
    let res = await setStart(start);
    qa.check('the license saves with a CME Cycle Start', res.closed, res.refusal);
    await sleep(2500);
    const lic = row(`select cme_cycle_start, custom_fields from public.licenses where user_id = '${pid}' and license_number = 'QA-OH-4401'`);
    qa.check('licenses.cme_cycle_start is saved', lic?.cme_cycle_start === start, lic?.cme_cycle_start);
    qa.check('editing the license kept the conditional-topic answer', lic?.custom_fields?.['Ohio pain clinic CME applies'] === 'Yes', lic?.custom_fields);
    let home = await homeCmeCards(page);
    const expected = dbHours(start, OH_EXP);
    qa.check(`Home: Ohio now counts only from the start date (${expected} h) and says "Start set on this license"`, home.OH?.total === `Total logged: ${expected}/50h` && /Start set on this license/.test(home.OH?.text || ''), home.OH);
    await page.getByText(/^Total logged: [\d.]+\/50h$/).first().click();
    const math = page.getByRole('dialog', { name: /OH CME \u2014 the math/ });
    await math.waitFor({ timeout: 10000 });
    const mathText = await math.innerText();
    await qa.shot('cme math custom start');
    const startShown = new Date(`${start}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    qa.check('the CME math opens with the window from the set date and says why', mathText.includes(`Counting CME dated ${startShown}`) && /Start set on this license, not derived from the renewal date/.test(mathText), mathText.slice(0, 300));
    await page.keyboard.press('Escape');

    // A start on the renewal date is ignored, with a warning.
    res = await setStart(OH_EXP);
    await sleep(2500);
    home = await homeCmeCards(page);
    const full = dbHours(ohStart, OH_EXP);
    qa.check('a start on the renewal date is not used: the default window is back', home.OH?.total === `Total logged: ${full}/50h`, home.OH?.total);
    qa.check('Home warns that the cycle start was not used', /CME cycle start on this license is on or after the renewal date, so it was not used/.test(home.OH?.text || ''), home.OH?.text.slice(0, 300));
    await page.getByText(/^Total logged: [\d.]+\/50h$/).first().click();
    await math.waitFor({ timeout: 10000 });
    qa.check('the CME math says to fix it on the license record', /falls on or after the renewal date, so it was not used\. Fix it on the license record/.test(await math.innerText()));
    await page.keyboard.press('Escape');
    res = await setStart('');
    await sleep(2000);
    qa.check('clearing the start saves null', row(`select cme_cycle_start from public.licenses where user_id = '${pid}' and license_number = 'QA-OH-4401'`)?.cme_cycle_start === null);
  }, { soft: true });

  await qa.feature('CRED-034', 'Find CME: search, For You / All Providers, pricing, special chips, topic chip, expand, external link, Browse All when compliant', async () => {
    const opened = await stubExternalPages(context, [...new Set(CME_PROVIDERS.map((p) => new URL(p.url).hostname))]);
    await openCredentials(page, 'Find CME');
    await page.getByRole('heading', { name: 'Find CME Courses' }).waitFor({ timeout: 15000 });
    const shownCount = async () => Number(((await page.locator('main, body').first().innerText()).match(/(\d+) providers?\b/) || [])[1]);
    const unmet = await page.locator('div').filter({ hasText: /^Unmet Topics/i }).filter({ has: page.getByRole('button') }).last().getByRole('button').allInnerTexts().catch(() => []);
    const forYou = CME_PROVIDERS.filter((p) => p.topics.some((t) => unmet.includes(t)) && (p.dualAccredited || p.accreditation.some((a) => a.includes('AMA PRA Category 1'))));
    qa.check(`For You (${unmet.join(', ')}) lists the providers for unmet topics with MD-appropriate credit (${forYou.length})`, (await shownCount()) === forYou.length, `${await shownCount()} shown`);
    await page.getByRole('button', { name: 'All Providers' }).click();
    qa.check(`All Providers lists all ${CME_PROVIDERS.length}`, (await shownCount()) === CME_PROVIDERS.length, `${await shownCount()}`);
    // Sort: "free first" (the code's own comment).
    const firstBadge = await page.getByRole('link', { name: /Visit/ }).first().locator('xpath=ancestor::div[3]').innerText().catch(() => '');
    const hasFree = CME_PROVIDERS.some((p) => p.pricing === 'free');
    qa.check('free providers are listed first', !hasFree || /\bFree\b/.test(firstBadge.split('\n').slice(0, 3).join(' ')), firstBadge.split('\n').slice(0, 3).join(' | '));
    if (hasFree && !/\bFree\b/.test(firstBadge.split('\n').slice(0, 3).join(' '))) {
      qa.bug({
        title: 'Find CME: free providers are sorted last, not first',
        step: 'Credentials > Find CME > All Providers (no filters)',
        expected: 'Free providers first ("Sort: free first" in the code), then freemium, paid, subscription',
        actual: `The first card is "${firstBadge.split('\n').slice(0, 2).join(' / ')}"; free providers come after every other price: priceOrder.free is 0 and \`(priceOrder[a.pricing] || 5)\` turns 0 into 5 (src/components/features/CMEResourcesSection.jsx:132-133). Fixed on fix/qa-cred-home (0ffc013e)`,
        severity: 'low',
      });
    }
    // Search.
    await page.getByPlaceholder('Search providers, topics...').fill('opioid');
    const opioid = CME_PROVIDERS.filter((p) => p.name.toLowerCase().includes('opioid') || p.description.toLowerCase().includes('opioid') || p.topics.some((t) => t.toLowerCase().includes('opioid')));
    qa.check(`searching "opioid" lists the ${opioid.length} providers that mention it`, (await shownCount()) === opioid.length, `${await shownCount()}`);
    await page.getByPlaceholder('Search providers, topics...').fill('');
    // Pricing.
    for (const [label, pred] of [['Free', (p) => p.pricing === 'free' || p.pricing === 'freemium'], ['Paid', (p) => p.pricing === 'paid'], ['Subscription', (p) => p.pricing === 'subscription']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const n = CME_PROVIDERS.filter(pred).length;
      qa.check(`pricing "${label}" lists ${n}`, (await shownCount()) === n, `${await shownCount()}`);
    }
    await page.getByRole('button', { name: 'All', exact: true }).click();
    // Special chips.
    for (const [label, pred] of [['MATE Act', (p) => p.mateActCompliant], ['State-Specific', (p) => p.stateSpecific]]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const n = CME_PROVIDERS.filter(pred).length;
      qa.check(`the "${label}" chip lists ${n}`, (await shownCount()) === n, `${await shownCount()}`);
      await page.getByRole('button', { name: label, exact: true }).click();
    }
    qa.check('no "DO Dual Credit" chip for an MD', !(await page.getByRole('button', { name: 'DO Dual Credit' }).count()));
    // A topic chip.
    const topic = unmet[0] || 'Ethics';
    await page.getByRole('button', { name: topic, exact: true }).first().click();
    const nTopic = CME_PROVIDERS.filter((p) => p.topics.includes(topic)).length;
    qa.check(`the "${topic}" topic chip lists ${nTopic}`, (await shownCount()) === nTopic, `${await shownCount()}`);
    await page.getByRole('button', { name: topic, exact: true }).first().click();
    // Expand a provider; open another's link without expanding it.
    // The description line expands its card (the card is the description's parent).
    const longDesc = CME_PROVIDERS.find((p) => p.description.length > 120);
    const desc = page.getByText(longDesc.description.slice(0, 60), { exact: false }).first();
    await desc.click();
    const card = desc.locator('xpath=..');
    qa.check('tapping the description ("more") expands the provider (accreditation and format shown)', /Accreditation:/.test(await card.innerText()) && /Format:/.test(await card.innerText()), (await card.innerText()).slice(0, 200));
    // Another provider's Visit link, on a card that is not expanded (a > buttons row > header > card).
    const urls = CME_PROVIDERS.map((p) => p.url);
    const other = CME_PROVIDERS.find((p) => p.id !== longDesc.id && urls.filter((u) => u === p.url).length === 1);
    const link = page.locator(`a[href="${other.url}"]`).first();
    const otherCard = link.locator('xpath=../../..');
    const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), link.click()]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    qa.check(`"Visit" opens ${other.url} in a new tab`, popup.url() === other.url || popup.url().startsWith(other.url), popup.url());
    await popup.close();
    qa.check('the card whose link was opened did not expand', !/Accreditation:/.test(await otherCard.innerText()));
    qa.check('the provider page was answered by the lab placeholder', opened.length >= 1, opened);

    // Fully compliant: For You says so and offers "Browse All Providers".
    await openCredentials(page, 'CME Credits');
    await page.getByRole('combobox', { name: QUESTION }).first().selectOption('No');
    await sleep(1500);
    const add = await addCme(page, { title: 'QA Ethics and Professionalism Intensive', hours: 40, date: day(-10), provider: 'QA Ethics Institute', topics: ['Ethics'] });
    qa.check('setup: 40 hours of Ethics logged', add.closed, add.refusal);
    await sleep(2000);
    await openCredentials(page, 'Find CME');
    const browse = page.getByRole('button', { name: 'Browse All Providers' });
    const compliant = await browse.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('find cme fully compliant');
    qa.check('For You says "Fully Compliant" and offers "Browse All Providers"', compliant && /Fully Compliant/.test(await page.locator('main, body').first().innerText()));
    if (compliant) {
      await browse.click();
      qa.check('"Browse All Providers" switches to every provider', (await shownCount()) === CME_PROVIDERS.length, `${await shownCount()}`);
    }
  }, { soft: true });
});
