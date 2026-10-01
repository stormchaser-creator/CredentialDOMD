// QA CRED-024 and CRED-014: an open Add form closed, and the Licenses NPI
// panel reset, with no request in flight. The cause was a change of the
// desk/phone layout flag: a Chromium full-page capture fires one resize that
// reads innerWidth 1, and a member crosses 1024px for real by turning an
// iPad, narrowing a window, zooming or docking devtools. The Credentials tab
// returned a different tree at each width (the section beside a rail in a
// flex row at desk, the bare section on a phone), so React unmounted and
// remounted the section and everything held in its state: the open form,
// what the member typed, the NPI lookup. Setup did the same to the open
// task's drawer.
//
// Here the real app shell (AppInner) and the real sections run under React's
// own renderer over the in-memory DOM (harness/live-dom.mjs). Each case opens
// a form or panel, types into it, flips the layout flag to phone and back
// (what the capture did) and also crosses it once and stays (what a turned
// iPad does), and checks the same element is still on the page with what was
// typed. A records replacement while a form is open (a reload-time load
// landing) keeps the form and updates the list beneath it. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installLiveDom } from './harness/live-dom.mjs';
import { loadScreens } from './harness/component-harness.mjs';
import { DEFAULT_DATA } from '../src/constants/defaults.js';
import { THEMES } from '../src/constants/themes.js';
import { withTask } from '../src/utils/setupTasks.js';

// Background work (sync checks, notices clearing themselves) may not hold the
// process open after the last test.
const realSetInterval = globalThis.setInterval, realSetTimeout = globalThis.setTimeout;
globalThis.setInterval = (...args) => { const t = realSetInterval(...args); t?.unref?.(); return t; };
globalThis.setTimeout = (...args) => { const t = realSetTimeout(...args); t?.unref?.(); return t; };
test.after(() => { globalThis.setInterval = realSetInterval; globalThis.setTimeout = realSetTimeout; });

// Bundled before the DOM exists; react-dom/client after, since it decides at
// load time whether it has a DOM.
const stored = new Map([['credentialdomd-ai-shared', JSON.stringify({ shared: true, anthropicShared: true, limit: 200, checkedAt: 1, unlimited: false })]]);
globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) };
const { AppInner } = await loadScreens('export { AppInner } from "./src/App.jsx";', {
  expose: { 'src/App.jsx': ['AppInner'] }, real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'], clerk: true,
});
const { doc, win } = installLiveDom();
win.confirm = () => true;
win.alert = () => {};
win.localStorage = globalThis.localStorage;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
win.navigator = { userAgent: 'Synthetic', clipboard: { writeText: async () => {} } };
win.visualViewport = null;
// Frames never run here (nothing is laid out), as in the window's own.
globalThis.requestAnimationFrame = win.requestAnimationFrame;
globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
const makeElement = doc.createElement.bind(doc);
doc.createElement = (tag) => {
  const el = makeElement(tag);
  if (tag === 'select') Object.defineProperty(el, 'options', { get: () => doc.all(n => n.tagName === 'OPTION', el) });
  return el;
};
doc.querySelector = () => null;
doc.querySelectorAll = () => [];
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const h = React.createElement;

