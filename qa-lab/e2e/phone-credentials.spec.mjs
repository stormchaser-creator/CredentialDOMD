// Phone layouts, part 2: every Credentials section on a phone (375 x 812 and
// 390 x 844, touch). For each section a member opens its list from the
// Credentials menu, taps Add, checks the form fits the screen and can be
// closed, types the record in, saves it (a database row), opens the record's
// card and details, and goes Back. Then a reload proves the records stayed,
// a second phone signed in to the same account lists them, the Multi-State
// Matrix and a custom category are checked, and the license is deleted from
// its card. Every list, card and form gets the phone layout audit.
import { test } from './support/fixtures.mjs';
import { field, recordButtons, row, sleep, tombstones } from './support/lab.mjs';
import {
  PHONES, anyOf, auditDialog, auditScreen, backButton, closeDialog, credentialsRow, exceptChrome, fileLayoutBugs, phoneCredentials,
  phoneTab, phoneUse, reloadPhone, secondPhone, signInPhone, smallByDesign, tapTarget,
  newPhoneMember,
} from './support/phone-helpers.mjs';

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

// [label, value]: {index: n} picks the nth option, {label: 'x'} an option by its label.
const SECTIONS = [
  { id: 'CRED-001', section: 'Licenses', table: 'licenses', mark: 'QA-PHL-4410', fields: [
    ['Type', { label: 'State Medical License' }], ['Display Name', 'QA Phone CO License'], ['License #', 'QA-PHL-4410'], ['State', { label: 'CO' }], ['Issued', day(-700)], [/^Expires/, day(40)] ] },
  { id: 'CRED-007', section: 'Privileges', table: 'privileges', mark: 'QA Phone Mercy', fields: [
    ['Type', { index: 1 }], ['Display Name', 'QA Phone Mercy Privileges'], ['Facility', 'QA Phone Mercy'], ['City', 'Denver'], ['State', { label: 'CO' }],
    ['Appointed', day(-300)], [/^Reappointment Due/, day(400)] ] },
  { id: 'CRED-008', section: 'Insurance', table: 'insurance', mark: 'QA-PHPOL-51', fields: [
    ['Type', { index: 1 }], ['Display Name', 'QA Phone Malpractice'], ['Carrier', 'QA Mutual'], ['Policy #', 'QA-PHPOL-51'], ['Per Claim', '1000000'],
    ['Aggregate', '3000000'], ['Effective', day(-100)], [/^Expires/, day(265)] ] },
  { id: 'CRED-009', section: 'CME Credits', table: 'cme', mark: 'QA Phone Spine Update', fields: [
    ['Activity / Title', 'QA Phone Spine Update'], ['Credit Category', { label: 'AMA PRA Category 1' }], ['Hours', '4'], ['Date Completed', day(-15)], ['Provider / Institution', 'QA CME Provider'] ] },
  { id: 'CRED-018', section: 'Education', table: 'education', mark: 'QA Phone School of Medicine', fields: [
    ['Type', { index: 1 }], ['Display Name', 'QA Phone MD Diploma'], ['Institution', 'QA Phone School of Medicine'], ['Start Date', day(-6000)], ['Graduation / End Date', day(-4600)] ] },
  { id: 'CRED-019', section: 'Work History', table: 'work_history', mark: 'QA Phone Health Partners', fields: [
    ['Position Type', { index: 1 }], ['Position/Title', 'Attending Neurosurgeon'], ['Employer/Organization', 'QA Phone Health Partners'], ['City', 'Denver'], ['State', { label: 'CO' }], ['Start Date', day(-1500)] ] },
  { id: 'CRED-020', section: 'Case Logs', table: 'case_logs', mark: 'QA phone lumbar laminectomy', fields: [
    ['Category', { index: 1 }], ['Description', 'QA phone lumbar laminectomy'], ['Date', day(-4)], ['Facility', 'QA Phone Mercy'], ['Role', { index: 1 }], ['CPT Code(s)', '63047'] ] },
  { id: 'CRED-021', section: 'Health Records', table: 'health_records', mark: 'QA-PHLOT-9', fields: [
    ['Category', { label: 'Vaccination' }], ['Display Name', 'QA Phone Flu Shot'], ['Date Administered', day(-30)], ['Lot / Batch #', 'QA-PHLOT-9'], ['Administrator / Facility', 'QA Clinic'] ] },
  { id: 'CRED-022', section: 'Travel & IDs', table: 'travel_docs', mark: 'QA-PHTRAVEL-7', fields: [
    ['Type', { index: 1 }], ['Airline / Hotel / Company', 'QA Airways'], ['Number', 'QA-PHTRAVEL-7'], ['Label (optional)', 'QA phone flyer'], ['Expires (if it does)', day(700)] ] },
  { id: 'CRED-037', section: 'Screenings', table: 'screenings', mark: 'QA-PHSCREEN-3', fields: [
    ['Type', { index: 1 }], ['Display name', 'QA Phone Background Check'], ['Screening agency', 'QA Screening Co'], ['File / report #', 'QA-PHSCREEN-3'], ['Ordered', day(-40)], ['Reported', day(-30)] ] },
  { id: 'CRED-039', section: 'Publications', table: 'publications', mark: 'QA Phone Journal of Synthetic Surgery', fields: [
    ['Short Label', 'QA phone paper'], ['Full Citation (as it should read on the CV)', 'Physician P, et al. A synthetic phone study. QA Phone Journal of Synthetic Surgery. 2024;2:3-4.'], ['Year', '2024'], ['Order on CV', '1'] ] },
  { id: 'CRED-040', section: 'Professional Organizations', table: 'professional_memberships', mark: 'QA Phone Society of Surgeons', fields: [
    ['Organization', 'QA Phone Society of Surgeons'], ['Membership Type', 'Member'], ['Member Since', day(-900)], ['Renewal Due', day(120)] ] },
  { id: 'CRED-041', section: 'Peer References', table: 'peer_references', mark: 'Riley Phoneref', fields: [
    ['Full Name', 'Riley Phoneref'], ['Degree/Credential', 'MD'], ['Specialty', 'Neurosurgery'], ['Institution/Hospital', 'QA Phone Mercy'], [/^Relationship/, { index: 1 }],
    ['Email', 'riley.phoneref@qa.credentialdomd.test'], ['Known Since (month & year)', '2019-03'] ] },
  { id: 'CRED-045', section: 'Malpractice History', table: 'malpractice_history', mark: 'QA phone synthetic claim', fields: [
    ['Date of Incident', day(-2100)], ['Date Filed', day(-2000)], ['State', { label: 'CO' }], ['Outcome', { index: 1 }], ['Description', 'QA phone synthetic claim'], ['Facility', 'QA Phone Mercy'] ] },
];

