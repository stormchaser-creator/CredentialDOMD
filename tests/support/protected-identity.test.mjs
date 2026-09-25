// Ticket d49088c7: Protected Identity stays on the device (no-PHI stance, no
// cloud sync). Every value here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as secretBox from '../../src/utils/secretBox.js';
import * as identity from '../../src/utils/protectedIdentity.js';
import { isDeviceOnlySection } from '../../src/utils/pausedApplicationRecords.js';
import { scrubSsn, hasSsnShape, SSN_REMOVED } from '../../src/utils/outgoingText.js';
import { DEVICE_KEYS_BASE } from '../../src/utils/storageScope.js';

const UID = 'user_synthetic_identity';
const SSN = '123-45-6789', DOB = '1970-01-02';
const slotKey = `${DEVICE_KEYS_BASE}:${UID}`;

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
const slot = storage => JSON.parse(storage.getItem(slotKey) || '{}');

// -- Pure rules --
test('a record needs a label and refuses an SSN in any plain field', () => {
  assert.match(identity.identityFormError({}), /label/);
  assert.equal(identity.identityFormError({ label: 'Liability application' }), null);
  for (const key of identity.PLAIN_FIELDS) {
    if (key === 'label') continue;
    assert.match(identity.identityFormError({ label: 'A', [key]: `see ${SSN}` }) || '', /encrypted/, key);
  }
  assert.match(identity.identityFormError({ label: `SSN ${SSN}` }), /encrypted/);
  assert.equal(identity.identityFormError({ label: 'A', notes: 'NPI 1234567890, phone 555-123-4567, verified 2026-09-25' }), null);
});

test('restoring from a backup keeps what is on the device and never stores an SSN in the clear', () => {
  const current = [{ id: 'a', label: 'Kept as is', ssn: 'enc1:CURRENT' }];
  const incoming = [
    { id: 'a', label: 'Stale copy', ssn: 'enc1:STALE' },
    { id: 'b', label: 'New', ssn: 'enc1:NEW', fullDob: 'enc1:NEWDATE', favorite: true, userId: 'someone', storagePath: 'x/y', injected: '<script>' },
    { id: 'c', label: 'Hand-edited', ssn: SSN, fullDob: DOB },
    { id: 'd', label: 'Plain note', notes: `ssn ${SSN}` },
    null, 'text', { label: 'no id' }, { id: 7 },
  ];
  const out = identity.mergeIdentityRestore(current, incoming);
  assert.deepEqual(out.records[0], current[0], 'a record already on this device is not overwritten');
  assert.equal(out.added, 3);
  assert.deepEqual(out.records.find(r => r.id === 'b'), { id: 'b', label: 'New', ssn: 'enc1:NEW', fullDob: 'enc1:NEWDATE' }, 'only this section\'s fields survive');
  assert.deepEqual(out.records.find(r => r.id === 'c'), { id: 'c', label: 'Hand-edited' }, 'a plaintext SSN and date of birth are left out');
  assert.deepEqual(out.records.find(r => r.id === 'd'), { id: 'd', label: 'Plain note' });
  assert.equal(out.droppedPlainSecret, true);
  assert.doesNotMatch(JSON.stringify(out.records), /123-45-6789|1970-01-02/);
});

