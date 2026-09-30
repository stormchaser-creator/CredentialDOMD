// Credentials > Licenses beyond add/edit/delete: the Multi-State Matrix (empty
// and with states), renewal info on a license card (phone width), the NPI
// registry import (the NIH/NLM mirror answered by the lab with a synthetic
// provider), filter tabs, the desk table's sorting and status colours, a scan
// that fills the form (the lab's mock AI answers for exactly that file), and
// the in-form camera (a lab camera, a refusal, and a phone's capture input).
import { guardContext, test, watchPage } from './support/fixtures.mjs';
import {
  base64Marker, chooseFiles, newMember, openCredentials, pendingOps, profileOf, row, rows, scriptAi, signIn, sleep,
  syncWarnings, syntheticPdf, syntheticPng, waitForMemberApp,
} from './support/lab.mjs';
import {
  addCme, addLicense, day, dbWait, fakeCamera, fillField, fillForm, hue, openAdd, saveDialog, stubExternalPages, stubNpiRegistry,
} from './support/cred-helpers.mjs';

// Synthetic registry entries: NPIs that start with 0 are never issued.
const NPI_ME = '0999000017';
const PROVIDERS = [
  { npi: NPI_ME, first: 'Lena', last: 'Licenses', credential: 'M.D.', city: 'Denver', state: 'CO', licenses: [
    { number: 'QADR55123', state: 'CO', primary: true, desc: 'Neurological Surgery' }, { number: 'QANM88001', state: 'NM', desc: 'Neurological Surgery' }] },
  { npi: '0999000025', first: 'Lena', last: 'Licenses', credential: 'D.O.', city: 'Austin', state: 'TX', licenses: [{ number: 'QATX0001', state: 'TX', primary: true }] },
];

/** The desk table as data: header labels, and each row's cells, Expires colour and group (0 active, 1 historical). */
async function deskTable(page) {
  return page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((t) => /Expires/i.test(t.querySelector('thead')?.textContent || ''));
    if (!table) return null;
    const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.replace(/[▲▼]/g, '').trim());
    const out = [];
    let group = 0;
    for (const tr of table.querySelectorAll('tbody tr')) {
      if (tr.classList.contains('cmd-desk-group')) { group = /Historical/i.test(tr.innerText) ? 1 : group; continue; }
      if (!tr.classList.contains('cmd-desk-row')) continue;
      const tds = [...tr.querySelectorAll('td')];
      out.push({ group, cells: tds.map((td) => td.innerText.trim()), colors: tds.map((td) => getComputedStyle(td).color) });
    }
    return { headers, rows: out, arrow: [...table.querySelectorAll('thead th')].map((th) => (th.textContent.match(/[▲▼]/) || [''])[0]) };
  });
}

// Mirrors DeskTable's comparison: strings lower-cased, dates and numbers parsed, blanks last both ways.
function sortKey(col, text) {
  if (!text || text === '\u2014' || /^(Does not expire|Not yet known)$/.test(text)) return null;
  if (col === 'Issued' || col === 'Expires') { const t = Date.parse(text); return Number.isNaN(t) ? null : t; }
  if (col === 'Cost') { const n = parseFloat(text.replace(/[$,]/g, '')); return Number.isNaN(n) ? null : n; }
  return text.toLowerCase();
}
function isSorted(values, dir) {
  const present = values.filter((v) => v !== null);
  const firstNull = values.indexOf(null);
  if (firstNull >= 0 && values.slice(firstNull).some((v) => v !== null)) return false;
  for (let i = 1; i < present.length; i++) {
    if (dir === 'asc' ? present[i - 1] > present[i] : present[i - 1] < present[i]) return false;
  }
  return true;
}

