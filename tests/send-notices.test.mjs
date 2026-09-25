import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Drive the real click handlers of the send screens a review found wrong
// (tickets e8cc2a02, 821d2f76 follow-up), with a synchronous hook scheduler,
// a synthetic account and a fake share sheet. Nothing leaves the process:
// no network, no clipboard, no messages.
//  - the alert screens' Text button said nothing when the digest was cut;
//  - the credential Send sheet showed one credential's clipboard hint on the
//    next, and "Send with N documents attached" could send the letter alone;
//  - the expense invoice claimed receipts on the clipboard and in the PDF
//    that did not ride along, and called a download "sent";
//  - the receipt resend wrote a receipt count to the clipboard first.
const require = createRequire(import.meta.url);
// Load the PDF library before any test stubs `window`: its node build
// switches to browser code paths when it sees one.
require('jspdf');
const autoTable = require('jspdf-autotable');
// The bundle imports autoTable as a default export in node-compat mode, which
// would hand it the whole module object; give it a callable that is also the
// module.
const externals = { 'jspdf-autotable': Object.assign((...args) => autoTable.default(...args), autoTable) };
const root = fileURLToPath(new URL('..', import.meta.url));
const built = await build({
  stdin: {
    contents: [
      'export {default as ShareModal} from "./src/components/features/ShareModal.jsx";',
      'export {default as NotificationCenter} from "./src/components/pages/NotificationCenter.jsx";',
      'export {default as NotificationBanner} from "./src/components/pages/NotificationBanner.jsx";',
      'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
      'export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";',
    ].join('\n'),
    resolveDir: root, loader: 'jsx',
  },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'jspdf', 'jspdf-autotable', 'xlsx', 'docx'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-account', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/admin$/ }, () => ({ path: 'admin', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
      contents: path === 'context' ? 'export const useApp = () => globalThis.__send.context;'
        : path === 'admin' ? 'export const useIsAdmin = () => false; export const isAdminUser = () => false;'
          : 'export const supabase = null; export const downloadDocumentBlob = (p) => globalThis.__send.download(p);',
      loader: 'js',
    }));
  } }],
});

// A synchronous stand-in for React's hooks: state lives in cells by call
// order, effects run after each render when their deps change.
function harness(componentName, props) {
  const cells = [];
  let index = 0;
  let effects = [];
  const effect = (fn, deps) => {
    const at = index++;
    const prev = cells[at];
    if (prev && deps && deps.length === prev.deps?.length && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
    cells[at] = { deps, cleanup: prev?.cleanup };
    effects.push(() => { cells[at].cleanup?.(); cells[at].cleanup = fn() || undefined; });
  };
  const hooks = {
    useState(initial) {
      const at = index++;
      if (!(at in cells)) cells[at] = { v: typeof initial === 'function' ? initial() : initial };
      const cell = cells[at];
      return [cell.v, (value) => { cell.v = typeof value === 'function' ? value(cell.v) : value; }];
    },
    useRef(value) { const at = index++; return (cells[at] ??= { current: value }); },
    useMemo: (fn) => fn(), useCallback: (fn) => fn, useEffect: effect, useLayoutEffect: effect,
    memo: (component) => component,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(
    (name) => (name === 'react' ? hooks : externals[name] ?? require(name)), module, module.exports);
  const Component = module.exports[componentName];
  const state = { props };
  state.render = () => {
    index = 0;
    effects = [];
    const tree = Component(state.props);
    for (const run of effects) run();
    return tree;
  };
  return state;
}

const theme = new Proxy({}, { get: () => '#777' });
function context(data, extra = {}) {
  const calls = [];
  return {
    calls,
    user: { id: 'user_synthetic' }, theme, isDesktop: false,
    data: {
      settings: { name: 'Synthetic Physician', degreeType: 'DO', npi: '9999999999', email: 'doc@example.test', phone: '(555) 123-4567' },
      licenses: [], cme: [], privileges: [], insurance: [], documents: [], shareLog: [], invoices: [],
      travelExpenses: [], locumContracts: [], workLog: [], dutyDays: [], notificationLog: [], alertAcks: [],
      ...data,
    },
    updateSettings: (u) => calls.push(['updateSettings', u]),
    addItem: (c, item) => { calls.push(['addItem', c, item]); return item; },
    editItem: (c, item) => { calls.push(['editItem', c, item]); return item; },
    deleteItem: (...a) => calls.push(['deleteItem', ...a]),
    setData: () => {},
    ...extra,
  };
}

const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) { for (const c of tree) { const hit = find(c, predicate); if (hit) return hit; } return null; }
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
};
const textOf = (n) => (n == null || typeof n === 'boolean' ? ''
  : typeof n === 'string' || typeof n === 'number' ? String(n)
    : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children));
