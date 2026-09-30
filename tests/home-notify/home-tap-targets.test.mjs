// HOME-001, HOME-003, HOME-004: controls on Home and the top bar were drawn
// at the height of their text line, below the 32 px the phone audit asks
// (Apple asks 44): the top bar's Back (60 x 20), the Setup card's "Not now"
// (48 x 15) and "Open setup" (82 x 16), the banner's Snooze (56 x 18), the
// rows under the ring (16), Follow up and Acknowledge (26), the acknowledged
// toggle (29), View All and Find CME (16), and the search field, a 20 px
// input inside a 42 px box whose padding did not focus it.
//
// Read from the JSX source: each control's own style must carry a minHeight
// of at least 32 (44 for Back), so the tap target no longer depends on the
// font size. The layouts are otherwise unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const root = fileURLToPath(new URL('../..', import.meta.url));

function parse(file) {
  const src = readFileSync(`${root}${file}`, 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true, loc: true });
  const elements = [], consts = new Map();
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'JSXElement') elements.push(n);
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init?.type === 'ObjectExpression' && !consts.has(n.id.name)) consts.set(n.id.name, n.init);
    for (const [k, v] of Object.entries(n)) {
      if (k === 'loc' || k === 'range') continue;
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast);
  const name = (el) => el.openingElement.name.name;
  const attr = (el, key) => el.openingElement.attributes.find(a => a.type === 'JSXAttribute' && a.name.name === key);
  const text = (n) => {
    if (!n) return '';
    if (n.type === 'JSXText') return n.value;
    if (n.type === 'Literal') return typeof n.value === 'string' ? n.value : '';
    if (n.type === 'TemplateLiteral') return n.quasis.map(q => q.value.cooked).join('');
    if (n.type === 'JSXExpressionContainer') return text(n.expression);
    if (n.type === 'ConditionalExpression') return `${text(n.consequent)}${text(n.alternate)}`;
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') return n.children.map(text).join('');
    return '';
  };
  /** The style object's properties, spreads and a named const resolved. */
  const styleProps = (el) => {
    const a = attr(el, 'style');
    let obj = a?.value?.type === 'JSXExpressionContainer' ? a.value.expression : null;
    if (obj?.type === 'Identifier') obj = consts.get(obj.name);
    const out = {};
    const take = (o) => {
      for (const p of o?.properties || []) {
        if (p.type === 'SpreadElement' && p.argument.type === 'Identifier') take(consts.get(p.argument.name));
        else if (p.type === 'Property' && p.key.type === 'Identifier') out[p.key.name] = p.value.type === 'Literal' ? p.value.value : src.slice(...p.value.range);
      }
    };
    take(obj);
    return out;
  };
  const opening = (el) => src.slice(...el.openingElement.range);
  return { elements, name, attr, text: (el) => text(el).replace(/\s+/g, ' ').trim(), styleProps, opening };
}

/** Every element in `file` the predicate picks: at least `expect` of them, each with style.minHeight >= min. */
function assertTall(file, what, pick, { min = 32, expect = 1 } = {}) {
  const f = parse(file);
  const hits = f.elements.filter(el => pick(el, f));
  assert.ok(hits.length >= expect, `${file}: ${what} found (${hits.length})`);
  for (const el of hits) {
    const h = f.styleProps(el).minHeight;
    assert.ok(typeof h === 'number' && h >= min, `${file}:${el.loc.start.line} ${what} has minHeight ${h}, needs ${min}`);
  }
}

const button = (label) => (el, f) => f.name(el) === 'button' && f.text(el) === label;
const buttonStarting = (label) => (el, f) => f.name(el) === 'button' && f.text(el).startsWith(label);
const buttonCalling = (code) => (el, f) => f.name(el) === 'button' && f.opening(el).includes(code);

test('HOME-004: the top bar\'s Back is 44 px tall', () => {
  assertTall('src/App.jsx', 'Back', button('Back'), { min: 44 });
});

test('HOME-001: the Setup card\'s "Not now" and "Open setup" are at least 32 px', () => {
  assertTall('src/components/features/SetupCard.jsx', 'Not now', button('Not now'));
  assertTall('src/components/features/SetupCard.jsx', 'Open setup', buttonStarting('Open setup'));
});

test('HOME-003: the banner, the ring rows, Action Required, the widgets and Find CME are at least 32 px', () => {
  assertTall('src/components/pages/NotificationBanner.jsx', 'Snooze', button('Snooze'));
  assertTall('src/components/pages/NotificationBanner.jsx', 'View', button('View'));
  assertTall('src/App.jsx', 'a needs-action row under the ring', buttonCalling('onClick={go}'));
  assertTall('src/App.jsx', 'Follow up', button('Follow up'));
  assertTall('src/App.jsx', 'Acknowledge on an Action Required card', buttonCalling('openAck(item)'));
  assertTall('src/App.jsx', 'the acknowledged list toggle', buttonCalling('setShowSnoozed'));
  assertTall('src/App.jsx', 'Wake', button('Wake'));
  assertTall('src/App.jsx', 'View All', button('View All'), { expect: 2 });
  assertTall('src/App.jsx', 'Find CME', buttonStarting('Find CME'), { expect: 3 });
  assertTall('src/App.jsx', 'Renewal packet', (el, f) => f.name(el) === 'button' && f.text(el).includes('Renewal packet'));
  assertTall('src/App.jsx', 'Review on the request banner', (el, f) => f.name(el) === 'button' && f.opening(el).includes('style={linkStyle}'));
});

test('HOME-003: the search field is its box\'s full height, and Clear is 32 px', () => {
  const file = 'src/components/features/HomeSearch.jsx';
  assertTall(file, 'the search input', (el, f) => f.name(el) === 'input' && f.attr(el, 'aria-label')?.value?.value === 'Search everything, or ask Vera');
  assertTall(file, 'Clear search', (el, f) => f.name(el) === 'button' && f.attr(el, 'aria-label')?.value?.value === 'Clear search');
  // The box's own padding is horizontal only: the vertical space is the input's, so a tap on it focuses the field.
  const f = parse(file);
  const box = f.elements.find(el => el.children.some(c => c.type === 'JSXElement' && f.name(c) === 'input'));
  assert.match(String(f.styleProps(box).padding), /^0 /, 'no vertical padding on the box around the input');
  assert.match(String(f.styleProps(f.elements.find(el => f.name(el) === 'input')).padding), /^10px 0$/);
});
