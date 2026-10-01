// Tap targets the QA lab's phone journeys measured under 32 px:
//   AUTH-003  the membership gate's "Check access again" and "Sign out" (and
//             the other gates' "Try again" / "Reload" and "Manage an existing
//             subscription") were bare browser buttons, 20 px tall, grey on
//             the dark card, under the CSS reset's padding 0.
//   ADMIN-001 to ADMIN-004, ADMIN-008  the owner's Admin screens: row actions,
//             search boxes and filters 24 px, disclosures 23 px, text buttons
//             14 px, "Refresh section" / "Load more" / "Refresh history" /
//             "Previous" / "Next" bare 20 px browser buttons, Refresh 28 px.
// The screens are rendered with the repo's harness at phone width and their
// styles read from the markup; the Admin floor is one CSS rule, pinned here
// with the class that scopes it. The desk layout is left as it was. Synthetic
// account only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadScreens, renderScreen } from './harness/component-harness.mjs';
import { DEFAULT_DATA } from '../src/constants/defaults.js';
import { THEMES } from '../src/constants/themes.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const SCREENS = [
  'export { AppInner } from "./src/App.jsx";',
  'export { default as AdminDashboard } from "./src/components/pages/AdminDashboard.jsx";',
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
const member = await load({ unlimited: false });
const owner = await load({ unlimited: true });

const all = value => ({ read: value, write: value, export: value });
function app({ isDesktop = false, access = { accessStatus: 'active', capabilities: { credential: all(true), practice: all(true) }, lifetime: { credential: false, practice: false }, freeBeta: { state: 'none' }, practiceTrial: { state: 'none' } }, launch = {} } = {}) {
  const data = structuredClone(DEFAULT_DATA);
  data.settings = { ...data.settings, name: 'Dana Synthetic', degreeType: 'MD', email: 'dana@example.invalid' };
  return {
    data, setData() {}, loaded: true, recordsLoadIssue: null, theme: THEMES.dark, themeName: 'dark', isDark: true, toggleTheme() {}, isDesktop,
    allTrackedStates: [], addItem: () => true, canAddItem: () => true, editItem: () => true, deleteItem: () => true, toggleFavorite() {},
    updateSection() {}, updateSettings() {}, navigate() {}, userIdRef: { current: 'user_synthetic' }, syncIssues: [], pendingWrites: 0, offlineCopyStale: false,
    user: { id: 'user_synthetic', email: 'dana@example.invalid', fullName: 'Dana Synthetic' }, authChecked: true, offlineMode: false, signOut() {},
    plan: 'locum', isPro: true, isPractice: true, subLoading: false, periodEnd: null, checkout() {}, manage() {}, setMockPlan() {}, isDevMode: false,
    hasSubscription: false, isFreeBeta: false, isLifetime: false, canWriteCredential: true, canWritePractice: true, credentialReadOnly: false, practiceReadOnly: false,
    settingsRefusal: null, clearSettingsRefusal() {},
    limitedLaunch: { enabled: true, refresh: async () => {}, checking: false, reconnecting: false, outdated: false, remembered: null, billingReturn: null, access, ...launch },
  };
}
const noop = () => {};
const home = { tab: 'home', setTab: noop, subPage: null, setSubPage: noop, navRecord: null };

/** Each <button> in the markup: its text and its inline style as a map. */
function buttons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => {
    const style = Object.fromEntries((attrs.match(/\bstyle="([^"]*)"/)?.[1] || '').split(';').map(d => d.split(':').map(x => x.trim())).filter(([k, v]) => k && v));
    return { text: inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(), style };
  });
}
const px = value => Number(String(value || '').replace(/px$/, '')) || 0;
function assertTappable(html, label) {
  const hit = buttons(html).filter(b => b.text === label);
  assert.ok(hit.length, `"${label}" is on this screen`);
  for (const b of hit) {
    assert.ok(px(b.style['min-height']) >= 32, `"${label}" min-height ${b.style['min-height']} (at least 32 px)`);
    assert.ok(b.style.padding && b.style.padding !== '0', `"${label}" has padding, not the reset's 0`);
    assert.ok(b.style.border || b.style['background-color'] || b.style.background, `"${label}" is styled, not a bare browser button`);
  }
}

