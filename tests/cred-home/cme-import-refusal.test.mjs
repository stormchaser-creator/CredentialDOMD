// A refused write in a CME transcript import is not counted as added and
// does not drop the rows from review; no CME entry is written with a blank
// credit type (cme.category is NOT NULL). Real component, synthetic rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, settle } from '../component-harness.mjs';
import { prepareRecord } from '../../src/utils/recordWrite.js';

const csvRows = 'Date,Title,Hours,Credit Type\n2026-01-10,Synthetic course one,2,AMA PRA Category 1\n2026-02-10,Synthetic course two,3,AMA PRA Category 1\n2026-03-10,Synthetic course three,1,AMA PRA Category 1\n';

async function mountImport(addItem) {
  const m = await mountComponent('src/components/features/CMEImport.jsx', {
    app: { data: { settings: { degreeType: 'MD' }, cme: [] }, theme: {}, addItem },
    props: { open: true, onClose() {}, requiredTopics: [] },
    modules: {
      cmeImport: await import('../../src/utils/cmeImport.js'),
      credentialTypes: await import('../../src/constants/credentialTypes.js'),
      cmeTopics: await import('../../src/constants/cmeTopics.js'),
      helpers: await import('../../src/utils/helpers.js'),
      spreadsheetGuard: await import('../../src/utils/spreadsheetGuard.js'),
      aiClient: { useAiAvailable: () => false, aiAvailable: () => false, describeAiStatus: () => '' },
      xlsx: await import('xlsx'),
    },
  });
  const [input] = m.fileInputs();
  await m.pick(input, [new File([csvRows], 'transcript.csv', { type: 'text/csv' })]);
  await settle();
  const next = m.nodes().find(n => n.type === 'button' && m.text(n) === 'Continue to review');
  if (next) { next.props.onClick(); m.render(); }
  return m;
}
const addButton = m => m.nodes().find(n => n.type === 'button' && /^Add \d+ to CME log/.test(m.text(n)));

test('a refusal after the first row stops, keeps the rest in review and never says they were added', async () => {
  let calls = 0;
  const m = await mountImport(() => (++calls === 1 ? undefined : false));
  const add = addButton(m);
  assert.ok(add, `the review step is showing: ${m.pageText().slice(0, 200)}`);
  add.props.onClick();
  m.render();
  const page = m.pageText();
  assert.doesNotMatch(page, /Added 3 CME entries/);
  assert.match(page, /1 added\. Nothing more was saved/);
  assert.match(page, /Add 2 to CME log/, 'the two refused rows are still there to add again');
  assert.equal(calls, 2, 'it stopped at the first refusal');
});

test('the review list offers no blank credit type', async () => {
  const m = await mountImport(() => undefined);
  const selects = m.nodes().filter(n => n.type === 'select');
  const credit = selects.filter(s => [s.props.children].flat(3).some(o => o?.props?.value === 'AMA PRA Category 1'));
  assert.ok(credit.length > 0);
  for (const s of credit) assert.ok(![s.props.children].flat(3).some(o => o?.type === 'option' && o.props.value === ''), 'no blank option');
});

test('no path writes a CME entry without a credit type', () => {
  assert.equal(prepareRecord('cme', { id: 'c', title: 'x', category: '' }).category, 'Other');
  assert.equal(prepareRecord('cme', { id: 'c', title: 'x' }).category, 'Other');
  assert.equal(prepareRecord('cme', { id: 'c', category: 'AMA PRA Category 1' }).category, 'AMA PRA Category 1');
});
