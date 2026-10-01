// HOME-001: the Tier 1 Reminders task counted Text Notifications, which send
// nothing yet and default on, so a member who turned Email reminders off still
// finished Tier 1 and read "Protected. ... a warning goes to <address> 90 days
// before anything expires". send-reminders skips notify_email = false; no
// email or text ever came, and the "reminders are off" line never showed.
// The real board and the real SetupCard; synthetic account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';
import * as setupTasks from '../../src/utils/setupTasks.js';
import * as reminderPreferences from '../../src/utils/reminderPreferences.js';
import { DEFAULT_SETTINGS } from '../../src/constants/defaults.js';

const reminders = setupTasks.TASK_DEFS.find(t => t.id === 'reminders');
const base = { ...DEFAULT_SETTINGS, email: 'synthetic@example.invalid', reminderLeadDays: 90 };

test('Email reminders off leaves the task undone while texts do not send', () => {
  assert.equal(DEFAULT_SETTINGS.notifyText, true, 'texts default on, which is why they cannot count');
  assert.equal(reminders.doneWhen({ s: { ...base, notifyEmail: false, notifyBrowser: false } }), false, 'only Text Notifications on');
  assert.equal(reminders.doneWhen({ s: { ...base, notifyEmail: true } }), true, 'email on');
  assert.equal(reminders.doneWhen({ s: { ...base, notifyEmail: null } }), true, 'email blank reads on, as send-reminders mails it');
  assert.equal(reminders.doneWhen({ s: { ...base, notifyEmail: false, notifyBrowser: true } }), true, 'in app alerts on');
});

const NOW = new Date('2026-09-10T17:00:00.000Z');
const licenses = [
  { id: 'l1', type: 'State Medical License (DO)', state: 'ZZ', licenseNumber: 'A1', expirationDate: '2027-06-30' },
  { id: 'd1', type: 'DEA Registration', state: 'ZZ', licenseNumber: 'BW1', expirationDate: '2027-01-31' },
];
async function protectedMoment(s) {
  const settings = { ...base, name: 'Synthetic Physician', degreeType: 'DO', primaryState: 'ZZ', ...s,
    setupState: { v: 1, startedAt: new Date(NOW.getTime() - 86400000).toISOString(), cvImportedAt: new Date(NOW.getTime() - 3600000).toISOString() } };
  const data = { settings, licenses, documents: [] };
  const setup = setupTasks.buildSetup(data, { now: NOW });
  const c = await mountComponent('src/components/features/SetupCard.jsx', {
    app: { data, theme: {} },
    modules: { setupTasks, reminderPreferences, useSetupState: { useSetupState: () => ({ setup, snooze() {}, stampTier1Done() {} }) } },
  });
  return { form: setupTasks.homeCardForm(setup, { now: NOW }), text: c.pageText() };
}

test('the Protected moment names email only when email reminders are on', async () => {
  const email = await protectedMoment({ notifyEmail: true });
  assert.equal(email.form, setupTasks.CARD_FORM.B, 'Tier 1 complete: the moment shows');
  assert.match(email.text, /a warning goes to synthetic@example\.invalid 90 days before anything expires/);

  const inApp = await protectedMoment({ notifyEmail: false, notifyBrowser: true });
  assert.equal(inApp.form, setupTasks.CARD_FORM.B);
  assert.match(inApp.text, /this app warns you 90 days before anything expires/);
  assert.doesNotMatch(inApp.text, /warning goes to|synthetic@example\.invalid/, 'no email is promised');

  const textOnly = await protectedMoment({ notifyEmail: false, notifyBrowser: false, notifyText: true });
  assert.notEqual(textOnly.form, setupTasks.CARD_FORM.B, 'Text Notifications alone is not Protected');
  assert.doesNotMatch(textOnly.text, /Protected\./);
});
