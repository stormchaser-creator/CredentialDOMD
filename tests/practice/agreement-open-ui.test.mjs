import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// PRAC-017: an attached agreement opens from account storage when its bytes
// are not on this device (a fresh device, or a background download that
// failed), instead of a tap that does nothing next to "syncing…" forever.
// Synthetic files only.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { Contracts, ContractSummary } = await loadScreens('export {default as Contracts} from "./src/components/features/locum/Contracts.jsx"; export {default as ContractSummary} from "./src/components/features/locum/ContractSummary.jsx";');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const CONTRACT = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, incrementMinutes: 15, minCallMinutes: 15 };
const PDF = { id: 'a1', name: 'signed-agreement.pdf', type: 'application/pdf', linkedTo: 'locumContracts:c1', storagePath: 'u/a1.pdf' };
const PHOTO = { id: 'a2', name: 'page-1.jpg', type: 'image/jpeg', linkedTo: 'locumContracts:c1', storagePath: 'u/a2.jpg' };

const openSummary = (docs, { download, online = true } = {}) => {
  const m = mount(Contracts, { data: { locumContracts: [CONTRACT], documents: docs } });
  const downloads = [];
  globalThis.__screen.download = async (p) => { downloads.push(p); return download ? download(p) : null; };
  const opened = [];
  globalThis.window.open = (url) => { const w = { url, location: { href: url }, closed: false, close() { this.closed = true; } }; opened.push(w); return w; };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: online } });
  find(m.render(), n => n.type === 'div' && typeof n.props.onClick === 'function' && textOf(n).includes('summary ›'), 'summary link').props.onClick();
  const summary = () => find(m.render(), n => typeof n.type === 'function' && 'onOpenDoc' in (n.props || {}), 'summary');
  return { m, downloads, opened, summary };
};

test('a PDF not on this device is downloaded from storage and opened', async () => {
  const s = openSummary([PDF], { download: async () => new Blob(['%PDF-1.4 synthetic'], { type: 'application/pdf' }) });
  await s.summary().props.onOpenDoc(PDF);
  await settle();
  assert.deepEqual(s.downloads, ['u/a1.pdf']);
  assert.equal(s.opened.length, 1, 'the window opens in the tap, before the download');
  assert.match(s.opened[0].location.href, /^blob:/);
});

test('an image not on this device opens in the viewer from storage', async () => {
  // The viewer listens for Escape on the document.
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  try {
    const s = openSummary([PHOTO], { download: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }) });
    await s.summary().props.onOpenDoc(PHOTO);
    await settle();
    const img = find(s.m.render(), n => n.type === 'img' && n.props.alt === 'page-1.jpg', 'viewer image');
    assert.match(img.props.src, /^blob:/);
  } finally { delete globalThis.document; }
});

test('offline, the tap says why instead of doing nothing', async () => {
  const s = openSummary([PDF], { online: false });
  await s.summary().props.onOpenDoc(PDF);
  await settle();
  assert.equal(s.opened.every(w => w.closed), true, 'the blank window is closed again');
  assert.equal(s.summary().props.openError, 'signed-agreement.pdf could not be opened: you are offline.');
});

test('a second tap while the download runs does not start another', async () => {
  let release;
  const s = openSummary([PDF], { download: () => new Promise(r => { release = () => r(new Blob(['%PDF'], { type: 'application/pdf' })); }) });
  const first = s.summary().props.onOpenDoc(PDF);
  await settle();
  const second = s.summary().props.onOpenDoc(PDF);
  release();
  await Promise.all([first, second]);
  assert.equal(s.downloads.length, 1);
});

test('the summary row can be tapped whenever the file is in storage, and shows why one could not open', () => {
  const m = mount(ContractSummary, { data: {}, props: { contract: CONTRACT, docs: [PDF, { ...PHOTO, storagePath: null }], onOpenDoc() {}, openingId: null } });
  const rows = nodes(m.render()).filter(n => n.type === 'button' && n.key);
  assert.equal(textOf(rows[0]).endsWith('view'), true, textOf(rows[0]));
  assert.equal(rows[0].props.style.cursor, 'pointer');
  assert.match(textOf(rows[1]), /not uploaded/);
  const busy = mount(ContractSummary, { data: {}, props: { contract: CONTRACT, docs: [PDF], onOpenDoc() {}, openingId: 'a1' } });
  assert.match(textOf(nodes(busy.render()).find(n => n.type === 'button' && n.key)), /opening…/);
  const failed = mount(ContractSummary, { data: {}, props: { contract: CONTRACT, docs: [PDF], onOpenDoc() {}, openError: 'signed-agreement.pdf could not be opened: you are offline.' } });
  assert.match(textOf(failed.render()), /could not be opened: you are offline\./);
});
