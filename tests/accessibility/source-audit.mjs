// The same accessibility rules as html-audit.mjs, read from the JSX source,
// so a control that only appears after a tap (an Add form, an edit row, a
// dialog) is held to them too. Not a test file itself.
//
//   - A button or link whose only content is an icon, an image without alt
//     text or a symbol ("×", "›", "🎤") needs an aria-label.
//   - An input, select or textarea needs a label: an aria-label, an
//     aria-labelledby, an id a <label htmlFor> names, a <label> around it, or
//     to be the field a <Field label> sits over (Field ties its label to the
//     one control inside it, through plain HTML wrappers only; a row with two
//     or more, or with a list it maps out, is a group and ties none).
//   - A choice chip (a button that sets a value and is drawn differently when
//     that value is the one chosen) says whether it is chosen: aria-pressed.
//   - role="dialog" comes with aria-modal and a name; role="switch" with aria-checked.
import * as espree from 'espree';

const CONTROLS = new Set(['input', 'select', 'textarea']);
const LETTER = /[\p{L}\p{N}]/u;

const jsxName = (n) => (n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${jsxName(n.object)}.${n.property.name}` : n.type === 'JSXNamespacedName' ? `${n.namespace.name}:${n.name.name}` : '?');
const attrs = (el) => el.openingElement.attributes;
const attr = (el, name) => attrs(el).find(a => a.type === 'JSXAttribute' && jsxName(a.name) === name);
const hasSpread = (el) => attrs(el).some(a => a.type === 'JSXSpreadAttribute');
/** An attribute's literal string value, `true` for a bare attribute, or the source of its expression. */
function attrValue(src, a) {
  if (!a) return undefined;
  if (!a.value) return true;
  if (a.value.type === 'Literal') return String(a.value.value);
  if (a.value.type === 'JSXExpressionContainer') {
    const e = a.value.expression;
    if (e.type === 'Literal') return String(e.value);
    return { expr: src.slice(e.range[0], e.range[1]) };
  }
  return undefined;
}
const isIntrinsic = (name) => /^[a-z]/.test(name);
const isHiddenStyle = (src, el) => { const s = attr(el, 'style'); return !!s && /display:\s*["']none["']/.test(src.slice(s.range[0], s.range[1])) && !/\?/.test(src.slice(s.range[0], s.range[1])); };

// What a child contributes to its parent's accessible name.
const merge = (list) => (list.includes('text') ? 'text' : list.includes('unknown') ? 'unknown' : list.includes('symbol') ? 'symbol' : 'none');
const ofString = (s) => (!String(s).trim() ? 'none' : LETTER.test(s) ? 'text' : 'symbol');
function ofExpression(e) {
  switch (e?.type) {
    case 'Literal': return e.value === null || typeof e.value === 'boolean' ? 'none' : ofString(e.value);
    case 'TemplateLiteral': return merge([...e.quasis.map(q => ofString(q.value.cooked || '')), ...(e.expressions.length ? ['unknown'] : [])]);
    // Either branch can be what is on screen, so the weaker one decides.
    case 'ConditionalExpression': { const both = [ofExpression(e.consequent), ofExpression(e.alternate)]; return both.includes('none') ? 'none' : both.includes('symbol') ? 'symbol' : merge(both); }
    case 'LogicalExpression': return e.operator === '&&' ? ofExpression(e.right) : merge([ofExpression(e.left), ofExpression(e.right)]);
    case 'JSXElement': return ofElement(e);
    case 'JSXFragment': return merge(e.children.map(ofChild));
    case 'JSXEmptyExpression': case undefined: return 'none';
    default: return 'unknown';
  }
}
function ofChild(c) {
  if (c.type === 'JSXText') return ofString(c.value);
  if (c.type === 'JSXExpressionContainer') return ofExpression(c.expression);
  if (c.type === 'JSXElement') return ofElement(c);
  if (c.type === 'JSXFragment') return merge(c.children.map(ofChild));
  return 'unknown';
}
function ofElement(el) {
  const name = jsxName(el.openingElement.name);
  const hidden = attr(el, 'aria-hidden');
  if (hidden && (!hidden.value || hidden.value.value === 'true' || hidden.value.expression?.value === true)) return 'none';
  if (attr(el, 'aria-label') || attr(el, 'aria-labelledby')) return 'text';
  if (name === 'svg') return 'none';
  if (name === 'img') { const alt = attr(el, 'alt'); return alt && !(alt.value?.type === 'Literal' && !alt.value.value) ? 'text' : 'none'; }
  // The app's icon components (BellIcon, CloseIcon...) draw an unlabelled svg.
  if (/Icon$/.test(name)) return 'none';
  if (!isIntrinsic(name)) return 'unknown';
  return merge(el.children.map(ofChild));
}

/**
 * What a button or link shows, ignoring its own aria-label: "text", "symbol"
 * (only characters like × › 🎤), "none" (only an icon or nothing) or
 * "unknown" (a value or component this reader cannot see into).
 */
export const visibleContent = (el) => merge(el.children.map(ofChild));

// The control a <Field> labels, the way Field.jsx decides it: walking its
// children through plain HTML wrappers and fragments, the row shows exactly
// one control and it is not an item of a list. A control inside a call (a
// .map(), a function that returns markup) or under a keyed element is a list
// item, and two or more controls make the row a group: then none is tied.
// Each way the row can render (every branch of every condition) is checked,
// and a control counts as tied only if it is the row's one control in every
// rendering it appears in. Where the source cannot tell, this reads stricter
// than the component, never looser.
const NOTHING = [{ controls: [], listed: false }];
const LIST = [{ controls: [], listed: true }];
function renderings(node) {
  if (!node) return NOTHING;
  switch (node.type) {
    case 'JSXText': case 'JSXEmptyExpression': case 'Literal': return NOTHING;
    case 'JSXFragment': return node.children.map(renderings).reduce(together, NOTHING);
    case 'JSXExpressionContainer': return renderings(node.expression);
    case 'LogicalExpression': return node.operator === '&&' ? [...NOTHING, ...renderings(node.right)] : [...renderings(node.left), ...renderings(node.right)];
    case 'ConditionalExpression': return [...renderings(node.consequent), ...renderings(node.alternate)];
    case 'JSXElement': {
      const name = jsxName(node.openingElement.name);
      if (!isIntrinsic(name) || name === 'button' || name === 'label') return NOTHING;
      if (attr(node, 'key')) return holdsControl(node) ? LIST : NOTHING;
      if (CONTROLS.has(name)) return attrValue('', attr(node, 'type')) === 'hidden' ? NOTHING : [{ controls: [node], listed: false }];
      return node.children.map(renderings).reduce(together, NOTHING);
    }
    default: return holdsControl(node) ? LIST : NOTHING;
  }
}
// Siblings render together: every pairing of their renderings, the same
// controls counted once. Past a few hundred, one rendering that ties nothing
// stands in for them all.
function together(a, b) {
  const out = new Map();
  for (const x of a) for (const y of b) {
    const r = { controls: [...x.controls, ...y.controls], listed: x.listed || y.listed };
    out.set(`${r.listed}:${r.controls.map(c => c.range[0]).join(',')}`, r);
  }
  return out.size > 256 ? LIST : [...out.values()];
}
function fieldTied(children, tied) {
  const alone = new Map();
  for (const r of children.map(renderings).reduce(together, NOTHING)) {
    for (const c of r.controls) alone.set(c, (alone.get(c) ?? true) && r.controls.length === 1 && !r.listed);
  }
  for (const [c, yes] of alone) if (yes) tied.add(c);
}

// Whether a control a Field could reach is anywhere under the node (through
// calls and callbacks too, but not into a component, a button or a <label>).
function holdsControl(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'JSXElement') {
    const name = jsxName(node.openingElement.name);
    if (!isIntrinsic(name) || name === 'button' || name === 'label') return false;
    if (CONTROLS.has(name)) return attrValue('', attr(node, 'type')) !== 'hidden';
    return node.children.some(holdsControl);
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v) ? v.some(holdsControl) : v && typeof v.type === 'string' && holdsControl(v)) return true;
  }
  return false;
}

// setX(v) in an onClick, and the element's style reading `x === v`: a chip for one choice.
function choiceChip(src, el) {
  const click = attr(el, 'onClick'); const style = attr(el, 'style');
  if (!click?.value || click.value.type !== 'JSXExpressionContainer' || !style) return false;
  const styleSrc = src.slice(style.range[0], style.range[1]).replace(/\s+/g, ' ');
  const clickSrc = src.slice(click.value.expression.range[0], click.value.expression.range[1]);
  for (const m of clickSrc.matchAll(/\bset([A-Z]\w*)\(\s*([^()=>]+?)\s*\)/g)) {
    const state = m[1][0].toLowerCase() + m[1].slice(1);
    const value = m[2].trim();
    if (!value || /^(true|false|null|undefined|!|\(|\[|\{)/.test(value)) continue;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc(state)}\\s*===\\s*${esc(value)}(?![\\w.])|(?<![\\w.])${esc(value)}\\s*===\\s*${esc(state)}\\b`).test(styleSrc)) return true;
  }
  return false;
}