// Layout bugs this journey files (once per run), each with the code behind it.
const BUGS = [
  {
    key: 'card-actions', feature: 'CRED-001', kind: 'small', severity: 'low',
    // The icons carry names since 43341dc1 ("Share", "Edit", "Delete"; the CME card's "... entry").
    match: /^button "(Add to Favorites|Remove from Favorites|(Share|Edit|Delete)( entry)?)"$|^button \(no text; icon\)$/,
    title: 'Phone record cards: the star, send, edit and delete buttons are 26 to 28 px tall',
    step: 'Credentials > any section with a record, on a phone: the four buttons on the right of each card',
    expected: 'Each card action at least 32 x 32 px (they sit 3 px apart, so a slightly-off tap hits the neighbour: edit is beside delete)',
    actual: 'Each is a 16 px icon with padding 6px 8px and a 3 px gap: CrudSection.jsx:1290-1295 (phone cards of every generic section) and :98 (the star), HealthRecordsSection.jsx:392-396, ScreeningsSection.jsx (same style); CMESection.jsx:827-831 uses padding 5px 7px, 26 px tall.',
  },
  {
    key: 'filter-chips', feature: 'CRED-026', kind: 'small', severity: 'low',
    match: /^button "(All|Medical Licenses|DEA \/ CSR|Board Certs|Life Support|Other|Vaccination|Titer \/ Immunity|TB Test|Drug Screen|Fit Test|Personal IDs|Travel Programs)( \(\d+\))?"$/,
    title: 'Phone Credentials: the filter chips (Licenses, Health Records, Travel & IDs) are 30 px tall',
    step: 'Credentials > Licenses (or Health Records, Travel & IDs) on a phone',
    expected: 'Each filter chip at least 32 px tall',
    actual: 'CrudSection.jsx:1148-1153 (Licenses, Travel & IDs) and HealthRecordsSection.jsx:161 style them padding 6px 14px, font 13: 30 px tall.',
  },
  {
    key: 'renewal-line', feature: 'CRED-028', kind: 'clipped', severity: 'medium',
    match: /How to renew/,
    title: 'Phone license card: "How to renew · Biennial (2 years)" is cut to "Ho…" when the license is urgent',
    step: 'Credentials > Licenses on a phone, a medical license expiring within the alert window (the card shows "Renew online")',
    expected: 'The renewal line reads "How to renew" (with the cycle, or at least the words) beside the Renew online button',
    actual: 'RenewalInfo.jsx:31-57 puts the "How to renew · <cycle>" button (flex 1, min-width 0, ellipsis) and the "Renew online" link (flex-shrink 0) on one line inside the card\'s text column, which on a phone is narrowed by the card\'s four action buttons (CrudSection.jsx:1290): the label gets about 29 px and shows "Ho…". The expander button itself is 40 x 23 px and "Renew online" 29 px tall.',
  },
  {
    key: 'cme-topics', feature: 'CRED-009', kind: 'small', severity: 'low',
    match: /^button "(✓ )?(Pain Management|Opioid Prescribing|Controlled Substances|Ethics|Infection Control|Patient Safety|Medical Errors Prevention|Risk Management|Suicide Prevention|Cultural Competency|[A-Z][A-Za-z /&-]+)"$/,
    only: 'CME Credits Add form',
    title: 'Phone CME form: the topic chips are 30 px tall',
    step: 'Credentials > CME Credits > Add, on a phone: the topic chips',
    expected: 'Each topic chip at least 32 px tall',
    actual: 'CMESection.jsx:588-593 styles them padding 6px 12px, font 13: 30 px tall, packed 4 px apart.',
  },
  {
    key: 'health-dates', feature: 'CRED-021', kind: 'offscreen', severity: 'medium',
    match: /^label "EXPIRATION DATE"$|^input\[type=date\]/,
    only: 'Health Records Add form',
    title: 'Phone Health Records form: the Expiration Date field runs off the right edge (the form scrolls sideways inside the dialog)',
    step: 'Credentials > Health Records > Add, on a phone',
    expected: 'Date Administered and Expiration Date both fit the form (side by side or stacked)',
    actual: 'HealthRecordsSection.jsx:189-191 lays the two date inputs in gridTemplateColumns "1fr 1fr"; a 1fr track cannot shrink below its content\'s minimum width, and a date input\'s is about 189 px in Chromium, so the second column starts at x=230 and ends at 419 px on a 375 px screen: the dialog body is 406 px wide in a 349 px box, the field\'s right part and its calendar button are cut off. The same "1fr 1fr" rows at :204-213 hold the other date pairs for TB tests, titers and drug screens. Seen in Chromium (Android Chrome); WebKit (iPhone Safari) was not available in the lab.',
  },
  {
    key: 'screening-dates', feature: 'CRED-037', kind: 'offscreen', severity: 'medium',
    match: /^label "REPORTED"$|^input\[type=date\]/,
    only: 'Screenings Add form',
    title: 'Phone Screenings form: the Reported date field runs off the right edge (the form scrolls sideways inside the dialog)',
    step: 'Credentials > Screenings > Add, on a phone',
    expected: 'Ordered and Reported both fit the form',
    actual: 'ScreeningsSection.jsx:218-220 puts the two date inputs in gridTemplateColumns "1fr 1fr" (the same pattern at :212, :222 and :240); the date input\'s minimum width keeps each track at about 189 px, so Reported starts at x=230 and is cut at the dialog\'s right edge (body 406 px wide in 349 px). Seen in Chromium; WebKit was not available in the lab.',
  },
  {
    key: 'category-field-editor', feature: 'CRED-047', kind: 'small', severity: 'low', only: 'custom category adding a field',
    match: /^button "(Save|Cancel)"$/,
    title: 'Phone custom category: the "Add a field" editor\'s Save and Cancel are 29 px tall',
    step: 'Credentials > Your categories > a category > Add a field, on a phone',
    expected: 'Each at least 32 px tall',
    actual: 'CustomCategorySection.jsx:131 (the shared header button style, padding 6px 10px, font 12.5) is used for the editor\'s Save and Cancel too: 29 px tall.',
  },
  {
    key: 'category-header', feature: 'CRED-047', kind: 'small', severity: 'low',
    match: /^button "(Rename|Add a field|Hide category)"$/,
    title: 'Phone custom category: "Rename", "Add a field" and "Hide category" are 29 px tall',
    step: 'Credentials > Your categories > a category, on a phone',
    expected: 'Each at least 32 px tall',
    actual: 'CustomCategorySection.jsx:131-138 styles them padding 6px 10px, font 12.5: 29 px tall.',
  },
];