const button = (tree, label) => find(tree, (n) => n.type === 'button' && textOf(n).includes(label));
// The Send sheet's share button reads "Opening..." for 3 s after a share.
const sendButton = (tree) => find(tree, (n) => n.type === 'button' && /Send with \d+ documents? attached|Opening/.test(textOf(n)));
const status = (tree) => { const n = find(tree, (x) => x.props?.role === 'status'); return n ? textOf(n) : ''; };
const flush = () => new Promise((r) => setImmediate(r));
// The text runs of a jsPDF file, one per line, for readable failures.
const pdfText = async (file) => [...(await file.text()).matchAll(/\((.*)\) Tj/g)].map((m) => m[1]).join('\n');

// Browser globals for one test, restored after.
async function withBrowser({ canShare = () => true, share = async () => {}, clipboard = true, ua = 'iPhone' } = {}, fn) {
  const saved = {
    window: globalThis.window, document: globalThis.document, confirm: globalThis.confirm,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const log = { opened: [], clipboard: [], shares: [], downloads: [] };
  globalThis.window = { open: (url) => log.opened.push(url), navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true };
  globalThis.document = { createElement: () => ({ click() { log.downloads.push(this.download); } }) };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: ua, onLine: true,
      clipboard: { writeText: async (t) => { if (!clipboard) throw Error('NotAllowedError'); log.clipboard.push(t); } },
      canShare: (p) => canShare(p),
      share: async (p) => { log.shares.push(p); return share(p); },
    },
  });
  try { return await fn(log); } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  }
}

// ── Alert screens ───────────────────────────────────────────────────────
const soonDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
const manyLicenses = (n) => Array.from({ length: n }, (_, i) => ({
  id: `lic-${i}`, type: 'Medical License', name: `Synthetic State Medical License ${i + 1}`,
  state: ['CA', 'ND', 'CO', 'TX', 'NV', 'AZ'][i % 6], expirationDate: soonDate,
}));

test('Notification Center: a digest cut for one text says so and keeps the full list on the clipboard', async () => {
  await withBrowser({}, async (log) => {
    const ctx = context({ licenses: manyLicenses(24) });
    globalThis.__send = { context: ctx };
    const ui = harness('NotificationCenter', { open: true, onClose() {} });
    button(ui.render(), 'Text to').props.onClick();
    await flush();
    const tree = ui.render();
    assert.match(status(tree), /Text shortened to fit one message/);
    assert.match(status(tree), /full list is on your clipboard/);
    assert.equal(log.clipboard.length, 1);
    // Alerts use the canonical label (type and state), so count the items.
    assert.equal((log.clipboard[0].match(/\u{23f3}/gu) || []).length, 24, 'the clipboard holds the whole digest');
    const sent = decodeURIComponent(log.opened[0].split('&body=')[1]);
    assert.ok(sent.length <= 1400);
    assert.match(sent, /Open CredentialDOMD for the full list\.$/);
  });
});

test('Notification Center: a digest that fits is sent whole with no cut notice', async () => {
  await withBrowser({}, async (log) => {
    globalThis.__send = { context: context({ licenses: manyLicenses(2) }) };
    const ui = harness('NotificationCenter', { open: true, onClose() {} });
    button(ui.render(), 'Text to').props.onClick();
    await flush();
    assert.doesNotMatch(status(ui.render()), /shortened/);
    assert.equal(log.clipboard.length, 0);
  });
});