/** Every problem in one source file, as "file:line  message" lines. */
export function auditSource(src, file) {
  let ast;
  try { ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true, loc: true }); } catch (e) { return [`${file}: does not parse (${e.message})`]; }
  const problems = [];
  const at = (node, msg) => problems.push(`${file}:${node.loc.start.line}  ${msg}`);
  // Every id a label or aria-labelledby points at, as literal text or expression source.
  const pointedAt = new Set();
  const tied = new Set();
  const all = [];
  const walk = (node, labels) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'JSXElement') {
      const name = jsxName(node.openingElement.name);
      all.push({ node, name, inLabel: labels > 0 });
      if (name === 'Field') fieldTied(node.children, tied);
      for (const a of attrs(node)) {
        if (a.type !== 'JSXAttribute' || !['htmlFor', 'aria-labelledby'].includes(jsxName(a.name))) continue;
        const v = attrValue(src, a);
        if (typeof v === 'string') v.split(/\s+/).forEach(id => pointedAt.add(id)); else if (v?.expr) pointedAt.add(v.expr);
      }
      for (const a of attrs(node)) walk(a, labels);
      node.children.forEach(c => walk(c, labels + (name === 'label' ? 1 : 0)));
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(c => walk(c, labels)); else if (v && typeof v.type === 'string') walk(v, labels);
    }
  };
  walk(ast, 0);
  for (const { node: el, name, inLabel } of all) {
    const role = attrValue(src, attr(el, 'role'));
    const named = attr(el, 'aria-label') || attr(el, 'aria-labelledby') || hasSpread(el);
    if (name === 'button' || name === 'a' || role === 'button') {
      const content = merge(el.children.map(ofChild));
      if (!named && (content === 'none' || content === 'symbol')) {
        at(el, `${name === 'a' ? 'link' : 'button'} with ${content === 'symbol' ? 'only a symbol' : 'only an icon'} and no aria-label${attr(el, 'title') ? ' (a title is not read as its name everywhere)' : ''}`);
      }
      if (name === 'button' && !attr(el, 'aria-pressed') && !attr(el, 'aria-checked') && !attr(el, 'aria-selected') && !attr(el, 'aria-current') && !attr(el, 'role') && choiceChip(src, el)) {
        at(el, 'choice button drawn as chosen without saying so: aria-pressed');
      }
    }
    if (CONTROLS.has(name)) {
      const type = attrValue(src, attr(el, 'type'));
      if (['hidden', 'button', 'submit', 'reset'].includes(type) || attr(el, 'hidden') || isHiddenStyle(src, el)) continue;
      if (named || inLabel || tied.has(el)) continue;
      const id = attrValue(src, attr(el, 'id'));
      if (typeof id === 'string' ? pointedAt.has(id) : id?.expr ? pointedAt.has(id.expr) : false) continue;
      at(el, `<${name}> with no label: give it an aria-label, or tie its visible label to it (htmlFor/id)`);
    }
    if (role === 'dialog' || role === 'alertdialog') {
      if (attrValue(src, attr(el, 'aria-modal')) !== 'true') at(el, 'dialog without aria-modal="true"');
      if (!attr(el, 'aria-label') && !attr(el, 'aria-labelledby')) at(el, 'dialog with no name');
    }
    if (role === 'switch' && !attr(el, 'aria-checked')) at(el, 'switch without aria-checked');
  }
  return problems;
}
