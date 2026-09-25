// Runs the real SupportModal component (src/components/pages/SupportModal.jsx)
// with synthetic React hooks, synthetic I/O and no DOM. Buttons are "clicked"
// by calling the onClick React would call. Shared by text-drafts-ui.test.mjs
// and archive-control.test.mjs; not a test file itself.
//
// Every module SupportModal imports from src/utils is passed through whole,
// so a new helper imported there does not silently become undefined here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as drafts from '../../src/utils/supportTextDrafts.js';
import * as ticketAttachments from '../../src/utils/ticketAttachments.js';
import * as outgoingText from '../../src/utils/outgoingText.js';

const source = await readFile(new URL('../../src/components/pages/SupportModal.jsx', import.meta.url), 'utf8');
export const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
export const deferred = () => { let resolve; return { promise: new Promise(r => resolve = r), resolve }; };
export const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), m }; };
export const ticket = (id, extra = {}) => ({ id, subject: `Issue ${id}`, body: 'Synthetic initial report', status: 'open', created_at: '2026-09-20T00:00:00Z', ...extra });
export const tick = () => new Promise(r => setImmediate(r));

export function fixture({ storage = store(), account = 'user_A', operations = false, tickets = null } = {}) {
  const hooks = [], effects = [], sends = [], timers = [], writes = [];
  let cursor = 0, closed = 0, props = { open: true, onClose: () => closed++ };
  const rows = tickets || [ticket(ID), ticket(ID2)];
  const window = { sessionStorage: storage, Clerk: { user: { id: account }, session: {} }, location: { pathname: '/app/' } };
  globalThis.window = window;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const react = {
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => hooks[i] = typeof v === 'function' ? v(hooks[i]) : v]; },
    useRef(init) { const i = cursor++; return hooks[i] ??= ({ current: init }); },
    useMemo(fn, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = fn(); }); } },
  };
  const db = {
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
        maybeSingle: async () => ({ data: { id: ID } }),
        // Every write is recorded with the filters it was scoped by.
        update(row) {
          const write = { table, row, filters: [] };
          writes.push(write);
          const u = { eq(column, value) { write.filters.push([column, value]); return u; }, then(resolve) { return Promise.resolve({ error: null }).then(resolve); } };
          return u;
        },
        then(resolve) { return Promise.resolve({ data: table === 'support_tickets' ? rows : [] }).then(resolve); },
      };
      return q;
    },
    functions: { invoke(name, args) { const d = deferred(); sends.push({ name, args, ...d }); return d.promise; } },
  };
  const operationClient = { createDraft: () => null, replyDraft: () => null };
  const imports = {
    react,
    'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '../../context/AppContext': { useApp: () => ({ theme: {}, user: { id: account, email: 'synthetic@example.invalid' }, isDesktop: true }) },
    '../../utils/deskKeys': { pushModal() {}, popModal() {}, isTopModal: () => true },
    '../../utils/edgeError': { edgeErrorMessage: async () => 'Synthetic read failure' },
    '../../lib/supabase': { supabase: db },
    '../shared': { ScreenshotAttach: 'screenshot' },
    '../shared/TicketAttachments': { default: 'attachments' },
    '../../utils/ticketAttachments': ticketAttachments,
    '../../utils/outgoingText.js': outgoingText,
    '../../utils/supportTextDrafts': drafts,
    '../../utils/supportOperationsClient': { SUPPORT_OPERATIONS_ENABLED: operations, createSupportOperationsClient: () => operationClient },
  };
  const module = { exports: {} };
  const ctx = vm.createContext({
    module, exports: module.exports,
    require: n => { assert.ok(n in imports, `SupportModal imports ${n}, which the harness does not provide`); return imports[n]; },
    window, document: { addEventListener() {}, removeEventListener() {} }, console,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
  });
  vm.runInContext(transformSync(source + '\nexport {SupportModalContent};', { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  const render = () => { cursor = 0; let tree = module.exports.SupportModalContent(props); if (effects.length) { effects.splice(0).forEach(fn => fn()); cursor = 0; tree = module.exports.SupportModalContent(props); } return tree; };
  const nodes = (tree = render()) => { const out = []; const visit = n => { if (n && typeof n === 'object') { if (n.type) out.push(n); const children = n.props?.children; for (const child of Array.isArray(children) ? children : [children]) Array.isArray(child) ? child.forEach(visit) : visit(child); } }; visit(tree); return out; };
  const text = node => { const c = node?.props?.children; return (Array.isArray(c) ? c : [c]).map(v => typeof v === 'string' ? v : v && typeof v === 'object' ? text(v) : '').join(''); };
  const findButton = label => nodes().find(n => n.type === 'button' && text(n) === label);
  const button = label => { const n = findButton(label); assert.ok(n, `Missing button ${label}`); return n; };
  return {
    storage, window, sends, timers, writes, render, nodes, text, button, findButton,
    get closed() { return closed; },
    setOpen(open) { props = { ...props, open }; render(); },
    edit(type, value) { const n = nodes().find(n => n.type === type); assert.ok(n); n.props.onChange({ target: { value } }); render(); },
    unmount() { for (const h of hooks) h?.cleanup?.(); },
    draft: () => drafts.createSupportTextDrafts({ accountId: account }),
  };
}

export async function openTicket(f, id = ID) {
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  const n = f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${id}`));
  assert.ok(n, `ticket ${id} is not in the visible list`);
  await n.props.onClick(); f.render();
}