const all = (value) => ({ read: value, write: value, export: value });
function account() {
  const data = structuredClone(DEFAULT_DATA);
  data.settings = { ...data.settings, name: 'Dana Synthetic', degreeType: 'MD', primaryState: 'CO', email: 'dana@example.invalid' };
  data.licenses = [{ id: 'L1', type: 'State Medical License', name: 'Colorado Medical License', state: 'CO', licenseNumber: 'QA-0001', expirationDate: '2027-06-30' }];
  data.customCategories = [{ id: 'CC1', name: 'Hospital ID Badges', icon: 'B', fields: [{ key: 'badgeNumber', label: 'Badge number' }, { key: 'facility', label: 'Facility' }] }];
  data.customRecords = [{ id: 'CR1', categoryId: 'CC1', categoryName: 'Hospital ID Badges', name: 'Synthetic badge', expirationDate: '2027-01-01', fieldValues: { badgeNumber: 'QA-1' }, fieldLabels: { badgeNumber: 'Badge number' } }];
  return data;
}
function appFor(data, isDesktop) {
  return {
    data, setData() {}, loaded: true, recordsLoadIssue: null, theme: THEMES.light, themeName: 'light', isDark: false, toggleTheme() {}, isDesktop,
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

// One app on the page at a time. `setDesk` changes the layout flag the way
// AppContext does; `replaceData` swaps the records the way a load does.
let mounted = null;
function open({ tab, subPage, isDesktop = true, edit = null }) {
  mounted?.unmount();
  const state = { data: account(), isDesktop };
  edit?.(state.data);
  globalThis.__screen = { app: appFor(state.data, isDesktop), storage: {}, vault: {} };
  let force;
  function Page() {
    const [, setTick] = React.useState(0);
    force = () => setTick(n => n + 1);
    return h(AppInner, { tab, setTab() {}, subPage, setSubPage() {}, navRecord: null });
  }
  const host = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(host);
  flushSync(() => root.render(h(Page)));
  let gone = false;
  mounted = {
    setDesk(next) { state.isDesktop = next; globalThis.__screen.app = appFor(state.data, next); flushSync(() => force()); },
    replaceData(fn) { state.data = fn(state.data); globalThis.__screen.app = appFor(state.data, state.isDesktop); flushSync(() => force()); },
    unmount() {
      if (gone) return;
      gone = true;
      flushSync(() => root.unmount());
      for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
    },
  };
  return mounted;
}
test.afterEach(() => mounted?.unmount());

const propsOf = (el) => el[Object.keys(el).find(k => k.startsWith('__reactProps$'))];
const press = (text, from = doc) => {
  const b = doc.all(n => n.tagName === 'BUTTON' && n.textContent.trim() === text, from)[0]
    ?? doc.all(n => n.tagName === 'BUTTON' && n.textContent.includes(text), from)[0];
  assert.ok(b, `button: ${text}`);
  flushSync(() => propsOf(b).onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: b, target: b }));
};
const dialogs = () => doc.all(n => n.getAttribute('role') === 'dialog');
const labelled = (text, from = doc) => {
  const label = doc.all(n => n.tagName === 'LABEL' && n.textContent.replace(/\s*\*$/, '').trim() === text, from)[0];
  assert.ok(label, `field: ${text}`);
  const id = label.getAttribute('for');
  const input = id ? doc.getElementById(id) : doc.all(n => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName), label.parentNode)[0];
  assert.ok(input, `input for: ${text}`);
  return input;
};
const byPlaceholder = (text) => {
  const el = doc.all(n => n.getAttribute('placeholder') === text)[0];
  assert.ok(el, `placeholder: ${text}`);
  return el;
};
const type = (el, value) => flushSync(() => propsOf(el).onChange({ target: { value, checked: false, files: null }, currentTarget: { value } }));
const valueOf = (el) => propsOf(el).value;

/** Phone and back (the capture), then phone and stay (a turned iPad), then desk again. */
function* flips(page) {
  page.setDesk(false); page.setDesk(true);
  yield 'a flip to phone width and back';
  page.setDesk(false);
  yield 'a crossing to phone width';
  page.setDesk(true);
  yield 'a crossing back to desk width';
}

test('a custom category Add form stays open with what was typed (CRED-024)', () => {
  const page = open({ tab: 'credentials', subPage: 'custom:CC1' });
  press('Add');
  const [dialog] = dialogs();
  assert.ok(dialog, 'the Add form is open');
  const badge = labelled('Badge number', dialog);
  type(badge, 'FLIP-1');
  for (const step of flips(page)) {
    assert.ok(dialog.isConnected, `${step}: the same form is still on the page`);
    assert.equal(valueOf(badge), 'FLIP-1', `${step}: what was typed is kept`);
    assert.ok(badge.isConnected, `${step}: the same input`);
  }
});