test('home alert banner: the Text button reports a cut digest', async () => {
  await withBrowser({ clipboard: false }, async (log) => {
    globalThis.__send = { context: context({ licenses: manyLicenses(24) }) };
    const ui = harness('NotificationBanner', { onOpenCenter() {}, onGoSettings() {} });
    const text = find(ui.render(), (n) => n.type === 'button' && textOf(n).trim() === 'Text');
    text.props.onClick();
    await flush();
    const notice = status(ui.render());
    assert.match(notice, /Text shortened to fit one message/);
    assert.doesNotMatch(notice, /clipboard/, 'the clipboard refused, so it is not mentioned');
    assert.equal(log.opened.length, 1);
  });
});

// ── Credential Send sheet ───────────────────────────────────────────────
const license = { id: 'lic-a', type: 'Medical License', licenseNumber: 'SYN-1', state: 'CA', expirationDate: '2027-05-01' };
const other = { id: 'lic-b', type: 'DEA Registration', licenseNumber: 'SYN-2', state: 'CA', expirationDate: '2027-06-01' };
const pdfData = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 synthetic').toString('base64')}`;

test('Send sheet: a hint written for one credential never shows on the next, and closing clears it', async () => {
  await withBrowser({}, async () => {
    const onDevice = { id: 'doc-a', name: 'CA license.pdf', type: 'application/pdf', data: pdfData, linkedTo: 'licenses:lic-a' };
    globalThis.__send = { context: context({ documents: [onDevice] }), download: async () => null };
    let closed = 0;
    const ui = harness('ShareModal', { open: true, onClose: () => { closed++; }, item: license, section: 'licenses', linkedDocs: [onDevice], onLogShare() {} });
    ui.render();              // runs the effect that resolves the linked file
    await flush();
    await sendButton(ui.render()).props.onClick();
    assert.match(status(ui.render()), /formatted letter is on your clipboard/);

    // Same mounted sheet, next credential, well inside the 12 s window.
    ui.props = { ...ui.props, item: other, linkedDocs: [] };
    assert.equal(status(ui.render()), '', "credential B must not show A's clipboard hint");

    // Back on A and closed: the hint is gone.
    ui.props = { ...ui.props, item: license, linkedDocs: [onDevice] };
    await sendButton(ui.render()).props.onClick();
    assert.match(status(ui.render()), /clipboard/);
    const modal = find(ui.render(), (n) => typeof n.props?.onClose === 'function' && n.props?.title === 'Send Credential');
    modal.props.onClose();
    assert.equal(closed, 1);
    assert.equal(status(ui.render()), '');
  });
});

test('Send sheet: documents stripped from the device are fetched when the sheet opens and ride along', async () => {
  await withBrowser({}, async (log) => {
    // saveData strips `data` once a document has a storagePath.
    const inCloud = { id: 'doc-c', name: 'DEA.pdf', type: 'application/pdf', storagePath: 'user_synthetic/doc-c', linkedTo: 'licenses:lic-a' };
    const fetched = [];
    globalThis.__send = {
      context: context({ documents: [inCloud] }),
      download: async (p) => { fetched.push(p); return new Blob([new TextEncoder().encode('%PDF')], { type: 'application/pdf' }); },
    };
    const logged = [];
    const ui = harness('ShareModal', { open: true, onClose() {}, item: license, section: 'licenses', linkedDocs: [inCloud], onLogShare: (e) => logged.push(e) });
    ui.render();
    await flush();
    assert.deepEqual(fetched, ['user_synthetic/doc-c'], 'fetched at open, not inside the tap');
    await sendButton(ui.render()).props.onClick();
    assert.equal(log.shares.length, 1);
    assert.equal(log.shares[0].files.length, 1);
    assert.equal(log.shares[0].files[0].name, 'DEA.pdf');
    assert.match(log.shares[0].text, /Supporting documentation is attached\./);
    assert.equal(logged[0].method, 'share');
  });
});

