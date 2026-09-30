// P1 journey: every other Credentials section, the way a physician fills
// them in: add a record through the section's form, see it listed, edit one
// field, reload, then delete it (tombstoned). Each section's database row is
// found by a unique synthetic value, so the check does not depend on column
// names. One test physician for the whole file; each section is its own
// stretch, and a failing section does not stop the others.
import { test } from './support/fixtures.mjs';
import {
  field, newMember, openCredentials, pendingOps, recordButtons, row, sleep, syncWarnings, tombstones, waitForMemberApp,
} from './support/lab.mjs';

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

// [label, value]: a value of {index: n} picks the nth option, {label: 'x'} an option by label.
const SECTIONS = [
  { id: 'CRED-007', section: 'Privileges', table: 'privileges', mark: 'QA Mercy Privileges', edit: ['Facility', 'QA Mercy Hospital East'], fields: [
    ['Type', { index: 1 }], ['Display Name', 'QA Mercy Privileges'], ['Facility', 'QA Mercy Hospital'], ['City', 'Denver'], ['State', { label: 'CO' }],
    ['Appointed', day(-300)], [/^Reappointment Due/, day(400)], ['Portal username', 'qa.portal.user'] ] },
  { id: 'CRED-008', section: 'Insurance', table: 'insurance', mark: 'QA-POL-7781', edit: ['Carrier', 'QA Mutual Assurance'], fields: [
    ['Type', { index: 1 }], ['Display Name', 'QA Malpractice Policy'], ['Carrier', 'QA Mutual'], ['Policy #', 'QA-POL-7781'], ['Per Claim', '1000000'],
    ['Aggregate', '3000000'], ['Effective', day(-100)], [/^Expires/, day(265)] ] },
  { id: 'CRED-009', section: 'CME Credits', table: 'cme', mark: 'QA Neurosurgery Update', edit: ['Hours', '6'], fields: [
    ['Activity / Title', 'QA Neurosurgery Update'], ['Credit Category', { label: 'AMA PRA Category 1' }], ['Hours', '5'], ['Date Completed', day(-20)], ['Provider / Institution', 'QA CME Provider'] ] },
  { id: 'CRED-019', section: 'Work History', table: 'work_history', mark: 'QA Health Partners', edit: ['City', 'Aurora'], fields: [
    ['Position Type', { index: 1 }], ['Position/Title', 'Attending Neurosurgeon'], ['Employer/Organization', 'QA Health Partners'], ['City', 'Denver'], ['State', { label: 'CO' }], ['Start Date', day(-1500)] ] },
  { id: 'CRED-021', section: 'Health Records', table: 'health_records', mark: 'QA Flu Shot', edit: ['Lot / Batch #', 'QA-LOT-22'], fields: [
    ['Category', { label: 'Vaccination' }], ['Display Name', 'QA Flu Shot'], ['Date Administered', day(-30)], ['Lot / Batch #', 'QA-LOT-21'], ['Administrator / Facility', 'QA Clinic'] ] },
  { id: 'CRED-022', section: 'Travel & IDs', table: 'travel_docs', mark: 'QA-TRAVEL-4410', edit: ['Label (optional)', 'QA frequent flyer (edited)'], fields: [
    ['Type', { index: 1 }], ['Airline / Hotel / Company', 'QA Airways'], ['Number', 'QA-TRAVEL-4410'], ['Label (optional)', 'QA frequent flyer'], ['Expires (if it does)', day(700)] ] },
  { id: 'CRED-020', section: 'Case Logs', table: 'case_logs', mark: 'QA suboccipital craniotomy', edit: ['Facility', 'QA Mercy Hospital East'], fields: [
    ['Category', { index: 1 }], ['Description', 'QA suboccipital craniotomy'], ['Date', day(-5)], ['Facility', 'QA Mercy Hospital'], ['Role', { index: 1 }], ['CPT Code(s)', '61510'] ] },
  { id: 'CRED-039', section: 'Publications', table: 'publications', mark: 'QA Journal of Synthetic Surgery', edit: ['Year', '2025'], fields: [
    ['Short Label', 'QA paper'], ['Full Citation (as it should read on the CV)', 'Physician T, et al. A synthetic study. QA Journal of Synthetic Surgery. 2024;1:1-2.'], ['Year', '2024'], ['Order on CV', '1'] ] },
  { id: 'CRED-040', section: 'Professional Organizations', table: 'professional_memberships', mark: 'QA Society of Neurosurgeons', edit: ['Membership Type', 'Fellow'], fields: [
    ['Organization', 'QA Society of Neurosurgeons'], ['Membership Type', 'Member'], ['Member Since', day(-900)], ['Renewal Due', day(120)] ] },
  { id: 'CRED-041', section: 'Peer References', table: 'peer_references', mark: 'Quinn Referee', edit: ['Institution/Hospital', 'QA Mercy Hospital East'], fields: [
    ['Full Name', 'Quinn Referee'], ['Degree/Credential', 'MD'], ['Specialty', 'Neurosurgery'], ['Institution/Hospital', 'QA Mercy Hospital'], [/^Relationship/, { index: 1 }],
    ['Email', 'quinn.referee@qa.credentialdomd.test'], ['Known Since (month & year)', '2018-07'] ] },
  { id: 'CRED-045', section: 'Malpractice History', table: 'malpractice_history', mark: 'QA synthetic claim description', edit: ['Facility', 'QA Mercy Hospital East'], fields: [
    ['Date of Incident', day(-2000)], ['Date Filed', day(-1900)], ['State', { label: 'CO' }], ['Outcome', { index: 1 }], ['Description', 'QA synthetic claim description'], ['Facility', 'QA Mercy Hospital'] ] },
  { id: 'CRED-037', section: 'Screenings', table: 'screenings', mark: 'QA-SCREEN-551', edit: ['Screening agency', 'QA Screening Co (edited)'], fields: [
    ['Type', { index: 1 }], ['Display name', 'QA Background Check'], ['Screening agency', 'QA Screening Co'], ['File / report #', 'QA-SCREEN-551'], ['Ordered', day(-40)], ['Reported', day(-30)] ] },
];

