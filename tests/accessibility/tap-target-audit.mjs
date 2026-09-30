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
//   - Every other control a finger taps (a text button, a link, a <summary>,
//     an element with role=button) is at least 32 px tall, and at least 32 px
//     wide where its words are written out, as the browser lays it out: its
//     own min-height / height, or one line of its words in Inter plus its
//     padding and border. Small padding is not a floor either: the Requests
//     screen's underlined links were 6 px above and below 13 px text, 28 px.
//
// The box model, measured against Chromium at 375 px with the app's base.css:
//   - A <button> takes the browser's own button font (13.33 px) and "normal"
//     line-height, Inter's 1.21, unless its style sets them; `font: inherit`
//     takes both from around it.
//   - Anything else takes its font size and line-height from the nearest
//     element around it in the same file that sets them. Past a component
//     boundary or the top of the file this reads 12 px text at 1.2, small on
//     purpose: a control that only clears the floor at a larger inherited
//     size carries a floor of its own.
//   - A plain inline <a> is as tall as its glyphs (1.21 x its size) plus its
//     padding, and takes no min-height. Its padding below lies over the
//     sentence's next line, which the browser hits first, so it only counts
//     when the link is positioned (inlineLinkTap in actionButton.js).
//   - A flex or grid item is a block whatever its display says. A block
//     control (a row, a disclosure) or one at a % width or flex: 1 is as wide
//     as its row; a label that is a value ({label}) is not measured across.
//   - Where the style cannot be read (a spread of a prop, a function this
//     reader cannot see into), only what is set after it counts.
// This reads stricter than the page, never looser.
//
// A control that only renders at desk width (under `isDesktop ? ... :`, or an
// `isDesktop && ...`) is the desk layout and is not read; `isDesktop` reads
// false everywhere else, so `minHeight: isDesktop ? undefined : TAP_MIN` is a
// floor. The owner's Admin screens are held by one CSS rule (.cdomd-admin,
// phone-tap-targets.test.mjs) and their buttons, rows and disclosures are not
// read here; their links are.
import * as espree from 'espree';
import * as actionButton from '../../src/components/shared/actionButton.js';
import * as adminViewBanner from '../../src/components/shared/adminViewBanner.js';
import { visibleContent } from './source-audit.mjs';

export const FLOOR = 32;

