// The CME transcript and Home's renewal packet carry the certificates they
// promise: bytes that live only in cloud storage are fetched before the tap,
// PDF certificates travel as files in the same share, and anything not
// included is named as not included. Synthetic records and files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf8');

const T = await (async () => {
  const out = await build({ entryPoints: [`${root}src/utils/cmeTranscriptPdf.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();

const PDF_BYTES = '%PDF-1.4\n% synthetic certificate\n';
const pdfDataUrl = `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString('base64')}`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const data = () => ({
  settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: 'CO' },
  licenses: [{ id: 'lic', state: 'CO', type: 'State Medical License (MD)', licenseNumber: 'SYN-1', expirationDate: '2027-04-30' }],
  cme: [
    { id: 'c1', date: '2026-02-01', hours: 10, category: 'AMA PRA Category 1', title: 'Synthetic course one' },
    { id: 'c2', date: '2026-03-01', hours: 20, category: 'AMA PRA Category 1', title: 'Synthetic course two' },
    { id: 'c3', date: '2026-04-01', hours: 5, category: 'AMA PRA Category 1', title: 'Synthetic course three' },
  ],
  // Stripped by saveData: metadata and a storage path, no bytes on the device.
  documents: [
    { id: 'd-pdf', name: 'course-one.pdf', type: 'application/pdf', linkedTo: 'cme:c1', storagePath: 'user/d-pdf.pdf' },
    { id: 'd-png', name: 'course-two.png', type: 'image/png', linkedTo: 'cme:c2', storagePath: 'user/d-png.png' },
    { id: 'd-gone', name: 'course-three.pdf', type: 'application/pdf', linkedTo: 'cme:c3', storagePath: 'user/d-gone.pdf' },
  ],
});

const download = async (path) => {
  if (path.endsWith('d-pdf.pdf')) return new Blob([PDF_BYTES], { type: 'application/pdf' });
  if (path.endsWith('d-png.png')) return new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' });
  return null;
};

test('certificate bytes only in cloud storage are fetched ahead and classified by what they are', async () => {
  const d = data();
  const docs = T.certificateDocsForModels([T.stateTranscriptModel(d, 'CO')]);
  assert.deepEqual(docs.map(x => x.id), ['d-pdf', 'd-png', 'd-gone']);
  const certFiles = await T.prefetchCertificates(docs, { download, budgetMs: 5000 });
  const model = T.stateTranscriptModel(d, 'CO', { certFiles });
  assert.deepEqual(model.certs.map(c => [c.ref, c.mode]), [['Cert 1', 'pdf'], ['Cert 2', 'image'], ['Cert 3', 'remote']]);
  assert.equal(model.certs[0].doc.data.startsWith('data:application/pdf;base64,'), true);
  assert.equal(d.documents[0].data, undefined, 'nothing is written back into documents');
  const summary = T.certificateSummary(model);
  assert.deepEqual([summary.total, summary.pages, summary.files, summary.missing.length], [3, 1, 1, 1]);
  assert.match(T.certificatesNotIncludedMessage(model), /^1 certificate is not in this packet \(course-three\.pdf\) because they could not be read from your account storage\./);
});

test('without the fetch, a stripped certificate is not claimed as on file', () => {
  const model = T.stateTranscriptModel(data(), 'CO');
  assert.ok(model.certs.every(c => c.mode === 'remote'));
  const note = T.certificateIndexNote(model);
  assert.doesNotMatch(note, /on file in cloud storage/);
  assert.match(note, /Cert 1 = course-one\.pdf \(not included; available from the physician on request\)/);
  assert.ok(T.buildTranscriptPdf(model), 'and the PDF still builds');
});

test('the PDF certificate is shared as a separate file with the transcript, named by its index ref', async () => {
  const d = data();
  const certFiles = await T.prefetchCertificates(T.certificateDocsForModels([T.stateTranscriptModel(d, 'CO')]), { download });
  const model = T.stateTranscriptModel(d, 'CO', { certFiles });
  const shared = [];
  const nav = { canShare: ({ files }) => files.every(f => f.type === 'application/pdf'), share: async ({ files }) => { shared.push(...files); } };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  try {
    assert.equal((await T.shareTranscriptPdf(model)).method, 'share');
  } finally {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator;
  }
  assert.deepEqual(shared.map(f => f.name), [model.fileName, 'Cert 1 - course-one.pdf']);
  assert.equal(Buffer.from(await shared[1].arrayBuffer()).toString(), PDF_BYTES);
});

test('the transcript index says the PDF certificate went as a separate file', () => {
  const d = data();
  d.documents[0].data = pdfDataUrl;
  const model = T.stateTranscriptModel(d, 'CO');
  assert.match(T.certificateIndexNote({ ...model, pdfDelivery: 'share' }), /Cert 1 = course-one\.pdf \(sent as a separate PDF file with this transcript\)/);
  assert.doesNotMatch(T.certificateIndexNote({ ...model, pdfDelivery: 'omitted' }), /sent as a separate PDF file/);
  assert.doesNotMatch(T.certificateIndexNote(model), /PDF on file\)/, 'never the old "PDF on file"');
});

test('the CME picker and Home fetch before the tap, never inside it', () => {
  const cme = read('src/components/features/CMESection.jsx');
  assert.match(cme, /prefetchCertificates\(docs, \{ download: downloadDocumentBlob/);
  assert.match(cme, /stateTranscriptModel\(data, st, \{ certFiles \}\)/);
  assert.doesNotMatch(cme, /runTranscript\(stateTranscriptModel\(data, allTrackedStates\[0\]\)\)/, 'the one-state shortcut goes through the picker');
  const app = read('src/App.jsx');
  assert.match(app, /stateTranscriptModel\(data, st, \{ certFiles: packetCerts \}\)/);
  const send = app.slice(app.indexOf('const sendRenewalPacket'), app.indexOf('const openShare'));
  assert.doesNotMatch(send, /prefetchCertificates|downloadDocument/);
});

// ── Review fixes (QA cred-home, 2026-09-29) ───────────────────────────────

// A browser stand-in: the share sheet is `nav`, and each download (an
// <a download> click) is recorded by file name and bytes.
async function inBrowser(t, nav, fn) {
  const downloads = [];
  const blobs = new Map();
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevCreate = URL.createObjectURL;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => ({ click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); } }) },
    configurable: true,
  });
  URL.createObjectURL = (blob) => { const u = `blob:synthetic/${blobs.size}`; blobs.set(u, blob); return u; };
  // downloadFile revokes its object URL on a 10 s timer; do not hold the test for it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    return { result: await fn(), downloads };
  } finally {
    t.mock.timers.reset();
    URL.createObjectURL = prevCreate;
    if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav); else delete globalThis.navigator;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc); else delete globalThis.document;
  }
}

const refusal = (name) => Object.assign(new Error(`synthetic ${name}`), { name });

// The text a built transcript PDF prints: jsPDF deflates each content stream
// and writes text as literal strings, so inflate the streams and join the
// strings. Whitespace is collapsed, since the index wraps across lines.
async function pdfText(blob) {
  const { inflateSync } = await import('node:zlib');
  const raw = Buffer.from(await blob.arrayBuffer());
  const out = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf('stream\n', at);
    if (start < 0) break;
    const end = raw.indexOf('\nendstream', start);
    const body = raw.subarray(start + 7, end);
    try { out.push(inflateSync(body).toString('latin1')); } catch { out.push(body.toString('latin1')); }
    at = end + 10;
  }
  const strings = [...out.join('\n').matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map(m => m[1].replace(/\\([()\\])/g, '$1'));
  return strings.join(' ').replace(/\s+/g, ' ');
}

for (const name of ['NotAllowedError', 'DataError']) {
  test(`a share that fails with ${name} after the build still delivers the PDF certificates the transcript promises`, async (t) => {
    const d = data();
    const certFiles = await T.prefetchCertificates(T.certificateDocsForModels([T.stateTranscriptModel(d, 'CO')]), { download });
    const model = T.stateTranscriptModel(d, 'CO', { certFiles });
    // iOS: canShare accepts the transcript and the certificate together, and
    // then the share itself is refused (the tap's gesture has expired).
    const nav = { canShare: () => true, share: async () => { throw refusal(name); } };
    const { result, downloads } = await inBrowser(t, nav, () => T.shareTranscriptPdf(model));
    assert.equal(result.method, 'download');
    // The transcript was built saying the certificate went with it ...
    assert.match(T.certificateIndexNote(result.model), /Cert 1 = course-one\.pdf \(sent as a separate PDF file with this transcript\)/);
    // ... so it has to: both files are downloaded, the certificate intact.
    assert.deepEqual(downloads.map(x => x.name), [model.fileName, 'Cert 1 - course-one.pdf']);
    assert.equal(Buffer.from(await downloads[1].blob.arrayBuffer()).toString(), PDF_BYTES);
    // And the physician is told only about the one that truly is not there.
    assert.match(T.certificatesNotIncludedMessage(result.model), /^1 certificate is not in this packet \(course-three\.pdf\)/);
  });
}

test('a cancelled share sheet sends nothing and downloads nothing', async (t) => {
  const d = data();
  const certFiles = await T.prefetchCertificates(T.certificateDocsForModels([T.stateTranscriptModel(d, 'CO')]), { download });
  const model = T.stateTranscriptModel(d, 'CO', { certFiles });
  const nav = { canShare: () => true, share: async () => { throw refusal('AbortError'); } };
  const { result, downloads } = await inBrowser(t, nav, () => T.shareTranscriptPdf(model));
  assert.equal(result, null);
  assert.deepEqual(downloads, []);
});

test('PDF certificates a share sheet cannot carry with the transcript are named as not included', async (t) => {
  const d = data();
  const certFiles = await T.prefetchCertificates(T.certificateDocsForModels([T.stateTranscriptModel(d, 'CO')]), { download });
  const model = T.stateTranscriptModel(d, 'CO', { certFiles });
  // Before the share: the picker counts the PDF as a file to send.
  assert.equal(T.certificateSummary(model).files, 1);
  const shared = [];
  // The share sheet takes one file, never the transcript plus certificates.
  const nav = { canShare: ({ files }) => files.length === 1, share: async ({ files }) => { shared.push(...files); } };
  const { result } = await inBrowser(t, nav, () => T.shareTranscriptPdf(model));
  assert.equal(result.method, 'share');
  assert.deepEqual(shared.map(f => f.name), [model.fileName]);
  assert.equal(result.model.pdfDelivery, 'omitted');
  assert.match(T.certificateIndexNote(result.model), /Cert 1 = course-one\.pdf \(not included; available from the physician on request\)/);
  const msg = T.certificatesNotIncludedMessage(result.model);
  assert.match(msg, /^2 certificates are not in this packet \(course-one\.pdf, course-three\.pdf\)/);
  assert.match(msg, /the share sheet on this device could not carry them with the transcript/);
  assert.equal(T.certificateSummary(result.model).files, 0);
});

test('a photo certificate this device cannot convert is counted as "may not convert", then named as not included', async (t) => {
  const d = data();
  d.documents = [{ id: 'd-heic', name: 'course-two.heic', type: 'image/heic', linkedTo: 'cme:c2', data: `data:image/heic;base64,${Buffer.from('synthetic heic').toString('base64')}` }];
  const model = T.stateTranscriptModel(d, 'CO');
  assert.equal(model.certs[0].mode, 'convert');
  const before = T.certificateSummary(model);
  assert.deepEqual([before.pages, before.mayNotConvert, before.missing.length], [0, 1, 0], 'not promised as a page before the build');
  // Desktop Chrome or Firefox: no share sheet for files, and no HEIC decoder
  // (here, no Image at all), so the photo stays unconverted.
  const { result, downloads } = await inBrowser(t, { canShare: () => false }, () => T.shareTranscriptPdf(model));
  assert.equal(result.method, 'download');
  assert.deepEqual(downloads.map(x => x.name), [model.fileName]);
  assert.match(T.certificateIndexNote(result.model), /Cert 1 = course-two\.heic \(not included; available from the physician on request \(image format could not be embedded\)\)/);
  assert.match(T.certificatesNotIncludedMessage(result.model),
    /^1 certificate is not in this packet \(course-two\.heic\) because this device could not convert the photo format to a page\. Open it from Documents to send separately\.$/);
});

test('only the certificates of entries inside the windows on offer are fetched', () => {
  const d = data();
  // Years-old CME with its certificate: outside the CO window.
  d.cme.push({ id: 'c-old', date: '2019-05-01', hours: 12, category: 'AMA PRA Category 1', title: 'Synthetic old course' });
  d.documents.push({ id: 'd-old', name: 'old-course.pdf', type: 'application/pdf', linkedTo: 'cme:c-old', storagePath: 'user/d-old.pdf' });
  // A certificate never uploaded cannot be fetched; one already on the device need not be.
  d.documents.push({ id: 'd-local', name: 'local.pdf', type: 'application/pdf', linkedTo: 'cme:c3', data: pdfDataUrl });
  d.documents.push({ id: 'd-never', name: 'never.pdf', type: 'application/pdf', linkedTo: 'cme:c3' });
  const model = T.stateTranscriptModel(d, 'CO');
  const ids = T.certificateDocsForModels([model, model]).map(x => x.id);
  assert.deepEqual(ids, ['d-pdf', 'd-png', 'd-gone']);
});

test('a download that never answers is cut off at the budget as "timeout", and its request aborted', { timeout: 5000 }, async () => {
  const signals = [];
  const stalled = (path, { signal } = {}) => { signals.push(signal); return new Promise(() => {}); };
  const started = Date.now();
  const got = await T.prefetchCertificates([
    { id: 'a', name: 'a.pdf', storagePath: 'user/a.pdf' },
    { id: 'b', name: 'b.pdf', storagePath: 'user/b.pdf' },
  ], { download: stalled, budgetMs: 60 });
  assert.ok(Date.now() - started < 2000, 'returns at the budget, not never');
  // By id: the two budgets can fire in either order under load.
  assert.deepEqual([...got].map(([id, r]) => [id, r.reason]).sort(), [['a', 'timeout'], ['b', 'timeout']]);
  assert.ok(signals.length === 2 && signals.every(s => s?.aborted), 'the stalled requests are aborted');
});

test('a slow certificate does not stop the others from arriving within the budget', { timeout: 5000 }, async () => {
  const slowThenFast = (path) => path.endsWith('slow.pdf') ? new Promise(() => {}) : Promise.resolve(new Blob([PDF_BYTES], { type: 'application/pdf' }));
  const got = await T.prefetchCertificates([
    { id: 'slow', name: 'slow.pdf', type: 'application/pdf', storagePath: 'user/slow.pdf' },
    { id: 'fast', name: 'fast.pdf', type: 'application/pdf', storagePath: 'user/fast.pdf' },
  ], { download: slowThenFast, budgetMs: 80 });
  assert.equal(got.get('slow').reason, 'timeout');
  assert.ok(got.get('fast').data.startsWith('data:application/pdf;base64,'));
});

test('Home fetches a timed-out or offline certificate again later, and a fetched or unreadable one never twice', () => {
  const tr = T.certificateFetchTracker();
  const docs = ['ok', 'slow', 'off', 'gone'].map(id => ({ id }));
  assert.deepEqual(tr.toFetch(docs).map(d => d.id), ['ok', 'slow', 'off', 'gone']);
  tr.started(docs);
  assert.deepEqual(tr.toFetch(docs), [], 'nothing in flight is fetched twice');
  tr.finished(docs, new Map([['ok', { data: 'data:application/pdf;base64,' }], ['slow', { reason: 'timeout' }], ['off', { reason: 'offline' }], ['gone', { reason: 'unavailable' }]]));
  assert.deepEqual(tr.toFetch(docs), [], 'not again on the same visit');
  tr.retryLater(); // the next visit to Home, or the connection coming back
  assert.deepEqual(tr.toFetch(docs).map(d => d.id), ['slow', 'off']);
  tr.started([{ id: 'slow' }]);
  tr.finished([{ id: 'slow' }], null); // the fetch itself failed
  tr.retryLater();
  assert.deepEqual(tr.toFetch(docs).map(d => d.id), ['slow', 'off']);
});

test('the picker lets a tap build with what has arrived, and Home fetches only in-window certificates and retries', () => {
  const cme = read('src/components/features/CMESection.jsx');
  assert.match(cme, /certificateDocsForModels\(\[/);
  assert.doesNotMatch(cme, /disabled=\{transcriptBusy \|\| certsPreparing\}/, 'buttons are not held while certificates download');
  assert.match(cme, /certificatesNotIncludedMessage\(sent\.model\)/);
  const app = read('src/App.jsx');
  assert.match(app, /certificateDocsForModels\(allTrackedStates\.map\(st => stateTranscriptModel\(data, st\)\)\)/);
  assert.doesNotMatch(app, /certificateDocsToFetch/);
  assert.match(app, /window\.addEventListener\("online", again\)/);
  assert.match(app, /certificatesNotIncludedMessage\(sent\.model\)/);
  assert.match(app, /method: sent\.method/);
  assert.match(read('src/lib/supabase.js'), /download\(storagePath, \{\}, signal \? \{ signal \} : undefined\)/);
});

// A share that fails after the build on a device that takes one download at
// a time (iOS, iPadOS): the certificates cannot follow the transcript as
// downloads, so the transcript it downloads is rebuilt to list them as not
// included, and the physician is told why.
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
for (const [device, nav] of [['an iPhone', { userAgent: IPHONE }], ['an iPad (which reports itself as a Mac)', { userAgent: IPAD, maxTouchPoints: 5 }]]) {
  test(`on ${device}, a failed share downloads a transcript that lists the PDF certificates as not included, and says so`, async (t) => {
    const d = data();
    const certFiles = await T.prefetchCertificates(T.certificateDocsForModels([T.stateTranscriptModel(d, 'CO')]), { download });
    const model = T.stateTranscriptModel(d, 'CO', { certFiles });
    const ios = { ...nav, canShare: () => true, share: async () => { throw refusal('NotAllowedError'); } };
    const { result, downloads } = await inBrowser(t, ios, () => T.shareTranscriptPdf(model));
    assert.equal(result.method, 'download');
    assert.deepEqual(downloads.map(x => x.name), [model.fileName], 'only the transcript leaves the device');
    assert.equal(result.model.pdfDelivery, 'omitted');
    // The PDF that was downloaded prints what actually left the device.
    const printed = await pdfText(downloads[0].blob);
    assert.match(printed, /Cert 1 = course-one\.pdf \(not included; available from the physician on request\)/);
    assert.doesNotMatch(printed, /sent as a separate PDF file/);
    const msg = T.certificatesNotIncludedMessage(result.model);
    assert.match(msg, /^2 certificates are not in this packet \(course-one\.pdf, course-three\.pdf\)/);
    assert.match(msg, /the share sheet did not open and this device downloads only one file at a time/);
    assert.equal(T.certificateSummary(result.model).files, 0);
  });
}

test('where a failed share falls back to downloads, the printed transcript says the PDF certificate went with it', async (t) => {
  const d = data();
  const certFiles = await T.prefetchCertificates(T.certificateDocsForModels([T.stateTranscriptModel(d, 'CO')]), { download });
  const model = T.stateTranscriptModel(d, 'CO', { certFiles });
  // A desktop share sheet that takes one file at a time, then refuses the share.
  const nav = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0', canShare: ({ files }) => files.length === 1, share: async () => { throw refusal('NotAllowedError'); } };
  const { result, downloads } = await inBrowser(t, nav, () => T.shareTranscriptPdf(model));
  assert.equal(result.model.pdfDelivery, 'download');
  assert.deepEqual(downloads.map(x => x.name), [model.fileName, 'Cert 1 - course-one.pdf']);
  // Built for the share as "not included"; rebuilt, because the download carries it.
  assert.match(await pdfText(downloads[0].blob), /Cert 1 = course-one\.pdf \(sent as a separate PDF file with this transcript\)/);
  assert.match(T.certificatesNotIncludedMessage(result.model), /^1 certificate is not in this packet \(course-three\.pdf\)/);
});
