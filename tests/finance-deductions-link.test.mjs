// "Open Deductions" lands on the Deductions ledger (DOCS-006). Filing a
// receipt as a deduction, or finding a deduction from Home search, opened
// Finance on its default Tax Prep view. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountComponent } from './component-harness.mjs';

const view = async (props) => {
  const ui = await mountComponent('src/components/features/locum/FinanceSection.jsx', { app: { theme: {} }, props });
  return ui.nodes().filter(n => typeof n.type === 'function').map(n => n.type.name).filter(n => n === 'DeductionMemo' || n === 'TaxPrep');
};

test('Finance opens on Deductions when asked to, and on Tax Prep otherwise', async () => {
  assert.deepEqual(await view({ initialTab: 'deductions' }), ['DeductionMemo']);
  assert.deepEqual(await view({}), ['TaxPrep']);
  assert.deepEqual(await view({ initialTab: 'nonsense' }), ['TaxPrep']);
});

test('the receipt banner and Home search both ask for the Deductions view, and App routes it', async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  const [docs, search, app] = await Promise.all([read('src/components/features/DocumentsSection.jsx'), read('src/components/features/HomeSearch.jsx'), read('src/App.jsx')]);
  assert.match(docs, /label: "Open Deductions", tab: "more", sub: "finance:deductions"/);
  assert.match(search, /\{ key: "deductibles", label: "Deductions", tab: "more", sub: "finance:deductions" \}/);
  assert.match(app, /subPage\?\.startsWith\("finance:"\)/);
  assert.match(app, /<FinanceSection key=\{subPage\} initialTab=\{subPage\.split\(":"\)\[1\]\} \/>/);
});