// Modules whose exports this reader uses as they are, by the specifier's tail.
const KNOWN_MODULES = [[/(^|\/)actionButton(\.js)?$/, actionButton], [/(^|\/)adminViewBanner(\.js)?$/, adminViewBanner]];
const UNKNOWN = Symbol('unknown');
const HOLE = '\u0000';
// A style object with a part this reader cannot see (a spread of a prop):
// only the properties set after that part are known.
const PARTIAL = Symbol('partial');
const theme = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? `#${k}` : undefined) });
const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const MAX_VARIANTS = 64;
// Roles that make any element a control a finger taps.
const ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'switch', 'checkbox']);

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
      if (name === 'button' || ROLES.has(literalAttr(n, 'role')) || (name === 'a' && attr(n, 'href')) || name === 'summary') buttons.push(n);
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
    case 'TemplateLiteral': {
      // `1px solid ${T.border}`: the literal parts, each expression a placeholder no length reads.
      if (e.expressions.length > 4) return [UNKNOWN];
      return [e.quasis.map(q => q.value.cooked ?? '').join(HOLE)];
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
          // A spread this reader cannot see into may set any property, so
          // what came before it is lost; what comes after it is still read.
          const add = styles(ctx, p.argument, depth + 1);
          for (const base of out) for (const v of add) next.push(v === UNKNOWN ? { [PARTIAL]: true } : v[PARTIAL] ? { ...v } : { ...base, ...v });
        } else {
          const key = p.computed ? null : p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
          if (key === null) { next = out.map(() => ({ [PARTIAL]: true })); } else {
            const vals = values(ctx, p.value, depth + 1);
            for (const base of out) for (const v of vals) next.push({ ...base, [key]: v });
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
const round = (n) => Math.round(n * 10) / 10;
const known = (s, k) => k in s || !s[PARTIAL];
/** One CSS length ("6px", 6, "0") in px, NaN where it cannot be read. */
const len = (x) => (typeof x === 'number' ? x : typeof x === 'string' && /^-?\d+(\.\d+)?(px)?$/.test(x.trim()) ? parseFloat(x) : NaN);
/** A CSS length list ("6px 0", 5, "0 12px 4px") as [top, right, bottom, left] px; NaN where a part cannot be read. */
function sides(v) {
  if (v === undefined) return [0, 0, 0, 0];
  const p = typeof v === 'number' ? [v] : typeof v === 'string' ? v.trim().split(/\s+/).map(len) : [NaN];
  const [t, r = t, b = t, l = r] = p;
  return [t, r, b, l];
}
/** paddingBlock / paddingInline ("6px", "4px 8px") as [start, end]. */
const pair = (v) => { const p = typeof v === 'string' ? v.trim().split(/\s+/).map(len) : [len(v)]; return [p[0], p[1] ?? p[0]]; };
/** A variant's padding on each side, the CSS reset's 0 where none is set; NaN where it cannot be read. */
function padding(s) {
  if (!known(s, 'padding')) return [NaN, NaN, NaN, NaN];
  const [t, r, b, l] = sides(s.padding);
  const out = { t, r, b, l };
  if ('paddingBlock' in s) [out.t, out.b] = pair(s.paddingBlock);
  if ('paddingInline' in s) [out.l, out.r] = pair(s.paddingInline);
  for (const [k, side] of [['paddingTop', 't'], ['paddingRight', 'r'], ['paddingBottom', 'b'], ['paddingLeft', 'l']]) if (k in s) out[side] = len(s[k]);
  return [out.t, out.r, out.b, out.l];
}
/** A border's width from `border`/`borderTop`...: "none" and 0 are 0, "1px solid ..." is 1; NaN where it cannot be read. */
const borderWidth = (v) => (v === undefined || v === 0 || v === 'none' || v === '0' ? 0 : typeof v === 'string' && /^\d+(\.\d+)?px\b/.test(v.trim()) ? parseFloat(v) : NaN);
function border(s) {
  // No border property: 0 here (the reset leaves a button the browser's 2 px; a
  // reader that cannot see a border does not count one).
  const all = borderWidth(s.border);
  const side = (k) => (k in s ? borderWidth(s[k]) : all);
  const w = 'borderWidth' in s ? sides(s.borderWidth) : null;
  const pick = (i, k) => (k in s ? side(k) : w ? w[i] : all);
  return [pick(0, 'borderTop'), pick(1, 'borderRight'), pick(2, 'borderBottom'), pick(3, 'borderLeft')].map(x => (Number.isNaN(x) ? 0 : x));
}

// Inter's advance widths (base.css; public/fonts), in thousandths of the font
// size, for the printable ASCII characters from the space on, at 400 and 700
// (500 and 600 lie between). Measured in Chromium. Kerning pulls a word in by
// up to a percent or so ("Review in full": 6,498 apart, 6,455 set), so a word
// reads 2% narrower than its letters add up to.
const ADVANCE = {
  400: [281,288,466,633,642,982,644,300,365,365,501,662,288,460,288,360,631,407,610,618,646,593,620,566,619,620,288,302,662,662,662,511,966,690,654,730,722,601,590,746,743,269,571,672,565,903,753,765,639,765,644,642,646,744,690,985,682,679,629,365,360,365,471,456,323,562,612,571,612,583,370,613,591,242,242,549,242,876,591,600,612,612,376,528,327,591,562,818,546,562,552,426,333,426,662],
  700: [237,338,552,649,655,1016,672,339,377,377,559,679,334,468,334,388,674,431,630,646,676,622,649,582,651,649,334,343,679,679,679,560,1016,747,662,740,722,607,587,750,747,281,584,719,565,932,762,771,648,777,657,655,667,732,747,1038,738,731,664,377,388,377,487,476,365,581,630,588,630,596,398,632,623,271,271,580,271,913,623,613,630,630,407,560,366,623,600,850,580,602,573,469,372,469,679],
};
/** The width of one line of `text` in Inter at `size` px and `weight`. */
function textWidth(text, size, weight) {
  const w = Math.min(Math.max(Number(weight) || 400, 400), 700);
  const f = (w - 400) / 300;
  let sum = 0;
  for (const ch of text) {
    const i = ch.charCodeAt(0) - 32;
    // Outside printable ASCII (an arrow, an accented letter): the narrowest letter.
    const at = (row) => (i >= 0 && i < row.length && ch.length === 1 ? row[i] : 242);
    sum += at(ADVANCE[400]) * (1 - f) + at(ADVANCE[700]) * f;
  }
  return (sum / 1000) * size * 0.98;
}

// Inter's "normal" line-height (ascent 0.96875 + descent 0.2421875 of the
// font size): a <button>'s, which the browser's own button font resets to
// it, and the height of an inline link's glyph box whatever its line-height.
const NORMAL_LINE = 1.21;
// The browser's own button font (base.css sets only the family on a button).
const BUTTON_FONT = { size: 13.333, line: NORMAL_LINE, weight: 400 };
// A size, line-height or weight inherited from outside what this file shows
// (a component's own wrapper, the app shell): read small, so a control that
// only clears the floor at a bigger inherited size carries its own floor.
const INHERITED_FONT = { size: 12, line: 1.2, weight: 400 };
const INHERIT = Symbol('inherit');

/** Font size, line-height (a multiple of the size, or { px }) and weight a variant sets itself: a value, INHERIT, or undefined. */
function ownFont(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'font') {
      if (v === 'inherit') { out.size = out.line = out.weight = INHERIT; continue; }
      const m = typeof v === 'string' && v.match(/(?:^|\s)(\d+(?:\.\d+)?)px(?:\s*\/\s*(\d+(?:\.\d+)?)(px)?)?/);
      if (!m) { out.size = out.line = out.weight = undefined; out.unread = true; continue; }
      out.size = +m[1];
      out.line = m[2] ? (m[3] ? { px: +m[2] } : +m[2]) : NORMAL_LINE;
      out.weight = /\b(bold|[5-9]00)\b/.test(v) ? (v.match(/\b([5-9]00)\b/)?.[1] ?? 700) : 400;
    } else if (k === 'fontSize') {
      out.size = v === 'inherit' ? INHERIT : len(v);
    } else if (k === 'lineHeight') {
      out.line = v === 'inherit' ? INHERIT : v === 'normal' ? NORMAL_LINE : typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? +v : typeof v === 'string' && /^\d+(\.\d+)?px$/.test(v) ? { px: parseFloat(v) } : NaN;
    } else if (k === 'fontWeight') {
      out.weight = v === 'inherit' ? INHERIT : v === 'bold' ? 700 : Number(v) || 400;
    }
  }
  return out;
}

