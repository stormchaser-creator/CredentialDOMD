// Where "Did <n> go out?" and the Invoices status badge land on a phone, in a
// real WebKit (Playwright's, the engine of the owner's installed iPhone app)
// at 390x844, against this tree's real components bundled for the browser:
// the shared Modal with an invoice preview's height of content, the Work
// log's reminder inside a scroller under a sticky top bar and over a fixed
// tab bar, and the Invoices tab's card list. Skipped, with a message, where
// Playwright's WebKit is not installed (CI installs no browsers); the
// behaviour without layout is in invoice-ask-in-view-live.test.mjs.
//
// From the iOS 26 Simulator pass (2026-10-02): Yes and No sat below the fold
// after a share sheet closed unanswered, and the badge read "OWED" with
// "· 0D" on a second line. Set ASK_IN_VIEW_SHOTS=<dir> to keep screenshots.
// Synthetic agreements, numbers and amounts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

let webkit = null;
try { ({ webkit } = await import('playwright-core')); } catch { webkit = null; }
const browserPath = (() => { try { return webkit?.executablePath(); } catch { return null; } })();
const skip = !browserPath || !existsSync(browserPath) ? 'Playwright WebKit is not installed (npx playwright install webkit)' : false;
const shots = process.env.ASK_IN_VIEW_SHOTS || '';

const src = (p) => JSON.stringify(resolve(root, p));
const ENTRY = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import Modal from ${src('src/components/shared/Modal.jsx')};
import InvoiceMarkSent, { UnrecordedNotes } from ${src('src/components/shared/InvoiceMarkSent.jsx')};
import InvoiceEmailIt from ${src('src/components/shared/InvoiceEmailIt.jsx')};
import Invoices from ${src('src/components/features/locum/Invoices.jsx')};
import { THEMES } from ${src('src/constants/themes.js')};
const h = React.createElement;
const T = THEMES.light;
const noop = () => {};
window.__app = { theme: T, isDesktop: false, data: { settings: {}, locumContracts: [], invoices: [] }, user: { id: "" }, limitedLaunch: {}, editItem: noop, deleteItem: noop, updateSection: noop };

// The invoice preview as Work log draws it: lines in a 300px box, the email
// button, Send and Copy, the line under them, then the question.
function Preview({ expose }) {
  const [ask, setAsk] = React.useState(null);
  expose.setAsk = setAsk;
  const big = { width: "100%", padding: "14px", borderRadius: 12, border: "1px solid " + T.border, fontSize: 15, fontWeight: 800, marginTop: 8 };
  return h(Modal, { open: true, onClose: noop, title: "Invoice preview" },
    h("div", { style: { height: 300, border: "1px solid " + T.inputBorder, borderRadius: 12, marginBottom: 14 } }, "INV-20261002-21 lines"),
    InvoiceEmailIt({ T, onClick: noop, other: "Send invoice… or Copy", primary: true }),
    h("div", { style: { display: "flex", gap: 8, marginTop: 8 } }, h("button", { style: { ...big, flex: 2 } }, "Send invoice…"), h("button", { style: { ...big, flex: 1 } }, "Copy")),
    h("div", { style: { fontSize: 12, marginTop: 8, textAlign: "center" } }, "Sending marks these entries as billed."),
    InvoiceMarkSent({ T, iS: {}, pending: null, note: null, form: null, setForm: noop, start: null, today: "2026-10-02", waiting: false,
      onRecordPending: noop, onRecordMarked: noop, ask, onYes: noop, onNo: noop }));
}

// The phone shell: a scroller with the sticky 56px top bar and a fixed tab bar.
function Shell({ expose }) {
  const [list, setList] = React.useState([]);
  expose.setList = setList;
  return h(React.Fragment, null,
    h("div", { "data-scroller": "", style: { height: "100%", overflowY: "auto" } },
      h("div", { "data-topbar": "", style: { position: "sticky", top: 0, zIndex: 50, height: 56, background: T.card, borderBottom: "1px solid " + T.border } }, "Work"),
      h("div", { style: { padding: "16px 16px 0", paddingBottom: 80 } },
        h("div", { style: { height: 700, background: T.input } }, "Timer and today's entries"),
        UnrecordedNotes({ T, list, what: "its entries", onForget: noop, onConfirm: noop, items: "entries" }),
        h("div", { style: { height: 900 } }, "Entries"))),
    h("div", { "data-tabbar": "", style: { position: "fixed", bottom: 0, left: 0, width: "100%", height: 64, background: T.tabBar || "#fff", borderTop: "1px solid " + T.border } }, "Tabs"));
}

