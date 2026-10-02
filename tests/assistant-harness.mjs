// Mounts Vera (src/components/features/AssistantSection.jsx) with synthetic
// hooks (tests/component-harness.mjs): the model turn, the transcript store
// and the app context are fakes; the pure helpers are the real modules.
// Not a test file itself. Every record here is synthetic.
import * as helpers from '../src/utils/helpers.js';
import * as sectionFields from '../src/utils/sectionFields.js';
import * as customCategories from '../src/utils/customCategories.js';
import * as referenceDraft from '../src/utils/referenceDraft.js';
import * as shareText from '../src/utils/shareText.js';
import * as docLabel from '../src/utils/docLabel.js';
import * as paused from '../src/utils/pausedApplicationRecords.js';
import * as guard from '../src/utils/spreadsheetGuard.js';
import * as dictationErrors from '../src/utils/dictationErrors.js';
import * as shareHandoff from '../src/utils/shareHandoff.js';
import * as professions from '../src/constants/professions.js';
import * as compliance from '../src/utils/compliance.js';
import { mountComponent, settle } from './component-harness.mjs';

export function recorder() {
  const calls = [];
  const fn = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
  return { calls, fn, of: name => calls.filter(c => c[0] === name) };
}

export const baseData = over => ({
  settings: { degreeType: 'MD' }, documents: [], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [],
  locumContracts: [], customCategories: [], customRecords: [], peerReferences: [], memberships: [], workHistory: [], shareLog: [],
  ...over,
});

/**
 * turn(args) answers each model call with { reply, actions }. `saved` seeds
 * the on-device transcript. `modules` replaces any module by its last path
 * segment. `device` is this account's small on-device store (lsGet/lsSet);
 * pass the same object to a second mount to stand in for leaving Vera and
 * coming back. Returns the harness plus helpers to type, send and find buttons.
 */
export async function mountVera({ rec = recorder(), data = {}, props = {}, turn = async () => ({ reply: 'OK', actions: [] }), saved = [], modules = {}, app = {}, globals = {}, device = {} } = {}) {
  const store = { chat: saved, archives: [] };
  const turns = [];
  const ui = await mountComponent('src/components/features/AssistantSection.jsx', {
    app: {
      data: baseData(data), theme: {}, userIdRef: { current: 'profile-synthetic' }, allTrackedStates: [],
      addItem: rec.fn('addItem', true), editItem: rec.fn('editItem', true), deleteItem: rec.fn('deleteItem', true), navigate: rec.fn('navigate'),
      ...app,
    },
    props,
    modules: {
      helpers, customCategories, shareText, docLabel, pausedApplicationRecords: paused, spreadsheetGuard: guard, dictationErrors, shareHandoff, professions, compliance,
      referenceDraft,
      assistant: { assistantTurn: async (args) => { turns.push(args); return turn(args); }, buildSnapshot: () => ({}), splitFields: sectionFields.splitFields },
      // The transcript and archives are the IndexedDB-backed stores, read and
      // written through largeGetJSON/largeSetJSON (storageScope.js).
      storageScope: {
        BASE_KEYS: { chat: 'chat', archives: 'archives', veraProfessionLater: 'veraProfessionLater' }, largeGetJSON: k => store[k], largeSetJSON: (k, v) => { store[k] = v; },
        lsGet: k => device[k] ?? null, lsSet: (k, v) => { device[k] = v; return true; },
      },
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: f => /\.(docx?|xlsx?|csv|txt|rtf)$/i.test(f?.name || ''), UPLOAD_ACCEPT: '*', extractOfficeText: async () => '' },
      ...modules,
    },
    globals: {
      window: {
        navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true,
        addEventListener() {}, removeEventListener() {}, innerHeight: 800,
      },
      ...globals,
    },
  });
  const buttons = () => ui.nodes().filter(n => n.type === 'button');
  const button = label => buttons().find(b => ui.text(b).trim() === label);
  const ask = async text => {
    ui.nodes().find(n => n.type === 'textarea').props.onChange({ target: { value: text } });
    ui.render();
    await button('Send').props.onClick();
    await settle();
    ui.render();
  };
  const node = name => ui.nodes().find(n => typeof n.type === 'function' && n.type.name === name);
  return { ...ui, rec, store, device, turns, buttons, button, ask, node };
}
