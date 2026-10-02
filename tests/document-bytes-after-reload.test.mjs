// QA lab DOCS-008 and DOCS-009 (release/goal2 at 940ca370, 2026-10-02):
// after a reload, Documents showed "Fetching the file from your account." for
// good under every stored file, though Storage answered each download 200.
//
// The mechanism, reproduced in the lab with the download held until the
// second load had begun: a screen asks for the bytes of the files it shows
// (AppContext requestDocumentBytes). The download was tied to the load that
// was current when it asked. The membership answer starts a second load a
// moment after the first (AppContext reconciledAccess), the bytes that landed
// after it began were thrown away, and the screen's list of files had not
// changed, so it never asked again. Any load did the same: the app back in
// front, back online, the identity retry.
//
// Runs AppContext's own code (cut from the source) on a small hook runtime:
// the byte requests and the load reconciler, with the downloads answered by
// the test. APPCONTEXT_SOURCE_FILE runs it against another version of the
// file. Synthetic documents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDocumentBytes } from '../src/utils/documentBytes.js';

const source = await readFile(process.env.APPCONTEXT_SOURCE_FILE || new URL('../src/context/AppContext.jsx', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  if (a < 0 || b < a) throw new Error(`AppContext: "${from.trim()}" could not be located`);
  return source.slice(a, b);
};
const bytesCode = cut("  // ─── A stored file's bytes, only while a screen shows it ───", '  const value = useMemo(() => ({');
const reconcileCode = cut('  async function reconcileDocumentFiles(', '  async function loadLocalData(');

const OWNER = 'user_syntheticReload';
const FILE = 'data:application/pdf;base64,JVBERi0xLjQgc3ludGhldGlj';
const row = (extra = {}) => ({ id: 'doc-letter', name: 'qa-loose-letter.pdf', type: 'application/pdf', size: 24, storagePath: `${OWNER}/doc-letter`, linkedTo: '', ...extra });
const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };

function provider() {
  // Refs and callbacks keep their slot by call order; an effect runs after a
  // render when its dependencies changed, its cleanup first.
  const slots = [];
  let at = 0;
  const effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
  const hooks = {
    useRef: (value) => { const i = at++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useCallback: (fn, deps) => { const i = at++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect: (fn, deps) => {
      const i = at++;
      if (slots[i] && !changed(slots[i].deps, deps)) return;
      const old = slots[i];
      slots[i] = { deps };
      effects.push(() => { old?.cleanup?.(); const c = fn(); slots[i].cleanup = typeof c === 'function' ? c : null; });
    },
  };
  const state = { data: { settings: {}, documents: [row()] } };
  const downloads = [];
  const answer = (path) => new Promise((resolve) => { downloads.push({ path, resolve }); });
  const dataRef = { current: state.data };
  const dataLoadGeneration = { current: 1 };
  const context = {
    ...hooks, createDocumentBytes, missingDocumentFiles: new Set(),
    dataRef, dataOwnerRef: { current: OWNER }, dataLoadGeneration, userIdRef: { current: 'profile-synthetic' },
    getActiveUserId: () => OWNER, offlineMode: false,
    setData: (update) => { state.data = typeof update === 'function' ? update(state.data) : update; },
    // The store's download (this version) and the reconciler's (the one before).
    documentDataUrl: (path) => answer(path),
    downloadDocumentFile: (path) => answer(path),
    uploadDocumentFile: async () => null,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  };
  vm.runInNewContext(`globalThis.__render = function (data, user) {\n${reconcileCode}\n${bytesCode}\nreturn { requestDocumentBytes, releaseDocumentBytes };\n};`, context);
  const render = () => {
    at = 0;
    const api = context.__render(state.data, { id: OWNER });
    for (const fn of effects.splice(0)) fn();
    return api;
  };
  // A load of the account: a newer generation, and the rows read again from
  // the account, which never carry a stored file's bytes.
  const load = (documents = [row()]) => {
    dataLoadGeneration.current += 1;
    state.data = { ...state.data, documents };
    dataRef.current = state.data;
    return render();
  };
  return { state, render, load, downloads };
}

test('DOCS-008/009: a file asked for after a reload gets its bytes, though the second load began while it downloaded', async () => {
  const p = provider();
  const api = p.render();
  // Documents is open and shows the stored file: it asks for its bytes.
  api.requestDocumentBytes(['doc-letter']);
  await settle();
  assert.deepEqual(p.downloads.map((d) => d.path), [`${OWNER}/doc-letter`], 'one download, for the file shown');
  // The membership answer's second load begins while it downloads.
  p.load();
  // Storage answers (200).
  p.downloads[0].resolve({ dataUrl: FILE });
  await settle();
  p.render();
  await settle();
  assert.equal(p.state.data.documents[0].data, FILE, 'View PDF, not "Fetching the file from your account." for good');
});

test('a load that puts the file on screen again without its bytes has it fetched again', async () => {
  const p = provider();
  const api = p.render();
  api.requestDocumentBytes(['doc-letter']);
  await settle();
  p.downloads[0].resolve({ dataUrl: FILE });
  await settle();
  p.render();
  assert.equal(p.state.data.documents[0].data, FILE);
  // A load whose rows the screen's bytes were not laid back over (the file
  // given again on another device: another size), while the screen still
  // shows it and its list of files has not changed.
  p.load([row({ size: 48 })]);
  await settle();
  assert.equal(p.downloads.length, 2, 'asked for again, for the file now in the account');
  p.downloads[1].resolve({ dataUrl: `${FILE}QUFB` });
  await settle();
  p.render();
  assert.equal(p.state.data.documents[0].data, `${FILE}QUFB`);
});

// QA lab DOCS-001 on this change: the stored file's bytes, read as a stream
// (so a stalled download can be told from a slow one), came back as an
// untyped Blob, and its data URL read "data:application/octet-stream". The
// same file picked again under another name was compared with it on screen
// (DocumentsSection: same data URL), did not match, and was stored twice.
const dataUrlCode = cut('async function documentDataUrl(', '// How often an open, visible tab');
class FileReaderLike {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.({ target: this });
    }, (e) => this.onerror?.(e));
  }
}
const { docMime } = await import('../src/utils/inboxDocs.js');

test('a stored file read as a stream carries its document\'s type, as the same file picked from the device does', async () => {
  const bytes = Buffer.from('%PDF-1.4 synthetic letter');
  const context = { downloadDocumentBlob: async () => ({ blob: new Blob([bytes]) }), docMime, Blob, FileReader: FileReaderLike };
  vm.runInNewContext(`${dataUrlCode}\nglobalThis.documentDataUrl = documentDataUrl;`, context);
  const got = await context.documentDataUrl(`${OWNER}/doc-letter`, { doc: row() });
  const picked = `data:application/pdf;base64,${bytes.toString('base64')}`;
  assert.equal(got.dataUrl, picked, 'the same data URL as the file picked again, so it is recognised as a duplicate');
  // An emailed file's row carries its inbox marker as `type` and the real one as mimeType.
  const emailed = await context.documentDataUrl(`${OWNER}/doc-mail`, { doc: { type: 'docs-inbox', mimeType: 'image/png' } });
  assert.match(emailed.dataUrl, /^data:image\/png;base64,/);
  context.downloadDocumentBlob = async () => ({ missing: true });
  assert.equal(JSON.stringify(await context.documentDataUrl('x', { doc: row() })), '{"missing":true}', 'Storage has no such object: said so');
});
