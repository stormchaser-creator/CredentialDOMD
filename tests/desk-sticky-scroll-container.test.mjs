// SETTINGS-013: at desk width the top bar (Back, bell, theme), the
// Credentials rail and every desk table header are position: sticky inside
// <div class="cmd-content-area"> (App.jsx). That div had overflow-x: hidden.
// CSS computes the other axis of a hidden/visible pair to auto, so the div
// became a scroll container that never scrolls (it grows with its content;
// the document scrolls). A sticky element binds to its nearest scroll
// container, so all three scrolled off with the page: the QA lab measured the
// bar at -648 to -900px after scrolling a long Licenses table.
//
// The rule: nothing between the document and those sticky elements may be a
// scroll container. overflow-x: clip cuts sideways overflow without making
// one, which is how #root and body were already fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = (await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** Top-level rules only ({ selectors, decls }), and the @media blocks' rules with their condition. */
function rules(text) {
  const out = [];
  let i = 0, media = null, depth = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i), close = text.indexOf('}', i);
    if (open < 0 && close < 0) break;
    if (close >= 0 && (open < 0 || close < open)) { if (depth > 0) { depth -= 1; media = null; } i = close + 1; continue; }
    const head = text.slice(i, open).trim();
    if (head.startsWith('@media') || head.startsWith('@supports')) { media = head; depth += 1; i = open + 1; continue; }
    const end = text.indexOf('}', open);
    const decls = text.slice(open + 1, end).split(';').map(d => d.trim()).filter(Boolean).map(d => { const at = d.indexOf(':'); return [d.slice(0, at).trim(), d.slice(at + 1).trim()]; });
    out.push({ selectors: head.split(',').map(s => s.trim()), decls, media });
    i = end + 1;
  }
  return out;
}

// The elements that hold the sticky bar, rail and table headers at desk width.
// html is left out: overflow on the root element belongs to the viewport.
const ANCESTORS = ['#root', 'body', '.cmd-content-area'];
const SCROLLS = /^(hidden|auto|scroll|overlay)$/;

test('the desk shell wraps the sticky top bar in .cmd-content-area', () => {
  assert.match(app, /className="cmd-content-area">\{shellBody\}/);
  assert.match(app, /position: "sticky", top: 0, zIndex: 50/, 'the top bar is sticky');
});

for (const selector of ANCESTORS) {
  test(`${selector} is never a scroll container, so sticky headers stick to the page`, () => {
    const mine = rules(css).filter(r => r.selectors.includes(selector));
    assert.ok(mine.length, `${selector} has a rule in base.css`);
    for (const { decls, media } of mine) {
      const overflowX = decls.filter(([p]) => p === 'overflow-x').map(([, v]) => v);
      // A browser without clip reads the hidden line first; one with clip
      // takes the later declaration, which must be clip.
      if (overflowX.length) assert.equal(overflowX.at(-1), 'clip', `${selector}${media ? ` in ${media}` : ''}: overflow-x ends ${overflowX.at(-1)}`);
      for (const [p, v] of decls) {
        if (p === 'overflow' || p === 'overflow-y') assert.doesNotMatch(v, SCROLLS, `${selector}: ${p}: ${v} makes a scroll container`);
      }
    }
  });
}

test('the check itself catches the old rule', () => {
  const old = rules('.cmd-content-area { flex: 1; overflow-x: hidden; }')[0];
  const overflowX = old.decls.filter(([p]) => p === 'overflow-x').map(([, v]) => v);
  assert.notEqual(overflowX.at(-1), 'clip');
});