test('Send sheet: "Send with N documents attached" never sends the letter alone', async () => {
  // A document that cannot be read: nothing opens, the sender is told why.
  await withBrowser({}, async (log) => {
    const gone = { id: 'doc-g', name: 'Board certificate.pdf', type: 'application/pdf', storagePath: 'user_synthetic/doc-g', linkedTo: 'licenses:lic-a' };
    globalThis.__send = { context: context({ documents: [gone] }), download: async () => null };
    const logged = [];
    const ui = harness('ShareModal', { open: true, onClose() {}, item: license, section: 'licenses', linkedDocs: [gone], onLogShare: (e) => logged.push(e) });
    ui.render();
    await flush();
    await sendButton(ui.render()).props.onClick();
    assert.equal(log.shares.length, 0, 'no share opened');
    assert.equal(logged.length, 0, 'nothing logged as sent');
    assert.match(status(ui.render()), /1 document could not be attached \(Board certificate\.pdf\).*Nothing was sent/);
  });
  // A browser that cannot share files: same refusal, not a text-only share.
  await withBrowser({ canShare: () => false }, async (log) => {
    const onDevice = { id: 'doc-a', name: 'CA license.pdf', type: 'application/pdf', data: pdfData, linkedTo: 'licenses:lic-a' };
    globalThis.__send = { context: context({ documents: [onDevice] }), download: async () => null };
    const ui = harness('ShareModal', { open: true, onClose() {}, item: license, section: 'licenses', linkedDocs: [onDevice], onLogShare() {} });
    ui.render();
    await flush();
    await sendButton(ui.render()).props.onClick();
    assert.equal(log.shares.length, 0);
    assert.match(status(ui.render()), /cannot attach files.*nothing was sent/);
  });
  // Still resolving: asks for a moment instead of sending.
  await withBrowser({}, async (log) => {
    const slow = { id: 'doc-s', name: 'Slow.pdf', type: 'application/pdf', storagePath: 'user_synthetic/doc-s', linkedTo: 'licenses:lic-a' };
    globalThis.__send = { context: context({ documents: [slow] }), download: () => new Promise(() => {}) };
    const ui = harness('ShareModal', { open: true, onClose() {}, item: license, section: 'licenses', linkedDocs: [slow], onLogShare() {} });
    await sendButton(ui.render()).props.onClick();
    assert.equal(log.shares.length, 0);
    assert.match(status(ui.render()), /still loading/);
  });
});

// ── Expense invoice ─────────────────────────────────────────────────────
const RECEIPT_CLAIM = /receipts? (?:is |are )?attached/i;
const expenseData = () => ({
  travelExpenses: [
    { id: 'e1', date: '2026-08-01', category: 'Airfare', vendor: 'Example Air', amount: 400, agency: 'Example Locums' },
    { id: 'e2', date: '2026-08-02', category: 'Lodging', vendor: 'Example Inn', amount: 300, agency: 'Example Locums', notes: 'late checkout' },
  ],
  documents: [
    { id: 'r1', name: 'air.jpg', type: 'image/jpeg', data: `data:image/jpeg;base64,${Buffer.from('JPEG1').toString('base64')}`, linkedTo: 'travelExpenses:e1' },
    { id: 'r2', name: 'inn.jpg', type: 'image/jpeg', data: `data:image/jpeg;base64,${Buffer.from('JPEG2').toString('base64')}`, linkedTo: 'travelExpenses:e2' },
  ],
  locumContracts: [{ id: 'c1', agency: 'Example Locums', facility: 'Example Regional' }],
});
async function sendExpenses(log) {
  const ctx = context(expenseData());
  globalThis.__send = { context: ctx, download: async () => null };
  const ui = harness('Expenses', {});
  button(ui.render(), 'Invoice 2 expenses').props.onClick();
  await flush();
  await button(ui.render(), 'Create & send with receipts').props.onClick();
  const tree = ui.render();
  const notice = textOf(find(tree, (n) => n.type === 'div' && /Invoice EXP-/.test(textOf(n)) && !find(n.props?.children, (c) => c.type === 'button')));
  const saved = ctx.calls.find(([k, c]) => k === 'addItem' && c === 'invoices')?.[2];
  return { notice, saved, log };
}

