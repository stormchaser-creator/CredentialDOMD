// SETTINGS-002 / SETTINGS-001: with no name on the profile, the Setup "About
// you" drawer filled its name field from the sign-in (Clerk) name. The member
// picked MD or DO and a primary state without touching the field; onBlur never
// ran, settings.name stayed blank, and the task stayed open ("Still needed:
// your name.") beside a visibly filled name. RemindersDrawer fixed the same
// pattern for the email field (SETTINGS-004); this drawer now does the same.
//
// The real IdentityDrawer through the component harness; synthetic account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';

const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
async function drawer({ name = '', fullName = 'Synthetic Member' } = {}) {
  const saved = [];
  const app = {
    data: { settings: { name, degreeType: '', primaryState: '' } },
    updateSettings: u => { saved.push(JSON.parse(JSON.stringify(u))); app.data = { settings: { ...app.data.settings, ...u } }; return true; },
    user: { fullName }, theme: {},
  };
  const c = await mountComponent('src/components/features/SetupPage.jsx', { app, exportName: 'IdentityDrawer', modules: {
    reminderPreferences: await import(src('utils/reminderPreferences.js')), contactFormat: await import(src('utils/contactFormat.js')),
    useInputStyle: { useInputStyle: () => ({}) }, states: await import(src('constants/states.js')),
  } });
  const input = () => c.nodes().find(n => n.type === 'input' && n.props.id === 'setup-full-name');
  const buttons = () => c.nodes().filter(n => n.type === 'button');
  return { c, app, saved, input, buttons };
}

test('a blank profile name is shown blank, never as a name on file', async () => {
  const d = await drawer();
  assert.equal(d.input().props.value, '', 'nothing unsaved looks saved');
  assert.equal(d.input().props.placeholder, 'Synthetic Member');
  // Picking a degree and a state without touching the name field.
  d.buttons().find(b => d.c.text(b) === 'MD').props.onClick();
  d.c.nodes().find(n => n.type === 'select').props.onChange({ target: { value: 'TX' } });
  d.input().props.onBlur({ target: { value: d.input().props.value } });
  assert.equal(d.saved.some(u => 'name' in u), false, 'no name is invented');
});

test('one tap saves the sign-in name, and the drawer then shows it as saved', async () => {
  const d = await drawer();
  const use = d.buttons().find(b => /^Use Synthetic Member$/.test(d.c.text(b)));
  assert.ok(use, 'the sign-in name is offered');
  use.props.onClick();
  d.buttons().find(b => d.c.text(b) === 'MD').props.onClick();
  d.c.nodes().find(n => n.type === 'select').props.onChange({ target: { value: 'TX' } });
  assert.deepEqual(d.saved, [{ name: 'Synthetic Member' }, { degreeType: 'MD' }, { primaryState: 'TX' }]);
  d.c.render();
  assert.equal(d.input().props.value, 'Synthetic Member');
  assert.equal(d.buttons().some(b => /^Use /.test(d.c.text(b))), false);
});

test('a typed name saves on blur; focusing and leaving without typing saves nothing', async () => {
  const d = await drawer();
  d.input().props.onBlur({ target: { value: '' } });
  assert.deepEqual(d.saved, []);
  d.input().props.onChange({ target: { value: '  Typed Name ' } }); d.c.render();
  d.input().props.onBlur({ target: { value: '  Typed Name ' } });
  assert.deepEqual(d.saved, [{ name: 'Typed Name' }]);
});

test('with a name on file the drawer shows it and offers nothing else', async () => {
  const d = await drawer({ name: 'Saved Name' });
  assert.equal(d.input().props.value, 'Saved Name');
  assert.equal(d.buttons().some(b => /^Use /.test(d.c.text(b))), false);
});

test('no sign-in name: the placeholder is the example and no button is offered', async () => {
  const d = await drawer({ fullName: null });
  assert.equal(d.input().props.placeholder, 'First Last');
  assert.equal(d.buttons().some(b => /^Use /.test(d.c.text(b))), false);
});
