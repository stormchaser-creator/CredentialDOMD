// Ticket 0b15a181: the Peer References Add form showed nothing about the
// references already saved, so a member had to remember the list. The top of
// the Add form now lists each saved reference by first and last name and
// credential, with the date it was added on the right when the record has it.
// Synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existingReferenceLines, splitReferenceName } from '../src/utils/peerReferenceList.js';
import { mountComponent } from './component-harness.mjs';
import * as helpers from '../src/utils/helpers.js';
import * as peerReferenceList from '../src/utils/peerReferenceList.js';

const read = p => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('a name keeps only first and last name; the credential after the comma is split off', () => {
  assert.deepEqual(splitReferenceName('Jane Smith, MD'), { name: 'Jane Smith', credential: 'MD' });
  assert.deepEqual(splitReferenceName('Dr. Alex Q. Rivera'), { name: 'Alex Rivera', credential: '' });
  assert.deepEqual(splitReferenceName('Sam Lee, DO, FACS'), { name: 'Sam Lee', credential: 'DO' });
  assert.deepEqual(splitReferenceName('Maria de la Cruz'), { name: 'Maria de la Cruz', credential: '' }, 'a compound surname is not cut');
});

test('a middle name, a degree typed without a comma and a last-name-first entry still read as first and last name', () => {
  assert.deepEqual(splitReferenceName('Jane Marie Smith'), { name: 'Jane Smith', credential: '' }, 'a middle name is dropped');
  assert.deepEqual(splitReferenceName('Jane Smith MD'), { name: 'Jane Smith', credential: 'MD' }, 'a degree after the name is not part of it');
  assert.deepEqual(splitReferenceName('Jane Smith M.D.'), { name: 'Jane Smith', credential: 'M.D.' });
  assert.deepEqual(splitReferenceName('Jane Smith Jr.'), { name: 'Jane Smith', credential: '' });
  assert.deepEqual(splitReferenceName('Jane Smith, Jr., MD'), { name: 'Jane Smith', credential: 'MD' });
  assert.deepEqual(splitReferenceName('Smith, Jane'), { name: 'Jane Smith', credential: '' }, 'last name first is not read as a credential');
  assert.deepEqual(splitReferenceName('Ludwig van Beethoven'), { name: 'Ludwig van Beethoven', credential: '' });
  const [line] = existingReferenceLines([{ id: 'z', name: 'Jane Smith MD', degree: 'MD' }]);
  assert.equal(`${line.name}, ${line.credential}`, 'Jane Smith, MD', 'the degree is not shown twice');
});

test('each saved reference becomes one line: name, credential, date added', () => {
  const lines = existingReferenceLines([
    { id: 'b', name: 'Taylor Brooks', degree: 'M.D.', createdAt: '2026-03-04T15:00:00Z', email: 'x@example.test', phone: '555-0100' },
    { id: 'a', name: 'Alex Q. Rivera, DO', degree: '', createdAt: '2026-01-02T15:00:00Z' },
    { id: 'c', name: 'Chris Park', degree: 'PA-C' },
    { id: 'd', name: '   ' },
    null,
  ]);
  assert.deepEqual(lines, [
    { id: 'a', name: 'Alex Rivera', credential: 'DO', added: '2026-01-02T15:00:00Z' },
    { id: 'c', name: 'Chris Park', credential: 'PA-C', added: '' },
    { id: 'b', name: 'Taylor Brooks', credential: 'MD', added: '2026-03-04T15:00:00Z' },
  ]);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['added', 'credential', 'id', 'name'], 'no email, phone or other detail');
  assert.deepEqual(existingReferenceLines(undefined), []);
  assert.equal(existingReferenceLines([{ id: 'x', name: 'Pat Doe', createdAt: 'not a date' }])[0].added, '', 'an unreadable date is not shown');
});

test('the list renders the names, credentials and dates; nothing when there are no references', async () => {
  const items = [
    { id: 'a', name: 'Alex Rivera', degree: 'DO', createdAt: '2026-01-02T15:00:00Z' },
    { id: 'c', name: 'Chris Park', degree: 'PA-C' },
  ];
  const m = await mountComponent('src/components/features/ExistingReferences.jsx', {
    modules: { helpers, peerReferenceList },
    app: { theme: {} },
    props: { items },
  });
  const text = m.pageText();
  assert.match(text, /Your references \(2\)/);
  assert.match(text, /Alex Rivera, DO/);
  assert.match(text, /Jan 2, 2026/);
  assert.match(text, /Chris Park, PA-C/);
  m.setProps({ items: [] });
  assert.equal(m.pageText(), '');
});

test('the Add form (not Edit) of Peer References shows the list at the top', () => {
  const crud = read('../src/components/features/CrudSection.jsx');
  const modal = crud.indexOf('<Modal open={showForm} onClose={closeForm} title={editItem ? "Edit" : "Add"}>');
  assert.ok(modal > 0);
  const top = crud.slice(modal, crud.indexOf('{contactImport && (', modal));
  assert.match(top, /\{!editItem && addHeader\}/, 'the list sits above the import help and only on Add');
  const app = read('../src/App.jsx');
  const section = app.slice(app.indexOf('if (sub === "peerReferences")'), app.indexOf('if (sub === "malpracticeHistory")'));
  assert.match(section, /addHeader=\{<ExistingReferences items=\{data\.peerReferences \|\| \[\]\} \/>\}/);
});
