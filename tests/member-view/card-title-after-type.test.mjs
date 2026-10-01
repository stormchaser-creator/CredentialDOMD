// The read-only records page showed a license as "State Medical License, , CO"
// and a policy as "Malpractice, , QA Mutual"; the Member viewer card put ", CO"
// under its STATE MEDICAL LICENSE header. describeItem joins a title with
// ", ", but the card stripped the type from it only when an em dash followed,
// and the archive then put the type in front again. The app's own cards
// (CrudSection, HealthRecordsSection) used the same strip.
//
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as helpers from '../../src/utils/helpers.js';
import { recordCard } from '../../src/utils/memberViewer.js';
import { recordHeading } from '../../src/utils/readOnlyArchive.js';

const license = { id: 'lic-synthetic-1', type: 'State Medical License', state: 'CO', licenseNumber: 'QA-000001', expirationDate: '2030-01-31' };
const policy = { id: 'ins-synthetic-1', type: 'Malpractice', provider: 'QA Mutual', policyNumber: 'QA-POL-1', expirationDate: '2030-06-30' };
const data = { settings: { name: 'Synthetic Physician' }, licenses: [license], insurance: [policy] };
const snapshot = { member: { name: 'Synthetic Physician' }, sections: data };

test('the main line is the title after its type, with the comma describeItem writes', () => {
  const { titleAfterType } = helpers;
  assert.equal(typeof titleAfterType, 'function');
  assert.equal(helpers.describeItem(license, '', 'licenses'), 'State Medical License, CO');
  assert.equal(titleAfterType('State Medical License, CO', 'State Medical License'), 'CO');
  assert.equal(titleAfterType('Malpractice, QA Mutual', 'malpractice'), 'QA Mutual', 'case of the type does not matter');
  assert.equal(titleAfterType('State Medical License \u{2014} CO', 'State Medical License'), 'CO', 'an em dash title still strips');
  assert.equal(titleAfterType('State Medical License', 'State Medical License'), '', 'only the type: nothing under the header');
  assert.equal(titleAfterType('DEA Registration, CO', 'DEA'), 'DEA Registration, CO', 'a longer word is not cut in half');
  assert.equal(titleAfterType('Board Certification, ABNS', 'Board'), 'Board Certification, ABNS');
  assert.equal(titleAfterType('Colorado, CO', 'State Medical License'), 'Colorado, CO', 'a title that does not lead with the type is whole');
  assert.equal(titleAfterType('Colorado, CO', ''), 'Colorado, CO');
});

test('the Member viewer card: STATE MEDICAL LICENSE over CO, Malpractice over QA Mutual', () => {
  const card = recordCard('licenses', license, snapshot);
  assert.equal(card.type, 'State Medical License');
  assert.equal(card.mainLine, 'CO');
  const ins = recordCard('insurance', policy, snapshot);
  assert.equal(ins.type, 'Malpractice');
  assert.equal(ins.mainLine, 'QA Mutual');
});

test('the read-only records page titles each record once, with no empty part', () => {
  assert.equal(recordHeading('licenses', license, data).title, 'State Medical License, CO');
  assert.equal(recordHeading('insurance', policy, data).title, 'Malpractice, QA Mutual');
  const bare = { id: 'lic-synthetic-2', type: 'State Medical License', expirationDate: '2030-01-31' };
  assert.equal(recordHeading('licenses', bare, { ...data, licenses: [bare] }).title, 'State Medical License');
  const dea = { id: 'lic-synthetic-3', type: 'DEA', name: 'DEA Registration', state: 'CO' };
  const deaTitle = recordHeading('licenses', dea, { ...data, licenses: [dea] }).title;
  assert.doesNotMatch(deaTitle, /,\s*,/);
  assert.equal(deaTitle.match(/DEA/g).length, 1, deaTitle);
  for (const record of [license, policy, bare]) {
    for (const key of ['licenses', 'insurance']) assert.doesNotMatch(recordHeading(key, record, data).title, /,\s*,|^\s*,/);
  }
});

