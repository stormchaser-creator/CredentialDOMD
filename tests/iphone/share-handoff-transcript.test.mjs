// CRED-011 and HOME-017 on the installed iPhone app (QA lab, WebKit + the iOS
// model): the CME transcript and Home's renewal packet went to Mail, the
// share sheet's promise never settled, and
//  - CME Credits stayed on a disabled "Building PDF" (picker locked too)
//    until the app was reloaded;
//  - the renewal packet was never recorded in share_log, and the alert naming
//    a certificate left out never showed.
// shareTranscriptPdf now reports the hand-off as the file goes. Synthetic
// records and files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const T = await (async () => {
  const out = await build({ entryPoints: [`${root}src/utils/cmeTranscriptPdf.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();

const data = () => ({
  settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: 'CO' },
  licenses: [{ id: 'lic', state: 'CO', type: 'State Medical License (MD)', licenseNumber: 'SYN-1', expirationDate: '2027-04-30' }],
  cme: [{ id: 'c1', date: '2026-02-01', hours: 10, category: 'AMA PRA Category 1', title: 'Synthetic course one' }],
  // A certificate whose bytes never arrived: named as not included.
  documents: [{ id: 'd-gone', name: 'course-one.pdf', type: 'application/pdf', linkedTo: 'cme:c1', storagePath: 'user/d-gone.pdf' }],
});

async function withNav(nav, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  try { return await fn(); } finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
}
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

test('a share sheet that never answers: the hand-off is reported with what went, before any answer', async () => {
  const certFiles = await T.prefetchCertificates(T.certificateDocsForModels([T.stateTranscriptModel(data(), 'CO')]), { download: async () => null });
  const model = T.stateTranscriptModel(data(), 'CO', { certFiles });
  const handed = [];
  let returned = false;
  await withNav({ canShare: () => true, share: () => new Promise(() => {}) }, async () => {
    T.shareTranscriptPdf(model, { onHanded: (h) => handed.push(h) }).then(() => { returned = true; });
    await settle();
  });
  assert.equal(returned, false, 'the share never answered');
  assert.equal(handed.length, 1);
  assert.equal(handed[0].method, 'share');
  assert.match(T.certificatesNotIncludedMessage(handed[0].model), /^1 certificate is not in this packet \(course-one\.pdf\)/, 'what is missing is known at hand-off');
});

test('a cancel is reported to undo; a share refused because another is open says so', async () => {
  const model = T.stateTranscriptModel(data(), 'CO', { certFiles: new Map() });
  const undone = [];
  const result = await withNav({ canShare: () => true, share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } },
    () => T.shareTranscriptPdf(model, { onHanded() {}, onUndo: (o) => undone.push(o) }));
  assert.equal(result, null);
  assert.deepEqual(undone, ['cancelled']);
  await withNav({ canShare: () => true, share: async () => { throw Object.assign(new Error('x'), { name: 'InvalidStateError' }); } }, async () => {
    await assert.rejects(T.shareTranscriptPdf(model), e => e.name === 'ShareBusy' && /A share sheet is still open/.test(e.message));
  });
});

test('CME Credits and Home act at hand-off: the busy state and picker clear, the packet is logged, the missing certificates are told', () => {
  const cme = readFileSync(`${root}src/components/features/CMESection.jsx`, 'utf8');
  const run = cme.slice(cme.indexOf('const runTranscript = useCallback'), cme.indexOf('const openTranscript'));
  assert.match(run, /onHanded: \(\{ model: going \}\) => \{[\s\S]*?flash\(`Transcript PDF is in the share sheet\.[\s\S]*?setShowTranscript\(false\);\s+setTranscriptBusy\(false\);/);
  const app = readFileSync(`${root}src/App.jsx`, 'utf8');
  const send = app.slice(app.indexOf('const sendRenewalPacket = useCallback'), app.indexOf('const openShare = useCallback'));
  assert.match(send, /onHanded: \(\{ model: going \}\) => \{\s+logId = generateId\(\);\s+addItem\("shareLog", \{ id: logId, itemId: null, itemName: `\$\{st\} renewal packet`, section: "cme", method: "share"/);
  assert.match(send, /missingNote = certificatesNotIncludedMessage\(going\);/);
  assert.match(send, /onUnanswered: tell,/, 'told once he is back in the app, even if the sheet never answers');
  assert.match(send, /onUndo: \(\) => \{ if \(logId\) deleteItem\("shareLog", logId\);/);
});
