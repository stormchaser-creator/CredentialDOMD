// The phone's 32 px tap-target floor, read from the JSX source so a control
// that only appears after a tap (an attachment's ×, an edit row's − and +, a
// notice's dismiss) is held to it too. Not a test file itself.
//
//   - A button whose only content is a symbol ("×", "✕", "‹", "−", "📎",
//     "🎤", "…") or an icon (StarIcon, TrashIcon, an svg) carries, in its own
//     inline style, a width or minWidth AND a height or minHeight of at least
//     32. Padding around a glyph is not a guarantee: the QA lab measured the
//     Favorites star at 35 x 31 (7 px by 9 px around a 17 px icon) and bare ×
//     buttons at 11 x 20.
//   - A text button with no vertical padding (the CSS reset makes a button
//     with no padding 0) carries a height or minHeight of at least 32.
//
// A button that only renders at desk width (under `isDesktop ? ... :`, or an
// `isDesktop && ...`) is the desk layout and is not read. The owner's Admin
// screens are held by one CSS rule (.cdomd-admin, phone-tap-targets.test.mjs)
// and their text buttons are not read here. Where the style cannot be read
// (a style from a prop, a function this reader cannot see into), a symbol
// button fails: this reads stricter than the page, never looser.
import * as espree from 'espree';
import * as actionButton from '../../src/components/shared/actionButton.js';
import { visibleContent } from './source-audit.mjs';

export const FLOOR = 32;

// Modules whose exports this reader uses as they are, by the specifier's tail.
const KNOWN_MODULES = [[/(^|\/)actionButton(\.js)?$/, actionButton]];
const UNKNOWN = Symbol('unknown');
const theme = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? `#${k}` : undefined) });
const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const MAX_VARIANTS = 64;

