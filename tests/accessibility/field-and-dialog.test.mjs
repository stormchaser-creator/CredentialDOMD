// The two shared pieces most forms and sheets are built on.
//
// Field: its <label> used to sit next to the control with nothing tying the
// two, so a screen reader announced every field in every Add/Edit form as an
// unnamed text box (the QA lab had to find fields as "the label's sibling").
// It now points the label at the first control inside it.
//
// Modal: focus now starts inside the dialog and goes back to the button that
// opened it when it closes (dialogFocus.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { loadScreens, renderScreen } from '../harness/component-harness.mjs';
import { auditHtml, parseHtml } from './html-audit.mjs';
import { takeDialogFocus } from '../../src/utils/dialogFocus.js';
import { THEMES } from '../../src/constants/themes.js';

const { Field, Modal } = await loadScreens('export { default as Field } from "./src/components/shared/Field.jsx"; export { default as Modal } from "./src/components/shared/Modal.jsx";');
const h = React.createElement;
const app = { theme: THEMES.light, isDesktop: false, data: { settings: {} } };
const render = (props) => renderScreen(Field, { app, props });
const all = (node, out = []) => { for (const c of node.children || []) if (c.tag) { out.push(c); all(c, out); } return out; };
const find = (html, pred) => all(parseHtml(html)).find(pred);

test('a Field ties its label to the control under it', () => {
  const html = render({ label: 'Email', children: h('input', { type: 'email', value: '', onChange() {} }) });
  const label = find(html, n => n.tag === 'label');
  const input = find(html, n => n.tag === 'input');
  assert.ok(input.attrs.id, 'the input gets an id');
  assert.equal(label.attrs.for, input.attrs.id, 'the label points at it');
  assert.deepEqual(auditHtml(html), []);
});

test('a control that already has an id keeps it, and the label uses it', () => {
  const html = render({ label: 'Email', children: h('input', { id: 'own-id', value: '', onChange() {} }) });
  assert.equal(find(html, n => n.tag === 'label').attrs.for, 'own-id');
  assert.equal(find(html, n => n.tag === 'input').attrs.id, 'own-id');
});

// Children the way JSX passes them: <Field label="..."><a /><b /></Field>.
const renderRow = (label, ...children) => renderScreen(() => h(Field, { label }, ...children), { app });

test('the first control inside plain wrappers is the one labelled; a condition that shows it counts', () => {
  const html = renderRow('Date',
    h('div', null, h('button', { type: 'button' }, 'Today'), h('button', { type: 'button' }, 'Yesterday')),
    true && h('input', { type: 'date', value: '', onChange() {} }));
  assert.equal(find(html, n => n.tag === 'label').attrs.for, find(html, n => n.tag === 'input').attrs.id);
  const grid = render({ label: 'Hospital', children: h('div', { style: { display: 'grid' } }, h('select', { value: '', onChange() {} }), h('button', null, 'Clear')) });
  assert.equal(find(grid, n => n.tag === 'label').attrs.for, find(grid, n => n.tag === 'select').attrs.id);
});

test('a control inside its own <label> or another component is left to it; the row becomes a named group', () => {
  const Picker = () => h('select', { 'aria-label': 'Specialty' });
  const html = render({ label: 'Specialties', children: h(Picker) });
  const row = find(html, n => n.attrs.role === 'group');
  const label = find(html, n => n.tag === 'label');
  assert.ok(row, 'a Field with no control of its own is a group');
  assert.equal(row.attrs['aria-labelledby'], label.attrs.id, 'named by its label');
  assert.equal(label.attrs.for, undefined);
  const inner = render({ label: 'Covered window', children: h('div', null, h(Field, { label: 'Start' }, h('input', { type: 'time' })), h(Field, { label: 'End' }, h('input', { type: 'time' }))) });
  assert.equal(all(parseHtml(inner)).filter(n => n.attrs.role === 'group').length, 1, 'the outer row groups the two inner fields');
  assert.deepEqual(auditHtml(inner), []);
  const wrapped = renderRow('Pay model', h('select'), h('label', null, h('input', { type: 'checkbox' }), ' Has a call grid'));
  assert.equal(find(wrapped, n => n.tag === 'label' && n.attrs.for).attrs.for, find(wrapped, n => n.tag === 'select').attrs.id);
  assert.equal(find(wrapped, n => n.attrs.type === 'checkbox').attrs.id, undefined, 'the checkbox keeps its own wrapping label');
  assert.deepEqual(auditHtml(wrapped), []);
});

