// Admin > Users > Repair sign-in emails: the transport and the card. The
// first tap only previews; Apply exists only after a preview found changes;
// every button is 16px so iPhone Safari does not zoom; nothing shown is an
// address. Synthetic values only: the repository is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMailboxRepairClient, repairSummary } from '../../src/utils/mailboxRepairClient.js';

const require = createRequire(import.meta.url);
const ACCOUNT = 'user_SynthAdmin';
const counts = (over = {}) => ({ schemaVersion: 1, applied: false, users: 12, change: 3, current: 7, skipped: 2,
  skippedBy: { noAccount: 1, closed: 0, continuity: 0, banned: 0, locked: 0, unverified: 1, unusable: 0 }, outcomes: { claimed: 3 }, ...over });

function clientWith(reply, { status = 200, session = { user: { id: ACCOUNT }, getToken: async () => 'synthetic-token' } } = {}) {
  const sent = [];
  const client = createMailboxRepairClient({ accountId: ACCOUNT, url: 'https://synthetic.supabase.test', anonKey: 'anon', getSession: () => session,
    fetchImpl: async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(typeof reply === 'function' ? reply(JSON.parse(init.body)) : reply), { status }); } });
  return { client, sent };
}

test('client: preview and apply are separate, explicit requests to admin-mailbox-repair', async () => {
  const f = clientWith(body => counts({ applied: body.action === 'apply' }));
  const preview = await f.client.preview();
  assert.equal(preview.applied, false);
  assert.equal(preview.change, 3);
  const applied = await f.client.apply();
  assert.equal(applied.applied, true);
  assert.deepEqual(f.sent.map(s => s.body), [{ action: 'preview' }, { action: 'apply' }]);
  assert.equal(f.sent[0].url, 'https://synthetic.supabase.test/functions/v1/admin-mailbox-repair');
  assert.equal(f.sent[0].init.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(f.sent[0].init.credentials, 'omit');
});

test('client: an answer that does not add up, or answers the other mode, is refused', async () => {
  for (const bad of [
    counts({ applied: true }),
    counts({ change: 4 }),
    counts({ skipped: 3 }),
    counts({ skippedBy: { noAccount: 1, closed: 0, banned: 0, locked: 0, unverified: 1 } }),
    counts({ skippedBy: { noAccount: 1, closed: 0, banned: 0, locked: 0, unverified: 1, unusable: 0 } }),
    counts({ skippedBy: { noAccount: 1, closed: 0, continuity: 1, banned: 0, locked: 0, unverified: 1, unusable: 0 } }),
    counts({ outcomes: { 'someone@example.invalid': 3 } }),
    counts({ schemaVersion: 2 }),
    { ...counts(), users: -1 },
  ]) {
    await assert.rejects(clientWith(bad).client.preview(), { code: 'mailbox_repair_unavailable' }, JSON.stringify(bad));
  }
  const kept = await clientWith(counts({ extra: 'dropped' })).client.preview();
  assert.equal('extra' in kept, false);
});

test('client: server refusals read plainly, and a changed session sends nothing', async () => {
  const cases = { admin_required: /Only an authorized administrator/, clerk_unavailable: /Clerk could not be read, so nothing was checked or changed/,
    too_many_users: /more Clerk users than one run/, unauthorized: /could not be verified/,
    continuity_disabled: /Sign-in continuity is switched off.*Nothing was checked or changed/ };
  for (const [code, message] of Object.entries(cases)) {
    await assert.rejects(clientWith({ error: code }, { status: 503 }).client.apply(), error => error.code === code && message.test(error.message));
  }
  await assert.rejects(clientWith({ error: 'something_else' }, { status: 503 }).client.apply(), { code: 'mailbox_repair_unavailable' });
  const other = createMailboxRepairClient({ accountId: ACCOUNT, url: 'https://synthetic.supabase.test', anonKey: 'anon',
    getSession: () => ({ user: { id: 'user_Other' }, getToken: async () => 'tok' }), fetchImpl: async () => { throw Error('must not fetch'); } });
  await assert.rejects(other.preview(), { code: 'session_changed' });
});

test('summary sentences: counts in plain words, never an address, no em dash', () => {
  const preview = repairSummary({ ...counts(), applied: false });
  assert.deepEqual(preview, ['3 accounts would change.', '7 accounts are already current.',
    'Skipped 2: 1 Clerk user has no account here; 1 user has no verified sign-in email.']);
  const done = repairSummary({ ...counts({ change: 1, current: 9, outcomes: { held: 1 } }), applied: true });
  assert.deepEqual(done, ['Done. 1 account was repaired.', '9 accounts are already current.',
    'Skipped 2: 1 Clerk user has no account here; 1 user has no verified sign-in email.',
    '1 account did not get the address because another account holds the same address.']);
  const nothing = repairSummary({ ...counts({ change: 0, current: 10, skipped: 2, outcomes: {} }), applied: false });
  assert.equal(nothing[0], 'Nothing to repair.');
  const held = repairSummary({ ...counts({ current: 6, skipped: 3,
    skippedBy: { noAccount: 1, closed: 0, continuity: 1, banned: 0, locked: 0, unverified: 1, unusable: 0 } }), applied: false });
  assert.equal(held[2], 'Skipped 3: 1 Clerk user has no account here; 1 account is held by the continuity check the sign-in webhook runs first'
    + ' (a move from the old sign-in is not finished, or access was revoked); 1 user has no verified sign-in email.');
  for (const line of [...preview, ...done, ...nothing, ...held]) { assert.doesNotMatch(line, /\u2014|@/); }
});

// ── The card ────────────────────────────────────────────────────────────────
const source = await readFile(new URL('../../src/components/pages/AdminMailboxRepair.jsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function card() {
  const hooks = [], effects = [], calls = [];
  let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useMemo(fn) { const i = cursor++; if (!(i in hooks)) hooks[i] = fn(); return hooks[i]; },
    useEffect(fn) { const i = cursor++; if (!(i in hooks)) { hooks[i] = true; effects.push(fn); } },
  };
  const f = { preview: async () => ({ ...counts(), applied: false }), apply: async () => ({ ...counts(), applied: true, change: 3 }) };
  const client = { preview: () => { calls.push('preview'); return f.preview(); }, apply: () => { calls.push('apply'); return f.apply(); } };
  const theme = { text: '#111', textMuted: '#555', border: '#ccc', accent: '#080', card: '#fff' };
  const imports = { react, 'react/jsx-runtime': require('react/jsx-runtime'),
    '../../context/AppContext': { useApp: () => ({ user: { id: ACCOUNT }, theme }) },
    '../../utils/mailboxRepairClient': { createMailboxRepairClient: () => client, repairSummary } };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => imports[name] });
  const render = () => { cursor = 0; return module.exports.default(); };
  f.render = render; f.html = () => renderToStaticMarkup(render()); f.calls = calls;
  f.mount = () => { render(); for (const effect of effects.splice(0)) effect(); };
  return f;
}
const nodes = node => (Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : []);
const buttons = f => nodes(f.render()).filter(n => n.type === 'button');
const label = b => [b.props.children].flat().join('');
const press = (f, text) => buttons(f).find(b => label(b) === text).props.onClick();