const jsxName = (n) => (n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${jsxName(n.object)}.${n.property.name}` : '?');
const attr = (el, name) => el.openingElement.attributes.find(a => a.type === 'JSXAttribute' && jsxName(a.name) === name);
const literalAttr = (el, name) => { const a = attr(el, name); return a?.value?.type === 'Literal' ? String(a.value.value) : a?.value?.expression?.type === 'Literal' ? String(a.value.expression.value) : undefined; };

/** true, false, or undefined when the source cannot say: how `expr` reads on a phone (isDesktop false). */
export function onPhone(expr) {
  if (!expr) return undefined;
  switch (expr.type) {
    case 'Identifier': return expr.name === 'isDesktop' ? false : undefined;
    case 'MemberExpression': return !expr.computed && expr.property.name === 'isDesktop' ? false : undefined;
    case 'UnaryExpression': { if (expr.operator !== '!') return undefined; const v = onPhone(expr.argument); return v === undefined ? undefined : !v; }
    case 'LogicalExpression': {
      const l = onPhone(expr.left), r = onPhone(expr.right);
      if (expr.operator === '&&') return l === false || r === false ? false : l === true && r === true ? true : undefined;
      if (expr.operator === '||') return l === true || r === true ? true : l === false && r === false ? false : undefined;
      return undefined;
    }
    default: return undefined;
  }
}

function parse(src) {
  const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true, loc: true });
  const parents = new Map();
  const buttons = [];
  const refs = new Map();
  const visit = (n, parent) => {
    if (!n || typeof n.type !== 'string') return;
    parents.set(n, parent);
    if (n.type === 'Identifier' && !(parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) && !(parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand)) {
      if (!refs.has(n.name)) refs.set(n.name, []);
      refs.get(n.name).push(n);
    }
    if (n.type === 'JSXElement') {
      const name = jsxName(n.openingElement.name);
      if (name === 'button' || literalAttr(n, 'role') === 'button') buttons.push(n);
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(c => visit(c, n)); else if (v && typeof v.type === 'string') visit(v, n);
    }
  };
  visit(ast, null);
  return { ast, parents, buttons, refs };
}

const bindsName = (pattern, name) => {
  if (!pattern) return false;
  switch (pattern.type) {
    case 'Identifier': return pattern.name === name;
    case 'AssignmentPattern': return bindsName(pattern.left, name);
    case 'RestElement': return bindsName(pattern.argument, name);
    case 'ArrayPattern': return pattern.elements.some(e => bindsName(e, name));
    case 'ObjectPattern': return pattern.properties.some(p => bindsName(p.type === 'RestElement' ? p : p.value, name));
    default: return false;
  }
};

/** What `name` is bound to where `at` sits: { init } for a const, { fn } for a function, { value } for a known import, or null. */
function lookup(ctx, at, name) {
  for (let n = at; n; n = ctx.parents.get(n)) {
    if (FUNCTION.has(n.type) && n.params.some(p => bindsName(p, name))) return null;
    const body = n.type === 'Program' || n.type === 'BlockStatement' ? n.body : null;
    if (!body) continue;
    for (let s of body) {
      if (s.type === 'ExportNamedDeclaration' && s.declaration) s = s.declaration;
      if (s.type === 'VariableDeclaration') {
        for (const d of s.declarations) {
          if (d.id.type === 'Identifier' && d.id.name === name) return { init: d.init };
          if (bindsName(d.id, name)) return null;
        }
      } else if (s.type === 'FunctionDeclaration' && s.id?.name === name) {
        return { fn: s };
      } else if (s.type === 'ImportDeclaration') {
        const spec = s.specifiers.find(x => x.local.name === name);
        if (!spec) continue;
        const mod = KNOWN_MODULES.find(([re]) => re.test(s.source.value))?.[1];
        if (!mod || spec.type !== 'ImportSpecifier') return null;
        const key = spec.imported.name;
        return key in mod ? { value: mod[key] } : null;
      }
    }
  }
  return null;
}

/** The possible values of an expression used as a style property: numbers, strings or UNKNOWN. */
function values(ctx, e, depth = 0) {
  if (!e || depth > 12) return [UNKNOWN];
  switch (e.type) {
    case 'Literal': return [typeof e.value === 'number' || typeof e.value === 'string' ? e.value : UNKNOWN];
    case 'Identifier': {
      const b = lookup(ctx, e, e.name);
      if (b?.init) return values(ctx, b.init, depth + 1);
      if (b && 'value' in b && (typeof b.value === 'number' || typeof b.value === 'string')) return [b.value];
      return [UNKNOWN];
    }
    case 'MemberExpression': {
      if (e.computed || e.property.type !== 'Identifier') return [UNKNOWN];
      return styles(ctx, e.object, depth + 1).map(v => (v === UNKNOWN || !(e.property.name in v) ? UNKNOWN : v[e.property.name]));
    }
    case 'ConditionalExpression': {
      const t = onPhone(e.test);
      if (t === true) return values(ctx, e.consequent, depth + 1);
      if (t === false) return values(ctx, e.alternate, depth + 1);
      return [...values(ctx, e.consequent, depth + 1), ...values(ctx, e.alternate, depth + 1)];
    }
    case 'BinaryExpression': {
      const out = [];
      for (const a of values(ctx, e.left, depth + 1)) for (const b of values(ctx, e.right, depth + 1)) {
        if (typeof a !== 'number' || typeof b !== 'number') { out.push(UNKNOWN); continue; }
        out.push({ '+': a + b, '-': a - b, '*': a * b, '/': a / b }[e.operator] ?? UNKNOWN);
      }
      return out;
    }
    default: return [UNKNOWN];
  }
}

/** A plain JS object from a known module, as one style variant. */
const fromValue = (v) => (v && typeof v === 'object' ? [{ ...v }] : [UNKNOWN]);

/** What a function returns, each return statement one possibility. */
function returned(fn) {
  if (fn.body.type !== 'BlockStatement') return [fn.body];
  const out = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string' || (n !== fn && FUNCTION.has(n.type))) return;
    if (n.type === 'ReturnStatement') { out.push(n.argument); return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(fn.body);
  return out;
}

/**
 * The inline style a `style={...}` expression can produce on a phone, as a
 * list of variants (one per way the conditions can go). A variant is an
 * object of property to value, or UNKNOWN where the source cannot say.
 */
export function styles(ctx, e, depth = 0) {
  if (depth > 12) return [UNKNOWN];
  if (!e) return [{}];
  switch (e.type) {
    case 'ObjectExpression': {
      let out = [{}];
      for (const p of e.properties) {
        let next = [];
        if (p.type === 'SpreadElement') {
          const add = styles(ctx, p.argument, depth + 1);
          for (const base of out) for (const v of add) next.push(base === UNKNOWN || v === UNKNOWN ? UNKNOWN : { ...base, ...v });
        } else {
          const key = p.computed ? null : p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
          if (key === null) { next = out.map(() => UNKNOWN); } else {
            const vals = values(ctx, p.value, depth + 1);
            for (const base of out) for (const v of vals) next.push(base === UNKNOWN ? UNKNOWN : { ...base, [key]: v });
          }
        }
        out = next.length > MAX_VARIANTS ? [UNKNOWN] : next;
      }
      return out;
    }
    case 'Literal': return e.value === null ? [{}] : [UNKNOWN];
    case 'Identifier': {
      if (e.name === 'undefined') return [{}];
      const b = lookup(ctx, e, e.name);
      if (b?.init) return styles(ctx, b.init, depth + 1);
      if (b && 'value' in b) return fromValue(b.value);
      return [UNKNOWN];
    }
    case 'MemberExpression': {
      if (e.computed || e.property.type !== 'Identifier') return [UNKNOWN];
      return styles(ctx, e.object, depth + 1).flatMap(v => {
        if (v === UNKNOWN) return [UNKNOWN];
        const inner = v[e.property.name];
        return inner && typeof inner === 'object' ? [inner] : [UNKNOWN];
      });
    }
    case 'ConditionalExpression': {
      const t = onPhone(e.test);
      if (t === true) return styles(ctx, e.consequent, depth + 1);
      if (t === false) return styles(ctx, e.alternate, depth + 1);
      return [...styles(ctx, e.consequent, depth + 1), ...styles(ctx, e.alternate, depth + 1)];
    }
    case 'LogicalExpression': {
      if (e.operator !== '&&') return [UNKNOWN];
      const t = onPhone(e.left);
      if (t === false) return [{}];
      if (t === true) return styles(ctx, e.right, depth + 1);
      return [{}, ...styles(ctx, e.right, depth + 1)];
    }
    case 'CallExpression': {
      if (e.callee.type !== 'Identifier') return [UNKNOWN];
      const b = lookup(ctx, e, e.callee.name);
      if (b && 'value' in b) {
        // A known module's style function, called the way a phone calls it.
        if (typeof b.value !== 'function') return [UNKNOWN];
        return fromValue(b.value(theme, { isDesktop: false }));
      }
      const fn = b?.fn || (b?.init && FUNCTION.has(b.init.type) ? b.init : null);
      if (!fn) return [UNKNOWN];
      const out = returned(fn).flatMap(r => styles(ctx, r, depth + 1));
      return out.length ? out : [UNKNOWN];
    }
    default: return [UNKNOWN];
  }
}

const px = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?(px)?$/.test(v.trim()) ? parseFloat(v) : 0);
const size = (s, a, b) => Math.max(px(s[a]), px(s[b]));
/** Top plus bottom padding in px from a variant, the CSS reset's 0 where none is set. */
function verticalPadding(s) {
  const sides = (v) => {
    if (typeof v === 'number') return [v, v];
    if (typeof v !== 'string') return v === undefined ? [0, 0] : [NaN, NaN];
    const p = v.trim().split(/\s+/).map(x => (/^0$|^\d+(\.\d+)?px$/.test(x) ? parseFloat(x) : NaN));
    return [p[0], p.length >= 3 ? p[2] : p[0]];
  };
  let [top, bottom] = sides(s.padding);
  if ('paddingBlock' in s) [top, bottom] = sides(s.paddingBlock);
  if ('paddingTop' in s) top = sides(s.paddingTop)[0];
  if ('paddingBottom' in s) bottom = sides(s.paddingBottom)[0];
  return top + bottom;
}

// Whether `node` never renders on a phone: it sits in the desk branch of an
// isDesktop condition, or inside a named function (renderDeskTables) whose
// every use sits in one.
function deskOnly(ctx, node, depth = 0) {
  if (depth > 6) return false;
  for (let child = node, n = ctx.parents.get(node); n; child = n, n = ctx.parents.get(n)) {
    if (n.type === 'ConditionalExpression') {
      const t = onPhone(n.test);
      if ((child === n.consequent && t === false) || (child === n.alternate && t === true)) return true;
    }
    if (n.type === 'LogicalExpression' && n.operator === '&&' && child === n.right && onPhone(n.left) === false) return true;
    if (FUNCTION.has(n.type)) {
      const holder = ctx.parents.get(n);
      const id = n.type === 'FunctionDeclaration' ? n.id : holder?.type === 'VariableDeclarator' && holder.init === n ? holder.id : null;
      if (id?.type !== 'Identifier') continue;
      const uses = (ctx.refs.get(id.name) || []).filter(r => r !== id);
      if (uses.length && uses.every(r => deskOnly(ctx, r, depth + 1))) return true;
    }
  }
  return false;
}

/**
 * Every button in one source file under the phone floor, as
 * "file:line  message" lines. `kinds` picks the rules: "symbol" (symbol-
 * and icon-only buttons) and "text" (text buttons with no vertical padding).
 */
export function auditTapTargets(src, file, { kinds = ['symbol', 'text'] } = {}) {
  let ctx;
  try { ctx = parse(src); } catch (e) { return [`${file}: does not parse (${e.message})`]; }
  const problems = [];
  const adminScreen = /(^|\/)Admin[A-Z]\w*\.jsx$/.test(file);
  for (const el of ctx.buttons) {
    if (deskOnly(ctx, el)) continue;
    const content = visibleContent(el);
    const symbol = content === 'symbol' || content === 'none';
    const kind = symbol ? 'symbol' : 'text';
    if (!kinds.includes(kind) || (kind === 'text' && adminScreen)) continue;
    const styleAttr = attr(el, 'style');
    const variants = styleAttr ? (styleAttr.value?.type === 'JSXExpressionContainer' ? styles(ctx, styleAttr.value.expression) : [UNKNOWN]) : [{}];
    const where = `${file}:${el.loc.start.line}`;
    const what = symbol ? `${content === 'symbol' ? 'symbol' : 'icon'}-only button` : 'text button';
    for (const s of variants) {
      if (s === UNKNOWN) {
        if (symbol) problems.push(`${where}  ${what}: its style cannot be read here, so its ${FLOOR} x ${FLOOR} floor cannot be seen (give it minWidth/minHeight inline)`);
        continue;
      }
      const w = size(s, 'minWidth', 'width'), h = size(s, 'minHeight', 'height');
      if (symbol && (w < FLOOR || h < FLOOR)) {
        problems.push(`${where}  ${what} is not held to ${FLOOR} x ${FLOOR}: minWidth/width ${w || 'none'}, minHeight/height ${h || 'none'}`);
        break;
      }
      if (!symbol && h < FLOOR && verticalPadding(s) === 0) {
        problems.push(`${where}  text button with no vertical padding and no minHeight of ${FLOOR} (height ${h || 'none'})`);
        break;
      }
    }
  }
  return problems;
}

/** Whether every <name ...> element in `src` renders only at desk width (and there is at least one). */
export function rendersOnlyAtDesk(src, name) {
  const ctx = parse(src);
  const found = [];
  for (const [n] of ctx.parents) if (n.type === 'JSXElement' && jsxName(n.openingElement.name) === name) found.push(n);
  return found.length > 0 && found.every(el => deskOnly(ctx, el));
}