/** The first style the nearest intrinsic element around `el` in this file gives `prop` (the smallest across its variants), or undefined. */
function inherited(ctx, el, prop) {
  for (let n = ctx.parents.get(el); n; n = ctx.parents.get(n)) {
    if (n.type !== 'JSXElement') continue;
    // A component draws its own wrapper around what it is given.
    if (!/^[a-z]/.test(jsxName(n.openingElement.name))) return undefined;
    const a = attr(n, 'style');
    if (!a) continue;
    const found = (a.value?.type === 'JSXExpressionContainer' ? styles(ctx, a.value.expression) : [UNKNOWN])
      .map(v => (v === UNKNOWN ? undefined : ownFont(v)[prop]))
      .filter(v => v !== undefined && v !== INHERIT && !Number.isNaN(v));
    if (found.length) return found.sort((x, y) => (typeof x === 'object' ? x.px : x) - (typeof y === 'object' ? y.px : y))[0];
  }
  return undefined;
}

/** The size, line-height in px and weight a control's words are set in on a phone. */
function fontFor(ctx, el, s, tag) {
  const own = ownFont(s);
  const pick = (prop) => {
    let v = own[prop];
    if (v === undefined && tag === 'button' && !own.unread) return BUTTON_FONT[prop];
    if (v === undefined || v === INHERIT || Number.isNaN(v)) v = inherited(ctx, el, prop);
    return v ?? INHERITED_FONT[prop];
  };
  const size = pick('size');
  const line = pick('line');
  return { size, line: typeof line === 'object' ? line.px : line * size, weight: pick('weight') };
}

/**
 * Every text a control's words can be, one per way its conditions go, or
 * null when a part is a value this reader cannot see ({label}, {count}).
 * An icon or other component inside reads as nothing.
 */
function labels(node) {
  let seen = true;
  const cap = (list) => (list.length > 16 ? [list.reduce((a, b) => (a.length <= b.length ? a : b))] : list);
  const join = (parts) => cap(parts.reduce((acc, p) => acc.flatMap(a => p.map(b => a + b)), ['']));
  const of = (n) => {
    if (!n) return [''];
    switch (n.type) {
      case 'JSXText': return [n.value.replace(/\s*\n\s*/g, ' ')];
      case 'Literal': return [typeof n.value === 'string' || typeof n.value === 'number' ? String(n.value) : ''];
      case 'TemplateLiteral': if (n.expressions.length) seen = false; return [n.quasis.map(q => q.value.cooked ?? '').join('')];
      case 'JSXExpressionContainer': return of(n.expression);
      case 'ConditionalExpression': return cap([...of(n.consequent), ...of(n.alternate)]);
      case 'LogicalExpression': return n.operator === '&&' ? cap(['', ...of(n.right)]) : cap([...of(n.left), ...of(n.right)]);
      case 'JSXFragment': return join(n.children.map(of));
      case 'JSXElement': return /^[a-z]/.test(jsxName(n.openingElement.name)) && jsxName(n.openingElement.name) !== 'svg' ? join(n.children.map(of)) : [''];
      case 'JSXEmptyExpression': return [''];
      default: seen = false; return [''];
    }
  };
  const out = join(node.children.map(of)).map(t => t.replace(/\s+/g, ' ').trim());
  return seen ? out : null;
}

