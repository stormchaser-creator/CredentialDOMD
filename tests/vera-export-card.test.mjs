// Vera's export card says it is an export (VERA-007). The card header had no
// export_data case and fell through to "New record → caseLogs", telling the
// physician a record would be created when approving only builds a
// spreadsheet. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';
import { loadScreens } from './harness/component-harness.mjs';

// The real export engine (its imports have no extensions, so it is bundled).
const exportData = await loadScreens('export * from "./src/utils/exportData.js";');

const CASES = [{ id: 'case-1', date: '2026-08-01', cptCode: '61510', description: 'Synthetic craniotomy', role: 'Primary' }];
const supabase = { supabase: { from: () => ({ insert: () => new Promise(() => {}) }) } };

async function exportCard(action) {
  const v = await mountVera({
    data: { caseLogs: CASES },
    modules: { exportData, supabase },
    turn: async () => ({ reply: 'Here is the export.', actions: [{ kind: 'export_data', summary: 'Excel of the last 12 months of case logs', ...action }] }),
    globals: { navigator: { userAgent: 'Synthetic desktop', clipboard: { writeText: async () => {} } } },
  });
  await v.ask('export my case logs to Excel');
  // The header is the line above the summary in the card.
  const header = () => {
    const tree = v.nodes();
    const summary = tree.find(n => n.type === 'div' && v.text(n) === 'Excel of the last 12 months of case logs');
    const card = tree.find(n => n.type === 'div' && Array.isArray(n.props.children) && n.props.children.includes(summary));
    return v.text(card.props.children[0]);
  };
  return { v, header };
}

test('an export card is headed as an export of that section, not as a new record', async () => {
  const { header } = await exportCard({ section: 'caseLogs', format: 'xlsx' });
  assert.equal(header(), 'Export · Case log · Excel');
  assert.doesNotMatch(header(), /New record/);
});

test('a CSV export says CSV, and the done card keeps the export label', async () => {
  const { v, header } = await exportCard({ section: 'caseLogs', format: 'csv' });
  assert.equal(header(), 'Export · Case log · CSV');
  await v.button('Approve').props.onClick();
  await settle();
  assert.equal(header(), 'Export · Case log · CSV ✓ done');
});

test('every section Vera may export has a name for the card', () => {
  for (const [section, label] of Object.entries({ caseLogs: 'Case log', cme: 'CME', workLog: 'Work log', licenses: 'Licenses', invoices: 'Invoices' })) {
    assert.equal(exportData.exportLabel?.(section), label, section);
  }
  assert.equal(exportData.exportLabel?.('nonsense'), null);
});
