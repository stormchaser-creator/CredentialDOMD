// Owner ticket 23920b06: on the iPhone home-screen app the bottom menu moved
// up after the keyboard closed and stayed there, with a white band beneath.
// The document had been left scrolled by the keyboard. These pin the reset.
import test from "node:test";
import assert from "node:assert/strict";
import { installPhoneViewportReset, resetIfStranded, paintPageBackground, isEditing } from "../src/utils/phoneViewport.js";

function fakes({ scrollY = 0, innerHeight = 844, vvHeight = 844, vvOffsetTop = 0, active = null } = {}) {
  const listeners = { win: {}, doc: {}, vv: {} };
  const on = (bag) => (type, fn) => { (bag[type] ||= []).push(fn); };
  const off = (bag) => (type, fn) => { bag[type] = (bag[type] || []).filter((f) => f !== fn); };
  const vv = { height: vvHeight, offsetTop: vvOffsetTop, addEventListener: on(listeners.vv), removeEventListener: off(listeners.vv) };
  const doc = {
    activeElement: active, documentElement: { scrollTop: scrollY, style: {} }, body: { scrollTop: 0, style: {} },
    addEventListener: on(listeners.doc), removeEventListener: off(listeners.doc),
  };
  const win = {
    scrollY, pageYOffset: scrollY, innerHeight, visualViewport: vv, scrolledTo: null,
    scrollTo(x, y) { this.scrolledTo = [x, y]; this.scrollY = y; this.pageYOffset = y; },
    addEventListener: on(listeners.win), removeEventListener: off(listeners.win),
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
  };
  const fire = (where, type) => (listeners[where][type] || []).forEach((fn) => fn());
  return { win, doc, vv, listeners, fire };
}

test("a document the keyboard left scrolled goes back to the top once the keyboard is gone", () => {
  const f = fakes({ scrollY: 260 });
  assert.equal(resetIfStranded(f.win, f.doc), true);
  assert.deepEqual(f.win.scrolledTo, [0, 0]);
  assert.equal(f.doc.documentElement.scrollTop, 0);
});

test("nothing moves while a field is being typed into or the keyboard is still up", () => {
  const typing = fakes({ scrollY: 260, active: { tagName: "TEXTAREA" } });
  assert.equal(isEditing(typing.doc), true);
  assert.equal(resetIfStranded(typing.win, typing.doc), false);
  assert.equal(typing.win.scrolledTo, null);
  const keyboardUp = fakes({ scrollY: 260, vvHeight: 480 });
  assert.equal(resetIfStranded(keyboardUp.win, keyboardUp.doc), false);
});

test("an unscrolled document is left alone", () => {
  const f = fakes();
  assert.equal(resetIfStranded(f.win, f.doc), false);
  assert.equal(f.win.scrolledTo, null);
});

test("a visual viewport left offset is reset even when the document reports no scroll", () => {
  const f = fakes({ vvOffsetTop: 120 });
  assert.equal(resetIfStranded(f.win, f.doc), true);
});

test("the listener resets after focus leaves a field and after the keyboard resize, and uninstalls", () => {
  const f = fakes({ scrollY: 200, active: { tagName: "INPUT" } });
  const stop = installPhoneViewportReset(f.win, f.doc);
  f.doc.activeElement = null; // the keyboard closed and focus left the field
  f.fire("doc", "focusout");
  assert.deepEqual(f.win.scrolledTo, [0, 0]);
  f.win.scrollY = 150; f.win.pageYOffset = 150; f.doc.documentElement.scrollTop = 150; f.win.scrolledTo = null;
  f.fire("vv", "resize");
  assert.deepEqual(f.win.scrolledTo, [0, 0]);
  stop();
  assert.equal((f.listeners.doc.focusout || []).length, 0);
  assert.equal((f.listeners.vv.resize || []).length, 0);
});

test("the page itself carries the app background, so a gap is never a white band", () => {
  const f = fakes();
  paintPageBackground(f.doc, "#0b0f1a");
  assert.equal(f.doc.documentElement.style.backgroundColor, "#0b0f1a");
  assert.equal(f.doc.body.style.backgroundColor, "#0b0f1a");
});