/** Whether `el` is a flex or grid item: its own style places it in one, or the element around it is one. */
function flexItem(ctx, el, s) {
  if (['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf', 'order', 'gridArea', 'gridColumn', 'gridRow'].some(k => k in s)) return true;
  for (let n = ctx.parents.get(el); n; n = ctx.parents.get(n)) {
    if (n.type !== 'JSXElement') continue;
    const a = attr(n, 'style');
    const outer = a?.value?.type === 'JSXExpressionContainer' ? styles(ctx, a.value.expression) : [];
    return outer.length > 0 && outer.every(v => v !== UNKNOWN && /(^|-)(flex|grid)$/.test(String(v.display)));
  }
  return false;
}

/**
 * A text control's border box on a phone, as the browser lays it out: its
 * words on one line in Inter, plus padding and border, or its min-height /
 * height (and min-width / width). `why` says where the height came from.
 */
function textBox(ctx, el, s, tag) {
  const display = typeof s.display === 'string' ? s.display : { button: 'inline-block', a: 'inline', span: 'inline', summary: 'block' }[tag] ?? 'block';
  // A flex or grid item is laid out as a block whatever its display says.
  const inline = display === 'inline' && !flexItem(ctx, el, s);
  const font = fontFor(ctx, el, s, tag);
  const [pt, pr, pb, pl] = padding(s).map(x => (Number.isNaN(x) ? 0 : x));
  const [bt, br, bb, bl] = border(s);
  // An inline box is as tall as its glyphs whatever its line-height, and takes
  // no min-height. Its padding below lies over the sentence's next line, which
  // the browser hits first unless the link is positioned (inlineLinkTap).
  const line = inline ? NORMAL_LINE * font.size : font.line;
  const below = inline && !/^(relative|absolute|fixed|sticky)$/.test(String(s.position)) ? 0 : pb;
  const content = line + pt + below + bt + bb;
  const setH = inline ? 0 : px(s.height), minH = inline ? 0 : px(s.minHeight);
  const h = setH ? Math.max(setH, minH) : Math.max(minH, content);
  // Width: a block box (a row, a disclosure) or a stretched one is as wide as its row.
  const full = (!inline && !display.startsWith('inline') && tag !== 'button')
    || (typeof s.width === 'string' && /%$/.test(s.width.trim())) || Number(s.flex) >= 1 || Number(s.flexGrow) >= 1 || /^1\b/.test(String(s.flex ?? ''));
  // A label this reader cannot see ({label}) is not measured across.
  const words = labels(el);
  let w = Infinity;
  if (!full && words) {
    const upper = s.textTransform === 'uppercase';
    const spacing = typeof s.letterSpacing === 'number' ? s.letterSpacing : typeof s.letterSpacing === 'string' && /em$/.test(s.letterSpacing) ? parseFloat(s.letterSpacing) * font.size : tag === 'button' ? 0 : -0.01 * font.size;
    const across = Math.min(...words.map(t => (upper ? t.toUpperCase() : t)).map(t => textWidth(t, font.size, font.weight) + spacing * [...t].length));
    const setW = inline ? 0 : px(s.width), minW = inline ? 0 : px(s.minWidth);
    w = setW ? Math.max(setW, minW) : Math.max(minW, across + pl + pr + bl + br);
  }
  return { h, w, why: setH || minH >= content ? `${setH ? 'height' : 'minHeight'} ${setH || minH}` : `${round(font.size)} px text on a ${round(line)} px line, ${pt + below} px padding${bt + bb ? `, ${bt + bb} px border` : ''}` };
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

/** The controls in one file a finger can reach on a phone, each with what it shows and its style variants. */
function phoneControls(ctx) {
  const out = [];
  for (const el of ctx.buttons) {
    if (deskOnly(ctx, el)) continue;
    const tag = jsxName(el.openingElement.name);
    const content = visibleContent(el);
    const styleAttr = attr(el, 'style');
    const variants = (styleAttr ? (styleAttr.value?.type === 'JSXExpressionContainer' ? styles(ctx, styleAttr.value.expression) : [UNKNOWN]) : [{}])
      .map(v => (v === UNKNOWN ? { [PARTIAL]: true } : v));
    out.push({ el, tag, content, symbol: content === 'symbol' || content === 'none', variants });
  }
  return out;
}

/** Why a text control's variant is under the floor on a phone, or null. */
function textProblem(ctx, el, s, tag) {
  if (s[PARTIAL]) {
    // Only what is set after the part this reader cannot see is known: a
    // min-height or height of its own, on a box that takes one.
    const inlineByDefault = tag === 'a' || tag === 'span';
    const takesHeight = !inlineByDefault || (typeof s.display === 'string' && s.display !== 'inline');
    return size(s, 'minHeight', 'height') >= FLOOR && takesHeight ? null
      : `its style cannot be read here, so its ${FLOOR} px floor cannot be seen (give it minHeight inline)`;
  }
  const box = textBox(ctx, el, s, tag);
  const short = [
    box.h < FLOOR - 0.5 && `${round(box.h)} px tall (${box.why})`,
    box.w < FLOOR - 0.5 && `${round(box.w)} px wide ("${labels(el).sort((a, b) => a.length - b.length)[0]}")`,
  ].filter(Boolean);
  return short.length ? `is ${short.join(' and ')} on a phone, under ${FLOOR}` : null;
}

/**
 * Every control in one source file under the phone floor, as
 * "file:line  message" lines. `kinds` picks the rules: "symbol" (symbol-
 * and icon-only buttons and links) and "text" (every other button, link,
 * disclosure and role=button element).
 */
export function auditTapTargets(src, file, { kinds = ['symbol', 'text'] } = {}) {
  let ctx;
  try { ctx = parse(src); } catch (e) { return [`${file}: does not parse (${e.message})`]; }
  const problems = [];
  const adminScreen = /(^|\/)Admin[A-Z]\w*\.jsx$/.test(file);
  for (const { el, tag, content, symbol, variants } of phoneControls(ctx)) {
    const kind = symbol ? 'symbol' : 'text';
    // The Admin screens' buttons, role=button rows and disclosures take the .cdomd-admin floor (base.css).
    if (!kinds.includes(kind) || (adminScreen && tag !== 'a')) continue;
    // A thumbnail link is as big as its picture, not a line of words.
    if (!symbol && el.children.every(c => (c.type === 'JSXText' && !c.value.trim()) || (c.type === 'JSXElement' && jsxName(c.openingElement.name) === 'img'))) continue;
    const where = `${file}:${el.loc.start.line}`;
    const noun = tag === 'a' || literalAttr(el, 'role') === 'link' ? 'link' : tag === 'summary' ? 'disclosure' : 'button';
    const what = symbol ? `${content === 'symbol' ? 'symbol' : 'icon'}-only ${noun}` : `text ${noun}`;
    for (const s of variants) {
      if (symbol) {
        const w = size(s, 'minWidth', 'width'), h = size(s, 'minHeight', 'height');
        if (w >= FLOOR && h >= FLOOR) continue;
        problems.push(s[PARTIAL]
          ? `${where}  ${what}: its style cannot be read here, so its ${FLOOR} x ${FLOOR} floor cannot be seen (give it minWidth/minHeight inline)`
          : `${where}  ${what} is not held to ${FLOOR} x ${FLOOR}: minWidth/width ${w || 'none'}, minHeight/height ${h || 'none'}`);
        break;
      }
      const problem = textProblem(ctx, el, s, tag);
      if (problem) { problems.push(`${where}  ${what}${problem.startsWith('is ') ? ' ' : ': '}${problem}`); break; }
    }
  }
  return problems;
}

/**
 * The border box this reader works out for every text control in `src` on a
 * phone, the smallest way its conditions can go: { line, tag, h, w } (w is
 * Infinity where the control is as wide as its row or its words are a value).
 * For pinning the box model against the browser's own measurements.
 */
export function textBoxes(src) {
  const ctx = parse(src);
  return phoneControls(ctx).filter(c => !c.symbol).map(({ el, tag, variants }) => {
    const boxes = variants.filter(s => !s[PARTIAL]).map(s => textBox(ctx, el, s, tag));
    return { line: el.loc.start.line, tag, h: Math.min(...boxes.map(b => b.h)), w: Math.min(...boxes.map(b => b.w)) };
  });
}

/** Whether every <name ...> element in `src` renders only at desk width (and there is at least one). */
export function rendersOnlyAtDesk(src, name) {
  const ctx = parse(src);
  const found = [];
  for (const [n] of ctx.parents) if (n.type === 'JSXElement' && jsxName(n.openingElement.name) === name) found.push(n);
  return found.length > 0 && found.every(el => deskOnly(ctx, el));
}
