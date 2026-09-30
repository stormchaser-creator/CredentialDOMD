// Vera's open_record (and Home search, Favorites) opens a CME entry or a
// screening itself, not just its section (VERA-005). App set the target, but
// CMESection and ScreeningsSection took no target props, so the card said
// "Opened CME" over a list. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as helpers from '../src/utils/helpers.js';
import * as credentialTypes from '../src/constants/credentialTypes.js';
import { mountComponent } from './component-harness.mjs';

const SCREENING = { id: 'scr-1', type: 'Background Check', agency: 'Synthetic Screening Co', result: 'Clear', reportDate: '2026-08-01', components: [] };

async function screenings(props) {
  return mountComponent('src/components/features/ScreeningsSection.jsx', {
    app: { data: { screenings: [SCREENING], documents: [], settings: {} }, theme: {}, addItem() {}, editItem() {}, deleteItem() {}, toggleFavorite() {} },
    props: { onShare() {}, ...props },
    modules: { helpers, credentialTypes },
  });
}

test('a screening named by id opens its detail, and the target is cleared', async () => {
  const done = [];
  const ui = await screenings({ autoViewId: 'scr-1', onAutoViewDone: () => done.push(true) });
  const modal = ui.nodes().find(n => typeof n.type === 'function' && n.type.name === 'Modal' && n.props.open);
  assert.ok(modal, 'a detail sheet is open');
  assert.ok(ui.text(modal).includes('Synthetic Screening Co') || JSON.stringify(modal.props.title || '').includes('Background'), 'for that screening');
  assert.equal(done.length, 1);
});

test('an id that is not there still clears the target', async () => {
  const done = [];
  const ui = await screenings({ autoViewId: 'gone', onAutoViewDone: () => done.push(true) });
  ui.render();
  assert.ok(done.length >= 1);
  assert.ok(!ui.nodes().some(n => typeof n.type === 'function' && n.type.name === 'Modal' && n.props.open), 'nothing opens');
});

test('App hands both sections their target, and CMESection opens the entry', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<CMESection onShare=\{openShare\} \{\.\.\.crudTarget\("cme"\)\} \/>/);
  assert.match(app, /<ScreeningsSection onShare=\{openShare\} \{\.\.\.crudTarget\("screenings"\)\} \/>/);
  const cme = await readFile(new URL('../src/components/features/CMESection.jsx', import.meta.url), 'utf8');
  // The Setup "add one" props (autoOpen, onAutoOpenDone, onAutoEditClosed) ride alongside.
  assert.match(cme, /function CMESection\(\{ onShare,[^}]*\bautoViewId, onAutoViewDone, autoEditId, onAutoEditDone \}\)/);
  assert.match(cme, /openEdit\(it\)/);
});
