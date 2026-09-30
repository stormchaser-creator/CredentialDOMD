// Every main screen of the member app and the admin area, rendered as a
// physician first sees it (phone and desk width), read the way a screen
// reader reads it. A button with no name, a form field with no label, a
// dialog that is not modal or not named, or a switch that does not say
// whether it is on fails here with the screen and the element.
//
// The QA lab found the top bar's bell and theme buttons, the record rows'
// share/edit/delete buttons and every Field form unusable by name (its
// journeys had to find them by position). This keeps them usable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, renderScreen } from '../harness/component-harness.mjs';
import { auditHtml } from './html-audit.mjs';
import { DEFAULT_DATA } from '../../src/constants/defaults.js';
import { THEMES } from '../../src/constants/themes.js';

// The device's cached AI status decides what AI-backed controls draw (the
// scan buttons, Vera's composer) and whether this account is an admin. The
// module reads it once, when the bundle loads, so each account is its own bundle.
const SCREENS = [
  'export { AppInner } from "./src/App.jsx";',
  'export { default as LocumDashboard } from "./src/components/features/locum/LocumDashboard.jsx";',
  'export { default as AdminDashboard } from "./src/components/pages/AdminDashboard.jsx";',
  'export { default as SupportModal } from "./src/components/pages/SupportModal.jsx";',
  'export { default as NotificationCenter } from "./src/components/pages/NotificationCenter.jsx";',
  'export { default as PricingModal } from "./src/components/pages/PricingModal.jsx";',
  'export { default as ShareModal } from "./src/components/features/ShareModal.jsx";',
  'export { default as FinanceSection } from "./src/components/features/locum/FinanceSection.jsx";',
].join('\n');
async function load(aiStatus) {
  const stored = new Map([['credentialdomd-ai-shared', JSON.stringify({ shared: true, anthropicShared: true, limit: 200, checkedAt: 1, ...aiStatus })]]);
  globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) };
  try {
    return await loadScreens(SCREENS, { expose: { 'src/App.jsx': ['AppInner'] }, real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'], clerk: true });
  } finally {
    delete globalThis.localStorage;
  }
}
const screens = await load({ unlimited: false });
const adminScreens = await load({ unlimited: true });

// A synthetic account with a record in most sections, so each list draws its
// rows and each row its buttons. No real person, facility or number.
const day = (offset) => { const d = new Date(Date.UTC(2026, 8, 29)); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
function account() {
  const data = structuredClone(DEFAULT_DATA);
  data.settings = { ...data.settings, name: 'Dana Synthetic', degreeType: 'MD', primaryState: 'CO', additionalStates: ['NM'], email: 'dana@example.invalid', specialties: ['Neurosurgery'] };
  data.licenses = [
    { id: 'L1', type: 'State Medical License', name: 'Colorado Medical License', state: 'CO', number: 'QA-0001', expirationDate: day(40), favorite: true },
    { id: 'L2', type: 'DEA Registration', name: 'DEA', state: 'CO', number: 'QA-0002', expirationDate: day(-3) },
  ];
  data.privileges = [{ id: 'P1', name: 'Synthetic General Hospital', hospital: 'Synthetic General Hospital', expirationDate: day(200) }];
  data.insurance = [{ id: 'I1', name: 'Synthetic Mutual', carrier: 'Synthetic Mutual', policyNumber: 'QA-POL', expirationDate: day(300) }];
  data.cme = [{ id: 'E1', name: 'Synthetic Grand Rounds', provider: 'Synthetic Society', hours: 2, category: 'Category 1', date: day(-20) }];
  data.caseLogs = [{ id: 'C1', date: day(-5), cptCode: '61510', description: 'Synthetic case', role: 'Primary' }];
  data.education = [{ id: 'ED1', type: 'Residency', name: 'Synthetic Residency', institution: 'Synthetic University', startDate: '2010-07-01', endDate: '2017-06-30' }];
  data.workHistory = [{ id: 'W1', type: 'Employment', name: 'Synthetic Clinic', employer: 'Synthetic Clinic', startDate: '2018-01-01' }];
  data.peerReferences = [{ id: 'R1', name: 'Pat Example', email: 'pat@example.invalid', relationship: 'Colleague' }];
  data.memberships = [{ id: 'M1', organization: 'Synthetic Society', name: 'Synthetic Society', role: 'Member' }];
  data.healthRecords = [{ id: 'H1', name: 'Influenza vaccine', type: 'Vaccination', date: day(-100) }];
  data.screenings = [{ id: 'S1', name: 'Background check', type: 'Background Check', expirationDate: day(100) }];
  data.documents = [{ id: 'D1', name: 'license.pdf', type: 'application/pdf', category: 'License', uploadedAt: '2026-09-01T00:00:00Z' }];
  data.customCategories = [{ id: 'CC1', name: 'Hospital ID Badges', icon: 'B', fields: [{ key: 'badgeNumber', label: 'Badge number' }] }];
  data.customRecords = [{ id: 'CR1', categoryId: 'CC1', categoryName: 'Hospital ID Badges', name: 'Synthetic badge', expirationDate: day(90), fieldValues: { badgeNumber: 'QA-1' }, fieldLabels: { badgeNumber: 'Badge number' } }];
  data.locumContracts = [{ id: 'K1', facility: 'Synthetic Regional', agency: 'Synthetic Staffing', hourlyRate: 200, callHourlyRate: 100, startDate: day(-60), endDate: day(120), workState: 'CO' }];
  data.workLog = [{ id: 'WL1', contractId: 'K1', type: 'Call', date: day(-2), startTime: '08:00', endTime: '10:00', durationMin: 120, billedMin: 120 }];
  data.invoices = [{ id: 'IN1', number: 'INV-QA-1', contractId: 'K1', periodStart: day(-30), periodEnd: day(-1), totalMinutes: 120, totalAmount: 400, entryIds: ['WL1'] }];
  data.travelExpenses = [{ id: 'X1', date: day(-3), category: 'Lodging', vendor: 'Synthetic Inn', amount: 120, taxYear: '2026' }];
  data.encounters = [{ id: 'EN1', contractId: 'K1', date: day(-1), codes: [{ code: '61510', units: 1, desc: 'Synthetic', wRVU: 30 }] }];
  data.taskNotes = [{ id: 'T1', text: 'Synthetic follow-up', capturedAt: '2026-09-28T12:00:00Z' }];
  data.scheduleDays = [{ id: 'SD1', contractId: 'K1', date: day(3), kind: 'work' }];
  data.answerBank = [{ id: 'A1', question: 'Synthetic question?', answer: 'Yes' }];
  data.publications = [{ id: 'PB1', name: 'Synthetic paper', citation: 'Synthetic J. 2020', year: 2020 }];
  data.travelDocs = [{ id: 'TD1', type: 'Passport', name: 'Passport', expirationDate: day(900) }];
  data.malpracticeHistory = [{ id: 'MH1', name: 'None reported', outcome: 'Dismissed' }];
  return data;
}

const all = (value) => ({ read: value, write: value, export: value });
function app({ isDesktop, plan = 'locum', data = account() }) {
  return {
    data, setData() {}, loaded: true, recordsLoadIssue: null, theme: THEMES.light, themeName: 'light', isDark: false, toggleTheme() {}, isDesktop,
    allTrackedStates: ['CO', 'NM'], addItem: () => true, canAddItem: () => true, editItem: () => true, deleteItem: () => true, toggleFavorite() {},
    updateSection() {}, updateSettings() {}, navigate() {}, userIdRef: { current: 'user_synthetic' }, syncIssues: [], pendingWrites: 0, offlineCopyStale: false,
    user: { id: 'user_synthetic', email: 'dana@example.invalid', fullName: 'Dana Synthetic' }, authChecked: true, offlineMode: false, signOut() {},
    plan, isPro: true, isPractice: plan === 'locum', subLoading: false, periodEnd: null, checkout() {}, manage() {}, setMockPlan() {}, isDevMode: false,
    hasSubscription: true, isFreeBeta: false, isLifetime: false, canWriteCredential: true, canWritePractice: true, credentialReadOnly: false, practiceReadOnly: false,
    settingsRefusal: null, clearSettingsRefusal() {},
    limitedLaunch: {
      enabled: true, refresh: async () => {}, checking: false, reconnecting: false, outdated: false, remembered: null, billingReturn: null,
      access: { accessStatus: 'active', capabilities: { credential: all(true), practice: all(true) }, lifetime: { credential: false, practice: false }, freeBeta: { state: 'none' }, practiceTrial: { state: 'none' } },
    },
  };
}

const CREDENTIAL_SECTIONS = ['licenses', 'privileges', 'insurance', 'cme', 'caseLogs', 'education', 'workHistory', 'peerReferences', 'malpracticeHistory',
  'healthRecords', 'screenings', 'memberships', 'publications', 'travelDocs', 'professionalPhotos', 'answerBank', 'identityVault', 'matrix', 'favorites',
  'newCategory', 'custom:CC1'];
const MORE_PAGES = [null, 'setup', 'settings', 'cv', 'finance', 'export', 'cptLookup', 'requests', 'assistant', 'faq', 'privacy', 'terms', 'data-rights',
  'cancellation', 'adminAccess', 'todo'];
const VIEWS = [
  ['home', null], ['documents', null], ['share', null], ['locum', null], ['team', null],
  ['credentials', null], ...CREDENTIAL_SECTIONS.map(s => ['credentials', s]),
  ...MORE_PAGES.map(s => ['more', s]),
];
const noop = () => {};

function audit(where, render) {
  let html;
  try { html = render(); } catch (e) { return [`${where}: did not render (${e.message.split('\n')[0]})`]; }
  return auditHtml(html, where);
}

for (const isDesktop of [false, true]) {
  const width = isDesktop ? 'desk' : 'phone';
  test(`every tab and page of the app, ${width} width: buttons named, fields labelled`, () => {
    const problems = [];
    for (const [tab, subPage] of VIEWS) {
      const plan = tab === 'team' ? 'pro' : 'locum';
      problems.push(...audit(`${width} ${tab}${subPage ? '/' + subPage : ''}`, () => renderScreen(screens.AppInner, {
        app: app({ isDesktop, plan }), props: { tab, setTab: noop, subPage, setSubPage: noop, navRecord: null },
      })));
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test(`every Practice tool, ${width} width: buttons named, fields labelled`, () => {
    const problems = [];
    for (const sub of ['work', 'rvus', 'schedule', 'invoices', 'contracts', 'expenses', 'todo']) {
      problems.push(...audit(`${width} practice/${sub}`, () => renderScreen(screens.LocumDashboard, { app: app({ isDesktop }), props: { initialSub: sub } })));
    }
    for (const view of [undefined, 'deductions', 'forecast', 'taxes']) {
      problems.push(...audit(`${width} finance/${view || 'default'}`, () => renderScreen(screens.FinanceSection, { app: app({ isDesktop }), props: { initialTab: view } })));
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test(`the sheets the app opens over a screen, ${width} width: modal, named, fields labelled`, () => {
    const problems = [];
    const a = () => app({ isDesktop });
    problems.push(...audit(`${width} support (new ticket)`, () => renderScreen(screens.SupportModal, { app: a(), props: { open: true, onClose: noop, initialTab: 'new', contextPage: 'home' } })));
    problems.push(...audit(`${width} support (tickets)`, () => renderScreen(screens.SupportModal, { app: a(), props: { open: true, onClose: noop, initialTab: 'tickets', contextPage: 'home' } })));
    problems.push(...audit(`${width} notification center`, () => renderScreen(screens.NotificationCenter, { app: a(), props: { open: true, onClose: noop } })));
    problems.push(...audit(`${width} membership options`, () => renderScreen(screens.PricingModal, { app: a(), props: { open: true, onClose: noop } })));
    const license = account().licenses[0];
    problems.push(...audit(`${width} send credential`, () => renderScreen(screens.ShareModal, { app: a(), props: { open: true, onClose: noop, item: license, section: 'licenses', linkedDocs: [], onLogShare: noop } })));
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });
}

test('the admin area, and the app as an admin sees it: buttons named, fields labelled', () => {
  const problems = [];
  for (const isDesktop of [false, true]) {
    const width = isDesktop ? 'desk' : 'phone';
    const html = renderScreen(adminScreens.AdminDashboard, { app: app({ isDesktop }), props: {} });
    assert.match(html, /Administration sections/, 'the admin render must reach the dashboard, not the "Admin only" notice');
    problems.push(...auditHtml(html, `${width} admin`));
    for (const subPage of [null, 'admin', 'settings', 'faq']) {
      problems.push(...audit(`${width} admin more/${subPage}`, () => renderScreen(adminScreens.AppInner, {
        app: app({ isDesktop }), props: { tab: 'more', setTab: noop, subPage, setSubPage: noop, navRecord: null },
      })));
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
