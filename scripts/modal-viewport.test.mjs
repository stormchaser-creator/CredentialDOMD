// Run: node scripts/modal-viewport.test.mjs
// Synthetic viewport/DOM events exercise the production controller. No auth,
// network, patient records, or real keyboard are involved. Browser geometry is
// checked separately with the actual Modal + WorkLog components.
import assert from "node:assert/strict";
import test from "node:test";
import { readModalViewport, revealModalField, watchModalViewport, lockModalDocument, fitModalScroll } from "../src/utils/modalViewport.js";

function events() {
  const handlers = new Map();
  return {
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    emit(name, event = {}) { for (const fn of handlers.get(name) || []) fn(event); },
    count() { return [...handlers.values()].reduce((n, set) => n + set.size, 0); },
  };
}
function style() {
  const values = new Map(), priorities = new Map();
  return new Proxy({
    setProperty(name, value, priority = "") { values.set(name, value); priorities.set(name, priority); },
    getPropertyValue(name) { return values.get(name) || ""; },
    getPropertyPriority(name) { return priorities.get(name) || ""; },
    removeProperty(name) { values.delete(name); priorities.delete(name); },
  }, {
    get(target, key) { return key in target ? target[key] : values.get(key) || ""; },
    set(_, key, value) { values.set(key, value); return true; },
  });
}
function fixture({ visualViewport = true, zoom = 1, topmost = true } = {}) {
  let nextId = 1;
  const frames = new Map(), timers = new Map();
  const win = Object.assign(events(), {
    innerHeight: 844, innerWidth: 390, scrollX: 0, scrollY: 0,
    requestAnimationFrame(fn) { const id = nextId++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn) { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    scrollTo() { throw new Error("focus/viewport handling must not scroll the page"); },
  });
  const vv = Object.assign(events(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0 });
  if (visualViewport) win.visualViewport = vv;
  const doc = { activeElement: null };
  const overlay = { style: style() };
  const fields = new Set();
  const body = { ...events(),
    ownerDocument: doc, scrollHeight: 1400, scrollTop: 0,
    contains(el) { return fields.has(el); },
    get clientHeight() { return Math.max(0, (parseFloat(overlay.style.height) - 32 - 140 * zoom) / zoom); },
    get offsetHeight() { return this.clientHeight; },
    getBoundingClientRect() {
      const top = parseFloat(overlay.style.top) + 16 + 70 * zoom;
      return { top, bottom: top + this.clientHeight * zoom, height: this.clientHeight * zoom };
    },
  };
  const field = (contentTop, height = 48) => {
    const el = {
      tagName: "INPUT",
      scrollIntoView() { throw new Error("scrollIntoView moves ancestor scroll containers"); },
      getBoundingClientRect() {
        const top = body.getBoundingClientRect().top + (contentTop - body.scrollTop) * zoom;
        return { top, bottom: top + height * zoom, height: height * zoom };
      },
    };
    fields.add(el);
    return el;
  };
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); };
  const flushTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); flush(); };
  const stop = watchModalViewport({ win, overlay, body, isTop: () => topmost });
  const focus = (el) => { doc.activeElement = el; body.emit("focusin", { target: el }); flush(); };
  const blur = () => { doc.activeElement = null; body.emit("focusout"); };
  const resize = (height, offsetTop = 0) => {
    vv.height = height; vv.offsetTop = offsetTop;
    if (visualViewport) vv.emit("resize"); else { win.innerHeight = height; win.emit("resize"); }
    flush();
  };
  return { win, vv, doc, overlay, body, field, focus, blur, resize, flush, flushTimers, stop, frames, timers };
}
function visible(f, field) {
  const bounds = f.body.getBoundingClientRect(), target = field.getBoundingClientRect();
  assert.ok(target.top >= bounds.top, `field top ${target.top} is above body ${bounds.top}`);
  assert.ok(target.bottom <= bounds.bottom, `field bottom ${target.bottom} is below body ${bounds.bottom}`);
}