test('expense invoice: when the OS refuses the bundle, nothing that goes out claims the receipts', async () => {
  await withBrowser({ canShare: ({ files }) => files.length === 1 }, async (log) => {
    const { notice, saved } = await sendExpenses(log);
    assert.equal(log.shares.length, 1, 'the invoice went alone');
    assert.doesNotMatch(log.shares[0].text, RECEIPT_CLAIM);
    const pdf = await pdfText(log.shares[0].files[0]);
    assert.doesNotMatch(pdf, /receipts? attached/, 'the PDF that went alone');
    assert.match(pdf, /receipt on file/);
    // The clipboard letter was written before the share: it never counts.
    assert.equal(log.clipboard.length, 1);
    assert.doesNotMatch(log.clipboard[0], RECEIPT_CLAIM);
    assert.ok(saved.lines.every((l) => !/attached/.test(l.detail)), 'the saved invoice matches what went');
    assert.ok(saved.lines.every((l) => l.expenseId), 'lines carry their expense for a resend');
    assert.match(notice, /sent on its own/);
  });
});

test('expense invoice: a download is called a download, with the cover letter on the clipboard', async () => {
  await withBrowser({ canShare: () => false }, async (log) => {
    const { notice } = await sendExpenses(log);
    assert.equal(log.shares.length, 0);
    assert.equal(log.downloads.length, 3, 'invoice and both receipts');
    assert.match(notice, /Invoice EXP-\S+ and 2 receipts downloaded/);
    assert.match(notice, /cover letter is on your clipboard/);
    assert.doesNotMatch(notice, /\bsent\b/);
  });
});

test('expense invoice: a bundle that goes whole says attached in the share text and on each line', async () => {
  await withBrowser({}, async (log) => {
    const { notice, saved } = await sendExpenses(log);
    assert.equal(log.shares[0].files.length, 3);
    assert.match(log.shares[0].text, /2 receipts are attached\./);
    assert.deepEqual(saved.lines.map((l) => l.detail), ['receipt attached', `late checkout ${String.fromCodePoint(0xb7)} receipt attached`]);
    assert.doesNotMatch(log.clipboard[0], RECEIPT_CLAIM);
    assert.match(notice, /sent with 2 receipts attached/);
  });
});

// ── Receipt resend from Invoices ────────────────────────────────────────
test('resend with receipts: the clipboard letter is count-free and a refused bundle resends a PDF with no receipt claim', async () => {
  await withBrowser({ canShare: ({ files }) => files.length === 1 }, async (log) => {
    const data = expenseData();
    const inv = {
      id: 'inv-x', number: 'EXP-0007', kind: 'expenses', billToLabel: 'Example Locums', periodStart: '2026-08-01', periodEnd: '2026-08-02',
      entryIds: ['e1', 'e2'], totalAmount: 700, totalMinutes: 0, sentAt: '2026-08-05T12:00:00Z',
      // Saved before lines carried expenseId, with the old wording.
      lines: [
        { date: '2026-08-01', label: 'Airfare: Example Air', detail: 'receipt attached', amount: 400 },
        { date: '2026-08-02', label: 'Lodging: Example Inn', detail: `late checkout ${String.fromCodePoint(0xb7)} receipt attached`, amount: 300 },
      ],
    };
    data.travelExpenses = data.travelExpenses.map((e) => ({ ...e, invoiceId: 'inv-x' }));
    globalThis.__send = { context: context({ ...data, invoices: [inv] }), download: async () => null };
    const ui = harness('Invoices', {});
    button(ui.render(), 'Resend').props.onClick({ stopPropagation() {} });
    await flush();
    const chooser = find(ui.render(), (n) => typeof n.props?.onPick === 'function');
    chooser.props.onPick('pdf');   // fires resend() without returning it
    for (let i = 0; i < 50 && !log.shares.length; i++) await flush();
    assert.ok(log.clipboard.length >= 1);
    for (const letter of log.clipboard) assert.doesNotMatch(letter, RECEIPT_CLAIM, 'no clipboard write counts receipts');
    assert.equal(log.shares.length, 1, 'the bundle was refused; the PDF went alone');
    assert.equal(log.shares[0].files.length, 1);
    const pdf = await pdfText(log.shares[0].files[0]);
    assert.doesNotMatch(pdf, /receipts? attached/);
    assert.match(pdf, /receipt on file/);
  });
});
