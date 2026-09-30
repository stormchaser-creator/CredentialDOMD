// Reads rendered markup the way a screen reader's accessibility tree does,
// for the checks that decide whether a control can be used without seeing it:
// every button and link has a name, every form field has a label, every
// dialog is modal and named, every switch says whether it is on, and no id is
// used twice (a label tied to a repeated id names the wrong field).
//
// Not a test file itself. The markup is renderToStaticMarkup output: well
// formed, attributes double quoted, text escaped.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m));

/** The markup as a tree of { tag, attrs, children, parent } and { text } nodes. */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let node = root;
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(token)) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      let open = node;
      while (open && open.tag !== tag) open = open.parent;
      if (open) node = open.parent;
    } else if (m[2]) {
      const attrs = {};
      for (const a of (m[3] || '').matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] === undefined ? '' : decode(a[2]);
      const el = { tag: m[2].toLowerCase(), attrs, children: [], parent: node };
      node.children.push(el);
      if (!VOID.has(el.tag) && !m[4]) node = el;
    } else if (m[5]) {
      node.children.push({ text: decode(m[5]), parent: node });
    }
  }
  return root;
}

const elements = (node, out = []) => { for (const c of node.children || []) if (c.tag) { out.push(c); elements(c, out); } return out; };
const hiddenStyle = (el) => /(^|;)\s*display\s*:\s*none/i.test(el.attrs.style || '') || /(^|;)\s*visibility\s*:\s*hidden/i.test(el.attrs.style || '');
/** Not in the accessibility tree: hidden by attribute, style or aria-hidden, itself or an ancestor. */
export const isHidden = (el) => { for (let n = el; n && n.tag !== '#root'; n = n.parent) if ('hidden' in n.attrs || n.attrs['aria-hidden'] === 'true' || hiddenStyle(n)) return true; return false; };

/** Text a screen reader would read for the subtree (hidden parts left out, images by alt). */
export function textOf(node) {
  if (node.text !== undefined) return node.text;
  if (node.attrs['aria-hidden'] === 'true' || 'hidden' in node.attrs || hiddenStyle(node)) return '';
  if (node.tag === 'img') return node.attrs.alt || '';
  if (node.attrs['aria-label']) return node.attrs['aria-label'];
  return (node.children || []).map(textOf).join(' ');
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** A name has to say something: a lone "×" or "›" is read as a symbol, not an action. */
const meaningful = (s) => /[\p{L}\p{N}]/u.test(s);

function nameOf(el, byId) {
  const ids = (el.attrs['aria-labelledby'] || '').split(/\s+/).filter(Boolean);
  if (ids.length) return clean(ids.map(id => (byId.get(id) ? textOf(byId.get(id)) : '')).join(' '));
  if (clean(el.attrs['aria-label'])) return clean(el.attrs['aria-label']);
  return '';
}

function labelOf(el, byId, labelsFor) {
  const named = nameOf(el, byId);
  if (named) return named;
  const parts = [];
  if (el.attrs.id && labelsFor.has(el.attrs.id)) parts.push(...labelsFor.get(el.attrs.id).map(textOf));
  for (let n = el.parent; n && n.tag !== '#root'; n = n.parent) if (n.tag === 'label') { parts.push(textOf(n)); break; }
  return clean(parts.join(' '));
}

const describe = (el) => {
  const attrs = Object.entries(el.attrs).filter(([k]) => k !== 'style' && k !== 'class').map(([k, v]) => `${k}="${String(v).slice(0, 40)}"`).join(' ');
  const text = clean(textOf(el)).slice(0, 40);
  return `<${el.tag}${attrs ? ' ' + attrs : ''}>${text}`;
};

/**
 * Every problem in the markup, one line each (empty when there are none).
 * `where` prefixes each line so a failure names the screen it came from.
 */
export function auditHtml(html, where = '') {
  const root = parseHtml(html);
  const all = elements(root);
  const byId = new Map();
  const problems = [];
  const at = (msg) => problems.push(where ? `${where}: ${msg}` : msg);
  for (const el of all) {
    if (el.attrs.id === undefined) continue;
    if (byId.has(el.attrs.id)) at(`id "${el.attrs.id}" is used twice, so a label or reference tied to it finds the wrong element: ${describe(el)}`);
    else byId.set(el.attrs.id, el);
  }
  const labelsFor = new Map();
  for (const el of all) if (el.tag === 'label' && el.attrs.for) (labelsFor.get(el.attrs.for) || labelsFor.set(el.attrs.for, []).get(el.attrs.for)).push(el);
  for (const el of all) {
    if (isHidden(el)) continue;
    const role = el.attrs.role;
    const inputType = (el.attrs.type || 'text').toLowerCase();
    const isButton = el.tag === 'button' || role === 'button' || (el.tag === 'input' && ['button', 'submit', 'reset'].includes(inputType));
    const isLink = el.tag === 'a' && 'href' in el.attrs;
    if (isButton || isLink || role === 'switch' || role === 'tab' || role === 'menuitem') {
      const name = nameOf(el, byId) || clean(el.tag === 'input' ? el.attrs.value : textOf(el));
      if (!meaningful(name)) at(`${isLink ? 'link' : 'button'} with no accessible name${name ? ` (only "${name}")` : ''}: ${describe(el)}`);
    }
    if ((el.tag === 'input' && !['hidden', 'button', 'submit', 'reset'].includes(inputType)) || el.tag === 'select' || el.tag === 'textarea') {
      if (!meaningful(labelOf(el, byId, labelsFor))) at(`form field with no label: ${describe(el)}`);
    }
    if (role === 'dialog' || role === 'alertdialog') {
      if (el.attrs['aria-modal'] !== 'true') at(`dialog without aria-modal="true": ${describe(el)}`);
      if (!meaningful(nameOf(el, byId))) at(`dialog with no name: ${describe(el)}`);
    }
    if ((role === 'switch' || role === 'checkbox') && !['true', 'false', 'mixed'].includes(el.attrs['aria-checked'])) at(`${role} that does not say whether it is on (aria-checked): ${describe(el)}`);
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const id of (el.attrs[attr] || '').split(/\s+/).filter(Boolean)) if (!byId.has(id)) at(`${attr} points at "${id}", which is not on the screen: ${describe(el)}`);
    }
  }
  for (const [id, labels] of labelsFor) if (!byId.has(id)) at(`label for "${id}" points at nothing: ${describe(labels[0])}`);
  return problems;
}