/** The text the list shows for the record: the mark, or the first typed value on screen. */
async function shownText(page, s) {
  const candidates = [s.mark, ...s.fields.map(([, v]) => v).filter((v) => typeof v === 'string' && v.length > 3 && !/^\d{4}-\d{2}/.test(v))];
  for (const text of candidates) if (await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)) return text;
  return null;
}

async function fill(page, dlg, label, value) {
  const control = field(dlg, label);
  await control.scrollIntoViewIfNeeded();
  const [tag, type] = await control.evaluate((e) => [e.tagName, e.type]);
  if (tag === 'SELECT') {
    if (value && typeof value === 'object' && 'index' in value) return control.selectOption({ index: value.index });
    const labels = await control.locator('option').allInnerTexts();
    const pick = labels.find((l) => l.trim() === value.label) || labels.find((l) => l.includes(value.label));
    return control.selectOption({ label: pick });
  }
  if (type === 'date' || type === 'month' || type === 'number') return control.fill(String(value));
  // A physician types: a tap on the field, then the keyboard.
  await control.tap();
  await page.keyboard.type(String(value));
}

// Protected Identity's Edit, Delete and Show (ProtectedIdentitySection.jsx:187-190, 31 px tall) were
// filed as a bug and verified not to be one (2026-09-30): see smallByDesign on that screen.
const PROTECTED_BUTTONS = /^button "(Edit|Delete|Show|Hide)"$/;
const PROTECTED_VERDICT = 'Verified not a bug (2026-09-30): the 32 px floor is these journeys\' own; WCAG 2.2 (2.5.8) asks for 24 px, which these meet; the buttons sit 8 px apart, and Delete asks first (window.confirm) before anything is erased, so a missed tap is harmless. A polish item (minHeight 32 on btn()), not a product bug.';

