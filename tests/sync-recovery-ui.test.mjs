import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { stableJson } from '../src/utils/syncRecovery.js';
import { isBackupFile } from '../src/utils/restoreBackup.js';

// Earlier versions kept on this device live under Data & Backup only
// (features/EarlierVersions.jsx). The everyday notice never mentions them.
const source = await readFile(new URL('../src/components/features/EarlierVersions.jsx', import.meta.url), 'utf8');
const notice = await readFile(new URL('../src/components/shared/SyncIssuesNotice.jsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code + '\nglobalThis.renderRecovery = module.exports.default;';
const A = 'user_syntheticA', B = 'user_syntheticB';
const copy = { entryId: 'synthetic-copy', collectionKey: 'licenses', local: { id: 'synthetic', name: 'Synthetic A license', notes: 'Private old A note' }, cloud: { id: 'synthetic', notes: 'Current A note' } };
function harness() {
  const f = { actor: A, state: { owner: A, fence: null, entries: [copy] }, effects: [], downloads: [], discarded: [], confirm: false };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    'react': { useState: () => [f.state, update => { f.state = typeof update === 'function' ? update(f.state) : update; }], useEffect: effect => f.effects.push(effect) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../context/AppContext': { useApp: () => ({ user: { id: f.actor }, theme: {}, isDesktop: true }) },
    '../../utils/storageScope.js': { localFence: () => null },
    '../../utils/syncRecovery.js': { stableJson, readRecovery: account => { assert.equal(account, f.actor); return [copy]; },
      onRecoveryChange: () => () => {},
      recoveryDownload: account => { if (account !== f.actor) throw Error('Account changed'); return { type: 'CredentialDOMD recovery copies', entries: [copy] }; },
      discardRecovery: (account, id) => { assert.equal(account, f.actor); f.discarded.push(id); } },
  };
  const module = { exports: {} }, context = vm.createContext({ module, exports: module.exports, require: name => imports[name], Blob,
    window: { confirm: () => f.confirm, addEventListener() {}, removeEventListener() {} },
    URL: { createObjectURL: blob => { f.downloads.push(blob); return 'blob:synthetic'; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } }, setTimeout() {},
  });
  vm.runInContext(code, context);
  f.render = context.renderRecovery;
  return f;
}
const walk = (value, found = []) => { if (!value || typeof value !== 'object') return found; if (value.type) found.push(value); for (const item of [].concat(value.props?.children || [])) { if (Array.isArray(item)) item.forEach(v => walk(v, found)); else walk(item, found); } return found; };
const button = (tree, text) => walk(tree).find(node => node.type === 'button' && node.props.children === text);

test('the everyday notice says nothing about earlier versions; Data & Backup holds them', async () => {
  assert.doesNotMatch(notice, /readRecovery|recoveryDownload|discardRecovery|data-sync-recovery|need your review/);
  const dataExport = await readFile(new URL('../src/components/features/DataExport.jsx', import.meta.url), 'utf8');
  assert.match(dataExport, /<EarlierVersions \/>/);
});

test('earlier versions are a quiet collapsed row: no red, no review wording', () => {
  const f = harness(), tree = f.render(), html = JSON.stringify(tree);
  assert.equal(tree.type, 'details');
  assert.equal(tree.props.open, undefined, 'collapsed until opened');
  assert.match(html, /Earlier versions kept on this device/);
  assert.match(html, /Synthetic A license/);
  assert.doesNotMatch(html, /review|danger/i);
});

test('earlier versions hide former account copies on the next account first render, before effects', () => {
  const f = harness(); assert.match(JSON.stringify(f.render()), /Synthetic A license/);
  f.actor = B;
  assert.equal(f.render(), null, 'no former account data while a new effect waits');
});

test('download keeps both values; download is not an import-compatible automatic restore', async () => {
  const f = harness(), tree = f.render();
  button(tree, 'Download').props.onClick();
  const parsed = JSON.parse(await f.downloads[0].text());
  assert.equal(isBackupFile(parsed), false);
  assert.equal(parsed.entries[0].local.notes, copy.local.notes);
  assert.equal(parsed.entries[0].cloud.notes, copy.cloud.notes);
  assert.deepEqual(f.discarded, []);
});

test('remove requires explicit confirmation; a stale-account download cannot expose old copies', () => {
  const f = harness(), tree = f.render();
  button(tree, 'Remove').props.onClick(); assert.deepEqual(f.discarded, []);
  f.confirm = true; button(tree, 'Remove').props.onClick(); assert.deepEqual(f.discarded, ['synthetic-copy']);
  f.actor = B; button(tree, 'Download').props.onClick(); assert.equal(f.downloads.length, 0);
});