/** The text the section's list shows for the record: the first entered value visible on a record card or row. */
async function shownText(page, s) {
  const candidates = [s.mark, ...s.fields.map(([, v]) => v).filter((v) => typeof v === 'string' && v.length > 3 && !/^\d{4}-\d{2}-\d{2}$/.test(v))];
  const star = page.getByRole('button', { name: /(Add to|Remove from) Favorites/ });
  for (const text of candidates) {
    if (await page.locator('tr, div').filter({ hasText: text }).filter({ has: star }).count()) return text;
  }
  return null;
}

async function fill(dlg, label, value) {
  const control = field(dlg, label);
  const tag = await control.evaluate((e) => e.tagName);
  if (tag === 'SELECT') {
    if (value && typeof value === 'object' && 'index' in value) return control.selectOption({ index: value.index });
    if (value && typeof value === 'object' && 'label' in value) {
      const labels = await control.locator('option').allInnerTexts();
      const pick = labels.find((l) => l.trim() === value.label) || labels.find((l) => l.includes(value.label));
      return control.selectOption({ label: pick });
    }
    return control.selectOption(String(value));
  }
  return control.fill(String(value));
}

test('credentials: every other section adds, edits, survives a reload and deletes', {
  tag: SECTIONS.map((s) => `@${s.id}`).concat(['@CRED-006']),
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Sasha', lastName: 'Sections' });
  const rowFor = (s) => row(`select t.id, row_to_json(t)::text as j from public.${s.table} t where user_id = '${profile.id}' and row_to_json(t)::text like '%${s.mark.replace(/'/g, "''")}%'`);

  for (const s of SECTIONS) {
    await qa.feature(s.id, `${s.section}: add, edit, reload, delete`, async () => {
      const mark = qa.report.console.length;
      await openCredentials(page, s.section);
      await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
      const dlg = page.getByRole('dialog').last();
      await dlg.waitFor();
      for (const [label, value] of s.fields) await fill(dlg, label, value);
      await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
      const closed = await dlg.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
      const refusal = closed ? '' : ((await dlg.innerText()).match(/Required[^\n]*/)?.[0] || 'the form stayed open');
      qa.check('the form saves', closed, refusal);
      if (!closed) { await qa.shot(`${s.section} form refused`); await dlg.getByRole('button', { name: 'Cancel' }).click().catch(() => {}); return; }
      await sleep(2500);
      const added = rowFor(s);
      qa.check(`a ${s.table} row with the entered values`, !!added, added ? added.j.slice(0, 160) : 'none');
      const shown = await shownText(page, s);
      qa.check('the record is listed', !!shown, shown ? `listed as "${shown}"` : 'none of the entered values is on a record card');
      // Edit one field.
      await recordButtons(page, shown || s.mark).edit.click();
      const edit = page.getByRole('dialog', { name: 'Edit' });
      await edit.waitFor({ timeout: 15000 });
      await fill(edit, s.edit[0], s.edit[1]);
      await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
      await edit.waitFor({ state: 'detached', timeout: 15000 });
      await sleep(2500);
      qa.check('no sync warning and an empty queue', syncWarnings(qa.report, mark).length === 0 && (await pendingOps(page)).length === 0, syncWarnings(qa.report, mark).join(' | '));
      await page.reload();
      await waitForMemberApp(page);
      const edited = rowFor(s);
      qa.check('the edit is in the database after a reload', !!edited && edited.j.includes(String(s.edit[1]).replace(/"/g, '\\"')), edited?.j.slice(0, 200));
      await openCredentials(page, s.section);
      // Delete.
      await recordButtons(page, (await shownText(page, s)) || s.mark).remove.click();
      await sleep(2500);
      qa.check('the row is deleted', !rowFor(s));
      qa.check('the deletion is tombstoned', tombstones(profile.id).some((t) => t.item_id === added.id), `collection ${tombstones(profile.id).find((t) => t.item_id === added.id)?.collection}`);
      await page.reload();
      await waitForMemberApp(page);
      await openCredentials(page, s.section);
      qa.check('it does not come back after a reload', !(await shownText(page, s)));
    }, { soft: true });
  }

  await qa.feature('CRED-006', 'Credentials menu shows each section', async () => {
    await openCredentials(page);
    const nav = page.getByRole('navigation').filter({ hasText: 'Active Credentials' });
    for (const s of ['Licenses', 'Privileges', 'Insurance', 'CME Credits', 'Education', 'Work History', 'Case Logs', 'Health Records', 'Travel & IDs', 'Screenings', 'Publications', 'Peer References', 'Malpractice History']) {
      qa.check(`the menu lists ${s}`, await nav.getByRole('button', { name: new RegExp(`${s.replace(/[&]/g, '&')}`) }).count() > 0);
    }
    qa.check('the Setup row shows "X of Y"', /Setup\s*\d of \d/.test(await nav.innerText()));
  });
});