// Contracts > Coverage dates, Call rate grid; Screenings > Searches
// performed; the Duty Log's On call. Each row of the list labels its own
// fields ("Block 1 start date"), so the caption names the whole list: a group,
// with no htmlFor that would hand it to block 1's start date (and open that
// date picker when the caption is tapped).
test('a row that maps out a list of labelled fields is a named group, not a label on the first one', () => {
  const blocks = [{ n: 1 }, { n: 2 }];
  const groupOf = (html) => {
    const row = find(html, n => n.attrs.role === 'group');
    const label = find(html, n => n.tag === 'label' && n.attrs.id);
    assert.ok(row, 'the row is a group');
    assert.equal(row.attrs['aria-labelledby'], label.attrs.id, 'named by its caption');
    assert.equal(label.attrs.for, undefined, 'the caption is tied to no one field');
    assert.deepEqual(all(parseHtml(html)).filter(n => n.tag === 'input' && n.attrs.id), [], 'no field was given the caption\'s id');
    assert.deepEqual(auditHtml(html), []);
  };
  // Two labelled inputs, mapped beside an Add button (Call rate grid, On call).
  groupOf(renderRow('Call rate grid',
    blocks.map(b => h('input', { key: b.n, 'aria-label': `Hospital ${b.n}` })),
    h('button', null, '+ Add hospital')));
  // A mapped list that is its wrapper's only child, one row of one field.
  groupOf(renderRow('On call', h('div', null, [{ n: 1 }].map(b => h('div', { key: b.n }, h('input', { 'aria-label': `Call period ${b.n} site` }))))));
  // One block of two dates inside a column with the Add button (Coverage dates).
  groupOf(renderRow('Coverage dates', h('div', null,
    [{ n: 1 }].map(b => h('div', { key: b.n }, h('input', { type: 'date', 'aria-label': `Block ${b.n} start date` }), h('input', { type: 'date', 'aria-label': `Block ${b.n} end date` }))),
    h('button', null, '+ Add a date block'))));
  // Two fields of its own, not mapped: still no single control to tie.
  const two = renderRow('When', h('div', null, h('input', { type: 'date', 'aria-label': 'From' }), h('input', { type: 'date', 'aria-label': 'To' })));
  assert.ok(find(two, n => n.attrs.role === 'group'));
  assert.equal(find(two, n => n.tag === 'label').attrs.for, undefined);
});

test('a control inside a fragment is the one labelled (a text field with its suggestion list)', () => {
  const html = renderRow('Issuing body', h(React.Fragment, null,
    h('input', { list: 'dl-issuer', value: '', onChange() {} }),
    h('datalist', { id: 'dl-issuer' }, h('option', { value: 'ABNS' }))));
  const input = find(html, n => n.tag === 'input');
  assert.ok(input.attrs.id);
  assert.equal(find(html, n => n.tag === 'label').attrs.for, input.attrs.id);
  assert.equal(find(html, n => n.attrs.role === 'group'), undefined);
  assert.deepEqual(auditHtml(html), []);
});

test('two Fields on one screen never share an id', () => {
  const Two = () => h('div', null, h(Field, { label: 'A' }, h('input')), h(Field, { label: 'B' }, h('input')));
  const html = renderScreen(Two, { app });
  const ids = all(parseHtml(html)).filter(n => n.tag === 'input').map(n => n.attrs.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(auditHtml(html), []);
});

test('tying the label adds no React key warning for the copied control', () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  // Children passed the way JSX passes them: <Field><input /><div /></Field>.
  const Note = () => h(Field, { label: 'Note', hint: 'optional' }, h('input'), h('div', null, 'shown under it'));
  const When = () => h(Field, { label: 'When' }, h('div', null, h('input', { type: 'date' }), h('span', null, 'to'), h('input', { type: 'date' })));
  const Issuer = () => h(Field, { label: 'Issuer' }, h(React.Fragment, null, h('input', { list: 'd' }), h('datalist', { id: 'd' })));
  try {
    renderScreen(Note, { app });
    renderScreen(When, { app });
    renderScreen(Issuer, { app });
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors.filter(e => /key/.test(e)), []);
});

test('the shared Modal is a named, modal dialog that can take focus', () => {
  const html = renderScreen(Modal, { app, props: { open: true, onClose() {}, title: 'Add' } });
  const dialog = find(html, n => n.attrs.role === 'dialog');
  assert.equal(dialog.attrs['aria-modal'], 'true');
  assert.equal(dialog.attrs['aria-label'], 'Add');
  assert.equal(dialog.attrs.tabindex, '-1', 'focusable, so focus can move into it on open');
  assert.deepEqual(auditHtml(html), []);
});