test('card: the first tap only previews, and every button is 16px', async () => {
  const f = card(); f.mount();
  assert.deepEqual(buttons(f).map(label), ['Repair sign-in emails']);
  assert.doesNotMatch(f.html(), /role="status"/);
  const held = deferred(); f.preview = () => held.promise;
  const first = press(f, 'Repair sign-in emails');
  assert.deepEqual(buttons(f).map(label), ['Checking...']);
  await buttons(f)[0].props.onClick(); // a second tap while checking does nothing
  held.resolve({ ...counts(), applied: false }); await first;
  assert.deepEqual(f.calls, ['preview']);
  assert.deepEqual(buttons(f).map(label), ['Apply to 3 accounts', 'Cancel']);
  assert.match(f.html(), /3 accounts would change\./);
  for (const b of buttons(f)) assert.equal(b.props.style.fontSize, 16);
  assert.doesNotMatch(f.html(), /@/);
});

test('card: the second tap applies, once, and says what happened', async () => {
  const f = card(); f.mount();
  await press(f, 'Repair sign-in emails');
  await press(f, 'Apply to 3 accounts');
  assert.deepEqual(f.calls, ['preview', 'apply']);
  assert.match(f.html(), /Done\. 3 accounts were repaired\./);
  assert.deepEqual(buttons(f).map(label), ['Check again']);
  assert.equal(buttons(f)[0].props.style.fontSize, 16);
});

test('card: nothing to repair offers no Apply; Cancel and errors put it back without applying', async () => {
  const none = card(); none.preview = async () => ({ ...counts({ change: 0, current: 10, outcomes: {} }), applied: false }); none.mount();
  await press(none, 'Repair sign-in emails');
  assert.match(none.html(), /Nothing to repair\./);
  assert.deepEqual(buttons(none).map(label), ['Check again']);

  const cancel = card(); cancel.mount();
  await press(cancel, 'Repair sign-in emails');
  press(cancel, 'Cancel');
  assert.deepEqual(buttons(cancel).map(label), ['Repair sign-in emails']);
  assert.deepEqual(cancel.calls, ['preview']);

  const failing = card(); failing.preview = async () => { throw new Error('Clerk could not be read, so nothing was checked or changed. Try again in a minute.'); };
  failing.mount();
  await press(failing, 'Repair sign-in emails');
  await tick();
  assert.match(failing.html(), /role="alert"[^>]*>Clerk could not be read/);
  assert.deepEqual(buttons(failing).map(label), ['Repair sign-in emails']);
});

test('card and client copy carry no em dash', async () => {
  const client = await readFile(new URL('../../src/utils/mailboxRepairClient.js', import.meta.url), 'utf8');
  for (const text of [source, client]) assert.doesNotMatch(text, /\u2014/);
});