window.__run = {
  preview() {
    const expose = {};
    const host = document.body.appendChild(document.createElement("div"));
    flushSync(() => createRoot(host).render(h(Preview, { expose })));
    window.__preview = expose;
  },
  shell() {
    document.documentElement.style.height = "100%"; document.body.style.height = "100%"; document.body.style.margin = "0";
    const expose = {};
    const host = document.body.appendChild(document.createElement("div"));
    host.style.height = "100%";
    flushSync(() => createRoot(host).render(h(Shell, { expose })));
    window.__shell = expose;
  },
  invoices(invoices, contracts) {
    window.__app.data = { settings: {}, locumContracts: contracts, invoices, workLog: [], dutyDays: [], travelExpenses: [], documents: [] };
    const host = document.body.appendChild(document.createElement("div"));
    host.style.padding = "16px";
    flushSync(() => createRoot(host).render(h(Invoices, { onOpenContract: noop, onOpenExpenses: noop })));
  },
};
`;

const STUBS = {
  'context/AppContext': 'export const useApp = () => window.__app; export const useNotifications = () => ({});',
  'lib/supabase': 'export const supabase = {}; export const downloadDocumentBlob = async () => null; export const downloadDocumentFile = async () => null; export const listSharedInvoiceNumbersRpc = () => null; export const markInvoiceNumberSharedRpc = () => null; export const readInvoiceRecordState = () => null; export const readInvoiceNumberRecorded = () => null; export const allocateInvoiceNumberRpc = () => null; export default {};',
};

async function bundle() {
  const { build } = await import('esbuild');
  const dir = resolve(root, 'node_modules/.cache/credentialdomd-webkit-ask-in-view');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `bundle-${process.pid}.js`);
  const keys = Object.keys(STUBS);
  await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: 'jsx' }, bundle: true, outfile: out, format: 'iife', platform: 'browser',
    target: 'safari16', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"', __APP_BUILD_ID__: '"test"' },
    loader: { '.js': 'jsx' }, jsx: 'automatic', logLevel: 'error',
    plugins: [{ name: 'synthetic', setup(b) {
      b.onResolve({ filter: /(context\/AppContext|lib\/supabase)(\.jsx?)?$/ }, ({ path }) => ({ path: keys.find(k => path.replace(/\.jsx?$/, '').endsWith(k)), namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: STUBS[path], loader: 'js' }));
    } }],
  });
  return readFileSync(out);
}

// The installed app's safe areas on an iPhone with a Dynamic Island (62px
// top, 34px home indicator), which a desktop WebKit reports as 0: the
// dialog's own rules with env() replaced by those numbers, so the preview has
// the height it has on the phone.
const SAFE_AREAS = '<style>[data-modal-overlay]{padding:78px 0 50px !important}[role=dialog]{max-height:calc(100dvh - 62px - 34px - 32px) !important}</style>';

async function withPhone(fn) {
  const js = await bundle();
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(js); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>t</title>' + SAFE_AREAS + '<body style="margin:0;font-family:-apple-system,system-ui,sans-serif"><script src="/bundle.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await fn(page);
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
}

const shot = async (page, name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${name}.png`) }); } };
// Smooth scrolling: wait until the scroller has stopped moving.
const still = (page, sel) => page.waitForFunction((s) => {
  const el = document.querySelector(s);
  const now = el.scrollTop;
  const was = el.__last;
  el.__last = now;
  return was === now;
}, sel, { polling: 150, timeout: 5000 });

test('real WebKit at 390x844: the preview question comes into view with Yes and No above the fold', { skip, timeout: 120_000 }, async () => {
  await withPhone(async (page) => {
    await page.evaluate(() => window.__run.preview());
    await page.evaluate(() => window.__preview.setAsk({ number: 'INV-20261002-21' }));
    // Where No would sit with nothing scrolled: below the fold. This is the case.
    const before = await page.evaluate(() => {
      const body = document.querySelector('[data-modal-body]');
      const no = [...document.querySelectorAll('button')].find(b => b.textContent === 'No, it did not go out');
      return { noBottomUnscrolled: no.getBoundingClientRect().bottom + body.scrollTop, bodyBottom: body.getBoundingClientRect().bottom };
    });
    assert.ok(before.noBottomUnscrolled > before.bodyBottom, `No sits below the fold unscrolled (${before.noBottomUnscrolled} > ${before.bodyBottom})`);
    await still(page, '[data-modal-body]');
    const after = await page.evaluate(() => {
      const body = document.querySelector('[data-modal-body]').getBoundingClientRect();
      const rect = (t) => [...document.querySelectorAll('button, div')].find(b => b.textContent === t || (b.tagName === 'DIV' && b.textContent === t)).getBoundingClientRect();
      const title = [...document.querySelectorAll('div')].find(d => d.textContent === 'Did INV-20261002-21 go out?').getBoundingClientRect();
      return { body: { top: body.top, bottom: body.bottom }, title: title.top, yes: rect('Yes, it was sent'), no: rect('No, it did not go out'), scrollTop: document.querySelector('[data-modal-body]').scrollTop, vh: innerHeight };
    });
    await shot(page, 'preview-ask');
    assert.ok(after.scrollTop > 0, 'the preview scrolled');
    assert.ok(after.title >= after.body.top, 'the question is in view');
    for (const [name, r] of [['Yes', after.yes], ['No', after.no]]) {
      assert.ok(r.top >= after.body.top && r.bottom <= after.body.bottom && r.bottom <= after.vh, `${name} is fully visible (${r.top}-${r.bottom} in ${after.body.top}-${after.body.bottom})`);
    }
  });
});

