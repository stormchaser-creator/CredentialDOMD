// The CV page previews whatever the CV holds, and says so when a copy fails.
// Real component, real CV builder; synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, settle } from '../component-harness.mjs';

const base = { settings: { name: 'Synthetic Physician', degreeType: 'MD' }, licenses: [], education: [], cme: [], workHistory: [], publications: [], memberships: [], privileges: [], insurance: [], peerReferences: [] };
const mount = async (data, copyResult = true) => mountComponent('src/components/features/CVGenerator.jsx', {
  app: { data, theme: {} },
  modules: {
    cvContent: await import('../../src/utils/cvContent.js'),
    shareText: await import('../../src/utils/shareText.js'),
    helpers: { copyToClipboard: async () => { if (copyResult instanceof Error) throw copyResult; return copyResult; } },
  },
});

test('a record with only work history shows the preview, not "Add credentials first"', async () => {
  const m = await mount({ ...base, workHistory: [{ id: 'w', employer: 'Synthetic Medical Center', position: 'Attending' }] });
  assert.doesNotMatch(m.pageText(), /Add credentials first/);
  const m2 = await mount({ ...base, publications: [{ id: 'p', citation: 'Synthetic A. A synthetic paper. J Synth. 2020.' }] });
  assert.doesNotMatch(m2.pageText(), /Add credentials first/);
  const empty = await mount(base);
  assert.match(empty.pageText(), /Add credentials first/, 'an empty record still says so');
});

test('a failed copy says it failed', async () => {
  for (const result of [false, new Error('denied')]) {
    const m = await mount({ ...base, licenses: [{ id: 'l', type: 'State Medical License (MD)', state: 'CO' }] }, result);
    const copy = m.nodes().find(n => n.type === 'button' && /Copy/.test(m.text(n)));
    assert.ok(copy, 'the Copy button is there');
    await copy.props.onClick();
    await settle();
    const page = m.pageText();
    assert.doesNotMatch(page, /Copied\. Paste it anywhere\./);
    assert.match(page, /Could not copy here\. Use Save PDF instead\./);
  }
  const ok = await mount({ ...base, licenses: [{ id: 'l', type: 'State Medical License (MD)', state: 'CO' }] }, true);
  await ok.nodes().find(n => n.type === 'button' && /Copy/.test(ok.text(n))).props.onClick();
  assert.match(ok.pageText(), /Copied\. Paste it anywhere\./);
});

// A record can fill one CV and leave another empty: publications alone fill
// the Clinical CV, while the Locum Tenens CV lists licences, privileges,
// courses, work, training, insurance and references. The Locum tile then
// said "Add credentials first" with an import prompt to a member with
// records, and Copy and Save PDF exported a CV with only its header.
const mountRecording = async (data) => {
  const calls = [];
  const m = await mountComponent('src/components/features/CVGenerator.jsx', {
    app: { data, theme: {} },
    modules: {
      cvContent: await import('../../src/utils/cvContent.js'),
      shareText: await import('../../src/utils/shareText.js'),
      helpers: { copyToClipboard: async (t) => { calls.push(['copy', t]); return true; } },
      cvPdf: { shareCvPdf: async () => { calls.push(['pdf']); return 'download'; } },
    },
  });
  const button = (re) => m.nodes().find(n => n.type === 'button' && re.test(m.text(n)));
  return { m, calls, button };
};
const PUBLICATIONS_ONLY = {
  ...base,
  publications: [{ id: 'p', citation: 'Synthetic A. A synthetic paper. J Synth. 2020.' }],
  memberships: [{ id: 'm', organization: 'Synthetic Society', role: 'Member' }],
};

test('a record with publications only: the Locum Tenens tile names what that CV lists, not "Add credentials first"', async () => {
  const { m, button } = await mountRecording(PUBLICATIONS_ONLY);
  assert.match(m.pageText(), /A synthetic paper/, 'the Clinical CV previews the publication');
  button(/^Locum Tenens/).props.onClick();
  const page = m.pageText();
  assert.doesNotMatch(page, /Add credentials first/);
  assert.match(page, /Nothing on the Locum Tenens CV yet\./);
  assert.match(page, /It lists your licenses, hospital privileges, courses, work history, education, languages, liability insurance and references\./);
  assert.doesNotMatch(page, /A synthetic paper/, 'no header-only preview either');
});

test('Copy and Save PDF on an empty CV say so and export nothing', async () => {
  const { m, calls, button } = await mountRecording(PUBLICATIONS_ONLY);
  button(/^Locum Tenens/).props.onClick();
  const said = () => m.pageText().split('Nothing on the Locum Tenens CV yet.').length - 1;
  assert.equal(said(), 1, 'the empty card says it once');
  await button(/Copy to Clipboard/).props.onClick();
  assert.equal(said(), 2, 'the Copy tap says it too');
  await button(/Save PDF/).props.onClick();
  await settle();
  assert.deepEqual(calls, [], 'nothing copied, no PDF built');
  button(/^Clinical CV/).props.onClick();
  await button(/Copy to Clipboard/).props.onClick();
  await button(/Save PDF/).props.onClick();
  await settle();
  assert.deepEqual(calls.map(c => c[0]), ['copy', 'pdf'], 'the Clinical CV still exports');
  assert.match(calls[0][1], /A synthetic paper/);
});

test('a record that fills no CV still says "Add credentials first" on every template', async () => {
  const { m, button } = await mountRecording(base);
  for (const tile of [/^Clinical CV/, /^Academic CV/, /^Locum Tenens/]) {
    button(tile).props.onClick();
    const page = m.pageText();
    assert.match(page, /Add credentials first/);
    assert.doesNotMatch(page, /Nothing on the/);
    assert.ok(button(/^Start from my CV$/), 'the import prompt stays');
  }
});
