import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { nodes, textOf } from '../harness/component-harness.mjs';
import { invoiceDays } from '../../src/utils/invoiceLayout.js';
import { NORTHFIELD, NORTHFIELD_CONTRACT } from '../billing/fixtures/northfield.mjs';

// A paused account's "Download invoice PDF" (ReadOnlyRecords.jsx) builds the
// invoice from the saved record like a resend does. Its lines were saved
// before the day layout, so they do not say when the call day starts: the
// arguments must carry the agreement's hour, or the PDF prints a 7:00 AM
// window over rows the engine filed by another hour. The PDF writer and the
// download are swapped for recorders; the account is synthetic.

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Archive} from "./src/components/features/ReadOnlyRecords.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'recorded-download', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/(credentialExport|invoicePdf)$/ }, () => ({ path: 'downloads', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__archive.app;'
      : path === 'database' ? 'export const COLLECTION_KEYS = ["invoices"]; export const downloadDocumentFile = () => { throw Error("No network"); };'
        : 'export const downloadBlob = (file, name) => { globalThis.__archive.saved.push(name); }; export const invoicePdfFile = (args) => { globalThis.__archive.pdf.push(args); return { name: "invoice.pdf" }; }; export const invoiceTextPdfFile = invoicePdfFile;' }));
  } }],
});
const mod = { exports: {} };
const req = (name) => (name === 'react' ? { useState: (v) => [v, () => {}] } : require(name));
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(req, mod, mod.exports);
const { Archive } = mod.exports;

const download = (contracts) => {
  const record = { id: 'inv-northfield', number: 'INV-SYN-1', contractId: NORTHFIELD_CONTRACT.id, periodStart: '2026-09-25', periodEnd: '2026-09-28', totalAmount: NORTHFIELD.total, lines: NORTHFIELD.lines, sentAt: '2026-09-28T17:00:00Z' };
  globalThis.__archive = {
    app: { data: { settings: {}, invoices: [record], locumContracts: contracts }, theme: { text: '#111', textMuted: '#666', border: '#aaa', card: '#fff' }, navigate() {} },
    pdf: [], saved: [],
  };
  const button = nodes(Archive({ scope: 'practice' })).find((n) => n.type === 'button' && textOf(n) === 'Download invoice PDF');
  assert.ok(button, 'the download button');
  button.props.onClick();
  assert.deepEqual(globalThis.__archive.saved, ['invoice.pdf']);
  return globalThis.__archive.pdf[0];
};

test('a paused account\'s invoice download prints the agreement\'s call-day window, not a default 7:00 AM', () => {
  const args = download([{ ...NORTHFIELD_CONTRACT, dayStartHour: 8 }]);
  assert.equal(args.dayStartHour, 8);
  assert.equal(invoiceDays(args)[0].window, 'call day 8:00 AM Sep 25 to 8:00 AM Sep 26');
  // With the agreement gone there is no hour to read: no key, the default window.
  const orphan = download([]);
  assert.equal('dayStartHour' in orphan, false);
  assert.equal(invoiceDays(orphan)[0].window, 'call day 7:00 AM Sep 25 to 7:00 AM Sep 26');
});
