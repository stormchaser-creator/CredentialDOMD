// CRED-037: deleting a screening also deletes every file linked to it (from
// Files and from Storage). The prompt said only "Delete this screening?", so a
// report already in Files that the member linked to it vanished unannounced.
// Every other section that does this names the files first. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as helpers from '../../src/utils/helpers.js';
import * as credentialTypes from '../../src/constants/credentialTypes.js';
import { mountComponent } from '../component-harness.mjs';

const SCREENING = { id: 'scr-9', type: 'Background Check', agency: 'Synthetic Screening Co', result: 'Clear', reportDate: '2026-08-01', components: [] };

async function mount(documents) {
  const asked = [], deleted = [];
  const ui = await mountComponent('src/components/features/ScreeningsSection.jsx', {
    app: { data: { screenings: [SCREENING], documents, settings: {} }, theme: {}, addItem() {}, editItem() {}, deleteItem: (s, id) => deleted.push([s, id]), toggleFavorite() {} },
    props: { onShare() {} },
    modules: { helpers, credentialTypes },
    globals: { window: { navigator: {}, matchMedia: () => ({ matches: false }), confirm: msg => { asked.push(msg); return true; } } },
  });
  const del = ui.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Delete');
  assert.ok(del, 'the card has a Delete button');
  del.props.onClick({ stopPropagation() {} });
  return { asked, deleted };
}

test('the delete prompt names the linked files and says they leave Files', async () => {
  const { asked, deleted } = await mount([{ id: 'doc-1', name: 'synthetic-report.pdf', linkedTo: 'screenings:scr-9' }, { id: 'doc-2', name: 'other.pdf', linkedTo: 'cme:x' }]);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /1 attached file \(synthetic-report\.pdf\)/);
  assert.match(asked[0], /removed from Files too/);
  assert.doesNotMatch(asked[0], /other\.pdf/);
  assert.deepEqual(deleted, [['screenings', 'scr-9']]);
});

test('with no linked files the prompt is the plain shared wording', async () => {
  const { asked } = await mount([]);
  assert.deepEqual(asked, ['Delete this screening? This cannot be undone.']);
});
