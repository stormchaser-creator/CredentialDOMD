// SETTINGS-001: Home's Form D line counted the whole board ("Setup · 13 of
// 15") while the Credentials rail and the Setup strip counted Tier 1 ("5 of
// 6"), when a Tier 1 row with no regression line (the CV) came undone. The
// real SetupCard with the real board; synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as setupTasks from '../src/utils/setupTasks.js';

const NOW = new Date('2026-09-10T17:00:00.000Z');
const day = n => new Date(NOW.getTime() - n * 86400000).toISOString();
const settings = { name: 'Synthetic Physician', degreeType: 'DO', primaryState: 'CA', email: 'synthetic@example.invalid', notifyEmail: true, reminderLeadDays: 90,
  setupState: { v: 1, startedAt: day(30), tier1DoneAt: day(20) } };
const licenses = [
  { id: 'l1', type: 'State Medical License (DO)', state: 'CA', licenseNumber: 'A1', expirationDate: '2027-06-30' },
  { id: 'd1', type: 'DEA Registration', state: 'CA', licenseNumber: 'BW1', expirationDate: '2027-01-31' },
];

test('Form D prints the same Tier 1 count the rail shows when the CV row comes undone', async () => {
  const data = { settings, licenses, documents: [] };
  const setup = setupTasks.buildSetup(data, { now: NOW });
  assert.equal(setupTasks.homeCardForm(setup, { now: NOW }), setupTasks.CARD_FORM.D);
  const c = await mountComponent('src/components/features/SetupCard.jsx', {
    app: { data, theme: {} },
    modules: { setupTasks, useSetupState: { useSetupState: () => ({ setup, snooze() {}, stampTier1Done() {} }) } },
  });
  const t1 = setup.counts.tier1;
  assert.match(c.pageText(), new RegExp(`Setup · ${t1.done} of ${t1.total}`));
  assert.doesNotMatch(c.pageText(), new RegExp(`of ${setupTasks.boardCounts(setup).total}\\b`));
});
