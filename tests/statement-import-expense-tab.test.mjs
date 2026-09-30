// A card-statement row billed to an agency goes to Practice > Expenses
// (DOCS-006). The import said "Work Expenses", and Work is a separate
// Practice tab, so a member following the words looked in the wrong place.
// Real component with synthetic hooks; synthetic statement rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import * as guard from '../src/utils/spreadsheetGuard.js';
import { mountComponent } from './component-harness.mjs';

test('billing a statement row to an agency names Practice > Expenses, before and after saving', async () => {
  const calls = [];
  const s = await mountComponent('src/components/features/locum/StatementImport.jsx', {
    app: {
      data: { settings: {}, documents: [], locumContracts: [{ id: 'K1', facility: 'Synthetic Regional', agency: 'Synthetic Staffing', startDate: '2026-08-01', endDate: '2027-01-31' }], deductibles: [], travelExpenses: [] },
      theme: {}, user: { id: 'user_synthetic' }, isDesktop: false,
      addItem: (...a) => { calls.push(a); return true; }, editItem() {}, setData() {},
    },
    props: { open: true, onClose() {} },
    modules: {
      spreadsheetGuard: guard, xlsx: XLSX, helpers: { generateId: () => 'synthetic-id' },
      contractsForDate: await import('../src/utils/contractsForDate.js'), deductionCategoryLabel: await import('../src/utils/deductionCategoryLabel.js'),
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.', aiAvailable: () => false },
      officeText: { isOfficeFile: f => /\.(csv|xlsx?)$/i.test(f?.name || ''), UPLOAD_ACCEPT: '*' },
    },
  });
  await s.pick(s.fileInputs()[0], [new File(['Date,Description,Amount\n09/02/2026,SYNTHETIC HOTEL DENVER,-212.40\n'], 'statement.csv', { type: 'text/csv' })]);
  const billBox = () => s.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.style?.width === 15);
  assert.ok(billBox(), `a bill-to-agency box on the hotel row: ${s.pageText().slice(0, 400)}`);
  assert.match(s.pageText(), /Bill to agency instead \(Practice > Expenses\)/);
  billBox().props.onChange({ target: { checked: true } });
  const agency = s.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Agency name');
  if (!agency.props.value) agency.props.onChange({ target: { value: 'Synthetic Staffing' } });
  s.nodes().find(n => n.type === 'button' && /^Save 1 line/.test(s.text(n))).props.onClick();
  assert.deepEqual(calls.map(c => c[0]), ['travelExpenses'], 'the row was billed, not deducted');
  const page = s.pageText();
  assert.match(page, /1 row was sent to Practice > Expenses to invoice the agency instead/, page);
  assert.doesNotMatch(page, /Work Expenses|Work > /);
});