test('a license Add form stays open with what was typed, every input the same element', () => {
  const page = open({ tab: 'credentials', subPage: 'licenses' });
  press('Add');
  const dialog = dialogs().at(-1);
  assert.ok(dialog, 'the Add form is open');
  const number = labelled('License #', dialog);
  type(number, 'FLIP-LIC');
  // Desk pairs the dates two across. Each input stays the same element, so
  // focus and a date half typed (an <input type=date> holds no value until
  // it is whole) survive the crossing too.
  const inputs = doc.all(n => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName), dialog);
  const pairs = doc.all(n => n.tagName === 'DIV' && n.style.display === 'grid', dialog);
  assert.ok(pairs.some(row => doc.all(n => n.getAttribute('data-fkey') === 'issuedDate', row).length), 'at desk width the issue date sits in a two-across row');
  for (const step of flips(page)) {
    assert.ok(dialog.isConnected, `${step}: the same form is still on the page`);
    assert.equal(valueOf(number), 'FLIP-LIC', `${step}: what was typed is kept`);
    const lost = inputs.filter(n => !n.isConnected).map(n => n.getAttribute('type') || n.tagName);
    assert.deepEqual(lost, [], `${step}: no input was replaced`);
  }
});

test('the Licenses NPI panel keeps the number and state typed into it (CRED-014)', () => {
  const page = open({ tab: 'credentials', subPage: 'licenses' });
  const npi = byPlaceholder('Blank searches by name');
  const state = doc.all(n => n.tagName === 'SELECT', npi.parentNode.parentNode)[0];
  assert.ok(state, 'the panel\'s state picker');
  type(npi, '12345');
  type(state, 'CO');
  for (const step of flips(page)) {
    assert.ok(npi.isConnected, `${step}: the same panel`);
    assert.equal(valueOf(npi), '12345', `${step}: the number typed is kept`);
    assert.equal(valueOf(state), 'CO', `${step}: the state chosen is kept`);
  }
});