/** A filed bug's pattern, to leave it out of another screen's sweep. */
const matchOf = (key) => BUGS.find((b) => b.key === key).match;

for (const width of [375, 390]) {
  const P = PHONES[width];
  test.describe(`phone ${P.name}`, () => {
    test.use(phoneUse(width));

    test(`credentials ${width}: every section's list, Add form and card; reload; second phone`, {
      tag: ['@phone', ...SECTIONS.map((s) => `@${s.id}`), '@CRED-006', '@CRED-002', '@CRED-003', '@CRED-017', '@CRED-023', '@CRED-026', '@CRED-028', '@CRED-047', '@CRED-005', '@CRED-038', '@CRED-025', '@CRED-046'],
    }, async ({ page, qa, browser }) => {
      test.setTimeout(20 * 60 * 1000);
      // A bug marked `only` is looked for on that one screen (its pattern is broad).
      const file = (audit, screen = '') => fileLayoutBugs(qa, audit, BUGS.filter((b) => !b.only || [].concat(b.only).includes(screen)), P.name);
      const { user, profile } = await newPhoneMember(page, { firstName: 'Casey', lastName: `Cards ${width}` });
      const rowFor = (s) => row(`select t.id, row_to_json(t)::text as j from public.${s.table} t where user_id = '${profile.id}' and row_to_json(t)::text like '%${s.mark.replace(/'/g, "''")}%'`);
      const known = anyOf(exceptChrome(), ...BUGS.filter((b) => b.kind === 'small' && !b.only).map((b) => b.match));
      // The license card's renewal line is CRED-028's check; other screens leave it out.
      const renewal = /How to renew|^a "Renew online"$/;
      const saved = [];

      await qa.feature('CRED-006', 'Credentials menu on a phone: every row, counts, Setup row', async () => {
        await phoneTab(page, 'Credentials');
        const audit = await auditScreen(qa, page, 'credentials menu', {
          allowSmall: exceptChrome(),
          primary: [['Setup row', credentialsRow(page, 'Setup')], ['Licenses row', credentialsRow(page, 'Licenses')], ['New category row', credentialsRow(page, 'New category')]],
        });
        file(audit);
        for (const s of SECTIONS) qa.check(`the menu lists ${s.section} with "0 items"`, /0 items/.test(await credentialsRow(page, s.section).innerText().catch(() => '')));
        qa.check('the Setup row shows "X of Y"', /\d of \d/.test(await credentialsRow(page, 'Setup').innerText()));
      }, { soft: true });

      for (const s of SECTIONS) {
        await qa.feature(s.id, `${s.section} on a phone: list, Add form, save, card, details`, async () => {
          await phoneCredentials(page, s.section);
          await sleep(600);
          const add = page.getByRole('button', { name: /^(\+ )?Add$/ }).first();
          file(await auditScreen(qa, page, `${s.section} list`, { allowSmall: known, primary: [['Add', add]] }));
          await add.tap();
          const dlg = page.getByRole('dialog').last();
          await dlg.waitFor({ timeout: 15000 });
          const d = await auditDialog(qa, page, `${s.section} Add form`, dlg, {
            actions: [['Add', dlg.getByRole('button', { name: /^(Add|Save)$/ }).last()], ['Cancel', dlg.getByRole('button', { name: 'Cancel' }).last()]],
          });
          file(d.audit, `${s.section} Add form`);
          for (const [label, value] of s.fields) await fill(page, dlg, label, value);
          await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().tap();
          const closed = await dlg.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
          qa.check('the form saves from the phone', closed, closed ? '' : ((await dlg.innerText()).match(/Required[^\n]*/)?.[0] || 'the form stayed open'));
          if (!closed) { await qa.shot(`${s.section} form refused`); await closeDialog(qa, `${s.section} Add form`, dlg); return; }
          await sleep(2000);
          const added = rowFor(s);
          qa.check(`a ${s.table} row with the typed values`, !!added, added ? added.j.slice(0, 160) : 'none');
          if (added) saved.push({ ...s, rowId: added.id });
          const shown = await shownText(page, s);
          qa.check('the record is listed', !!shown, shown ? `listed as "${shown}"` : 'none of the typed values is on screen');
          const star = page.getByRole('button', { name: /(Add to|Remove from) Favorites/ }).first();
          const primary = [];
          if (shown && await star.count()) {
            const b = recordButtons(page, shown);
            primary.push(['star', b.star], ['send', b.share], ['edit', b.edit], ['delete', b.remove]);
          }
          file(await auditScreen(qa, page, `${s.section} list with a record`, { allowSmall: anyOf(known, renewal), allowClipped: renewal, primary }));
          // Tap the card itself: the details view.
          const textNode = page.getByText(shown || s.mark, { exact: false }).first();
          if (s.id === 'CRED-009') {
            // By design: a CME entry has no details view (CMESection.jsx has no view modal); the pencil edits it.
          } else if (shown && await textNode.isVisible().catch(() => false)) {
            await textNode.tap();
            const view = page.getByRole('dialog').last();
            if (await view.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
              const v = await auditDialog(qa, page, `${s.section} details`, view);
              file(v.audit);
              await closeDialog(qa, `${s.section} details`, view);
            } else {
              qa.check('a tap on the card opens its details', false, 'no dialog opened');
            }
          }
          const back = backButton(page);
          const t = await tapTarget(back);
          qa.check('Back can be reached', t.onScreen && !t.covered, `${t.size} ${t.why}`);
          await back.tap();
          await sleep(400);
          qa.check('Back returns to the Credentials menu, the row now counts the record', /1 item/.test(await credentialsRow(page, s.section).innerText().catch(() => '')));
        }, { soft: true });
      }

      await qa.feature('CRED-005', 'Protected Identity on a phone: the form fits; saved on this device only', async () => {
        await phoneCredentials(page, 'Protected Identity');
        await sleep(600);
        const add = page.getByRole('button', { name: 'Add record' });
        file(await auditScreen(qa, page, 'Protected Identity', { allowSmall: known, primary: [['Add record', add]] }));
        await add.tap();
        const d = page.getByRole('dialog', { name: 'Add protected identity' });
        await d.waitFor();
        const save = d.getByRole('button', { name: 'Save on this device' });
        file((await auditDialog(qa, page, 'Add protected identity', d, { actions: [['Save on this device', save], ['Cancel', d.getByRole('button', { name: 'Cancel' })]] })).audit);
        await d.getByPlaceholder('e.g. Liability application 2026').tap();
        await page.keyboard.type('QA phone liability application');
        await field(d, 'Legal first name').tap();
        await page.keyboard.type('Casey');
        await field(d, 'Legal last name').tap();
        await page.keyboard.type('Cards');
        await d.getByPlaceholder('YYYY-MM-DD').fill('1981-03-04');
        await d.getByPlaceholder('###-##-####').tap();
        await page.keyboard.type('000-12-3456');
        const lock = d.getByPlaceholder('Lock code (8+ characters)');
        if (!(await lock.isVisible().catch(() => false))) { await save.tap(); await lock.waitFor({ timeout: 5000 }).catch(() => {}); }
        if (await lock.isVisible().catch(() => false)) {
          file((await auditDialog(qa, page, 'Add protected identity (lock code)', d, { actions: [['lock code', lock], ['Save on this device', save]] })).audit);
          await lock.tap();
          await page.keyboard.type('qa-lab-lock-code');
          await save.tap();
        }
        const closed = await d.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
        qa.check('the record saves on the phone', closed);
        await sleep(1500);
        qa.check('it is listed', await page.getByText('QA phone liability application').first().isVisible().catch(() => false));
        qa.check('the SSN is not shown in the clear', !(await page.locator('body').innerText()).includes('000-12-3456'));
        const withRecord = await auditScreen(qa, page, 'Protected Identity with a record', { allowSmall: anyOf(known, PROTECTED_BUTTONS) });
        // Its Edit and Delete also fit CRED-001's card-action pattern; they are the by-design
        // controls recorded just below, so they must not file the CRED-001 bug (smallByDesign:
        // "file no bug for them"). Every other section's cards are still swept for it.
        file({ ...withRecord, small: (withRecord.small || []).filter((s) => !PROTECTED_BUTTONS.test(s.el)) }, 'Protected Identity with a record');
        smallByDesign(qa, withRecord, { id: 'CRED-005', match: PROTECTED_BUTTONS, what: 'a record\'s Edit, Delete and Show', why: PROTECTED_VERDICT });
        await backButton(page).tap();
      }, { soft: true });

      await qa.feature('CRED-038', 'Professional Photo on a phone: the list and its Add form fit', async () => {
        await phoneCredentials(page, 'Professional Photo');
        await sleep(600);
        const add = page.getByRole('button', { name: /^(\+ )?Add$/ }).first();
        file(await auditScreen(qa, page, 'Professional Photo', { allowSmall: known, primary: [['Add', add]] }));
        await add.tap();
        const d = page.getByRole('dialog').last();
        await d.waitFor();
        file((await auditDialog(qa, page, 'Professional Photo Add form', d, { actions: [['Upload', d.getByRole('button', { name: 'Upload' })], ['Camera', d.getByRole('button', { name: 'Camera' })], ['Add', d.getByRole('button', { name: 'Add', exact: true }).last()]] })).audit);
        await closeDialog(qa, 'Professional Photo Add form', d);
        await backButton(page).tap();
      }, { soft: true });

      await qa.feature('CRED-025', 'Star a record on a phone; Favorites lists it', async () => {
        const priv = SECTIONS.find((x) => x.id === 'CRED-007');
        await phoneCredentials(page, 'Privileges');
        await sleep(600);
        const text = await shownText(page, priv);
        const star = recordButtons(page, text || priv.mark).star;
        await star.tap();
        await sleep(2000);
        qa.check('the star turns on', (await star.getAttribute('aria-pressed')) === 'true');
        const fav = row(`select favorite from public.privileges where user_id = '${profile.id}'`);
        qa.check('privileges.favorite is true in the database', fav?.favorite === true, fav);
        await backButton(page).tap();
        qa.check('the Favorites row counts 1 item', /1 item/.test(await credentialsRow(page, 'Favorites').innerText().catch(() => '')));
        await phoneCredentials(page, 'Favorites');
        await sleep(800);
        qa.check('Favorites lists the starred privileges', !!text && await page.getByText(text).first().isVisible().catch(() => false));
        file(await auditScreen(qa, page, 'Favorites', { allowSmall: known }));
        await backButton(page).tap();
      }, { soft: true });

      await qa.feature('CRED-046', 'Answer Bank (paused) on a phone', async () => {
        await phoneCredentials(page, 'Answer Bank');
        await sleep(600);
        file(await auditScreen(qa, page, 'Answer Bank', { allowSmall: known }));
        await backButton(page).tap();
      }, { soft: true });

      await qa.feature('CRED-026', 'License filter chips on a phone: each one filters the list', async () => {
        await phoneCredentials(page, 'Licenses');
        await sleep(600);
        for (const [chip, shows] of [['Medical Licenses', true], ['DEA / CSR', false], ['Board Certs', false], ['Life Support', false], ['All', true]]) {
          const b = page.getByRole('button', { name: new RegExp(`^${chip.replace(/[/]/g, '\\/')}( \\(\\d+\\))?$`) }).first();
          const t = await tapTarget(b);
          qa.check(`"${chip}" can be reached (${t.size})`, t.onScreen && !t.covered, t.why);
          await b.tap();
          await sleep(400);
          const listed = await page.getByText('QA-PHL-4410').first().isVisible().catch(() => false);
          qa.check(`"${chip}" ${shows ? 'lists' : 'hides'} the CO medical license`, listed === shows);
        }
        file(await auditScreen(qa, page, 'Licenses filtered', { allowSmall: anyOf(exceptChrome(), matchOf('card-actions'), renewal), allowClipped: renewal }));
      }, { soft: true });

      await qa.feature('CRED-028', 'Renewal info on the phone license card: the line reads, the box opens', async () => {
        const line = page.getByRole('button', { name: /^How to renew/ }).first();
        const has = await line.isVisible().catch(() => false);
        qa.check('the license card shows the "How to renew" line', has);
        if (!has) return;
        const visible = await line.evaluate((b) => { const span = b.querySelector('span'); return { text: span.innerText, shown: span.clientWidth, needs: span.scrollWidth }; });
        qa.check('the words "How to renew" are readable on the card', visible.shown >= visible.needs - 1, `${visible.shown}px shown of ${visible.needs}px needed`);
        await line.tap();
        await sleep(500);
        qa.check('a tap opens the renewal box', (await line.getAttribute('aria-expanded')) === 'true');
        file(await auditScreen(qa, page, 'Licenses with the renewal box open', { allowSmall: anyOf(exceptChrome(), matchOf('card-actions'), matchOf('filter-chips')) }));
        await line.tap();
        await backButton(page).tap();
      }, { soft: true });

      await qa.feature('CRED-017', 'Multi-State Matrix on a phone', async () => {
        await phoneCredentials(page, 'Multi-State Matrix');
        await sleep(1000);
        file(await auditScreen(qa, page, 'Multi-State Matrix', { allowSmall: known }));
        await backButton(page).tap();
      }, { soft: true });

      await qa.feature('CRED-023', 'Create a custom category on a phone and add a record', async () => {
        await phoneCredentials(page, 'New category');
        await sleep(600);
        file(await auditScreen(qa, page, 'New category form', { allowSmall: known, primary: [['Create category', page.getByRole('button', { name: 'Create category' })]] }));
        await page.getByPlaceholder('e.g. Hospital ID Badges').tap();
        await page.keyboard.type('QA Phone Badges');
        await page.getByPlaceholder('One emoji').fill('🪪');
        await page.getByPlaceholder('Badge number, Facility, Access level').tap();
        await page.keyboard.type('Badge number, Facility');
        await page.getByRole('button', { name: 'Create category' }).tap();
        await sleep(2500);
        const cat = row(`select id from public.custom_categories where user_id = '${profile.id}' and name = 'QA Phone Badges'`);
        qa.check('custom_categories row created', !!cat);
      }, { soft: true });

      await qa.feature('CRED-047', 'Custom category header on a phone: Rename, Add a field, Hide category', async () => {
        const heading = page.getByRole('heading', { name: /QA Phone Badges/ }).first();
        qa.check('the new category is open', await heading.isVisible().catch(() => false));
        file(await auditScreen(qa, page, 'custom category (empty)', {
          allowSmall: exceptChrome(),
          primary: ['Rename', 'Add a field', 'Hide category'].map((n) => [n, page.getByRole('button', { name: n, exact: true })]),
        }));
        await page.getByRole('button', { name: 'Add a field', exact: true }).tap();
        await sleep(500);
        const input = page.locator('input:focus, input[placeholder]').last();
        qa.check('"Add a field" shows a field name box', await input.isVisible().catch(() => false));
        file(await auditScreen(qa, page, 'custom category adding a field', { allowSmall: anyOf(exceptChrome(), BUGS.find((b) => b.key === 'category-header').match) }), 'custom category adding a field');
        await page.keyboard.press('Escape').catch(() => {});
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true }).first();
        if (await cancel.isVisible().catch(() => false)) await cancel.tap();
      }, { soft: true });

      await qa.feature('CRED-002', 'After a reload the records are still listed; a second phone lists them too', async () => {
        await reloadPhone(page);
        await phoneTab(page, 'Credentials');
        for (const s of saved.slice(0, 4)) qa.check(`${s.section} still counts 1 item after a reload`, /1 item/.test(await credentialsRow(page, s.section).innerText().catch(() => '')));
        const other = await secondPhone(browser, qa.report, width === 375 ? 390 : 375);
        try {
          await signInPhone(other.page, user);
          await phoneCredentials(other.page, 'Licenses');
          await sleep(1500);
          qa.check('the second phone lists the license added on the first', await other.page.getByText('QA-PHL-4410').first().isVisible().catch(() => false));
          await backButton(other.page).tap();
          await phoneCredentials(other.page, 'Insurance');
          await sleep(1000);
          qa.check('and the insurance policy', await other.page.getByText(/QA-PHPOL-51|QA Phone Malpractice|QA Mutual/).first().isVisible().catch(() => false));
        } finally { await other.context.close().catch(() => {}); }
      }, { soft: true });

      await qa.feature('CRED-003', 'Delete the license from its phone card', async () => {
        const lic = saved.find((s) => s.id === 'CRED-001');
        if (!lic) { qa.check('a license was saved earlier', false); return; }
        await phoneCredentials(page, 'Licenses');
        await sleep(800);
        const dialogs = qa.report.dialogs.length;
        await recordButtons(page, (await shownText(page, lic)) || lic.mark).remove.tap();
        await sleep(2500);
        qa.check('a confirmation was asked', qa.report.dialogs.length > dialogs, qa.report.dialogs.slice(dialogs).join(' | '));
        qa.check('the licenses row is gone and tombstoned', !row(`select id from public.licenses where id = '${lic.rowId}'`) && tombstones(profile.id).some((t) => t.item_id === lic.rowId));
        await reloadPhone(page);
        await phoneCredentials(page, 'Licenses');
        qa.check('it does not come back after a reload', !(await page.getByText('QA-PHL-4410').count()));
      }, { soft: true });
    });
  });
}