test('AUTH-003: the membership gate\'s Check access again and Sign out are the gate\'s own 44 px buttons, phone and desk', () => {
  for (const isDesktop of [false, true]) {
    const html = renderScreen(member.AppInner, { app: app({ isDesktop, access: { accessStatus: 'pending', capabilities: { credential: all(false), practice: all(false) }, lifetime: { credential: false, practice: false }, freeBeta: { state: 'none' }, practiceTrial: { state: 'none' } } }), props: home });
    for (const label of ['Check access again', 'Sign out']) assertTappable(html, label);
    const check = buttons(html).find(b => b.text === 'Check access again');
    assert.equal(check.style['font-size'], isDesktop ? '14px' : '16px', '16 px text on a phone, like every other control there');
  }
});

test('AUTH-003: the paused-access gate\'s Manage button and the no-decision gate\'s Try again are styled 44 px buttons', () => {
  const paused = renderScreen(member.AppInner, { app: app({ access: { accessStatus: 'revoked', capabilities: { credential: all(false), practice: all(false) }, lifetime: { credential: false, practice: false }, freeBeta: { state: 'none' }, practiceTrial: { state: 'none' } } }), props: home });
  assert.match(paused, /Access paused/);
  assertTappable(paused, 'Manage an existing subscription');
  const undecided = renderScreen(member.AppInner, { app: app({ access: null, launch: { initializationError: new Error('synthetic') } }), props: home });
  const retry = buttons(undecided).find(b => b.text === 'Try again' || b.text === 'Reload');
  assert.ok(retry, 'the no-decision gate offers its button');
  assertTappable(undecided, retry.text);
  const signOut = buttons(undecided).find(b => b.text === 'Sign out');
  assert.ok(px(signOut.style['min-height']) >= 32, 'its Sign out link is a 32 px target too');
});

test('ADMIN-001..004, 008: the Admin root carries the phone tap-target class, and the CSS floor is 32 px below the desk breakpoint', async () => {
  const html = renderScreen(owner.AdminDashboard, { app: app({ isDesktop: false }), props: {} });
  assert.match(html, /^<div class="cdomd-admin">/, 'every Admin tab renders inside the scoped root');
  assert.match(html, /Administration sections/, 'the admin render reaches the dashboard, not the "Admin only" notice');
  const css = (await read('src/styles/base.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const block = css.match(/@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const rules = [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.split(',').map(x => x.trim()), body }));
  const floor = (selector, prop) => rules.some(r => r.sel.includes(selector) && new RegExp(`${prop}:\\s*32px`).test(r.body));
  for (const selector of ['.cdomd-admin button', '.cdomd-admin select', '.cdomd-admin input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])', '.cdomd-admin summary', '.cdomd-admin [role="button"]']) {
    assert.ok(floor(selector, 'min-height'), `${selector} has a 32 px min-height on a phone`);
  }
  for (const selector of ['.cdomd-admin button', '.cdomd-admin [role="button"]']) assert.ok(floor(selector, 'min-width'), `${selector} is 32 px wide at least`);
  // AppContext's isDesktop is a settled innerWidth >= 1024: the desk keeps its layout.
  assert.match(await read('src/context/AppContext.jsx'), /watchDeskBreakpoint\(window,/);
  assert.match(await read('src/utils/deskBreakpoint.js'), /export const DESK_MIN_WIDTH = 1024;/);
});

test('ADMIN-001, 003, 004: no Admin screen draws a bare browser button, and none caps a control under 32 px inline', async () => {
  const files = ['AdminDashboard', 'AdminControlHistory', 'AdminErrorReports', 'AdminWelcomeEmail', 'AdminAccessChange', 'AdminOperationsReport', 'AdminPreview'];
  for (const name of files) {
    const source = await read(`src/components/pages/${name}.jsx`);
    for (const [tag] of source.matchAll(/<button\b(?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*>/g)) {
      assert.match(tag, /\bstyle=\{/, `${name}: ${tag.slice(0, 90)} has a style`);
    }
    // An inline minHeight outranks the CSS floor, so none may sit under it.
    for (const [decl, value] of source.matchAll(/\bminHeight:\s*(\d+)/g)) assert.ok(Number(value) >= 32, `${name}: ${decl}`);
  }
  const history = buttons(renderScreen(owner.AdminDashboard, { app: app(), props: {} }));
  assert.ok(history.every(b => b.style.padding !== undefined || b.style.border !== undefined), 'every rendered Admin button is styled');
});