test('a category Rename keeps the name being typed', () => {
  const page = open({ tab: 'credentials', subPage: 'custom:CC1' });
  press('Rename');
  const name = doc.all(n => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Category name')[0];
  assert.ok(name, 'the Rename editor is open');
  type(name, 'QA Flip Renamed');
  for (const step of flips(page)) {
    assert.ok(name.isConnected, `${step}: the same editor`);
    assert.equal(valueOf(name), 'QA Flip Renamed', `${step}: the name typed is kept`);
  }
});

test('a records load landing while the Add form is open keeps the form and updates the list beneath it', () => {
  const page = open({ tab: 'credentials', subPage: 'custom:CC1' });
  press('Add');
  const [dialog] = dialogs();
  const badge = labelled('Badge number', dialog);
  type(badge, 'LOAD-1');
  page.replaceData(d => ({ ...structuredClone(d), customRecords: [...d.customRecords, { id: 'CR2', categoryId: 'CC1', categoryName: 'Hospital ID Badges', name: 'Second synthetic badge', fieldValues: {}, fieldLabels: {} }] }));
  assert.ok(dialog.isConnected, 'the same form is on the page');
  assert.equal(valueOf(badge), 'LOAD-1', 'what was typed is kept');
  assert.ok(doc.body.textContent.includes('Second synthetic badge'), 'the list shows the record the load brought');
});

test('Setup: the open Your licenses drawer keeps the NPI typed into it, and shows where each layout puts it', () => {
  const page = open({ tab: 'more', subPage: 'setup', isDesktop: false });
  const opener = doc.all(n => n.tagName === 'BUTTON' && /Your licenses/.test(n.textContent))[0];
  assert.ok(opener, 'the Your licenses row');
  flushSync(() => propsOf(opener).onClick({ stopPropagation() {}, preventDefault() {} }));
  const npi = byPlaceholder('Blank searches by name');
  const row = () => doc.all(n => n.getAttribute('data-task-row') === 'licenses')[0];
  assert.ok(row()?.contains(npi), 'on a phone the drawer is under its own row');
  type(npi, '54321');
  page.setDesk(true);
  assert.ok(npi.isConnected, 'turned to desk width: the same drawer');
  assert.equal(valueOf(npi), '54321', 'turned to desk width: the number typed is kept');
  assert.ok(!row(), 'at desk width there are no accordion rows; the drawer is in the right pane');
  assert.equal(doc.all(n => n.getAttribute('placeholder') === 'Blank searches by name').length, 1, 'one drawer on the page');
  page.setDesk(false); page.setDesk(true); page.setDesk(false);
  assert.ok(npi.isConnected && row()?.contains(npi), 'back on a phone: the same drawer, under its row again');
  assert.equal(valueOf(npi), '54321', 'back on a phone: the number typed is kept');
});

test('Setup: a phone with no task open draws no drawer; desk width shows one, in the right pane', () => {
  const page = open({ tab: 'more', subPage: 'setup', isDesktop: false });
  const slots = () => doc.all(n => n.hasAttribute('data-kept-panel-slot'));
  assert.equal(slots().length, 0, 'nothing open on a phone: no drawer');
  page.setDesk(true);
  assert.equal(slots().length, 1, 'desk width: one drawer');
  assert.ok(slots()[0].childNodes[0]?.childNodes.length > 0, 'and it has the task in it');
  page.setDesk(false);
  assert.equal(slots().length, 0, 'back on a phone with nothing opened: no drawer');
});

// Review finding on fix/second-load-reset: at desk width the right pane shows
// the first row's drawer before any row is tapped, and a member can type
// straight into it. Nothing made it the open task, so crossing to phone width
// drew no drawer and dropped what was typed. Touching it now makes it the open
// task. React delivers the focus to the drawer's wrapper through the portal;
// this renderer has no event dispatch, so the test hands the wrapper the focus
// React would, as the other cases call onChange.
test('Setup: a desk drawer typed into before any row is tapped is kept through a crossing to phone width', () => {
  // CV marked "does not apply", so the first row is "About you" and its name field.
  const page = open({ tab: 'more', subPage: 'setup', isDesktop: true, edit: d => { d.settings.setupState = withTask(d.settings.setupState, 'cv', 'na'); } });
  const drawer = doc.all(n => n.hasAttribute('data-task-drawer'))[0];
  assert.ok(drawer, 'the right pane shows a drawer with no row tapped');
  assert.equal(drawer.getAttribute('data-task-drawer'), 'identity');
  const name = doc.getElementById('setup-full-name');
  assert.ok(drawer.contains(name), 'the name field is in it');
  flushSync(() => propsOf(drawer).onFocusCapture({ target: name, currentTarget: drawer }));
  type(name, 'Dana Q Synthetic');
  page.setDesk(false);
  const row = () => doc.all(n => n.getAttribute('data-task-row') === 'identity')[0];
  assert.ok(name.isConnected, 'at phone width: the same field');
  assert.ok(row()?.contains(name), 'under its own row');
  assert.equal(valueOf(name), 'Dana Q Synthetic', 'with what was typed');
  page.setDesk(true);
  assert.ok(name.isConnected && drawer.contains(name), 'back at desk width: the same drawer');
  assert.equal(valueOf(name), 'Dana Q Synthetic');
});

// The same crossing with a row tapped at desk width whose section a phone
// folds: a packet row while Tier 1 is unfinished. The packet unfolds, so the
// drawer stays on the page.
test('Setup: a packet drawer opened at desk width stays open through a crossing to phone width', () => {
  const page = open({ tab: 'more', subPage: 'setup', isDesktop: true });
  const rail = doc.all(n => n.tagName === 'BUTTON' && /Copies of your license and DEA/.test(n.textContent))[0];
  assert.ok(rail, 'the packet row in the rail');
  flushSync(() => propsOf(rail).onClick({ stopPropagation() {}, preventDefault() {} }));
  const drawer = doc.all(n => n.getAttribute('data-task-drawer') === 'proof')[0];
  assert.ok(drawer, 'its drawer is in the right pane');
  page.setDesk(false);
  const row = () => doc.all(n => n.getAttribute('data-task-row') === 'proof')[0];
  assert.ok(drawer.isConnected, 'at phone width: the same drawer');
  assert.ok(row()?.contains(drawer), 'under its row, the packet unfolded');
});

test('must-pass: the Home search draft, which already sat at one place at both widths, is still kept', () => {
  const page = open({ tab: 'home' });
  const search = byPlaceholder('Search everything, or ask Vera');
  type(search, 'flip draft');
  for (const step of flips(page)) {
    assert.ok(search.isConnected, `${step}: the same search box`);
    assert.equal(valueOf(search), 'flip draft', `${step}: the draft is kept`);
  }
});
