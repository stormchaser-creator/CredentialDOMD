// Deleting a record deletes the files attached to it (AppContext
// deleteItemFn cascades them), so the confirmation says so, with the count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deleteConfirmText } from '../../src/utils/helpers.js';
import { mountComponent } from '../component-harness.mjs';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('the wording names the attached files and their count', () => {
  assert.equal(deleteConfirmText('item', 0), 'Delete this item? This cannot be undone.');
  assert.equal(deleteConfirmText('item', 1), 'Delete this item and its 1 attached file? The file will be removed from Files too. This cannot be undone.');
  assert.equal(deleteConfirmText('expense', 2, { one: 'receipt', many: 'receipts' }), 'Delete this expense and its 2 receipts? The receipts will be removed from Files too. This cannot be undone.');
  // PRAC-017: an agreement's confirm names up to three of its files.
  assert.equal(deleteConfirmText('agreement', 4, { names: ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'] }), 'Delete this agreement and its 4 attached files (a.pdf, b.pdf, c.pdf, ...)? The files will be removed from Files too. This cannot be undone.');
});

// CRED-003: the question names the file, as an agreement's does (PRAC-017).
test('the trash button on a license with an attached PDF says the PDF goes too, by name', async () => {
  const asked = [];
  const lic = { id: 'lic-1', type: 'State Medical License (MD)', state: 'CO', expirationDate: '2027-04-30' };
  const m = await mountComponent('src/components/features/CrudSection.jsx', {
    app: { data: { settings: {}, documents: [{ id: 'd1', name: 'license.pdf', linkedTo: 'licenses:lic-1' }], followUps: [] }, theme: {}, isDesktop: false, addItem() {}, editItem() {}, toggleFavorite() {} },
    props: { title: 'Licenses', sectionKey: 'licenses', items: [lic], fields: [{ key: 'state', label: 'State' }], onDelete() {} },
    modules: { helpers: await import('../../src/utils/helpers.js'), lifecycle: await import('../../src/utils/lifecycle.js'), caseBilling: await import('../../src/utils/caseBilling.js'), formLayout: await import('../../src/utils/formLayout.js') },
    globals: { window: { navigator: {}, matchMedia: () => ({ matches: false }), confirm: (msg) => { asked.push(msg); return false; } } },
  });
  const trash = m.nodes().find(n => n.type === 'button' && n.props.children?.type?.name === 'TrashIcon');
  assert.ok(trash, 'the card has its trash button');
  trash.props.onClick({ stopPropagation() {} });
  assert.deepEqual(asked, ['Delete this item and its 1 attached file (license.pdf)? The file will be removed from Files too. This cannot be undone.']);
});

test('every delete that cascades files says so', () => {
  const crud = read('src/components/features/CrudSection.jsx');
  assert.doesNotMatch(crud, /window\.confirm\("Delete this item\? This cannot be undone\."\)/);
  assert.match(read('src/components/features/HealthRecordsSection.jsx'), /deleteConfirmText\("record", linkedDocs\(item\)\.length, \{ names: linkedDocs\(item\)\.map\(d => d\.name \|\| "file"\) \}\)/);
  // Both license trash buttons (desk and phone) ask the one named question.
  assert.equal((crud.match(/if \(confirmDelete\(item\)\) onDelete\(item\.id\)/g) || []).length, 2);
  assert.match(crud, /deleteConfirmText\("item", files\.length, \{ names: files\.map\(d => d\.name \|\| "file"\) \}\)/);
  assert.match(read('src/components/features/locum/Contracts.jsx'), /deleteConfirmText\("agreement", linkedDocsFor\(item\.id\)\.length/);
  const exp = read('src/components/features/locum/Expenses.jsx');
  assert.doesNotMatch(exp, /Its receipts stay in Files/);
  assert.match(exp, /deleteConfirmText\("expense", receiptsOf\(exp\)\.length, \{ one: "receipt", many: "receipts" \}\)/);
});