// -- The lock code --
test('a short saved-password code keeps working for passwords, and Protected Identity asks for its own of 8 or more', async () => {
  const storage = memoryStorage({ [slotKey]: { lockCode: '1234', apiKey: 'synthetic-key' } });
  globalThis.localStorage = storage;
  try {
    assert.equal(secretBox.IDENTITY_LOCK_MIN, 8);
    assert.equal(secretBox.getIdentityLockCode(UID), null, 'a 4-character code does not open Protected Identity');
    assert.equal(secretBox.getShortLockCode(UID), '1234');
    assert.equal(secretBox.saveIdentityLockCode('short', UID), false, 'a code under 8 characters is refused');
    assert.equal(secretBox.saveIdentityLockCode('synthetic-strong', UID), true);
    assert.equal(secretBox.getIdentityLockCode(UID), 'synthetic-strong');
    assert.equal(slot(storage).lockCode, '1234', 'the password code is untouched');
    assert.equal(slot(storage).apiKey, 'synthetic-key', 'nothing else in the slot is lost');
    const password = await secretBox.encryptSecret('portal-password', '1234', UID);
    assert.equal(await secretBox.decryptSecret(password, secretBox.getLockCode(UID), UID), 'portal-password');
  } finally { delete globalThis.localStorage; }

  const fresh = memoryStorage();
  globalThis.localStorage = fresh;
  try {
    assert.equal(secretBox.saveIdentityLockCode('synthetic-strong', UID), true);
    assert.equal(slot(fresh).lockCode, 'synthetic-strong', 'a device with no code takes it as its lock code');
    assert.equal(slot(fresh).identityLockCode, undefined);
  } finally { delete globalThis.localStorage; }

  const long = memoryStorage({ [slotKey]: { lockCode: 'already-long-code' } });
  globalThis.localStorage = long;
  try { assert.equal(secretBox.getIdentityLockCode(UID), 'already-long-code', 'a code of 8 or more serves both'); }
  finally { delete globalThis.localStorage; }
});

// -- The four CRUD helpers in AppContext --
test('AppContext saves, edits, stars and deletes a device-only record without any cloud call', async () => {
  const source = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  // A device-only section (Protected Identity) is saved');
  const end = source.indexOf('  // Tracked states:', start);
  assert.ok(start > 0 && end > start, 'the CRUD helpers could not be located');
  const cloud = [];
  const state = { current: { identityVault: [], licenses: [], documents: [{ id: 'doc-l', linkedTo: 'licenses:l1' }] } };
  const record = name => (...args) => { cloud.push(name); return Promise.resolve(args); };
  const context = {
    useCallback: fn => fn, window: { alert() {} }, user: { id: UID }, userIdRef: { current: 'profile' },
    get dataRef() { return state; },
    updateSection: (key, updater) => { state.current = { ...state.current, [key]: updater(state.current[key]) }; return true; },
    guardedSetData: next => { state.current = next; return true; },
    accessAuthority: { allowsMutation: () => true }, membershipWriteError: () => new Error('read-only'),
    sbInsert: record('sbInsert'), sbUpdate: record('sbUpdate'), sbSetFavorite: record('sbSetFavorite'),
    sbDelete: record('sbDelete'), recordTombstone: record('recordTombstone'),
    isDeviceOnlySection,
  };
  vm.createContext(context);
  vm.runInContext(transformSync(`${source.slice(start, end)}\nglobalThis.api = { addItem, editItem, toggleFavorite, deleteItemFn };`, { loader: 'jsx' }).code, context);
  const { addItem, editItem, toggleFavorite, deleteItemFn } = context.api;
  const secret = { id: 'iv1', label: 'Synthetic', ssn: 'enc1:SYNTHETIC' };
  assert.notEqual(addItem('identityVault', secret), false);
  assert.notEqual(editItem('identityVault', { ...secret, label: 'Edited' }), false);
  assert.equal(toggleFavorite('identityVault', 'iv1'), false, 'no star: a star is a cloud column write');
  assert.equal(deleteItemFn('identityVault', 'iv1'), true);
  assert.deepEqual(cloud, [], 'nothing about a Protected Identity record reaches the cloud');
  assert.equal(state.current.identityVault.length, 0);

  addItem('licenses', { id: 'l1' });
  editItem('licenses', { id: 'l1', state: 'CA' });
  deleteItemFn('licenses', 'l1');
  assert.deepEqual(cloud, ['sbInsert', 'sbUpdate', 'sbDelete', 'recordTombstone', 'sbDelete', 'recordTombstone'], 'a synced collection still syncs');
});

