// SETTINGS-013 follow-up: once .cmd-content-area stopped being a scroll
// container (desk-sticky-scroll-container.test.mjs), the Credentials rail and
// the Setup task rail really stuck under the top bar. Neither had a height
// limit. The Credentials rail (a Setup button, seven groups, 21 sections and
// more with custom categories) is about 1,050px at text size M and taller at
// XXL; a 1280x800 laptop shows about 730px of it. Stuck at the top, its lower
// sections (Peer References, Answer Bank, Protected Identity, New category)
// sat below the fold and could not be reached until the page's last screen.
//
// Now each rail is at most the window below the bar and scrolls on its own.
// Its height is a viewport length inside the text-size zoom, which Chromium
// scales by the zoom (100vh at XXL renders as 135% of the window), so the
// shell publishes the window's height already divided by the zoom, as it
// does the bar's. The CSS is evaluated here by hand at every text size.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deskRailStyle, deskStickyVars, DESK_TOP_BAR_H, DESK_RAIL_GAP } from '../src/components/shared/deskSticky.js';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const setup = await readFile(new URL('../src/components/features/SetupPage.jsx', import.meta.url), 'utf8');
const FONT_ZOOM = Function(`return (${/const FONT_ZOOM = (\{[^}]+\});/.exec(app)[1]})`)();

/**
 * A length as the browser draws it, in window px: `css` (px, svh/vh, calc,
 * var() with fallback) resolved against `vars`, inside a subtree zoomed by
 * `zoom` on a window `height` px tall. Every length, viewport ones included,
 * is scaled by the zoom (Chromium 128 and later, checked in Chromium 153).
 */
function drawn(css, { vars = {}, zoom = 1, height }) {
  let text = String(css);
  for (let guard = 0; /var\(/.test(text); guard++) {
    assert.ok(guard < 10, `unresolved var() in ${css}`);
    text = text.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fallback) => {
      if (vars[name] != null) return vars[name];
      assert.ok(fallback != null, `${name} has no value and no fallback`);
      return fallback.trim();
    });
  }
  const expr = text.replace(/^calc\(/, '(')
    .replace(/(-?\d*\.?\d+)s?vh/g, (_, n) => `(${n} * ${height} / 100)`)
    .replace(/(-?\d*\.?\d+)px/g, (_, n) => `(${n})`);
  assert.match(expr, /^[\d\s.()+\-*/]+$/, `only arithmetic left in ${expr}`);
  return Function(`return ${expr}`)() * zoom;
}

test('a desk rail sticks under the bar, is never taller than the window below it, and scrolls on its own', () => {
  const rail = deskRailStyle(240);
  assert.equal(rail.position, 'sticky');
  assert.ok(rail.maxHeight, 'the rail has a height limit (it had none)');
  assert.match(rail.maxHeight, /var\(--desk-viewport-h/, 'the limit is the window height the shell publishes');
  assert.equal(rail.overflowY, 'auto', 'what does not fit scrolls inside the rail');
  assert.equal(rail.overscrollBehavior, 'contain');
  // The ring room given back: the rail still takes 240px beside the section.
  assert.equal(rail.width + 2 * rail.margin, 240);
});

for (const height of [700, 800, 900]) {
  for (const [size, zoom] of Object.entries(FONT_ZOOM)) {
    test(`${height}px window at text size ${size}: the stuck rail runs from under the bar to just above the window's foot`, () => {
      const at = { vars: deskStickyVars(zoom), zoom, height };
      const rail = deskRailStyle(240);
      const top = drawn(rail.top, at), limit = drawn(rail.maxHeight, at);
      assert.ok(Math.abs(top - (DESK_TOP_BAR_H + DESK_RAIL_GAP * zoom)) < 0.1, `top ${top}`);
      // Its border box ends DESK_RAIL_GAP (zoomed) above the window's foot,
      // so its last section can always be scrolled into view.
      assert.ok(Math.abs(top + limit - (height - DESK_RAIL_GAP * zoom)) < 0.1, `bottom ${top + limit} of ${height}`);
      assert.ok(top + limit <= height);
      // Without the zoom divided out the rail would run past the window at L and up.
      if (zoom > 1) {
        const undivided = drawn(rail.maxHeight, { vars: { '--desk-sticky-top': at.vars['--desk-sticky-top'], '--desk-viewport-h': '100svh' }, zoom, height });
        assert.ok(top + undivided > height, 'the check can tell a limit the zoom was not divided out of');
      }
    });
  }
}

test('the shell publishes the window height to the zoomed content, and both rails use the shared style', () => {
  assert.match(app, /const stickyVars = deskStickyVars\(fontZoom\);/);
  assert.match(app, /isDesktop \? \{ zoom: fontZoom, \.\.\.stickyVars \}/, 'the zoomed content wrapper carries the variables');
  assert.match(app, /<nav style=\{\{ \.\.\.deskRailStyle\(240\), display: "flex"/, 'the Credentials rail');
  assert.match(setup, /<div style=\{deskRailStyle\(300\)\}>/, 'the Setup task rail');
  // No rail sticks under the bar some other way (the old hand-written ones).
  for (const [name, src] of [['App.jsx', app], ['SetupPage.jsx', setup]]) {
    assert.doesNotMatch(src, /position: "sticky", top: (72|"calc\(var\(--desk-sticky-top)/, `${name} has a sticky rail without a height limit`);
  }
});
