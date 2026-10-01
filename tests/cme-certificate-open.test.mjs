// CRED-031: opening a CME entry's certificate whose file is not on this
// device. The phone card's certificate button runs openSourceDoc in the real
// CMESection, and the download goes through the real src/lib/supabase.js (the
// persistence fixture's in-memory client), answered with the error the
// installed @supabase/storage-js really returns. Before the fix a file missing
// from Storage alerted "Could not open that document: {}". Synthetic records
// and paths only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageClient } from '@supabase/storage-js';
import { mountComponent, settle } from './component-harness.mjs';
import { fixture } from './limited-launch/persistence-fixture.mjs';

const PATH = 'user_syntheticA/00000000-0000-4000-8000-0000000000d1';
const ENTRY = { id: 'cme-syn-1', title: 'Synthetic Skull Base Course', hours: 6, category: 'AMA PRA Category 1', date: '2026-08-01' };
const CERT = { id: '00000000-0000-4000-8000-0000000000d1', name: 'synthetic-certificate.pdf', type: 'application/pdf', linkedTo: `cme:${ENTRY.id}`, storagePath: PATH };

/** The error storage-js hands back for a download Storage answered with `status` and `body`. */
async function storageError(status, body) {
  const client = new StorageClient('https://storage.synthetic.invalid/storage/v1', {}, async () => new Response(JSON.stringify(body), { status }));
  return (await client.from('documents').download(PATH)).error;
}
const MISSING = () => storageError(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
const EXPIRED = () => storageError(400, { statusCode: '403', error: 'Unauthorized', message: 'jwt expired' });

async function openCertificate({ doc = CERT, answer, wait = true }) {
  const f = fixture();
  f.onRequest = async (op) => (op.method === 'download' ? answer() : { error: null });
  const alerts = [], opened = [];
  const ui = await mountComponent('src/components/features/CMESection.jsx', {
    app: { data: { cme: [ENTRY], documents: [doc], settings: {} }, theme: {}, allTrackedStates: [], isDesktop: false, toggleFavorite() {} },
    props: { onShare() {} },
    modules: {
      supabase: { supabase: f.api.supabase, downloadDocumentBlob: f.api.downloadDocumentBlob },
      useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [], loading: false }) },
      helpers: await import('../src/utils/helpers.js'),
      credentialTypes: await import('../src/constants/credentialTypes.js'),
      cmeTopics: await import('../src/constants/cmeTopics.js'),
      inboxDocs: await import('../src/utils/inboxDocs.js'),
    },
    globals: { window: { navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true, alert: (m) => alerts.push(m), open: (url) => { const w = { url, closed: false, close() { w.closed = true; }, location: {} };
      Object.defineProperty(w.location, 'href', { set(v) { w.url = v; }, get() { return w.url; } }); opened.push(w); return w; } } },
  });
  const button = ui.nodes().find((n) => n.type === 'button' && ui.text(n).includes(CERT.name));
  assert.ok(button, 'the phone card shows the certificate button');
  button.props.onClick({ stopPropagation() {} });
  if (wait) await settle();
  return { alerts, opened, downloads: f.requests.filter((r) => r.method === 'download') };
}

test('CRED-031: a certificate whose file is missing from Storage says so in words, never "{}"', async () => {
  const { alerts, opened, downloads } = await openCertificate({ answer: async () => ({ data: null, error: await MISSING() }) });
  assert.equal(downloads.length, 1);
  assert.ok(opened.every((w) => w.closed), 'nothing is left open');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /missing from your account/);
  assert.match(alerts[0], /Upload it again from Documents/);
  assert.doesNotMatch(alerts[0], /\{\}|\u2014/);
});

test('CRED-031: a certificate the load already found missing is said at once, without asking Storage again', async () => {
  const { alerts, downloads } = await openCertificate({ doc: { ...CERT, fileMissing: true }, answer: async () => { throw new Error('not asked'); } });
  assert.equal(downloads.length, 0);
  assert.match(alerts[0], /missing from your account/);
});

test('CRED-031: a download that failed for another reason (expired session) asks to try again, and is not called missing', async () => {
  const { alerts } = await openCertificate({ answer: async () => ({ data: null, error: await EXPIRED() }) });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Could not download this certificate/);
  assert.doesNotMatch(alerts[0], /missing|\{\}/);
});

test('a certificate Storage has opens in a new tab, with no alert', async () => {
  const file = new Blob(['%PDF-1.4 synthetic'], { type: 'application/pdf' });
  const { alerts, opened } = await openCertificate({ answer: async () => ({ data: file, error: null }) });
  assert.deepEqual(alerts, []);
  assert.equal(opened.length, 1);
  assert.match(opened[0].url, /^blob:/);
  assert.equal(opened[0].closed, false);
});

// A window opened after the download's await is outside the tap, and Safari
// (the home-screen app above all) blocks it with no word. The tab opens in the
// tap and the file is put in it once downloaded.
test('CRED-031: the certificate tab opens in the tap itself, before the download answers', async () => {
  let release;
  const file = new Blob(['%PDF-1.4 synthetic'], { type: 'application/pdf' });
  const { alerts, opened } = await openCertificate({ wait: false, answer: () => new Promise((r) => { release = () => r({ data: file, error: null }); }) });
  assert.equal(opened.length, 1, 'a window is open while the download is still running');
  assert.equal(opened[0].url, 'about:blank');
  await settle();
  release();
  await settle();
  assert.deepEqual(alerts, []);
  assert.equal(opened.length, 1, 'the same window, not a second one');
  assert.match(opened[0].url, /^blob:/);
});

test('CRED-031: a failed download closes the tab it opened', async () => {
  const { opened } = await openCertificate({ answer: async () => ({ data: null, error: await EXPIRED() }) });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].closed, true);
});
