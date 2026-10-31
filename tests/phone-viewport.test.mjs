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

// ─── The home-screen app's height (owner's photos, 2026-10-30) ─────────────
// Reproduced on the iOS 27 simulator: the layout viewport is the screen minus
// the top inset once the document sits at 0, nothing is painted below it, and
// a cold launch shows the page at scrollY -62. A screen-tall shell (the
// previous fix) was clipped there: the bar was cut off.
import { isStandalone, markStandalone } from "../src/utils/phoneViewport.js";
import { readFileSync, existsSync } from "node:fs";

const rootDoc = () => ({ documentElement: { dataset: {} } });

test("the home-screen app is marked on the root, and nothing else is", () => {
  const home = rootDoc();
  assert.equal(markStandalone({ navigator: { standalone: true } }, home), true);
  assert.equal(home.documentElement.dataset.standalone, "true");
  const viaManifest = rootDoc();
  assert.equal(markStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) }, viaManifest), true);
  const safari = rootDoc();
  safari.documentElement.dataset.standalone = "true";
  assert.equal(markStandalone({ navigator: { standalone: false }, matchMedia: () => ({ matches: false }) }, safari), false);
  assert.equal("standalone" in safari.documentElement.dataset, false);
  assert.equal(isStandalone({ matchMedia: () => { throw new Error("old browser"); } }), false);
  assert.equal(markStandalone({}, {}), false);
});

test("the launch offset (page shown scrolled to -62) is put back to 0, where taps land under the finger", () => {
  const f = fakes({ scrollY: -62 });
  assert.equal(resetIfStranded(f.win, f.doc), true);
  assert.deepEqual(f.win.scrolledTo, [0, 0]);
  const vvAbove = fakes({ vvOffsetTop: -62 });
  assert.equal(resetIfStranded(vvAbove.win, vvAbove.doc), true);
  const typing = fakes({ scrollY: -62, active: { tagName: "TEXTAREA" } });
  assert.equal(resetIfStranded(typing.win, typing.doc), false, "never while a field has focus");
});

test("the reset runs once at install, so a cold launch is corrected before the first tap", () => {
  const f = fakes({ scrollY: -62 });
  const stop = installPhoneViewportReset(f.win, f.doc);
  assert.deepEqual(f.win.scrolledTo, [0, 0]);
  stop();
});

test("the height floor is in base.css, keyed on the attribute main.jsx sets before rendering", () => {
  const css = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-standalone\] \{\n\s+min-height: min\(100lvh, calc\(100% \+ env\(safe-area-inset-top, 0px\)\)\);\n\}/);
  const main = readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
  const marked = main.indexOf("markStandalone(window, document);");
  assert.ok(marked > 0 && marked < main.indexOf("createRoot("), "marked before the first render");
});

test("the phone shell is fixed to the viewport's top and bottom; no screen-tall shell, no 100dvh", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /backgroundColor: T\.bg, maxWidth: 480, margin: "0 auto",\n\s+position: "fixed", top: 0, bottom: 0, left: 0, right: 0,/);
  assert.doesNotMatch(app, /--app-height|installAppHeight/);
  const bar = app.slice(app.indexOf("{/* ─── BOTTOM TAB BAR (phone only)"), app.indexOf("{tabItems.map("));
  assert.match(bar, /position: "absolute", bottom: 0, left: 0, right: 0,/);
  assert.doesNotMatch(bar, /position: "fixed"/);
});

// Real WebKit with the app's own base.css and the shell's styles: the bar ends
// exactly at the viewport's bottom, never past it (past it is not painted on
// the iPhone), and the floor makes the document at least the viewport's
// height. Desktop WebKit cannot show the iOS short state itself; that was
// measured on the simulator.
let webkit = null;
try { ({ webkit } = await import("playwright-core")); } catch { webkit = null; }
const browserPath = (() => { try { return webkit?.executablePath(); } catch { return null; } })();
const skip = !browserPath || !existsSync(browserPath) ? "Playwright WebKit is not installed" : false;
test("real WebKit: the bar ends at the viewport's bottom and the floor holds the document to the viewport", { skip, timeout: 60000 }, async () => {
  const css = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 440, height: 894 }, screen: { width: 440, height: 956 } });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html data-standalone="true"><head><style>${css}</style></head><body>
      <div id="root"><div id="shell" style="max-width: 480px; margin: 0 auto; position: fixed; top: 0; bottom: 0; left: 0; right: 0; overflow: hidden">
        <div style="height:100%; overflow-y:auto"><div style="height:3000px">content</div></div>
        <div id="bar" style="position:absolute; bottom:0; left:0; right:0; height:64px; transform: translate3d(0,0,0)">bar</div>
      </div></div></body></html>`);
    const out = await page.evaluate(() => ({
      inner: innerHeight, bar: document.getElementById("bar").getBoundingClientRect().bottom,
      shell: document.getElementById("shell").getBoundingClientRect().height,
      html: document.documentElement.getBoundingClientRect().height,
    }));
    assert.equal(out.inner, 894);
    assert.equal(out.bar, 894, "the bar's bottom is the viewport's bottom");
    assert.equal(out.shell, 894);
    assert.ok(out.html >= 894, `the floor holds the document to at least the viewport (got ${out.html})`);
  } finally { await browser.close(); }
});
