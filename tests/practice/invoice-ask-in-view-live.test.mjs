// "Did <n> go out?" comes into view with its buttons (iOS 26 Simulator pass
// of the owner's invoice flows, 2026-10-02: on a 402x874 screen the question
// appeared at the foot of the invoice preview with Yes and No below the fold).
// React's own commit runs here (react-dom/client over harness/live-dom.mjs),
// so the effect that scrolls runs when React runs it: once when the question
// appears, again for another invoice, never on an ordinary re-render, which
// would pull back a physician who scrolled away. Where it lands on a real
// phone-sized screen: invoice-ask-in-view-webkit.test.mjs.
// Synthetic invoice numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installLiveDom } from '../harness/live-dom.mjs';
import { loadScreens } from '../harness/component-harness.mjs';
import { THEMES } from '../../src/constants/themes.js';

const { doc, win } = installLiveDom();
const S = await loadScreens([
  'export { default as InvoiceMarkSent, UnrecordedNotes } from "./src/components/shared/InvoiceMarkSent.jsx";',
  'export { revealInView } from "./src/utils/revealInView.js";',
].join(' '));
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const h = React.createElement;
const T = THEMES.light;

// Frames run when the test says so; every scrollIntoView is written down.
const frames = [];
win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
win.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
win.matchMedia = () => ({ matches: false });
const runFrames = () => { for (const fn of frames.splice(0)) fn?.(); };
const scrolled = [];
Object.getPrototypeOf(doc.createElement('div')).scrollIntoView = function (opts) { scrolled.push({ el: this, opts }); };

const settle = () => new Promise(resolve => setImmediate(resolve));
const textOf = (el) => el?.textContent || '';
function mountPage(Page) {
  const host = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(host);
  flushSync(() => root.render(h(Page)));
  return () => { flushSync(() => root.unmount()); doc.body.removeChild(host); };
}
async function commit(fn) { flushSync(fn); await settle(); runFrames(); }

function Preview({ expose }) {
  const [ask, setAsk] = React.useState(null);
  const [tick, setTick] = React.useState(0);
  expose.current = { setAsk, setTick };
  return h('div', { 'data-tick': tick },
    h('div', { style: { height: 900 } }, 'Invoice lines'),
    S.InvoiceMarkSent({ T, iS: {}, pending: null, note: null, form: null, setForm() {}, start: null, today: '2026-10-02', waiting: false,
      onRecordPending() {}, onRecordMarked() {}, ask, onYes() {}, onNo() {} }));
}

test('the preview question scrolls into view once when it appears, with block "nearest", and not on a re-render', async () => {
  scrolled.length = 0;
  const expose = {};
  const unmount = mountPage(() => h(Preview, { expose }));
  await settle(); runFrames();
  assert.equal(scrolled.length, 0, 'nothing scrolls before there is a question');

  await commit(() => expose.current.setAsk({ number: 'INV-20261002-01' }));
  assert.equal(scrolled.length, 1, 'the question scrolled into view');
  const { el, opts } = scrolled[0];
  assert.match(textOf(el), /Did INV-20261002-01 go out\?/);
  assert.match(textOf(el), /Yes, it was sent/, 'Yes is inside what is brought into view');
  assert.match(textOf(el), /No, it did not go out/, 'No is inside what is brought into view');
  assert.equal(el.getAttribute('role'), 'alert', 'still announced');
  assert.equal(opts.block, 'nearest', 'already in view: nothing moves');
  assert.equal(opts.behavior, 'smooth');
  assert.equal(el.style.scrollMarginBottom, '12px', 'a little air under No inside the dialog');

  // Yes is checking (a re-render with the same question): nothing moves.
  await commit(() => expose.current.setAsk({ number: 'INV-20261002-01', checking: true }));
  await commit(() => expose.current.setTick(t => t + 1));
  assert.equal(scrolled.length, 1, 'a re-render does not pull the physician back');

  // Another invoice asks: brought into view again.
  await commit(() => expose.current.setAsk({ number: 'INV-20261002-02' }));
  assert.equal(scrolled.length, 2);
  assert.match(textOf(scrolled[1].el), /Did INV-20261002-02 go out\?/);

  // Answered, then the same invoice asks again after a second share: again.
  await commit(() => expose.current.setAsk(null));
  await commit(() => expose.current.setAsk({ number: 'INV-20261002-02' }));
  assert.equal(scrolled.length, 3, 'a question that comes back is brought into view again');
  unmount();
});

test('a question gone before its frame scrolls nothing', async () => {
  scrolled.length = 0;
  const expose = {};
  const unmount = mountPage(() => h(Preview, { expose }));
  flushSync(() => expose.current.setAsk({ number: 'INV-20261002-03' }));
  await settle();
  flushSync(() => expose.current.setAsk(null));
  await settle();
  runFrames();
  assert.equal(scrolled.length, 0);
  unmount();
});

test('reduced motion: the question jumps into view instead of gliding', async () => {
  scrolled.length = 0;
  win.matchMedia = (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  try {
    const expose = {};
    const unmount = mountPage(() => h(Preview, { expose }));
    await commit(() => expose.current.setAsk({ number: 'INV-20261002-04' }));
    assert.equal(scrolled.length, 1);
    assert.equal(scrolled[0].opts.behavior, 'auto');
    unmount();
  } finally {
    win.matchMedia = () => ({ matches: false });
  }
});

test("a screen's reminders: the first one that asks comes into view, clear of the top and tab bars", async () => {
  scrolled.length = 0;
  let setList;
  function Screen() {
    const [list, set] = React.useState([]);
    setList = set;
    return h('div', null, S.UnrecordedNotes({ T, list, what: 'its entries', onForget() {}, onConfirm() {}, items: 'entries' }));
  }
  const unmount = mountPage(Screen);
  await settle(); runFrames();
  await commit(() => setList([
    // Known only from the server: no Yes or No here, so not the one revealed.
    { number: 'INV-20261002-05', sentAt: '2026-10-02T15:00:00Z', total: 100, handed: true, fromServer: true },
    { number: 'INV-20261002-06', sentAt: '2026-10-02T15:00:00Z', total: 200, handed: true },
    { number: 'INV-20261002-07', sentAt: '2026-10-02T15:00:00Z', total: 300, handed: true },
  ]));
  assert.equal(scrolled.length, 1, 'one reminder brought into view, not each in turn');
  const { el } = scrolled[0];
  assert.match(textOf(el), /INV-20261002-06 is not recorded\. Did it go out\?/);
  assert.match(textOf(el), /Yes, it was sent/);
  assert.match(el.style.scrollMarginBottom, /safe-area-inset-bottom.*84px/, 'clears the phone tab bar');
  assert.match(el.style.scrollMarginTop, /safe-area-inset-top.*68px/, 'clears the sticky top bar');

  // Answered: the next one that asks comes into view.
  await commit(() => setList(l => l.filter(n => n.number !== 'INV-20261002-06')));
  assert.equal(scrolled.length, 2);
  assert.match(textOf(scrolled[1].el), /INV-20261002-07 is not recorded\. Did it go out\?/);
  unmount();
});

test('revealInView survives a browser without scrollIntoView options and an element without it', () => {
  const calls = [];
  const old = { scrollIntoView(arg) { if (typeof arg === 'object') throw new TypeError('no options'); calls.push(arg); } };
  assert.equal(S.revealInView(old, win), true);
  assert.deepEqual(calls, [false], 'the plain call, aligning the bottom edge');
  assert.equal(S.revealInView({}, win), false);
  assert.equal(S.revealInView(null, win), false);
});