test('real WebKit at 390x844: a reminder below the fold comes into view clear of the top bar and the tab bar', { skip, timeout: 120_000 }, async () => {
  await withPhone(async (page) => {
    await page.evaluate(() => window.__run.shell());
    await page.evaluate(() => window.__shell.setList([{ number: 'INV-20261002-22', sentAt: '2026-10-02T15:00:00Z', total: 2000, handed: true }]));
    await still(page, '[data-scroller]');
    const r = await page.evaluate(() => {
      const box = [...document.querySelectorAll('[role=status]')].find(d => d.textContent.includes('INV-20261002-22 is not recorded')).getBoundingClientRect();
      const no = [...document.querySelectorAll('button')].find(b => b.textContent === 'No, it did not go out').getBoundingClientRect();
      return { box: { top: box.top, bottom: box.bottom }, no: { bottom: no.bottom }, top: document.querySelector('[data-topbar]').getBoundingClientRect().bottom, tab: document.querySelector('[data-tabbar]').getBoundingClientRect().top, scrollTop: document.querySelector('[data-scroller]').scrollTop };
    });
    await shot(page, 'worklog-reminder');
    assert.ok(r.scrollTop > 0, 'the screen scrolled to it');
    assert.ok(r.box.top >= r.top, `under the top bar, not behind it (${r.box.top} >= ${r.top})`);
    assert.ok(r.box.bottom <= r.tab && r.no.bottom <= r.tab, `above the tab bar, not behind it (${r.box.bottom} <= ${r.tab})`);
  });
});

test('real WebKit at 390x844: the Invoices status badge stays on one line', { skip, timeout: 120_000 }, async () => {
  await withPhone(async (page) => {
    const contracts = [{ id: 'c-s', facility: 'Synthetic Regional Medical Center', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 2000 }];
    const sentAt = new Date().toISOString();
    // Amounts from $5 to $18,225: some leave room for "OWED" and not "· 0D".
    const amounts = [5, 50, 500, 2000, 4500, 18225];
    const invoices = amounts.map((a, i) => ({ id: `i${i}`, number: `INV-20261002-${30 + i}`, contractId: 'c-s', totalAmount: a, sentAt, payments: [] }));
    await page.evaluate(([inv, c]) => window.__run.invoices(inv, c), [invoices, contracts]);
    const badges = await page.evaluate(() => [...document.querySelectorAll('span')].filter(s => /^owed · \d+d$/i.test(s.textContent)).map(s => {
      const line = parseFloat(getComputedStyle(s).lineHeight) || s.getBoundingClientRect().height;
      const lines = s.getClientRects().length;
      const row = s.parentElement;
      const left = s.getBoundingClientRect().left - row.getBoundingClientRect().left;
      const top = s.getBoundingClientRect().top - row.getBoundingClientRect().top;
      // The old badge, measured in place: inline in a text line, free to wrap.
      const was = { row: row.getAttribute('style'), s: s.getAttribute('style') };
      row.style.display = 'block'; s.style.display = 'inline'; s.style.whiteSpace = 'normal'; s.style.marginLeft = '8px';
      row.children[1].style.marginLeft = '8px';
      const oldLines = s.getClientRects().length;
      row.setAttribute('style', was.row); s.setAttribute('style', was.s); row.children[1].style.marginLeft = '';
      return { text: s.textContent, lines, height: s.getBoundingClientRect().height, line, oldLines, left, top };
    }));
    await shot(page, 'invoices-badges');
    assert.equal(badges.length, amounts.length);
    assert.ok(badges.some(b => b.oldLines > 1), `the old badge did break over two lines here: this is the case (${badges.map(b => b.oldLines)})`);
    for (const b of badges) {
      assert.equal(b.lines, 1, `${b.text} is one box`);
      assert.ok(b.height < 24, `${b.text} is one line tall (${b.height}px)`);
      // On a line of its own it starts flush with the invoice number.
      if (b.top > 4) assert.ok(b.left < 1, `a wrapped badge starts flush left (${b.left}px)`);
    }
  });
});