// A tiny DOM: elements with focus() and contains(), a document whose
// activeElement moves, and removal that drops focus to the body the way a
// browser does. The give-back runs once the closing commit is over (a
// microtask), so each close is followed by a tick.
function dom() {
  const doc = { body: { tagName: 'BODY' } };
  doc.activeElement = doc.body;
  const el = (tagName, parent = null) => {
    const node = { tagName, parent, removed: false, focused: [], focus(opts) { this.focused.push(opts); doc.activeElement = this; } };
    Object.defineProperty(node, 'isConnected', { get() { for (let n = node; n; n = n.parent) if (n.removed) return false; return true; } });
    node.contains = (other) => { for (let n = other; n && n !== doc.body; n = n.parent) if (n === node) return true; return false; };
    return node;
  };
  const remove = (node) => { node.removed = true; if (node.contains(doc.activeElement)) doc.activeElement = doc.body; };
  return { doc, el, remove };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('opening a dialog moves focus into it; closing gives it back to the button that opened it', async () => {
  const { doc, el, remove } = dom();
  const opener = el('BUTTON');
  const card = el('DIV');
  opener.focus();
  const giveBack = takeDialogFocus(doc, card);
  assert.equal(doc.activeElement, card);
  assert.deepEqual(card.focused, [{ preventScroll: true }], 'moved without scrolling the page');
  remove(card); // the dialog left the page, focus fell to the body
  giveBack();
  await tick();
  assert.equal(doc.activeElement, opener);
  assert.deepEqual(opener.focused.at(-1), { preventScroll: true });
});

test('a field that took focus on open keeps it', () => {
  const { doc, el } = dom();
  const card = el('DIV');
  const field = el('INPUT', card);
  field.focus();
  takeDialogFocus(doc, card);
  assert.equal(doc.activeElement, field);
  assert.deepEqual(card.focused, []);
});

// Modal records the opener before the dialog's content commits, because a
// field with autoFocus (TaxPrep's Amount, the Work Log's description) takes
// focus before Modal's layout effect runs. Read then, the opener was the field.
test('a dialog whose field took focus first gives focus back to the opener recorded before it', async () => {
  const { doc, el, remove } = dom();
  const opener = el('BUTTON');
  const card = el('DIV');
  const amount = el('INPUT', card);
  opener.focus();
  amount.focus(); // autoFocus, in the same commit, before the dialog's own effect
  const giveBack = takeDialogFocus(doc, card, opener);
  assert.equal(doc.activeElement, amount, 'the field keeps focus while the dialog is open');
  remove(card);
  giveBack();
  await tick();
  assert.equal(doc.activeElement, opener, 'focus goes back to the button, not to the page body');
});

// Work Log: "Check the date" opens over "Log past time" from its Save button,
// and Save anyway closes both in one commit. React cleans up the form first,
// while the date check (holding focus) is still on the page, then removes the
// date check, whose opener (Save) went with the form.
test('two stacked dialogs that close together give focus back to the first opener', async () => {
  const { doc, el, remove } = dom();
  const logPast = el('BUTTON');
  const form = el('DIV'); const save = el('BUTTON', form);
  const check = el('DIV'); const saveAnyway = el('BUTTON', check);
  logPast.focus();
  const giveBackForm = takeDialogFocus(doc, form);
  save.focus();
  const giveBackCheck = takeDialogFocus(doc, check);
  saveAnyway.focus();
  remove(form); giveBackForm();
  remove(check); giveBackCheck();
  await tick();
  assert.equal(doc.activeElement, logPast);
});

test('when the opener is gone and a dialog underneath is still open, focus goes to that dialog', async () => {
  const { doc, el, remove } = dom();
  const invoice = el('DIV'); const record = el('BUTTON', invoice);
  const payment = el('DIV');
  el('BUTTON').focus();
  takeDialogFocus(doc, invoice);
  record.focus();
  const giveBack = takeDialogFocus(doc, payment);
  remove(record); // the invoice was paid, its Record payment button went away
  remove(payment); giveBack();
  await tick();
  assert.equal(doc.activeElement, invoice, 'not the page behind the invoice dialog');
});

test('closing does not take focus back from where the physician moved it, or put it on a field or a removed button', async () => {
  let { doc, el, remove } = dom();
  let opener = el('BUTTON'); let card = el('DIV'); const elsewhere = el('BUTTON');
  opener.focus();
  let giveBack = takeDialogFocus(doc, card);
  elsewhere.focus();
  remove(card); giveBack();
  await tick();
  assert.equal(doc.activeElement, elsewhere, 'focus moved on purpose (another dialog, another control) stays there');

  ({ doc, el, remove } = dom());
  opener = el('INPUT'); card = el('DIV');
  opener.focus();
  giveBack = takeDialogFocus(doc, card);
  remove(card); giveBack();
  await tick();
  assert.equal(doc.activeElement, doc.body, 'a text field is not refocused: that could open the keyboard or reopen the dialog');

  ({ doc, el, remove } = dom());
  opener = el('BUTTON'); card = el('DIV');
  opener.focus();
  giveBack = takeDialogFocus(doc, card);
  remove(opener);
  remove(card); giveBack();
  await tick();
  assert.equal(doc.activeElement, doc.body, 'a button that is gone (its row was deleted) is not refocused');

  ({ doc, el, remove } = dom());
  opener = el('BUTTON'); card = el('DIV');
  opener.focus();
  giveBack = takeDialogFocus(doc, card);
  giveBack(); // React's development double mount: closed and opened again at once
  takeDialogFocus(doc, card);
  await tick();
  assert.equal(doc.activeElement, card, 'a dialog still on the page keeps focus');

  assert.doesNotThrow(() => takeDialogFocus(null, null)(), 'no document (a server render) is a no-op');
});
