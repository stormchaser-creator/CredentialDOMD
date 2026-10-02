// After iOS discards the installed app (a call taken with the Phone app in
// front), it loaded again on Home: a running Work timer was out of sight
// until he tapped Practice and then Work (lab, ios-practice timer journeys:
// "reopened on Work: false"). The app now opens on the screen last on view in
// this tab, and Practice opens on Work while a timer runs. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf } from '../harness/component-harness.mjs';
import { mountComponent } from '../component-harness.mjs';
import * as deepLinks from '../../src/utils/supportDeepLink.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// ── Practice: Work while a timer runs, else the sub-view last on view ──
globalThis.localStorage = new MemoryStorage();
const { LocumDashboard, setActiveUserId, scopedKey, BASE_KEYS } = await loadScreens(
  'export {default as LocumDashboard} from "./src/components/features/locum/LocumDashboard.jsx"; export { setActiveUserId, scopedKey, BASE_KEYS } from "./src/utils/storageScope.js";',
  { real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'] });
setActiveUserId('user_synthetic');
const practice = () => {
  const m = mount(LocumDashboard, { data: { locumContracts: [] } });
  Object.assign(globalThis.__screen.app, { plan: 'locum', isDevMode: false, limitedLaunch: { enabled: false }, practiceReadOnly: false });
  return m;
};
const pressed = (m) => nodes(m.render()).filter(n => n.type === 'button' && n.props['aria-pressed'] === true).map(textOf);

test('Practice opens on the sub-view last on view in this tab', () => {
  globalThis.sessionStorage = new MemoryStorage();
  try {
    globalThis.sessionStorage.setItem('credentialdomd.last-practice-sub', 'invoices');
    assert.deepEqual(pressed(practice()), ['Invoices']);
  } finally { delete globalThis.sessionStorage; }
});

test('...but on Work while a timer runs, whatever was last on view', () => {
  globalThis.sessionStorage = new MemoryStorage();
  try {
    globalThis.sessionStorage.setItem('credentialdomd.last-practice-sub', 'invoices');
    globalThis.localStorage.setItem(scopedKey(BASE_KEYS.timer), JSON.stringify({ contractId: 'c-1', type: 'Call', startedAt: '2026-09-29T15:00:00.000Z' }));
    assert.deepEqual(pressed(practice()), ['Work']);
  } finally { delete globalThis.sessionStorage; globalThis.localStorage.removeItem(scopedKey(BASE_KEYS.timer)); }
});

// ── App: the screen last on view, unless an email link names one ──
async function mountApp({ hash = '', last }) {
  const u = new URL(`/app/${hash}`, 'https://credentialdomd.com');
  const location = { pathname: u.pathname, search: '', hash: u.hash };
  const history = { state: null, replaceState: (_s, _t, to) => { location.hash = new URL(to, 'https://credentialdomd.com').hash; } };
  const tab = new MemoryStorage();
  if (last) tab.setItem('credentialdomd.last-screen', JSON.stringify(last));
  deepLinks.captureAppDeepLink({ location, history, storage: tab });
  const window = { location, history, sessionStorage: tab, addEventListener() {}, removeEventListener() {}, navigator: {}, matchMedia: () => ({ matches: false }) };
  globalThis.window = window;
  const app = await mountComponent('src/App.jsx', {
    modules: { 'clerk-react': { useUser: () => ({ isLoaded: true }), useAuth: () => ({ userId: 'user_synthetic' }) }, supportDeepLink: deepLinks },
    globals: { window, navigator: { onLine: true }, sessionStorage: tab },
  });
  const inner = app.nodes().find(n => n.type?.name === 'AppInner');
  return { inner, tab };
}

test('the app loads again on the screen last on view (Practice), and keeps it as he moves', async () => {
  const { inner, tab } = await mountApp({ last: { tab: 'locum', subPage: null, at: Date.now() - 60_000 } });
  assert.equal(inner.props.tab, 'locum');
  assert.equal(JSON.parse(tab.getItem('credentialdomd.last-screen')).tab, 'locum');
});

test('an old or unknown screen, or an email link, is not overridden by it', async () => {
  assert.equal((await mountApp({ last: { tab: 'locum', at: Date.now() - 2 * 60 * 60_000 } })).inner.props.tab, 'home', 'older than half an hour');
  assert.equal((await mountApp({ last: { tab: 'admin-secret', at: Date.now() } })).inner.props.tab, 'home');
  const linked = (await mountApp({ hash: '#requests', last: { tab: 'locum', at: Date.now() } })).inner;
  assert.deepEqual([linked.props.tab, linked.props.subPage], ['more', 'requests']);
});