// -- The screen itself --
async function screen({ storage, records = [] }) {
  const source = await readFile(new URL('../../src/components/features/ProtectedIdentitySection.jsx', import.meta.url), 'utf8');
  const hooks = [], effects = [], calls = [];
  let cursor = 0;
  const data = { identityVault: records };
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const react = {
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => hooks[i] = typeof v === 'function' ? v(hooks[i]) : v]; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { hooks[i] = { deps }; effects.push(fn); } },
  };
  const upsert = (list, rec) => list.some(r => r.id === rec.id) ? list.map(r => r.id === rec.id ? rec : r) : [...list, rec];
  const app = {
    get data() { return data; }, theme: {}, user: { id: UID },
    addItem: (key, rec) => { calls.push(['addItem', key, rec]); data[key] = upsert(data[key], rec); },
    editItem: (key, rec) => { calls.push(['editItem', key, rec]); data[key] = upsert(data[key], rec); },
    deleteItem: (key, id) => { calls.push(['deleteItem', key, id]); data[key] = data[key].filter(r => r.id !== id); return true; },
  };
  const imports = {
    react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'Fragment' },
    '../../context/AppContext': { useApp: () => app }, '../shared/useInputStyle': { useInputStyle: () => ({}) },
    '../shared/Modal': { __esModule: true, default: 'Modal' }, '../shared/Field': { __esModule: true, default: 'Field' },
    '../../utils/helpers': { generateId: () => 'new-record', formatDate: d => d },
    '../../utils/secretBox': secretBox, '../../utils/protectedIdentity': identity,
  };
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: n => { assert.ok(n in imports, `unexpected import ${n}`); return imports[n]; }, window: { confirm: () => true }, navigator: {}, console });
  vm.runInContext(transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  globalThis.localStorage = storage;
  const render = () => { cursor = 0; let tree = module.exports.default(); while (effects.length) { effects.splice(0).forEach(fn => fn()); cursor = 0; tree = module.exports.default(); } return tree; };
  const nodes = (tree = render()) => { const out = []; const visit = n => { if (Array.isArray(n)) { n.forEach(visit); return; } if (n && typeof n === 'object') { if (n.type) out.push(n); visit(n.props?.children); } }; visit(tree); return out; };
  const text = node => { const c = node?.props?.children; return (Array.isArray(c) ? c : [c]).flat(Infinity).map(v => typeof v === 'string' || typeof v === 'number' ? String(v) : v && typeof v === 'object' ? text(v) : '').join(''); };
  const button = label => { const n = nodes().find(n => n.type === 'button' && text(n) === label); assert.ok(n, `Missing button ${label}`); return n; };
  const field = label => { const f = nodes().find(n => n.type === 'Field' && n.props.label === label); assert.ok(f, `Missing field ${label}`); const kids = [f.props.children].flat(); return kids.find(k => k && (k.type === 'input' || k.type === 'textarea')); };
  const type = (label, value) => { field(label).props.onChange({ target: { value } }); render(); };
  return { render, nodes, text, button, field, type, calls, data };
}

