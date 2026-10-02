// Home's empty state for a member with no records (GetStartedCard): a blank
// profession is asked on the card itself before any licence is added; a
// chosen profession adds its own licence in one tap, as before.
import '../helpers/app-rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';

const T = { card: '#fff', border: '#ddd', accent: '#06c', accentDim: '#eef', text: '#000', textMuted: '#666', shadow1: 'none' };
const mount = (degreeType, calls) => mountComponent('src/components/features/GetStartedCard.jsx', {
  props: { degreeType, theme: T, onAdd: () => calls.push(['add']), onChooseProfession: (d) => calls.push(['choose', d]) },
});

test('a blank member is asked her profession on the first card, with the one-tap picker', async () => {
  const calls = [];
  const c = await mount('', calls);
  assert.doesNotMatch(c.pageText(), /medical license/i, 'the blank card never names only a medical license');
  const picker = c.nodes().find(n => typeof n.type === 'function' && n.type.name === 'ProfessionPicker');
  assert.ok(picker, 'the shared picker (ProfessionPicker.jsx) asks it');
  assert.equal(picker.props.id, 'get-started-profession');
  assert.equal(picker.props.why, 'Your profession sets the license types and the rules the app tracks.');
  assert.equal(picker.props.onDismiss, undefined, 'Home has no "Not now": the card is the choice');
  assert.equal(c.render().props.onClick, undefined, 'the blank card itself never opens the physician add form');
  picker.props.onChoose('PA');
  assert.deepEqual(calls, [['choose', 'PA']]);
});

test('the picker: "Which license do you hold?" with MD, DO, PA and NP, one tap each; "Not now" only where offered', async () => {
  const chosen = [];
  const T2 = { ...T, textDim: '#777' };
  const appRules = await import('../../src/utils/appRules.js');
  const home = await mountComponent('src/components/features/ProfessionPicker.jsx', { modules: { appRules },
    props: { id: 'get-started-profession', why: 'Your profession sets the license types and the rules the app tracks.', onChoose: d => chosen.push(d), theme: T2 } });
  // Home's card reads exactly as it did before the picker was shared.
  assert.equal(home.pageText(), 'Which license do you hold? Your profession sets the license types and the rules the app tracks.MDDOPANP');
  const buttons = home.nodes().filter(n => n.type === 'button');
  assert.deepEqual(buttons.map(b => home.text(b)), ['MD', 'DO', 'PA', 'NP']);
  buttons.find(b => home.text(b) === 'NP').props.onClick();
  assert.deepEqual(chosen, ['NP']);
  let dismissed = 0;
  const inline = await mountComponent('src/components/features/ProfessionPicker.jsx', { modules: { appRules },
    props: { id: 'x', why: 'Why.', onChoose: () => {}, onDismiss: () => { dismissed++; }, theme: T2 } });
  const notNow = inline.nodes().filter(n => n.type === 'button').find(b => inline.text(b) === 'Not now');
  notNow.props.onClick();
  assert.equal(dismissed, 1);
});

test('a member with a profession adds her own licence in one tap, with the copy unchanged', async () => {
  for (const [deg, copy] of [['MD', 'Add your medical license to begin tracking credentials'], ['DO', 'Add your medical license to begin tracking credentials'], ['PA', 'Add your physician assistant license to begin tracking credentials'], ['NP', 'Add your APRN and RN licenses to begin tracking credentials']]) {
    const calls = [];
    const c = await mount(deg, calls);
    assert.equal(c.pageText(), `Get Started${copy}`);
    assert.equal(c.nodes().filter(n => n.type === 'button').length, 0);
    c.render().props.onClick();
    assert.deepEqual(calls, [['add']]);
  }
});

test('Home: a refused profile save says so and opens no Add License form; a saved choice opens it', async () => {
  const { readFileSync } = await import('node:fs');
  // The helper as written in ProfessionPicker.jsx (node does not load JSX).
  const src = readFileSync(new URL('../../src/components/features/ProfessionPicker.jsx', import.meta.url), 'utf8');
  const helper = `import { afterAppRules } from ${JSON.stringify(new URL('../../src/utils/appRules.js', import.meta.url).href)};\n`
    + src.slice(src.indexOf('export function chooseProfessionThen'), src.indexOf('// A PA or NP tap waits here'));
  const { chooseProfessionThen } = await import(`data:text/javascript;base64,${Buffer.from(helper).toString('base64')}`);
  for (const refused of [true, false]) {
    const calls = [];
    const updateSettings = (patch) => { calls.push(['updateSettings', patch]); return refused ? false : undefined; };
    const result = chooseProfessionThen(updateSettings, 'PA', () => calls.push(['openAddIn', 'licenses']), () => calls.push(['alertWriteRefused']));
    assert.equal(result, !refused);
    assert.deepEqual(calls, refused
      ? [['updateSettings', { degreeType: 'PA' }], ['alertWriteRefused']]
      : [['updateSettings', { degreeType: 'PA' }], ['openAddIn', 'licenses']]);
  }
  // Home's card goes through it: the form opens only after a saved choice.
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /onChooseProfession=\{\(d\) => chooseProfessionThen\(updateSettings, d, \(\) => openAddIn\("licenses"\), \(\) => alertWriteRefused\(\{ scope: "credential" \}\)\)\}/);
  assert.doesNotMatch(app, /updateSettings\(\{ degreeType: d \}\); openAddIn/);
});