test('the app cards and the viewer share the one strip', async () => {
  for (const file of ['src/components/features/CrudSection.jsx', 'src/components/features/HealthRecordsSection.jsx', 'src/utils/memberViewer.js']) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes('titleAfterType('), `${file} uses titleAfterType`);
    assert.ok(!source.includes('.slice(String(item.type).length)'), `${file} keeps no strip of its own`);
  }
});

// Review of the fix above. (1) The archive kept a main line whole when it
// began with the type's letters, so a "Tail" policy from "Tailored Risk
// Insurance" lost its type on the read-only page. (2) A stored type with a
// trailing space did not strip, and the page read "State Medical License ,
// State Medical License, CO". (4) The Member viewer's Home row printed the
// type and then a main line that was only the type again.
test('letters are not the type: Tail over Tailored Risk Insurance keeps its type', () => {
  const tail = { id: 'ins-synthetic-2', type: 'Tail', provider: 'Tailored Risk Insurance', expirationDate: '2030-06-30' };
  assert.equal(recordHeading('insurance', tail, { ...data, insurance: [tail] }).title, 'Tail, Tailored Risk Insurance');
  const same = { id: 'ins-synthetic-3', type: 'Malpractice', provider: 'Malpractice Mutual', expirationDate: '2030-06-30' };
  assert.equal(recordHeading('insurance', same, { ...data, insurance: [same] }).title, 'Malpractice, Malpractice Mutual');
  const { titleWithType } = helpers;
  assert.equal(titleWithType('Tailored Risk Insurance', 'Tail'), 'Tail, Tailored Risk Insurance');
  assert.equal(titleWithType('DEA Registration, CO', 'DEA'), 'DEA Registration, CO', 'the type as a whole word leads already');
  assert.equal(titleWithType('State Medical License, CO', 'State Medical License'), 'State Medical License, CO');
  assert.equal(titleWithType('State Medical License', 'State Medical License'), 'State Medical License');
  assert.equal(titleWithType('Colorado, CO', 'State Medical License'), 'State Medical License, Colorado, CO');
  assert.equal(titleWithType('Colorado, CO', ''), 'Colorado, CO');
});

test('a type stored with stray whitespace strips like the trimmed one', () => {
  assert.equal(helpers.titleAfterType('State Medical License, CO', 'State Medical License '), 'CO');
  const spaced = { ...license, id: 'lic-synthetic-4', type: 'State Medical License ' };
  const card = recordCard('licenses', spaced, { ...snapshot, sections: { ...data, licenses: [spaced] } });
  assert.deepEqual([card.type, card.mainLine], ['State Medical License', 'CO']);
  assert.equal(recordHeading('licenses', spaced, { ...data, licenses: [spaced] }).title, 'State Medical License, CO');
  const tail = { id: 'ins-synthetic-5', type: ' Tail Coverage ', provider: 'QA Mutual', expirationDate: '2030-06-30' };
  assert.equal(recordHeading('insurance', tail, { ...data, insurance: [tail] }).title, 'Tail Coverage, QA Mutual');
});

test('the Home row names a record whose title is only its type once', async () => {
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const bare = { id: 'lic-synthetic-6', type: 'State Medical License', licenseNumber: 'X1', expirationDate: soon };
  const card = recordCard('licenses', bare, { ...snapshot, sections: { ...data, licenses: [bare] } });
  assert.equal(card.headline, 'State Medical License');
  assert.equal(recordCard('licenses', license, snapshot).headline, 'State Medical License, CO');
  const source = await readFile(new URL('../../src/components/features/MemberViewer.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('{item.label}: {item.headline}'), 'the Home row prints the headline');
  assert.ok(!source.includes('`${item.type} `'), 'and no type of its own in front of it');
});
