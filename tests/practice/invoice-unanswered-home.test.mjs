// After a relaunch the app opens on Home (2026-10-01: iOS dropped the
// home-screen app while an invoice went out through Gmail). An invoice
// whose share sheet never answered is now said on Home, with the screen that
// answers it; and Practice opened from there lands Work on the agreement it
// went out from, not on today's scheduled one. The real app shell (AppInner)
// and LocumDashboard with a synthetic account. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, renderScreen } from '../harness/component-harness.mjs';
import { DEFAULT_DATA } from '../../src/constants/defaults.js';
import { THEMES } from '../../src/constants/themes.js';

const stored = new Map([['credentialdomd-ai-shared', JSON.stringify({ shared: true, anthropicShared: true, limit: 200, checkedAt: 1, unlimited: false })]]);
globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) };
let S;
try {
  S = await loadScreens([
    'export { AppInner } from "./src/App.jsx";',
    'export { default as LocumDashboard } from "./src/components/features/locum/LocumDashboard.jsx";',
    'export { keepInvoiceNote, _resetInvoiceHandoff } from "./src/utils/invoiceHandoff.js";',
  ].join(' '), { expose: { 'src/App.jsx': ['AppInner'] }, real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'], clerk: true });
} finally {
  delete globalThis.localStorage;
}

const all = (value) => ({ read: value, write: value, export: value });
function app() {
  const data = structuredClone(DEFAULT_DATA);
  data.settings = { ...data.settings, name: 'Dana Synthetic', degreeType: 'MD', primaryState: 'CO' };
  data.locumContracts = [
    { id: 'K1', facility: 'Synthetic Regional', agency: 'Synthetic Staffing', hourlyRate: 200, startDate: '2026-08-01', endDate: '2027-01-31', workState: 'CO' },
    { id: 'K2', facility: 'Synthetic Mountain', agency: 'Synthetic Staffing', hourlyRate: 220, startDate: '2026-08-01', endDate: '2027-01-31', workState: 'CO' },
  ];
  data.invoices = [];
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
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('Home says an invoice from Synthetic Mountain went to the share sheet unanswered, with the way to answer it', () => {
  S._resetInvoiceHandoff();
  S.keepInvoiceNote('user_synthetic', { number: 'INV-20260930-02', sentAt: '2026-09-30T18:00:00Z', kind: 'INV', contractId: 'K2', total: 1760, days: ['2026-09-29'], handed: true });
  const html = renderScreen(S.AppInner, { app: app(), props: { tab: 'home', setTab: noop, subPage: null, setSubPage: noop, navRecord: null } });
  const t = text(html);
  assert.match(t, /INV-20260930-02 is not recorded\. Did it go out\?/);
  assert.match(t, /It went to the share sheet Sep 30, 2026 for \$1,760\.00, and its work is still unbilled until it is answered\. Open Synthetic Mountain to answer\./);
  assert.match(t, /Open Synthetic Mountain/);
});

test('Home says nothing once that invoice is recorded (must still pass)', () => {
  S._resetInvoiceHandoff();
  S.keepInvoiceNote('user_synthetic', { number: 'INV-20260930-02', sentAt: '2026-09-30T18:00:00Z', kind: 'INV', contractId: 'K2', total: 1760, handed: true });
  const a = app();
  a.data.invoices = [{ id: 'i2', number: 'INV-20260930-02', contractId: 'K2', totalAmount: 1760 }];
  const t = text(renderScreen(S.AppInner, { app: a, props: { tab: 'home', setTab: noop, subPage: null, setSubPage: noop, navRecord: null } }));
  assert.doesNotMatch(t, /INV-20260930-02 is not recorded/);
});

test('Practice opened for an invoice lands Work on the agreement it went out from', () => {
  S._resetInvoiceHandoff();
  const html = renderScreen(S.LocumDashboard, { app: app(), props: { initialSub: 'work', openContract: 'K2', onFocusConsumed: noop }, storage: { lastContract: 'K1' } });
  assert.match(html, /<option value="K2" selected="">Synthetic Mountain/);
  const plain = renderScreen(S.LocumDashboard, { app: app(), props: { initialSub: 'work', onFocusConsumed: noop }, storage: { lastContract: 'K1' } });
  assert.match(plain, /<option value="K1" selected="">Synthetic Regional/, 'without it, the agreement last used (must still pass)');
});