test("keyboard opening reveals the time field locally and follows viewport panning", () => {
  const f = fixture();
  const input = f.field(470);
  f.focus(input);
  assert.equal(f.body.scrollTop, 0, "already visible fields must not be centered");
  f.resize(370, 145);
  assert.equal(f.overlay.style.top, "145px");
  assert.equal(f.overlay.style.height, "370px");
  visible(f, input);
  assert.ok(f.body.scrollTop > 0);
  f.stop();
});

test("scroll-only viewport events reposition the modal without pulling the form away from Save", () => {
  const f = fixture();
  f.focus(f.field(470));
  f.resize(370, 145);
  f.flushTimers();
  f.body.scrollTop = f.body.scrollHeight - f.body.clientHeight;
  const scrolled = f.body.scrollTop;
  f.vv.offsetTop = 188; f.vv.emit("scroll"); f.flush();
  assert.equal(f.overlay.style.top, "188px");
  assert.equal(f.body.scrollTop, scrolled);
  f.stop();
});

test("keyboard dismissal clears delayed focus scrolling and restores all viewport space", () => {
  const f = fixture();
  f.focus(f.field(900));
  f.resize(370, 145);
  f.body.scrollTop = f.body.scrollHeight - f.body.clientHeight;
  f.blur();
  // iOS can first expand the viewport, then report offsetTop returning to 0.
  f.resize(844, 70);
  f.vv.offsetTop = 0; f.vv.emit("scroll"); f.flush();
  f.flushTimers();
  assert.equal(f.overlay.style.top, "0px");
  assert.equal(f.overlay.style.height, "844px");
  assert.equal(f.body.scrollTop, f.body.scrollHeight - f.body.clientHeight);
  assert.equal(f.timers.size, 0);
  f.stop();
});

test("cleanup cancels pending keyboard callbacks and removes all listeners", () => {
  const f = fixture();
  f.focus(f.field(900));
  f.vv.emit("resize");
  const before = [f.overlay.style.top, f.overlay.style.height, f.body.scrollTop];
  f.stop(); f.vv.height = 270; f.vv.offsetTop = 160;
  f.flush(); f.flushTimers();
  assert.deepEqual([f.overlay.style.top, f.overlay.style.height, f.body.scrollTop], before);
  assert.equal(f.vv.count() + f.win.count() + f.body.count(), 0);
  assert.equal(f.frames.size + f.timers.size, 0);
});

test("a covered modal cannot react to a focused input", () => {
  const f = fixture({ topmost: false });
  f.focus(f.field(1000)); f.flushTimers(); f.resize(370, 145);
  assert.equal(f.body.scrollTop, 0);
  f.stop();
});

test("focus scrolling accounts for enlarged text and an oversized textarea", () => {
  const f = fixture({ zoom: 1.35 });
  const input = f.field(700);
  f.focus(input); f.resize(440, 80); visible(f, input);
  const textarea = f.field(400, 600);
  textarea.tagName = "TEXTAREA";
  f.focus(textarea);
  assert.ok(Math.abs(textarea.getBoundingClientRect().top - f.body.getBoundingClientRect().top - 8 * 1.35) < 0.01);
  f.stop();
});

test("outside fields cannot move the modal, and scrolling clamps at both ends", () => {
  const f = fixture();
  f.body.scrollTop = 40;
  revealModalField(f.body, { getBoundingClientRect() { throw new Error("not in this modal"); } });
  assert.equal(f.body.scrollTop, 40);
  revealModalField(f.body, f.field(0)); assert.equal(f.body.scrollTop, 0);
  revealModalField(f.body, f.field(2000)); assert.equal(f.body.scrollTop, f.body.scrollHeight - f.body.clientHeight);
  f.stop();
});

test("layout viewport resize remains supported without VisualViewport", () => {
  const f = fixture({ visualViewport: false });
  f.resize(600);
  assert.deepEqual(readModalViewport(f.win), { top: 0, left: 0, height: 600, width: 390 });
  assert.equal(f.overlay.style.height, "600px");
  f.stop();
});

