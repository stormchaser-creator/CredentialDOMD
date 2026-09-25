// Runs one real component file (src/components/...) with synthetic React
// hooks, synthetic I/O and no DOM. Not a test file itself.
//
// Every import the component makes is replaced by a named no-op stub unless
// the test passes the real module (or a fake) for it in `modules`, keyed by
// the last path segment ("spreadsheetGuard", "AppContext"...). Buttons and
// inputs are driven by calling the handler React would call; state lives in
// the hook slots, so render() after an event shows what the physician sees.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** { specifier: { default?: localName, named: [names] } } for every import in the source. */
function importsOf(source) {
  const out = {};
  for (const [, clause, spec] of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm)) {
    const entry = out[spec] ||= { named: [] };
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) for (const part of braces[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n) entry.named.push(n); }
    const def = clause.trim().match(/^([A-Za-z_$][\w$]*)/);
    if (def) entry.default = def[1];
  }
  return out;
}

const stub = (name) => { const fn = function () { return undefined; }; Object.defineProperty(fn, 'name', { value: name }); return fn; };
const keyOf = spec => spec.split('/').pop().replace(/\.(m?js|jsx)$/, '');

/** A FileReader that reads a Blob/File into a data URL the way the browser does. */
class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buf => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.({ target: this });
    }, err => this.onerror?.(err));
  }
  readAsText(blob) {
    blob.text().then(t => { this.result = t; this.onload?.({ target: this }); }, err => this.onerror?.(err));
  }
}

export const settle = async (turns = 60) => { for (let i = 0; i < turns; i++) await new Promise(r => setImmediate(r)); };

export async function mountComponent(path, { modules = {}, app = {}, props = {}, exportName = 'default', globals = {} } = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const hooks = [], effects = [], timers = [];
  let cursor = 0;
  const react = {
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(init) { const i = cursor++; return hooks[i] ??= ({ current: init }); },
    useMemo(fn, deps) { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || !deps || !same(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); const c = fn(); hooks[i].cleanup = typeof c === 'function' ? c : null; }); } },
    memo: c => c, forwardRef: c => c, Fragment: 'Fragment',
  };
  react.useLayoutEffect = react.useEffect;
  const jsx = (type, props, key) => ({ type, props, key });
  const provided = { react: { __esModule: true, default: react, ...react }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' } };
  for (const [spec, { default: def, named }] of Object.entries(importsOf(source))) {
    if (spec in provided) continue;
    const real = modules[keyOf(spec)];
    const mod = { __esModule: true };
    if (def) mod.default = stub(def);
    for (const n of named) mod[n] = stub(n);
    if (keyOf(spec) === 'AppContext') mod.useApp = () => app;
    provided[spec] = real ? { __esModule: true, ...mod, ...real } : mod;
  }
  const module = { exports: {} };
  const document = { querySelector: () => null, createElement: () => ({ style: {}, click() {}, select() {} }), body: { appendChild() {}, removeChild() {} }, addEventListener() {}, removeEventListener() {}, execCommand: () => true };
  const ctx = vm.createContext({
    module, exports: module.exports,
    require: n => { assert.ok(n in provided, `${path} imports ${n}, which the harness does not provide`); return provided[n]; },
    console, URL, Blob, File, Buffer, TextEncoder, TextDecoder, atob, btoa, fetch,
    FileReader: FakeFileReader,
    navigator: { userAgent: 'Synthetic desktop', clipboard: { writeText: async () => {} } },
    document, window: { navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    ...globals,
  });
  vm.runInContext(transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic', define: { 'import.meta.env': '{}' } }).code, ctx);
  const Component = module.exports[exportName];
  assert.equal(typeof Component, 'function', `${path} has no ${exportName} export`);

  let currentProps = props;
  const render = () => {
    cursor = 0;
    let tree = Component(currentProps);
    for (let loops = 0; effects.length && loops < 20; loops++) { effects.splice(0).forEach(fn => fn()); cursor = 0; tree = Component(currentProps); }
    return tree;
  };
  const nodes = (tree = render()) => {
    const out = [];
    const visit = n => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (!n || typeof n !== 'object') return;
      if (n.type) out.push(n);
      // Children, and any prop that is itself an element (a Modal's footer).
      const isElement = v => v && typeof v === 'object' && 'type' in v && 'props' in v;
      for (const [k, v] of Object.entries(n.props || {})) if (k !== 'children' && (isElement(v) || (Array.isArray(v) && v.some(isElement)))) visit(v);
      visit(n.props?.children);
    };
    visit(tree);
    return out;
  };
  const text = node => {
    const c = node?.props?.children;
    return (Array.isArray(c) ? c : [c]).flat(Infinity).map(v => typeof v === 'string' || typeof v === 'number' ? String(v) : v && typeof v === 'object' ? text(v) : '').join('');
  };
  const pageText = () => text({ props: { children: render() } });
  /** The file inputs, in source order. */
  const fileInputs = () => nodes().filter(n => n.type === 'input' && n.props.type === 'file');
  /** Pick files on a file input the way the browser does, then let the handler finish. */
  const pick = async (input, files) => { input.props.onChange({ target: { files, value: 'C:\\fakepath' } }); await settle(); render(); };
  return { render, nodes, text, pageText, fileInputs, pick, timers, setProps(p) { currentProps = { ...currentProps, ...p }; render(); } };
}
