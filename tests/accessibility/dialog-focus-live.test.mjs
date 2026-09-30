// Where focus goes when the shared Modal opens and closes, with React's own
// commit running (react-dom/client over the in-memory DOM in
// harness/live-dom.mjs). Both cases here turn on commit order, which a
// hand-driven fake cannot show:
//
// - A field with autoFocus inside the dialog takes focus before Modal's own
//   layout effect runs (children commit first), so the opener has to be
//   recorded earlier than that or it is lost. TaxPrep's payment form, the
//   Work Log's manual entry and TaskNotes all open this way.
// - Two stacked dialogs that close in one commit (Work Log's "Check the date"
//   over "Log past time": Save anyway closes both) each clean up while the
//   other is still half there, so neither could see that focus was lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installLiveDom } from '../harness/live-dom.mjs';
import { loadScreens } from '../harness/component-harness.mjs';
import { THEMES } from '../../src/constants/themes.js';

// Left installed to the end of the file: React finishes scheduled work after
// the last test, and it reads window.
const { doc } = installLiveDom();
const { Modal } = await loadScreens('export { default as Modal } from "./src/components/shared/Modal.jsx";');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
globalThis.__screen = { app: { theme: THEMES.light, isDesktop: true, data: { settings: {} } } };
const h = React.createElement;

function mountPage(Page, { strict = false } = {}) {
  const host = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(host);
  flushSync(() => root.render(strict ? h(React.StrictMode, null, h(Page)) : h(Page)));
  return () => { flushSync(() => root.unmount()); doc.body.removeChild(host); doc.activeElement = doc.body; };
}
// Past every microtask the close queued.
const settle = () => new Promise(resolve => setImmediate(resolve));
const button = (text) => doc.all(n => n.tagName === 'BUTTON' && n.textContent === text)[0];
const labelled = (name) => doc.all(n => n.getAttribute('aria-label') === name)[0];
const dialog = (name) => doc.all(n => n.getAttribute('role') === 'dialog' && n.getAttribute('aria-label') === name)[0];
// Compared by identity and reported by name: a failed deep compare would try
// to print the whole node graph, React's fibers included.
const describe = (el) => (!el ? 'nothing' : el === doc.body ? '<body>' : `<${el.localName}> "${el.getAttribute('aria-label') || el.textContent}"`);
const focusIs = (el, message) => assert.ok(doc.activeElement === el, `${message}: expected ${describe(el)}, focus is on ${describe(doc.activeElement)}`);
const focusWithin = (el, message) => assert.ok(!!el && el.contains(doc.activeElement), `${message}: focus is on ${describe(doc.activeElement)}`);

test('a dialog whose field takes focus on open still gives focus back to the button that opened it', async () => {
  let setOpen;
  function Page() {
    const [open, set] = React.useState(false);
    setOpen = set;
    return h('div', null,
      h('button', { onClick: () => set(true) }, 'Add a payment'),
      h(Modal, { open, onClose: () => set(false), title: 'Tax payment' },
        h('input', { type: 'number', 'aria-label': 'Amount ($)', autoFocus: true })));
  }
  const unmount = mountPage(Page);
  const opener = button('Add a payment');
  opener.focus();
  flushSync(() => setOpen(true));
  focusIs(labelled('Amount ($)'), 'the field took focus on open');
  flushSync(() => setOpen(false)); // Escape, or the close cross
  await settle();
  focusIs(opener, 'focus is back on the opener, not on <body>');
  unmount();
});

// The Work Log shape: two sibling Modals, the second opened from the first's Save.
function WorkLogShape({ expose }) {
  const [manual, setManual] = React.useState(false);
  const [placement, setPlacement] = React.useState(false);
  expose.current = { setManual, setPlacement };
  return h('div', null,
    h('button', { onClick: () => setManual(true) }, 'Log past time'),
    h(Modal, { open: manual, onClose: () => setManual(false), title: 'Log past time', footer: h('button', { onClick: () => setPlacement(true) }, 'Save') },
      h('input', { 'aria-label': 'Description', autoFocus: true })),
    h(Modal, { open: placement, onClose: () => setPlacement(false), title: 'Check the date' },
      h('button', { onClick() { setPlacement(false); setManual(false); } }, 'Save anyway'),
      h('button', { onClick: () => setPlacement(false) }, 'Change the date')));
}

function openBoth(expose) {
  const logPast = button('Log past time');
  logPast.focus();
  flushSync(() => expose.current.setManual(true));
  const save = button('Save');
  save.focus();
  flushSync(() => expose.current.setPlacement(true));
  focusWithin(dialog('Check the date'), 'focus moved into the dialog on top');
  return { logPast, save };
}

test('two stacked dialogs that close in one commit give focus back to the first opener', async () => {
  const expose = {};
  const unmount = mountPage(() => h(WorkLogShape, { expose }));
  const { logPast } = openBoth(expose);
  button('Save anyway').focus();
  flushSync(() => { expose.current.setPlacement(false); expose.current.setManual(false); });
  await settle();
  assert.ok(!dialog('Log past time'), 'both dialogs closed');
  focusIs(logPast, 'focus is on Log past time, not on <body>');
  unmount();
});

test('closing only the top dialog gives focus back to its opener in the dialog below', async () => {
  const expose = {};
  const unmount = mountPage(() => h(WorkLogShape, { expose }));
  const { save } = openBoth(expose);
  button('Change the date').focus();
  flushSync(() => expose.current.setPlacement(false));
  await settle();
  focusIs(save, 'focus is on Save in the dialog still open');
  unmount();
});

// React runs a new component's effects twice in development (StrictMode):
// close then open again, back to back. The close's give-back must not then
// pull focus out of the dialog that is still open. Only a Modal that mounts
// already open gets the double run, as one rendered only while open does.
test('the development double mount (StrictMode) leaves focus inside the open dialog', async () => {
  let setOpen;
  function Page() {
    const [open, set] = React.useState(false);
    setOpen = set;
    return h('div', null,
      h('button', { onClick: () => set(true) }, 'Add a note'),
      open && h(Modal, { open, onClose: () => set(false), title: 'Note' }, h('p', null, 'Body')));
  }
  const unmount = mountPage(Page, { strict: true });
  const opener = button('Add a note');
  opener.focus();
  flushSync(() => setOpen(true));
  await settle();
  focusIs(dialog('Note'), 'still in the dialog after the effects ran twice');
  flushSync(() => setOpen(false));
  await settle();
  focusIs(opener, 'back on the opener');
  unmount();
});
