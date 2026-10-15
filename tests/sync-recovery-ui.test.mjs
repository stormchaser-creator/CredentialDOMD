import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { stableJson } from '../src/utils/syncRecovery.js';
import { isBackupFile } from '../src/utils/restoreBackup.js';

const source = await readFile(new URL('../src/components/shared/SyncIssuesNotice.jsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code + '\nglobalThis.renderRecovery = RecoveryNotice;';
const A = 'user_syntheticA', B = 'user_syntheticB';
const copy = { entryId: 'synthetic-copy', collectionKey: 'licenses', local: { id: 'synthetic', name: 'Synthetic A license', notes: 'Private old A note' }, cloud: { id: 'synthetic', notes: 'Current A note' } };
function harness() {
  const f = { actor: A, state: { owner: A, fence: null, entries: [copy], error: null }, effects: [], downloads: [], discarded: [], confirm: false };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    'react': { useState: () => [f.state, update => { f.state = typeof update === 'function' ? update(f.state) : update; }], useEffect: effect => f.effects.push(effect) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../context/AppContext': { useApp: () => ({ user: { id: f.actor }, theme: {}, isDesktop: true }) },
    '../../utils/syncIssues.js': {}, './actionButton.js': { actionButtonStyle: () => ({}) },
    '../../utils/storageScope.js': { localFence: () => null },
    '../../utils/syncRecovery.js': { stableJson, readRecovery: account => { assert.equal(account, f.actor); return [copy]; },
      recoveryFailureFor: () => null, onRecoveryChange: () => () => {},
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

test('recovery notice hides former account copies on the next account first render, before effects', () => {
  const f = harness(); assert.match(JSON.stringify(f.render()), /Private old A note/);
  f.actor = B;
  assert.equal(f.render(), null, 'no former account data while a new effect waits');
});

test('compare and download keep both values; download is not an import-compatible automatic restore', async () => {
  const f = harness(), tree = f.render();
  assert.match(JSON.stringify(tree), /Private old A note/); assert.match(JSON.stringify(tree), /Current A note/);
  button(tree, 'Download both copies').props.onClick();
  const parsed = JSON.parse(await f.downloads[0].text());
  assert.equal(isBackupFile(parsed), false);
  assert.equal(parsed.entries[0].local.notes, copy.local.notes);
  assert.equal(parsed.entries[0].cloud.notes, copy.cloud.notes);
  assert.deepEqual(f.discarded, []);
});

test('discard requires explicit confirmation; a stale-account download cannot expose old copies', () => {
  const f = harness(), tree = f.render();
  button(tree, 'Remove saved copy').props.onClick(); assert.deepEqual(f.discarded, []);
  f.confirm = true; button(tree, 'Remove saved copy').props.onClick(); assert.deepEqual(f.discarded, ['synthetic-copy']);
  f.actor = B; button(tree, 'Download both copies').props.onClick(); assert.equal(f.downloads.length, 0);
});


test('saved file contents stay downloadable without dumping a data URL into the comparison', () => {
  const f = harness();
  f.state.entries = [{ ...copy, collectionKey: 'documents', local: { id: 'synthetic-doc', name: 'Synthetic.pdf', data: 'data:application/pdf;base64,U1lOVEhFVElD' }, cloud: { id: 'synthetic-doc', name: 'Synthetic.pdf' } }];
  const tree = JSON.stringify(f.render());
  assert.match(tree, /File contents retained in the download/);
  assert.doesNotMatch(tree, /U1lOVEhFVElD/);
});