test('saving an SSN and date of birth encrypts them before anything is stored, under a code of 8 or more', async () => {
  const storage = memoryStorage({ [slotKey]: { lockCode: '1234' } });
  const s = await screen({ storage });
  try {
    const page = s.text(s.render());
    assert.match(page, /Kept on this device only/);
    assert.match(page, /never sync to your account/);
    assert.doesNotMatch(page, /HIPAA|\u{2014}/u);
    for (const absent of ['Send', 'Share', 'Scan', 'Add to Favorites', 'Attach']) assert.ok(!s.nodes().some(n => n.type === 'button' && s.text(n).includes(absent)), absent);

    s.button('Add record').props.onClick(); s.render();
    s.type('Record label', 'Synthetic liability application');
    s.type('Legal last name', 'Synthetic');
    s.type('Social Security number', SSN);
    s.type('Full date of birth', DOB);
    const codeField = s.nodes().find(n => n.type === 'Field' && n.props.label === 'Lock code for Protected Identity');
    assert.ok(codeField, 'a stronger code is asked for first');
    assert.match(codeField.props.hint, /shorter than 8 characters and keeps working/);

    s.type('Lock code for Protected Identity', 'abc');
    await s.button('Save on this device').props.onClick(); s.render();
    assert.equal(s.calls.length, 0, 'nothing is saved with a short code');
    assert.match(s.text(s.render()), /at least 8 characters/);

    s.type('Lock code for Protected Identity', 'synthetic-strong');
    await s.button('Save on this device').props.onClick(); s.render();
    assert.equal(s.calls.length, 1);
    const [[call, key, saved]] = s.calls;
    assert.deepEqual([call, key], ['addItem', 'identityVault']);
    assert.ok(saved.ssn.startsWith('enc1:') && saved.fullDob.startsWith('enc1:'));
    assert.doesNotMatch(JSON.stringify(saved), /123-45-6789|1970-01-02/, 'no plaintext identifier in the saved record');
    assert.equal(await secretBox.decryptSecret(saved.ssn, 'synthetic-strong', UID), SSN);
    await assert.rejects(secretBox.decryptSecret(saved.ssn, '1234', UID), /wrong-lock-code/, 'the short code cannot open it');
    assert.equal(slot(storage).lockCode, '1234');
    assert.equal(slot(storage).identityLockCode, 'synthetic-strong');
    assert.doesNotMatch(s.text(s.render()), /123-45-6789/, 'masked until shown');
  } finally { delete globalThis.localStorage; }
});

test('showing an SSN saved under a short code asks for a stronger code first, then re-locks it', async () => {
  const storage = memoryStorage({ [slotKey]: { lockCode: '1234' } });
  globalThis.localStorage = storage;
  const legacy = { id: 'iv-legacy', label: 'Saved during the live window', ssn: await secretBox.encryptSecret(SSN, '1234', UID) };
  const s = await screen({ storage, records: [legacy] });
  try {
    await s.button('Show').props.onClick(); s.render();
    assert.doesNotMatch(s.text(s.render()), /123-45-6789/, 'not shown with the short code alone');
    assert.match(s.text(s.render()), /shorter than 8 characters/);
    const input = s.nodes().find(n => n.type === 'input' && n.props.placeholder === 'Lock code (8+ characters)');
    input.props.onChange({ target: { value: 'short' } }); s.render();
    await s.nodes().filter(n => n.type === 'button' && s.text(n) === 'Show').at(-1).props.onClick(); s.render();
    assert.match(s.text(s.render()), /Use at least 8 characters/);

    s.nodes().find(n => n.type === 'input' && n.props.placeholder === 'Lock code (8+ characters)').props.onChange({ target: { value: 'synthetic-strong' } }); s.render();
    await s.nodes().filter(n => n.type === 'button' && s.text(n) === 'Show').at(-1).props.onClick(); s.render();
    assert.match(s.text(s.render()), /123-45-6789/, 'shown once the stronger code is set');
    const edit = s.calls.find(([c]) => c === 'editItem');
    assert.ok(edit, 'the record is re-locked');
    assert.equal(await secretBox.decryptSecret(edit[2].ssn, 'synthetic-strong', UID), SSN);
    await assert.rejects(secretBox.decryptSecret(edit[2].ssn, '1234', UID), /wrong-lock-code/);
    assert.deepEqual(s.calls.map(([c, k]) => `${c}:${k}`), ['editItem:identityVault'], 'the only write is the device-only re-lock');
  } finally { delete globalThis.localStorage; }
});

// -- Outgoing text --
test('an SSN-shaped value is scrubbed from outgoing text and nothing else is', () => {
  for (const [input, expected] of [
    [`SSN ${SSN}`, `SSN ${SSN_REMOVED}`],
    ['ssn: 123456789', `ssn: ${SSN_REMOVED}`],
    ['Social Security Number 123456789', `Social Security Number ${SSN_REMOVED}`],
    ['123 45 6789 and 123.45.6789', `${SSN_REMOVED} and ${SSN_REMOVED}`],
    [`TIN ${SSN}`, `TIN ${SSN_REMOVED}`],
  ]) assert.equal(scrubSsn(input), expected);
  for (const kept of ['Call 555-123-4567', 'Expires 2027-06-30', 'Policy 123456789', 'NPI 1234567890', 'DEA AB1234567', 'License 12-345-6789', '9876-54-3210']) {
    assert.equal(scrubSsn(kept), kept); assert.equal(hasSsnShape(kept), false, kept);
  }
  assert.equal(scrubSsn(null), null);
});

