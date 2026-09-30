import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, click, pinClock } from '../harness/component-harness.mjs';

// The deduction ledger (PRAC-028): the CSV a CPA opens keeps its five
// columns whatever the category says, and a refused save keeps the line.
// Synthetic amounts only.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { DeductionMemo } = await loadScreens('export {default as DeductionMemo} from "./src/components/features/locum/DeductionMemo.jsx";');

// RFC 4180: quoted fields, "" inside quotes, CRLF or LF between rows.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

const LINES = [
  { id: 'd1', date: '2026-03-01', category: 'Software / SaaS (CredentialDoMD, Doximity, etc.)', description: 'Synthetic app, annual', amount: 99, taxYear: '2026', source: 'manual' },
  { id: 'd2', date: '2026-03-02', category: 'Equipment (computer, capitalize or Section 179)', description: 'Synthetic laptop, "pro"', amount: 2499, taxYear: '2026', source: 'manual' },
  { id: 'd3', date: '2026-03-03', category: 'Professional fees (CPA, legal)', description: '=HYPERLINK("http://example.invalid")', amount: 350, taxYear: '2026', source: 'manual' },
  { id: 'd4', date: '2026-03-04', category: 'Meals (50% deductible, travel)', description: 'Synthetic diner', amount: -12.5, taxYear: '2026', source: 'manual' },
];

test('Export CSV: every row has exactly 5 columns, even for categories with commas', async () => {
  const blobs = [];
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return 'blob:synthetic'; };
  URL.revokeObjectURL = () => {};
  globalThis.document = { createElement: () => ({ click() {} }) };
  try {
    const m = mount(DeductionMemo, { data: { deductibles: LINES, licenses: [], insurance: [], cme: [], memberships: [] } });
    click(m, 'Export CSV');
    const text = (await blobs[0].text()).replace(/^﻿/, '');
    const rows = parseCsv(text.trimEnd());
    assert.equal(rows.length, 5);
    for (const r of rows) assert.equal(r.length, 5, JSON.stringify(r));
    const byId = Object.fromEntries(rows.slice(1).map(r => [r[2], r]));
    assert.deepEqual(byId['Synthetic app, annual'], ['2026-03-01', 'Software / SaaS (CredentialDOMD, Doximity, etc.)', 'Synthetic app, annual', '99', 'manual']);
    assert.deepEqual(byId['Synthetic laptop, "pro"'].slice(1, 4), ['Equipment (computer, capitalize or Section 179)', 'Synthetic laptop, "pro"', '2499']);
    assert.equal(byId['Synthetic diner'][3], '-12.5', 'a negative amount stays a number');
    // A description that starts like a formula is not run by the spreadsheet.
    assert.ok(rows.some(r => r[2] === `'=HYPERLINK("http://example.invalid")`));
  } finally {
    URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; delete globalThis.document;
  }
});

test('a refused save keeps the line in the form and never says Added', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] }, refuse: (op, key) => key === 'deductibles' });
  click(m, '+ Add line item');
  const formEl = () => find(m.render(), n => typeof n.type === 'function' && 'onSave' in (n.props || {}), 'deduction form');
  formEl().props.setForm(f => ({ ...f, description: 'Synthetic board exam', amount: '1,250.00', date: '2026-04-01', taxYear: '2026' }));
  formEl().props.onSave();
  assert.deepEqual(m.calls, [['refused', 'add', 'deductibles']]);
  const page = textOf(m.render());
  assert.doesNotMatch(page, /Added Synthetic board exam/);
  assert.equal(formEl().props.form.description, 'Synthetic board exam', 'the typed line is still there');
  assert.equal(formEl().props.msg, 'Not saved yet. Your entry is still here.');
});

test('an accepted save records $1,250.00 and says so', () => {
  const m = mount(DeductionMemo, { data: { deductibles: [] } });
  click(m, '+ Add line item');
  const formEl = () => find(m.render(), n => typeof n.type === 'function' && 'onSave' in (n.props || {}), 'deduction form');
  formEl().props.setForm(f => ({ ...f, description: 'Synthetic board exam', amount: '1,250.00', date: '2026-04-01', taxYear: '2026' }));
  formEl().props.onSave();
  assert.equal(m.calls.find(c => c[0] === 'add')[2].amount, 1250);
  assert.match(textOf(m.render()), /Added Synthetic board exam, \$1,250\.00 \(2026\)\./);
  assert.equal(nodes(m.render()).filter(n => typeof n.type === 'function' && 'onSave' in (n.props || {})).length, 0, 'the form closed');
});

// PRAC-029: a line read off a card statement or a receipt keeps the source it
// was saved with, in the list and in the CSV's Source column, and can still
// be removed. Every stored line used to be relabelled "manual".
const IMPORTED = [
  { id: 'i1', date: '2026-09-05', category: 'Software / SaaS (CredentialDoMD, Doximity, etc.)', description: 'SYNTHETIC CODE HOSTING', amount: 12, taxYear: '2026', source: 'card import' },
  { id: 'i2', date: '2026-09-06', category: 'Office supplies', description: 'Synthetic receipt paper', amount: 8, taxYear: '2026', source: 'receipt scan' },
  { id: 'i3', date: '2026-09-07', category: 'Other deductible expense', description: 'Synthetic typed line', amount: 20, taxYear: '2026', source: 'manual' },
  { id: 'i4', date: '2026-09-08', category: 'Other deductible expense', description: 'Synthetic line saved before sources', amount: 5, taxYear: '2026' },
];

test('PRAC-029: the CSV and the list say "card import" and "receipt scan" for lines that came from them', async () => {
  const blobs = [];
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return 'blob:synthetic'; };
  URL.revokeObjectURL = () => {};
  globalThis.document = { createElement: () => ({ click() {} }) };
  try {
    const m = mount(DeductionMemo, { data: { deductibles: IMPORTED, licenses: [], insurance: [], cme: [], memberships: [] } });
    click(m, 'Export CSV');
    const rows = parseCsv((await blobs[0].text()).replace(/^﻿/, '').trimEnd());
    const sourceOf = Object.fromEntries(rows.slice(1).map(r => [r[2], r[4]]));
    assert.deepEqual(sourceOf, {
      'SYNTHETIC CODE HOSTING': 'card import',
      'Synthetic receipt paper': 'receipt scan',
      'Synthetic typed line': 'manual',
      'Synthetic line saved before sources': 'manual',
    });
    const page = textOf(m.render());
    assert.match(page, /card import/);
    assert.match(page, /receipt scan/);
    // Every stored line keeps its remove button, whatever its source.
    const removable = nodes(m.render()).filter(n => n.type === 'button' && /^Remove /.test(n.props['aria-label'] || '')).map(n => n.props['aria-label']);
    assert.deepEqual(removable.sort(), ['Remove Synthetic line saved before sources', 'Remove Synthetic receipt paper', 'Remove Synthetic typed line', 'Remove SYNTHETIC CODE HOSTING'].sort());
    nodes(m.render()).find(n => n.props?.['aria-label'] === 'Remove SYNTHETIC CODE HOSTING').props.onClick();
    assert.deepEqual(m.calls.filter(c => c[0] === 'delete'), [['delete', 'deductibles', 'i1']]);
  } finally {
    URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; delete globalThis.document;
  }
});
