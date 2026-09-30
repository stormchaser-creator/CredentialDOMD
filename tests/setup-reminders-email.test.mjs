// SETTINGS-004: with no Email on the profile, the Setup Reminders drawer
// filled its address field from the sign-in email. The member turned
// reminders on and picked a lead time without touching the field; onBlur
// never ran, settings.email stayed blank, and the task kept saying "No
// address on file to warn" beside a visibly filled address. No reminder
// could be sent. The one reachable path today is a member who cleared the
// Email field in Settings.
//
// The real RemindersDrawer through the component harness; synthetic account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';

const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
async function drawer({ email = '', refusal = null } = {}) {
  const saved = [];
  const app = {
    data: { settings: { email, notifyEmail: null, reminderLeadDays: 90 } },
    updateSettings: u => { saved.push(JSON.parse(JSON.stringify(u))); app.data = { settings: { ...app.data.settings, ...u } }; return true; },
    user: { email: 'login@example.invalid' }, theme: {}, settingsRefusal: refusal, clearSettingsRefusal() {},
  };
  const c = await mountComponent('src/components/features/SetupPage.jsx', { app, exportName: 'RemindersDrawer', modules: {
    reminderPreferences: await import(src('utils/reminderPreferences.js')), contactFormat: await import(src('utils/contactFormat.js')),
    useInputStyle: { useInputStyle: () => ({}) },
  } });
  const input = () => c.nodes().find(n => n.type === 'input' && n.props.type === 'email');
  const buttons = () => c.nodes().filter(n => n.type === 'button');
  return { c, app, saved, input, buttons };
}

test('a blank profile email is shown blank, never as an address on file', async () => {
  const d = await drawer();
  assert.equal(d.input().props.value, '', 'nothing unsaved looks saved');
  assert.equal(d.input().props.placeholder, 'login@example.invalid');
  // Turning reminders on and choosing a lead time without touching the field.
  d.buttons().find(b => b.props['aria-label'] === 'Email reminders').props.onClick();
  d.buttons().find(b => d.c.text(b) === '60 days').props.onClick();
  assert.equal(d.saved.some(u => 'email' in u), false, 'no address is invented');
});

test('one tap saves the sign-in address as the reminder address', async () => {
  const d = await drawer();
  const use = d.buttons().find(b => /Use login@example\.invalid/.test(d.c.text(b)));
  assert.ok(use, 'the sign-in address is offered');
  use.props.onClick();
  assert.deepEqual(d.saved, [{ email: 'login@example.invalid' }]);
});

test('a typed address saves on blur only when it is a usable address', async () => {
  const d = await drawer();
  d.input().props.onChange({ target: { value: 'half@' } }); d.c.render();
  d.input().props.onBlur({ target: { value: 'half@' } });
  assert.deepEqual(d.saved, []);
  d.input().props.onChange({ target: { value: 'typed@example.invalid' } }); d.c.render();
  d.input().props.onBlur({ target: { value: 'typed@example.invalid' } });
  assert.deepEqual(d.saved, [{ email: 'typed@example.invalid' }]);
});

test('an address on another account is named in the drawer', async () => {
  const d = await drawer({ refusal: { field: 'email', address: 'taken@example.invalid' } });
  assert.match(d.c.pageText(), /taken@example\.invalid is on another CredentialDOMD account, so it was not saved/);
});

test('with an address on file the drawer shows it and offers nothing else', async () => {
  const d = await drawer({ email: 'saved@example.invalid' });
  assert.equal(d.input().props.value, 'saved@example.invalid');
  assert.equal(d.buttons().some(b => /Use login@/.test(d.c.text(b))), false);
});
