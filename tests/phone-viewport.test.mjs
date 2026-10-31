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

// ─── The shell's height in the home-screen app (owner's photo, 2026-10-30) ──
import { fullAppHeight, installAppHeight, isStandalone } from "../src/utils/phoneViewport.js";
import { readFileSync, existsSync } from "node:fs";

const phone = ({ standalone = true, screen = [440, 956], inner = [440, 894], media = false } = {}) => ({
  navigator: { standalone }, matchMedia: () => ({ matches: media }),
  screen: { width: screen[0], height: screen[1] }, innerWidth: inner[0], innerHeight: inner[1],
});

test("the home-screen app takes the screen's height, even when iOS left the viewport a band short", () => {
  assert.equal(fullAppHeight(phone()), 956, "his iPhone: 894 reported, 956 real");
  assert.equal(fullAppHeight(phone({ inner: [440, 956] })), 956);
  assert.equal(fullAppHeight(phone({ inner: [956, 440 - 20] })), 440, "landscape takes the short side");
  assert.equal(isStandalone(phone({ standalone: false, media: true })), true, "display-mode standalone counts too");
});

test("must-pass: Safari's tab, a window smaller than the screen, and nonsense keep 100dvh", () => {
  assert.equal(fullAppHeight(phone({ standalone: false })), null, "in Safari the browser bars take room");
  assert.equal(fullAppHeight(phone({ screen: [1024, 1366], inner: [507, 1300] })), null, "an iPad in Split View");
  assert.equal(fullAppHeight(phone({ inner: [440, 500] })), null, "far short is a window, not the bug");
  assert.equal(fullAppHeight(phone({ screen: [0, 0] })), null);
  assert.equal(fullAppHeight({}), null);
});

test("--app-height is set at once, kept current on every resize, and removed on uninstall", () => {
  const listeners = {};
  const on = (where) => (type, fn) => { (listeners[`${where}:${type}`] ||= []).push(fn); };
  const off = (where) => (type, fn) => { listeners[`${where}:${type}`] = (listeners[`${where}:${type}`] || []).filter(f => f !== fn); };
  const props = new Map();
  const win = { ...phone(), visualViewport: { addEventListener: on("vv"), removeEventListener: off("vv") },
    addEventListener: on("win"), removeEventListener: off("win") };
  const doc = { documentElement: { style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) } },
    addEventListener: on("doc"), removeEventListener: off("doc") };
  const stop = installAppHeight(win, doc, { schedule: fn => { fn(); return 1; }, cancel: () => {} });
  assert.equal(props.get("--app-height"), "956px");
  win.innerWidth = 956; win.innerHeight = 420; // turned to landscape
  listeners["win:orientationchange"].forEach(fn => fn());
  assert.equal(props.get("--app-height"), "440px");
  win.navigator = { standalone: false };
  listeners["vv:resize"].forEach(fn => fn());
  assert.equal(props.has("--app-height"), false, "outside the home-screen app nothing is set");
  stop();
  assert.equal((listeners["win:resize"] || []).length + (listeners["vv:resize"] || []).length + (listeners["doc:focusout"] || []).length, 0);
});

test("the phone shell uses --app-height and the bar sits on the shell, not the viewport", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /installAppHeight\(window, document\)/);
  assert.match(app, /height: "var\(--app-height, 100dvh\)", maxWidth: 480, margin: "0 auto",\n\s+position: "fixed", top: 0, left: 0, right: 0,/);
  const bar = app.slice(app.indexOf("{/* ─── BOTTOM TAB BAR (phone only)"), app.indexOf("{tabItems.map("));
  assert.match(bar, /position: "absolute", bottom: 0, left: 0, right: 0,/);
  assert.doesNotMatch(bar, /position: "fixed"/);
});

// In real WebKit: a viewport 62 px short of a 956 px screen, as iOS leaves the
// home-screen app. The bar must end at the screen's bottom, not the viewport's.
let webkit = null;
try { ({ webkit } = await import("playwright-core")); } catch { webkit = null; }
const browserPath = (() => { try { return webkit?.executablePath(); } catch { return null; } })();
const skip = !browserPath || !existsSync(browserPath) ? "Playwright WebKit is not installed" : false;
test("real WebKit: with the viewport left short, the bar still ends at the bottom of the screen", { skip, timeout: 60000 }, async () => {
  const source = readFileSync(new URL("../src/utils/phoneViewport.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 440, height: 894 }, screen: { width: 440, height: 956 } });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <div id="shell" style="height: var(--app-height, 100dvh); max-width: 480px; margin: 0 auto; position: fixed; top: 0; left: 0; right: 0; overflow: hidden">
        <div style="height:100%; overflow-y:auto"><div style="height:3000px">content</div></div>
        <div id="bar" style="position:absolute; bottom:0; left:0; right:0; height:64px; transform: translate3d(0,0,0)">bar</div>
      </div><script>Object.defineProperty(navigator, "standalone", { get: () => true });\n${source}\ninstallAppHeight(window, document);</script></body></html>`);
    const out = await page.evaluate(() => ({
      inner: innerHeight, screen: screen.height, bar: document.getElementById("bar").getBoundingClientRect().bottom,
      scroll: document.documentElement.scrollHeight,
    }));
    assert.equal(out.inner, 894);
    assert.equal(out.screen, 956);
    assert.equal(out.bar, 956, "the bar ends at the screen's bottom, past the short viewport");
    assert.ok(out.scroll <= 894, "and the document has nothing to scroll");
  } finally { await browser.close(); }
});