test("nested modal scroll locks restore existing styles and page position only after the last close", () => {
  const body = { style: style() }, root = { style: style(), clientWidth: 1200 };
  body.style.setProperty("position", "relative", "important");
  root.style.setProperty("overflow", "clip");
  const doc = { body, documentElement: root }, restores = [];
  const win = { scrollX: 12, scrollY: 680, scrollTo: value => restores.push(value) };
  const closeFirst = lockModalDocument(win, doc), closeSecond = lockModalDocument(win, doc);
  assert.equal(body.style.top, "-680px");
  assert.equal(body.style.position, "fixed");
  closeFirst(); closeFirst();
  assert.equal(restores.length, 0);
  assert.equal(body.style.position, "fixed");
  closeSecond();
  assert.deepEqual(restores, [{ left: 12, top: 680, behavior: "instant" }]);
  assert.equal(body.style.position, "relative");
  assert.equal(body.style.getPropertyPriority("position"), "important");
  assert.equal(body.style.top, "");
  assert.equal(root.style.overflow, "clip");
});

test("the shared Modal renders action controls outside the scrolling form, including enlarged text", async () => {
  const [{ build }, fs, path, { fileURLToPath }, React, { renderToStaticMarkup }] = await Promise.all([
    import("esbuild"), import("node:fs"), import("node:path"), import("node:url"), import("react"), import("react-dom/server"),
  ]);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const temporary = path.join(here, `.modal-viewport-render-${process.pid}.tmp.mjs`);
  const bundled = await build({
    entryPoints: [path.join(here, "../src/components/shared/Modal.jsx")],
    bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"], logLevel: "silent",
    plugins: [{ name: "synthetic-app-context", setup(b) {
      b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: "app", namespace: "audit" }));
      b.onLoad({ filter: /^app$/, namespace: "audit" }, () => ({ loader: "js", contents:
        'export const useApp = () => ({theme: {}, isDesktop: false, data: {settings: {fontSize: "XXL"}}});',
      }));
    } }],
  });
  fs.writeFileSync(temporary, bundled.outputFiles[0].text);
  try {
    const { default: Modal } = await import(temporary);
    const markup = renderToStaticMarkup(React.createElement(Modal, {
      open: true, title: "Log past time", onClose() {},
      footer: React.createElement("button", null, "Save changes"),
    }, "FORM_CONTENT"));
    assert.match(markup, /data-modal-body=""[^>]*><div[^>]*>FORM_CONTENT<\/div><\/div><div data-modal-footer=""/);
    assert.match(markup, /data-modal-footer=""[^>]*flex-shrink:0[^>]*><button>Save changes<\/button>/);
    assert.match(markup, /zoom:1\.35/);
    assert.match(markup, /role="dialog"/);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
});


test("a very short viewport scrolls the whole dialog, then restores the form scroller on dismissal", () => {
  const body = { style: style(), scrollTop: 340, offsetHeight: 0 };
  const header = { offsetHeight: 65 }, footer = { offsetHeight: 79 };
  const card = {
    clientHeight: 139, scrollTop: 0, style: style(), children: [header, body, footer],
    setAttribute(name, value) { this[name] = value; },
  };
  let scroller = fitModalScroll(card, body);
  assert.equal(scroller, card, "the header/buttons cannot fit with a usable form at 220px and XXL text");
  assert.equal(card.style.overflowY, "auto");
  assert.equal(card.style.display, "block");
  assert.equal(body.style.overflowY, "visible", "the form must expand within the dialog, leaving one scroller");
  assert.equal(card.scrollTop, 340);
  assert.equal(body.scrollTop, 0);
  card.scrollTop = 700; // physician can reach the footer at the end of the card
  card.clientHeight = 601;
  scroller = fitModalScroll(card, body, scroller);
  assert.equal(scroller, body);
  assert.equal(card.style.display, "flex");
  assert.equal(card.style.overflowY, "hidden");
  assert.equal(body.style.overflowY, "auto");
  assert.equal(card.scrollTop, 0);
  assert.equal(body.scrollTop, 700, "scroll position survives the keyboard closing");
});