test('the mail, text-message, clipboard and share paths scrub, and the error reporter redacts SSNs and birth dates', async () => {
  const read = p => readFile(new URL(`../../${p}`, import.meta.url), 'utf8');
  const { mailtoHref } = await import('../../src/utils/helpers.js');
  const href = mailtoHref('office@example.invalid', `SSN ${SSN}`, `Line one\nSSN ${SSN}`);
  assert.doesNotMatch(decodeURIComponent(href), /123-45-6789/);
  assert.match(decodeURIComponent(href), /\[SSN removed\]/);
  assert.match(href, /%0D%0A/, 'CRLF line breaks are kept');
  const [helpers, notifications, share, emailPacket, support] = await Promise.all(['src/utils/helpers.js', 'src/utils/notifications.js', 'src/components/features/ShareModal.jsx', 'src/components/features/EmailPacketModal.jsx', 'src/components/pages/SupportModal.jsx'].map(read));
  assert.match(helpers, /export async function copyToClipboard\(raw\) \{\n(?:.*\n)?\s*const text = scrubSsn\(raw\);/);
  assert.match(notifications, /export function composeText\(phone, raw\) \{[\s\S]{0,120}const body = scrubSsn\(/);
  assert.match(share, /const blurb = scrubSsn\(buildCredentialBlurb\(/);
  assert.match(emailPacket, /text: scrubSsn\(text\)/);
  assert.match(emailPacket, /filter\(\(d\) => !isIdentityLink\(d\?\.linkedTo\)\)/, 'no file linked to Protected Identity is offered for sending');
  assert.equal((support.match(/body: scrubSsn\(/g) || []).length, 4, 'ticket create and reply, both paths');

  const source = await read('src/lib/errorReport.js');
  const reports = [];
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Error, location: new URL('https://app.invalid/app/'),
    navigator: { userAgent: 'Synthetic', sendBeacon: (_t, body) => { reports.push(JSON.parse(body)); return true; } },
    window: { addEventListener() {} }, console: { warn() {}, error() {} }, fetch: async () => ({}),
    require: name => name === 'react' ? { Component: class {}, createElement: () => null } : { redactLaunchInvitation: s => String(s ?? '') },
  });
  vm.runInContext(transformSync(source, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://report.invalid', DEV: false }), '__APP_BUILD_ID__': '"synthetic"' } }).code, context);
  context.module.exports.reportError(new Error(`save failed for ${SSN}, dob: 01/02/1970, {"fullDob":"1970-01-02","dateOfBirth":"1970-01-02"} ssn=123456789`), 'error', { detail: `DOB 1970-01-02 SSN ${SSN}` });
  const sent = JSON.stringify(reports);
  assert.ok(reports.length, 'a report was sent');
  assert.doesNotMatch(sent, /123-45-6789|123456789|1970-01-02|01\/02\/1970/);
});

test('restoring a JSON backup brings Protected Identity back to this device only', async () => {
  const src = await readFile(new URL('../../src/components/features/DataExport.jsx', import.meta.url), 'utf8');
  assert.match(src, /mergeIdentityRestore\(data\[IDENTITY_SECTION\], raw\[IDENTITY_SECTION\]\)/);
  // The cloud push after a restore walks the synced collections only, and
  // Protected Identity is not one of them.
  assert.match(src, /for \(const key of COLLECTION_KEYS\) \{\s*if \(merged\[key\]\?\.length > 0\) bulkSync/);
  assert.doesNotMatch(src, /bulkSync\([^)]*IDENTITY_SECTION/);
});