test('licenses: matrix, renewal info, NPI import, filter tabs, desk sorting, scan to fill, camera', {
  tag: ['@CRED-017', '@CRED-028', '@CRED-014', '@CRED-026', '@CRED-027', '@CRED-015', '@CRED-030'],
}, async ({ page, context, browser, qa }) => {
  test.setTimeout(14 * 60 * 1000);
  const npiCalls = await stubNpiRegistry(context, PROVIDERS);
  await fakeCamera(context);
  const { user, profile } = await newMember(page, { firstName: 'Lena', lastName: 'Licenses' });
  const pid = profile.id;
  const lic = (number) => row(`select * from public.licenses where user_id = '${pid}' and license_number = '${number}'`);

  await qa.feature('CRED-017', 'Multi-State Matrix with no licenses: "Add a license" opens Licenses', async () => {
    const p = profileOf(user.id);
    qa.check('the new member has no licenses and no primary or additional states', !rows(`select id from public.licenses where user_id = '${pid}'`).length && !p.primary_state && !(p.additional_states || []).length, { primary: p.primary_state, extra: p.additional_states });
    await openCredentials(page, 'Multi-State Matrix');
    const empty = page.getByText(/Add at least one state medical license to see the matrix/);
    qa.check('the empty matrix says what to add', await empty.isVisible().catch(() => false));
    await page.getByRole('button', { name: 'Add a license', exact: true }).click();
    await sleep(1500);
    const moved = await page.getByText('Import from the NPI registry').first().isVisible().catch(() => false);
    const hash = await page.evaluate(() => location.hash);
    // Since 726b2d73 it opens Licenses with its Add form open (App.jsx openAddIn('licenses')).
    const addForm = page.getByRole('dialog', { name: 'Add', exact: true });
    const formOpen = await addForm.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('matrix add a license');
    qa.check('"Add a license" opens Credentials > Licenses', moved, `still on the matrix: ${await empty.isVisible().catch(() => false)}; location.hash ${hash}`);
    qa.check('...with the Add form open, ready for the license', formOpen && (await addForm.getByRole('button', { name: 'Add', exact: true }).count()) > 0);
    if (formOpen) {
      // Closed with its own button, so the next stretch starts on the Licenses page.
      await addForm.getByRole('button', { name: 'Close dialog' }).click();
      qa.check('the Add form closes', await addForm.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false));
    }
    if (!moved) {
      qa.bug({
        title: 'Multi-State Matrix: the empty state\'s "Add a license" button does nothing',
        step: 'A member with no licenses and no primary state: Credentials > Multi-State Matrix > Add a license',
        expected: 'Credentials > Licenses opens (its Add form)',
        actual: `The matrix stays on screen; the button only sets location.hash to ${hash || '#credentials/licenses'} (src/components/features/locum/MultiStateMatrix.jsx:121), which the signed-in app does not read. Fixed on fix/qa-cred-home (726b2d73, onAddLicense)`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('CRED-028', 'Renewal info on a license card (phone width): expands in place; portal, osteopathic board and state guide open in new tabs', async () => {
    const res = await addLicense(page, { name: 'QA Arizona License', number: 'QA-AZ-3001', state: 'AZ', issued: '2023-02-01', expires: day(400) });
    qa.check('an Arizona medical license saves (degree not set yet)', res.closed, res.refusal);
    // Open Licenses at desk width, then narrow the window to a phone's: the section stays open.
    await openCredentials(page, 'Licenses');
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(800);
    const how = page.getByRole('button', { name: /How to renew/ }).first();
    const shown = await how.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('the license card carries a "How to renew" line', shown);
    if (!shown) { await page.setViewportSize({ width: 1280, height: 900 }); return; }
    const dialogsBefore = await page.getByRole('dialog').count();
    await how.click();
    await sleep(600);
    qa.check('it expands without opening the record', (await page.getByRole('dialog').count()) === dialogsBefore && (await how.getAttribute('aria-expanded')) === 'true');
    await qa.shot('renewal info expanded');
    const panel = how.locator('xpath=../..');
    const links = await panel.locator('a').evaluateAll((as) => as.map((a) => ({ text: a.innerText.trim(), href: a.href, target: a.target, rel: a.rel })));
    const portal = links.find((l) => /^Renew at|^Renew online/.test(l.text));
    const osteo = links.find((l) => l.text === 'Osteopathic board');
    const guide = links.find((l) => l.text === 'Steps, fees and pitfalls');
    qa.check('the expansion offers the board portal, the osteopathic board (degree not set, AZ has a DO board) and the state guide', !!portal && !!osteo && !!guide, links);
    qa.check('every link opens in a new tab (target _blank, noopener)', links.length > 0 && links.every((l) => l.target === '_blank' && /noopener/.test(l.rel)), links);
    qa.check('the state guide is the Arizona guide', /arizona|\/az\b|-az|az-/i.test(guide?.href || ''), guide?.href);
    const hosts = [...new Set(links.map((l) => new URL(l.href).hostname))];
    const opened = await stubExternalPages(context, hosts);
    for (const l of [portal, osteo, guide].filter(Boolean)) {
      const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), panel.getByRole('link', { name: l.text, exact: true }).click()]);
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      qa.check(`"${l.text}" opens ${new URL(l.href).hostname} in a new tab`, popup.url() === l.href, popup.url());
      await popup.close();
    }
    qa.check('the three pages were requested only from the lab placeholder', opened.length >= 3, opened);
    qa.check('no record opened while using the links', (await page.getByRole('dialog').count()) === dialogsBefore);
    await page.setViewportSize({ width: 1280, height: 900 });
    await sleep(800);
    await openCredentials(page, 'Licenses');
    let deskHasIt = await page.getByRole('button', { name: /How to renew/ }).count();
    if (!deskHasIt) {
      // Not on the row: open the record, as a desk user would look next.
      await page.getByRole('row').filter({ hasText: 'QA-AZ-3001' }).getByRole('cell').nth(3).click();
      await page.getByRole('dialog').last().waitFor({ timeout: 10000 }).catch(() => {});
      deskHasIt = await page.getByRole('dialog').last().getByRole('button', { name: /How to renew/ }).count();
      await page.keyboard.press('Escape').catch(() => {});
    }
    qa.check('at desk width the renewal info is reachable too (on the row or in the record)', deskHasIt > 0, `${deskHasIt} "How to renew" controls on the desk table and in the record view`);
    if (!deskHasIt) {
      qa.bug({
        title: 'Licenses at desk width: a license\'s renewal info ("How to renew", portal, state guide) is not reachable',
        step: 'Credentials > Licenses at 1024px or wider; look on the row, and open the record',
        expected: 'The renewal line (portal, osteopathic board, steps and fees) is on the license, as on a phone',
        actual: 'CrudSection passes renderExtra only to the phone cards (src/components/features/CrudSection.jsx:1286); the DeskTable branch (1162-1195) and the record view never render it, so at desk width the renewal portal and state guide are nowhere on the license. Fixed on fix/qa-cred-home (e26ccc86: the desk record view carries How to renew)',
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('CRED-014', 'Import licenses from the NPI registry (the lab answers as the NIH/NLM mirror)', async () => {
    await openCredentials(page, 'Licenses');
    const panel = page.locator('div').filter({ hasText: /^Import from the NPI registry/ }).filter({ has: page.getByRole('button', { name: /Look up/ }) }).last();
    await panel.getByPlaceholder('Blank searches by name').fill('');
    await panel.locator('select').first().selectOption('CO');
    await panel.getByRole('button', { name: 'Look up' }).click();
    const mine = panel.getByRole('button', { name: new RegExp(`Lena Licenses.*${NPI_ME}`) });
    const listed = await mine.waitFor({ timeout: 20000 }).then(() => true, () => false);
    await qa.shot('npi matches');
    qa.check('a name search in CO lists the matching provider (and not the TX one)', listed && !(await panel.getByText('0999000025').count()), (await panel.innerText()).slice(0, 300));
    qa.check('the browser asked the NIH/NLM mirror (clinicaltables.nlm.nih.gov/api/npi_idv/v3/search) by name and state', npiCalls.some((u) => u.includes('/api/npi_idv/v3/search') && /terms=Licenses(\+|%20)Lena/.test(u) && /addr_practice\.state%3ACO|addr_practice.state:CO/.test(u)), npiCalls.slice(-2));
    if (!listed) return;
    await mine.click();
    const importBtn = panel.getByRole('button', { name: /^Import 2 licenses$/ });
    await importBtn.waitFor({ timeout: 20000 });
    qa.check('the result lists both registry licenses', /2 licenses on the registry: CO, NM/.test(await panel.innerText()));
    await importBtn.click();
    await panel.getByText(/2 licenses imported/).waitFor({ timeout: 15000 }).catch(() => {});
    await sleep(3000);
    const imported = rows(`select type, state, license_number, npi_imported, expiration_date from public.licenses where user_id = '${pid}' and npi_imported order by state`);
    qa.check('two licenses saved, flagged npi_imported, with no made-up dates', imported.length === 2 && imported.every((l) => l.npi_imported && !l.expiration_date) && imported.map((l) => l.state).join(',') === 'CO,NM', imported);
    const p = await dbWait('npi on the profile', () => { const x = profileOf(user.id); return x.npi === NPI_ME ? x : null; });
    qa.check('the NPI is saved on the profile', p?.npi === NPI_ME, p?.npi);
    qa.check('the degree is taken from the registry credential (MD)', p?.degree_type === 'MD', p?.degree_type);
    qa.check('both registry states are tracked (additional_states)', ['CO', 'NM'].every((s) => (p?.additional_states || []).includes(s)), p?.additional_states);
    // Flagged for review until dated (the phone card says so; the desk table marks the row red).
    await openCredentials(page, 'Licenses');
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(800);
    const review = (await page.locator('main, body').first().innerText()).match(/Needs review[^\n]*/g) || [];
    qa.check('each imported license is flagged "Needs review" until it has a date', review.length >= 2, review.slice(0, 3));
    await page.setViewportSize({ width: 1280, height: 900 });
    await sleep(800);
    // The same import again adds nothing.
    await openCredentials(page, 'Licenses');
    const panel2 = page.locator('div').filter({ hasText: /^Import from the NPI registry/ }).filter({ has: page.getByRole('button', { name: /Look up/ }) }).last();
    qa.check('the NPI field now holds the saved NPI', (await panel2.getByPlaceholder('Blank searches by name').inputValue()) === NPI_ME);
    await panel2.getByRole('button', { name: 'Look up' }).click();
    const already = await panel2.getByText(/All 2 registry licenses are already on file/).waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('running it again offers nothing to import ("already on file")', already && !(await panel2.getByRole('button', { name: /^Import \d+ license/ }).count()));
    qa.check('still two imported licenses', rows(`select id from public.licenses where user_id = '${pid}' and npi_imported`).length === 2);
  }, { soft: true });

  // The other license kinds, for the tabs, the sorting and the matrix.
  const extras = [
    { type: 'DEA Registration', number: 'QA-DEA-CO77', state: 'CO', expires: day(20) },
    { type: 'Board Certification (ABMS)', name: 'QA Neurosurgery Board', number: 'QA-ABMS-12', noExpiration: true },
    { type: 'ACLS Certification', name: 'QA ACLS', number: 'QA-ACLS-9', expires: day(-10) },
    { type: 'State Medical License', name: 'QA Texas (old)', number: 'QA-TX-OLD', state: 'TX', issued: '2015-01-01', expires: day(-400), historical: true },
  ];
  await qa.feature('CRED-026', 'License filter tabs: each shows only its kind; All shows everything', async () => {
    for (const x of extras) {
      const dlg = await openAdd(page, 'Licenses');
      await fillField(dlg, 'Type', x.type);
      if (x.name) await fillField(dlg, /^(Display Name|What Is It In\?)/, x.name);
      await fillField(dlg, 'License #', x.number);
      if (x.state) await fillField(dlg, 'State', x.state);
      if (x.issued) await fillField(dlg, 'Issued', x.issued);
      if (x.expires) await fillField(dlg, /^Expires/, x.expires);
      if (x.noExpiration) await dlg.getByRole('checkbox', { name: 'This certificate does not expire' }).check();
      if (x.historical) await fillField(dlg, 'Status', { label: 'Historical' });
      const res = await saveDialog(dlg);
      qa.check(`${x.type} ${x.number} saves`, res.closed, res.refusal);
    }
    await sleep(2500);
    await openCredentials(page, 'Licenses');
    const all = rows(`select type, license_number from public.licenses where user_id = '${pid}'`);
    const expect = {
      'Medical Licenses': all.filter((l) => /medical license/i.test(l.type)).map((l) => l.license_number),
      'DEA / CSR': ['QA-DEA-CO77'], 'Board Certs': ['QA-ABMS-12'], 'Life Support': ['QA-ACLS-9'],
    };
    qa.check('seven licenses in the database', all.length === 7, all.map((l) => l.license_number));
    for (const [tab, numbers] of Object.entries(expect)) {
      await page.getByRole('button', { name: new RegExp(`^${tab.replace('/', '\\/')} \\(\\d+\\)$`) }).click();
      await sleep(400);
      const t = await deskTable(page);
      const shown = (t?.rows || []).map((r) => r.cells[3]);
      qa.check(`"${tab}" shows only its ${numbers.length} license(s)`, shown.length === numbers.length && numbers.every((n) => shown.includes(n)), shown);
    }
    await page.getByRole('button', { name: /^All \(\d+\)$/ }).click();
    await sleep(400);
    const t = await deskTable(page);
    await qa.shot('licenses all');
    qa.check('"All (7)" shows every license', (t?.rows || []).length === 7 && (await page.getByRole('button', { name: 'All (7)' }).count()) === 1, (t?.rows || []).map((r) => r.cells[3]));
  }, { soft: true });

  await qa.feature('CRED-027', 'Desk table: default sort Expires ascending, each header toggles, status colours', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Licenses');
    let t = await deskTable(page);
    const cols = t.headers.slice(1, 8); // after the status cell: Type, State, Number, Issued, Expires, Status, Cost
    qa.check('columns Type, State, Number, Issued, Expires, Status, Cost', cols.join(',') === 'Type,State,Number,Issued,Expires,Status,Cost', t.headers);
    const col = (name) => t.headers.indexOf(name);
    const active = (tb) => tb.rows.filter((r) => r.group === 0);
    const exp = active(t).map((r) => sortKey('Expires', r.cells[col('Expires')]));
    qa.check('default sort: Expires ascending (blanks last), historical records below', t.arrow[col('Expires')] === '▲' && isSorted(exp, 'asc') && t.rows.at(-1).cells[col('Number')] === 'QA-TX-OLD', active(t).map((r) => `${r.cells[col('Number')]} ${r.cells[col('Expires')]}`));
    const colourOf = (n) => hue(t.rows.find((r) => r.cells[col('Number')] === n)?.colors[col('Expires')]);
    qa.check('expired shows red, due within 30 days amber, far off green, historical grey', colourOf('QA-ACLS-9') === 'red' && colourOf('QA-DEA-CO77') === 'amber' && colourOf('QA-AZ-3001') === 'green' && colourOf('QA-TX-OLD') === 'grey',
      { expired: colourOf('QA-ACLS-9'), soon: colourOf('QA-DEA-CO77'), far: colourOf('QA-AZ-3001'), historical: colourOf('QA-TX-OLD'), raw: t.rows.map((r) => `${r.cells[col('Number')]}:${r.colors[col('Expires')]}`) });
    for (const name of ['Expires', 'Type', 'State', 'Number', 'Issued', 'Status', 'Cost']) {
      const header = page.locator('table thead th').filter({ hasText: new RegExp(`^${name}`, 'i') }).first();
      const results = [];
      for (const dir of name === 'Expires' ? ['desc', 'asc'] : ['asc', 'desc']) {
        await header.click();
        await sleep(250);
        t = await deskTable(page);
        const vals = active(t).map((r) => sortKey(name, r.cells[col(name)]));
        results.push({ dir, arrow: t.arrow[col(name)], ok: isSorted(vals, dir), vals: active(t).map((r) => r.cells[col(name)]) });
      }
      qa.check(`${name}: two clicks sort ascending then descending (the arrow follows)`, results.every((r) => r.ok && r.arrow === (r.dir === 'asc' ? '▲' : '▼')), results);
    }
  }, { soft: true });

  await qa.feature('CRED-017', 'Multi-State Matrix with licenses in several states: license, DEA, CME progress and privileges per state', async () => {
    const cme = await addCme(page, { title: 'QA Colorado Neurosurgery Update', hours: 10, date: day(-20), provider: 'QA CME Provider' });
    qa.check('10 CME hours logged', cme.closed, cme.refusal);
    const pdlg = await openAdd(page, 'Privileges');
    await fillForm(pdlg, [['Type', { index: 1 }], ['Display Name', 'QA Denver Privileges'], ['Facility', 'QA Denver Health'], ['State', { label: 'CO' }], [/^Reappointment Due/, day(200)]]);
    const pres = await saveDialog(pdlg);
    qa.check('a Colorado privilege saves', pres.closed, pres.refusal);
    await sleep(2000);
    await openCredentials(page, 'Multi-State Matrix');
    const matrix = page.locator('main, body').first();
    await page.getByText('Multi-State License Matrix').waitFor({ timeout: 15000 });
    await qa.shot('matrix states');
    const text = await matrix.innerText();
    const cards = await page.locator('div').filter({ has: page.getByText(/^Medical License$/) }).filter({ has: page.getByText(/^DEA$/) }).evaluateAll((els) => els.map((e) => e.innerText));
    const card = (st) => cards.filter((c) => new RegExp(`^${st}\\b`).test(c.trim())).sort((a, b) => a.length - b.length)[0] || '';
    qa.check('one row per held state (AZ, CO, NM; the historical TX license is not held)', ['AZ', 'CO', 'NM'].every((s) => card(s)) && !card('TX'), text.match(/\d+ states?/)?.[0]);
    const co = card('CO');
    qa.check('Colorado shows its license number and its DEA', /QADR55123/.test(co) && /QA-DEA-CO77/.test(co), co.replace(/\s+/g, ' '));
    qa.check('Colorado shows its privilege (1 hosp.)', /Privileges \(1\)/.test(co) && /1 hosp\./.test(co), co.replace(/\s+/g, ' '));
    const hrs = co.match(/([\d.]+) \/ (\d+) hrs/);
    qa.check('Colorado\'s CME cell counts the 10 logged hours toward 30', !!hrs && Number(hrs[1]) === 10 && hrs[2] === '30', hrs?.[0] || co.replace(/\s+/g, ' '));
    if (hrs && Number(hrs[1]) !== 10) {
      qa.bug({
        title: 'Multi-State Matrix: the CME cell always reads 0 hours',
        step: 'Log 10 AMA PRA Category 1 hours dated 20 days ago with a Colorado license on file; open Credentials > Multi-State Matrix',
        expected: 'Colorado CME shows 10 / 30 hrs (33%), the figure the CME Compliance card and Home show',
        actual: `"${hrs[0]}"; the matrix reads cmeData.totalHours, which complianceFor never returns (it returns totalEarned), and cmeData.unmet (unmet topics never show either) (src/components/features/locum/MultiStateMatrix.jsx:150,217,232-242). Fixed on fix/qa-cred-home (726b2d73)`,
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('CRED-015', 'Scan a document into the Add form: only its own fields filled, extras kept as details, identifiers withheld, file attached', async () => {
    const cases = [
      { section: 'Licenses', docType: 'license', table: 'licenses', key: 'license_number', value: 'QA-SCAN-LIC-7', extracted: { type: 'State Medical License', name: 'QA Scanned Utah License', licenseNumber: 'QA-SCAN-LIC-7', state: 'UT', issuedDate: '2024-03-01', expirationDate: day(600), boardName: 'QA Utah Division of Licensing', ssn: '000-12-3456', dateOfBirth: '1980-02-03' }, filled: 6, details: 1 },
      { section: 'Privileges', docType: 'privilege', table: 'privileges', key: 'facility', value: 'QA Scanned Mercy Hospital', extracted: { type: 'Surgical Privileges', facility: 'QA Scanned Mercy Hospital', state: 'CO', appointmentDate: day(-100), expirationDate: day(630), departmentChair: 'Dr. QA Chair' }, filled: 5, details: 1 },
      { section: 'Insurance', docType: 'insurance', table: 'insurance', key: 'policy_number', value: 'QA-SCAN-POL-3', extracted: { type: 'Medical Malpractice (Claims-Made)', provider: 'QA Scanned Mutual', policyNumber: 'QA-SCAN-POL-3', effectiveDate: day(-30), expirationDate: day(335), retroactiveDate: '2019-01-01' }, filled: 5, details: 1 },
      { section: 'Education', docType: 'education', table: 'education', key: 'institution', value: 'QA Scanned Medical College', extracted: { type: 'Residency Certificate', institution: 'QA Scanned Medical College', graduationDate: '2021-06-30', fieldOfStudy: 'Neurological Surgery', programDirector: 'Dr. QA Director' }, filled: 4, details: 1 },
    ];
    for (const c of cases) {
      const pdf = syntheticPdf(`QA synthetic ${c.section} scan ${Date.now()}`);
      await scriptAi('gemini', { json: { documentType: c.docType, confidence: 'high', extracted: c.extracted } }, base64Marker(pdf));
      const dlg = await openAdd(page, c.section);
      const fileName = `qa-scan-${c.section.toLowerCase()}.pdf`;
      await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }), [{ name: fileName, mimeType: 'application/pdf', buffer: pdf }]);
      const msg = dlg.getByText(/fields? filled/).first();
      const done = await msg.waitFor({ timeout: 60000 }).then(() => true, () => false);
      const said = done ? await msg.innerText() : (await dlg.innerText()).match(/Document scanned[^\n]*|Could not extract[^\n]*/)?.[0] || '';
      if (c.section === 'Licenses') await qa.shot('scan filled license form');
      qa.check(`${c.section}: "${c.filled} fields filled, ${c.details} more detail kept"`, new RegExp(`^${c.filled} fields filled, ${c.details} more detail`).test(said), said);
      const values = await dlg.locator('input, select, textarea').evaluateAll((els) => els.map((e) => e.value));
      qa.check(`${c.section}: the form holds the scanned value`, values.includes(c.value), values.filter(Boolean).slice(0, 10));
      if (c.section === 'Licenses') {
        qa.check('identifiers (SSN, full date of birth) are withheld and it says so', /Patient identifiers, SSNs and full birth dates were left out/.test(said) && !values.some((v) => v.includes('000-12-3456') || v.includes('1980-02-03')), said);
      }
      const res = await saveDialog(dlg);
      qa.check(`${c.section}: the scanned record saves`, res.closed, res.refusal);
      await sleep(2500);
      const rec = await dbWait(`the ${c.table} row`, () => row(`select id, custom_fields::text as cf, row_to_json(t)::text as j from public.${c.table} t where user_id = '${pid}' and ${c.key} = '${c.value}'`));
      qa.check(`${c.section}: row saved with the extra detail in custom_fields`, !!rec && rec.cf && rec.cf !== '{}' && rec.cf !== 'null', rec?.cf);
      if (c.section === 'Licenses') qa.check('no identifier reached the row', rec && !/000-12-3456|1980-02-03/.test(rec.j));
      const doc = rec ? await dbWait('the attached file', () => row(`select linked_to, storage_path from public.documents where user_id = '${pid}' and linked_to = '${c.section === 'Licenses' ? 'licenses' : c.section === 'Education' ? 'education' : c.table}:${rec.id}'`), 30000) : null;
      qa.check(`${c.section}: the file is attached after save (documents.linked_to = ${c.table}:<id>)`, !!doc?.storage_path, doc);
    }
    const usage = rows(`select provider, ok from public.ai_usage where user_id = '${pid}'`);
    qa.check('each scan went through ai-proxy and was metered (ai_usage)', usage.length >= 4, usage.length);

    // A spreadsheet with a patient-identifier column is refused with a reason.
    const dlg = await openAdd(page, 'Licenses');
    const csv = Buffer.from('MRN,Patient Name,Procedure\nQA0001,Test Patient One,Craniotomy\n');
    await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }), [{ name: 'qa-case-sheet.csv', mimeType: 'text/csv', buffer: csv }]);
    await sleep(2000);
    const text = await dlg.innerText();
    qa.check('the spreadsheet is refused with a reason naming the identifier column', /"qa-case-sheet\.csv" was not attached/.test(text) && /MRN|patient/i.test(text.match(/was not attached[^\n]*/)?.[0] || ''), text.match(/[^\n]*was not attached[^\n]*/)?.[0]);
    qa.check('nothing is staged to attach', !/qa-case-sheet\.csv\s*\d+ KB/.test(text));
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  }, { soft: true });

  await qa.feature('CRED-030', 'Camera inside a record form: live preview, Take Photo scans like an upload, Cancel, a refused camera', async () => {
    const mark = qa.report.console.length;
    const queued = (await pendingOps(page)).length;
    let dlg = await openAdd(page, 'Licenses');
    await fillForm(dlg, [['Type', 'BLS Certification'], [/^(Display Name|What Is It In\?)/, 'QA BLS'], ['License #', 'QA-BLS-CAM'], [/^Expires/, day(500)]]);
    await dlg.getByRole('button', { name: 'Camera' }).click();
    const video = dlg.locator('video');
    const live = await video.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await sleep(1000);
    const size = await video.evaluate((v) => [v.videoWidth, v.videoHeight]).catch(() => [0, 0]);
    await qa.shot('camera preview');
    qa.check('the live preview opens (lab camera)', live && size[0] > 0, size);
    await dlg.getByRole('button', { name: 'Take Photo' }).click();
    const staged = await dlg.getByText(/camera-\d+\.jpg/).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    await dlg.getByText(/Scanning document/).waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    const msg = (await dlg.innerText()).match(/[^\n]*(fields? filled|no fields could be extracted|Could not extract)[^\n]*/)?.[0] || '';
    qa.check('the photo is captured and staged as a JPEG', staged);
    qa.check('it is read like an upload (the AI scan ran and said so)', !!msg, msg);
    qa.check('the preview closes after the photo', !(await video.count()));
    const res = await saveDialog(dlg);
    qa.check('the license saves with the photo', res.closed, res.refusal);
    await sleep(3000);
    const bls = lic('QA-BLS-CAM');
    const doc = bls ? await dbWait('the photo document', () => row(`select name, type, storage_path from public.documents where linked_to = 'licenses:${bls.id}'`), 30000) : null;
    qa.check('a documents row for the photo after save', !!doc?.storage_path && /^camera-\d+\.jpg$/.test(doc.name) && doc.type === 'image/jpeg', doc);

    // Cancel on a second try.
    dlg = await openAdd(page, 'Licenses');
    await dlg.getByRole('button', { name: 'Camera' }).click();
    await dlg.locator('video').waitFor({ timeout: 10000 });
    await dlg.getByRole('button', { name: 'Cancel' }).first().click();
    await sleep(500);
    qa.check('Cancel closes the preview and stages nothing', !(await dlg.locator('video').count()) && !(await dlg.getByText(/camera-\d+\.jpg/).count()));
    // A refused camera.
    await page.evaluate(() => { window.__qaCameraDeny = true; });
    await dlg.getByRole('button', { name: 'Camera' }).click();
    const denied = await dlg.getByText('Could not access camera. Check browser permissions.').waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('a refused camera says "Could not access camera"', denied);
    await page.evaluate(() => { window.__qaCameraDeny = false; });
    await dlg.getByRole('button', { name: 'Cancel' }).last().click();
    const ops = await pendingOps(page);
    qa.check('no sync warning and nothing newly queued by the camera stretch', syncWarnings(qa.report, mark).length === 0 && ops.length <= queued, { warnings: syncWarnings(qa.report, mark), queued: JSON.stringify(ops).slice(0, 300) });

    // On a phone the same button opens the device camera (a capture file input).
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', isMobile: true, hasTouch: true });
    await guardContext(phone, qa.report);
    const pp = await phone.newPage();
    watchPage(pp, qa.report);
    try {
      await signIn(pp, user);
      // The phone's bottom bar (not a <nav>): its Credentials tab.
      const credTab = pp.getByRole('button', { name: /^(\S+ )?Credentials$/ }).filter({ visible: true }).first();
      const onPhone = await credTab.waitFor({ timeout: 120000 }).then(() => true, () => false);
      await pp.screenshot({ path: (await qa.shot('phone signed in')).replace(/\.png$/, '-phone.png') });
      qa.check('the phone opens the member app (bottom bar)', onPhone);
      await credTab.click();
      await pp.getByRole('button', { name: /^\S+ Licenses( |$)/ }).first().click();
      await pp.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
      const pd = pp.getByRole('dialog', { name: 'Add' });
      await pd.waitFor({ timeout: 15000 });
      const [chooser] = await Promise.all([pp.waitForEvent('filechooser', { timeout: 15000 }), pd.getByRole('button', { name: 'Camera' }).click()]);
      qa.check('on a phone, Camera opens the device camera (an image capture input)', chooser.isMultiple() === false && await chooser.element().evaluate((e) => e.accept === 'image/*' && e.getAttribute('capture') === 'environment'));
      await chooser.setFiles([{ name: 'qa-phone-photo.png', mimeType: 'image/png', buffer: syntheticPng() }]);
      qa.check('the phone photo is staged on the form', await pd.getByText('qa-phone-photo.png').first().waitFor({ timeout: 15000 }).then(() => true, () => false));
      await pd.getByRole('button', { name: 'Cancel' }).last().click();
    } finally { await phone.close(); }
  }, { soft: true });
});
