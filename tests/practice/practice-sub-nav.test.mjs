// A navigation that names a Practice sub-page opens Practice on it (DOCS-006).
// Filing a receipt as an agency expense shows "Open Expenses", which calls
// navigate("locum", "expenses"). App only passed "todo" through to the
// dashboard, so every other sub-page opened Practice on Work ("Add an
// agreement first") instead of the expense just saved. The real app shell
// (AppInner) is rendered here with a synthetic account. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadScreens, renderScreen } from '../harness/component-harness.mjs';
import { DEFAULT_DATA } from '../../src/constants/defaults.js';
import { THEMES } from '../../src/constants/themes.js';

const stored = new Map([['credentialdomd-ai-shared', JSON.stringify({ shared: true, anthropicShared: true, limit: 200, checkedAt: 1, unlimited: false })]]);
globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) };
let screens;
try {
  screens = await loadScreens('export { AppInner } from "./src/App.jsx";', { expose: { 'src/App.jsx': ['AppInner'] }, real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'], clerk: true });
} finally {
  delete globalThis.localStorage;
}

const all = (value) => ({ read: value, write: value, export: value });
function app() {
  const data = structuredClone(DEFAULT_DATA);
  data.settings = { ...data.settings, name: 'Dana Synthetic', degreeType: 'MD', primaryState: 'CO' };
  data.locumContracts = [{ id: 'K1', facility: 'Synthetic Regional', agency: 'Synthetic Staffing', hourlyRate: 200, startDate: '2026-08-01', endDate: '2027-01-31', workState: 'CO' }];
  data.travelExpenses = [{ id: 'X1', date: '2026-09-20', category: 'Rideshare', vendor: 'Synthetic Rides', amount: 42.5, agency: 'Synthetic Staffing', billable: true, taxYear: '2026' }];
  return {
    data, setData() {}, loaded: true, recordsLoadIssue: null, theme: THEMES.light, themeName: 'light', isDark: false, toggleTheme() {}, isDesktop: false,
    allTrackedStates: ['CO'], addItem: () => true, canAddItem: () => true, editItem: () => true, deleteItem: () => true, toggleFavorite() {},
    updateSection() {}, updateSettings() {}, navigate() {}, userIdRef: { current: 'user_synthetic' }, syncIssues: [], pendingWrites: 0, offlineCopyStale: false,
    user: { id: 'user_synthetic', email: 'dana@example.invalid', fullName: 'Dana Synthetic' }, authChecked: true, offlineMode: false, signOut() {},
    plan: 'locum', isPro: true, isPractice: true, subLoading: false, periodEnd: null, checkout() {}, manage() {}, setMockPlan() {}, isDevMode: false,
    hasSubscription: true, isFreeBeta: false, isLifetime: false, canWriteCredential: true, canWritePractice: true, credentialReadOnly: false, practiceReadOnly: false,
    settingsRefusal: null, clearSettingsRefusal() {},
    limitedLaunch: {
      enabled: true, refresh: async () => {}, checking: false, reconnecting: false, outdated: false, remembered: null, billingReturn: null,
      access: { accessStatus: 'active', capabilities: { credential: all(true), practice: all(true) }, lifetime: { credential: false, practice: false }, freeBeta: { state: 'none' }, practiceTrial: { state: 'none' } },
    },
  };
}

const noop = () => {};
// The Practice tab that is showing, by its label.
function openPracticeTab(subPage) {
  const html = renderScreen(screens.AppInner, { app: app(), props: { tab: 'locum', setTab: noop, subPage, setSubPage: noop, navRecord: null } });
  const pressed = [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
  assert.equal(pressed.length, 1, `one Practice tab is showing: ${pressed.join(', ')}`);
  return pressed[0];
}

test('"Open Expenses" (navigate("locum", "expenses")) opens Practice on Exp.', () => {
  assert.equal(openPracticeTab('expenses'), 'Exp.');
});

test('every Practice sub-page a navigation names is the one that opens', () => {
  const want = { work: 'Work', rvus: 'RVUs', schedule: 'Sched.', invoices: 'Invoices', contracts: 'Contracts', expenses: 'Exp.', todo: 'To do' };
  for (const [sub, label] of Object.entries(want)) assert.equal(openPracticeTab(sub), label, sub);
});

test('the Practice tab from the tab bar (no sub-page), or a sub-page it does not have, opens Work', () => {
  assert.equal(openPracticeTab(null), 'Work');
  assert.equal(openPracticeTab('finance:deductions'), 'Work');
});

test('the receipt banner still asks for Practice > Exp.', async () => {
  const docs = await readFile(new URL('../../src/components/features/DocumentsSection.jsx', import.meta.url), 'utf8');
  assert.match(docs, /label: "Open Expenses", tab: "locum", sub: "expenses"/);
});
