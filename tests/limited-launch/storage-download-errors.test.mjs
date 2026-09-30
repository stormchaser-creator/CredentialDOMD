import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageClient } from '@supabase/storage-js';
import { fixture } from './persistence-fixture.mjs';

// CRED-031 / SYNC-013: what a failed document download says. The errors here
// are the ones the installed @supabase/storage-js really returns, made by its
// own client against a synthetic fetch: a download asks storage-js not to
// parse the answer, so a missing object comes back as a StorageUnknownError
// whose message is "{}" and whose originalError is the unread Response. The
// SYNC-013 test in cloud-writes.test.mjs used a hand-made { statusCode: "404" }
// error that storage-js never produces, so it passed while every real missing
// file read as "failed" (and CME showed "Could not open that document: {}").
// Synthetic paths only; no network.

const json = (v) => JSON.parse(JSON.stringify(v));
const PATH = 'user_syntheticA/00000000-0000-4000-8000-0000000000c1';

async function storageAnswer(respond) {
  const client = new StorageClient('https://storage.synthetic.invalid/storage/v1', {}, respond);
  const { data, error } = await client.from('documents').download(PATH);
  assert.equal(data, null);
  return error;
}
const answered = (status, body) => () => storageAnswer(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const offline = () => storageAnswer(async () => { throw new TypeError('Failed to fetch'); });

const MISSING_400 = answered(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
const MISSING_404 = answered(404, { statusCode: '404', error: 'NoSuchKey', message: 'The resource was not found' });
const EXPIRED_SESSION = answered(400, { statusCode: '403', error: 'Unauthorized', message: 'jwt expired' });
const SERVER_ERROR = answered(500, { statusCode: '500', error: 'internal', message: 'Internal Server Error' });

/** A fixture whose Storage answers every download with a fresh real error (a Response body reads once). */
function cloudAnswering(makeError) {
  const f = fixture();
  f.onRequest = async (op) => (op.method === 'download' ? { data: null, error: await makeError() } : { error: null });
  return f;
}

test('the real storage-js error for a missing object carries nothing readable itself', async () => {
  const error = await MISSING_400();
  assert.equal(error.name, 'StorageUnknownError');
  assert.equal(error.message, '{}', 'why CME printed "{}"');
  assert.equal(error.status, undefined);
  assert.equal(error.statusCode, undefined);
  assert.equal(error.originalError.status, 400, 'the answer is in the unread Response');
});

test('CRED-031: a missing object (HTTP 400, statusCode 404) is "missing" from both download helpers', async () => {
  const f = cloudAnswering(MISSING_400);
  assert.deepEqual(json(await f.api.downloadDocumentFile(PATH, { detail: true })), { missing: true });
  assert.deepEqual(json(await f.api.downloadDocumentBlob(PATH, { detail: true })), { missing: true });
  assert.equal(await f.api.downloadDocumentFile(PATH), null, 'the plain calls are unchanged');
  assert.equal(await f.api.downloadDocumentBlob(PATH), null);
});

test('CRED-031: a plain HTTP 404 is "missing" too', async () => {
  const f = cloudAnswering(MISSING_404);
  assert.deepEqual(json(await f.api.downloadDocumentBlob(PATH, { detail: true })), { missing: true });
});

test('CRED-031: an expired session, a server error and no network are "failed" (tried again later), never "missing"', async () => {
  for (const [name, make] of [['expired session', EXPIRED_SESSION], ['server error', SERVER_ERROR], ['offline', offline]]) {
    const f = cloudAnswering(make);
    assert.deepEqual(json(await f.api.downloadDocumentBlob(PATH, { detail: true })), { failed: true }, name);
    assert.deepEqual(json(await f.api.downloadDocumentFile(PATH, { detail: true })), { failed: true }, name);
  }
});

test('a download that lands hands back the Blob, with or without detail', async () => {
  const f = fixture();
  const file = new Blob(['%PDF-1.4 synthetic'], { type: 'application/pdf' });
  f.onRequest = async (op) => (op.method === 'download' ? { data: file, error: null } : { error: null });
  assert.equal(await f.api.downloadDocumentBlob(PATH), file);
  const got = await f.api.downloadDocumentBlob(PATH, { detail: true });
  assert.equal(got.blob, file);
  assert.deepEqual(f.requests.map((r) => [r.method, r.bucket, r.path]), [['download', 'documents', PATH], ['download', 'documents', PATH]]);
});

// The anon-key fallback. The app's client mints each request's token with
// Clerk, and when Clerk cannot (a token refresh that failed, a network blip,
// window.Clerk.session briefly null) supabase-js sends `Bearer <anon key>`
// instead. The documents bucket's policies are `to authenticated` only, so
// Storage answers that request exactly as it answers a deleted object: HTTP
// 400, statusCode 404, "Object not found". No body check can tell the two
// apart, so a download that did not carry the member's token must never read
// as "missing" (reconcileDocumentFiles would then tell the member to delete a
// document whose file is intact). These run the real @supabase/supabase-js
// against a synthetic Storage that applies that policy by the Authorization
// header; nothing leaves the process.
const MEMBER_TOKEN = 'synthetic-member-token';
const STORED_PDF = '%PDF-1.4 synthetic stored certificate';

function storageBehindPolicy({ stored = new Set([PATH]) } = {}) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const auth = new Headers(init.headers).get('authorization');
    const path = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/object\/documents\//, ''));
    requests.push({ path, auth });
    if (auth === `Bearer ${MEMBER_TOKEN}` && stored.has(path)) return new Response(STORED_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
    // Anyone else (the anon key included) sees no object at all.
    return new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

/** The real supabase.js on the real supabase-js, its fetch answered by `storage`, with Clerk's token getter `getToken`. */
async function withRealClient(storage, getToken, run) {
  const supabaseJs = await import('@supabase/supabase-js');
  const realFetch = globalThis.fetch, realWarn = console.warn;
  globalThis.fetch = storage.fetch;
  console.warn = () => {};
  try {
    const f = fixture({ supabaseJs });
    f.clerk.session = getToken === null ? null : { user: { id: 'user_syntheticA' }, getToken };
    return await run(f);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

test('the synthetic Storage answers an anon-key download of a stored file as "Object not found" (why the body cannot decide)', async () => {
  const storage = storageBehindPolicy();
  const anon = await storage.fetch(`https://synthetic.invalid/storage/v1/object/documents/${PATH}`, { headers: { Authorization: 'Bearer synthetic-public' } });
  assert.equal(anon.status, 400);
  assert.deepEqual(await anon.json(), { statusCode: '404', error: 'not_found', message: 'Object not found' });
});

test('CRED-031: a download sent without a Clerk token is "failed", never "missing", though its file is stored', async () => {
  const noToken = [
    ['the token getter returns null', async () => null],
    ['the token refresh throws', async () => { throw new Error('synthetic refresh failure'); }],
    ['window.Clerk.session is briefly null', null],
  ];
  for (const [name, getToken] of noToken) {
    const storage = storageBehindPolicy();
    await withRealClient(storage, getToken, async (f) => {
      assert.deepEqual(json(await f.api.downloadDocumentFile(PATH, { detail: true })), { failed: true }, `${name}: downloadDocumentFile`);
      assert.deepEqual(json(await f.api.downloadDocumentBlob(PATH, { detail: true })), { failed: true }, `${name}: downloadDocumentBlob`);
      assert.equal(await f.api.downloadDocumentBlob(PATH), null, `${name}: the plain call`);
    });
    assert.equal(storage.requests.filter((r) => r.auth !== `Bearer ${MEMBER_TOKEN}`).length, 0, `${name}: no request went to Storage without the member's token`);
  }
});

test('CRED-031: with the member\'s token, a file Storage lacks is "missing" and a stored one downloads', async () => {
  const storage = storageBehindPolicy();
  await withRealClient(storage, async () => MEMBER_TOKEN, async (f) => {
    const gone = 'user_syntheticA/00000000-0000-4000-8000-0000000000c2';
    assert.deepEqual(json(await f.api.downloadDocumentFile(gone, { detail: true })), { missing: true });
    assert.deepEqual(json(await f.api.downloadDocumentBlob(gone, { detail: true })), { missing: true });
    const got = await f.api.downloadDocumentBlob(PATH, { detail: true });
    assert.equal(await got.blob.text(), STORED_PDF);
  });
  assert.ok(storage.requests.length === 3 && storage.requests.every((r) => r.auth === `Bearer ${MEMBER_TOKEN}`), storage.requests);
});

test('CRED-031: a token refresh that fails partway through a run of downloads fails only that download; the files after it still land', async () => {
  const paths = ['c3', 'c4', 'c5'].map((n) => `user_syntheticA/00000000-0000-4000-8000-0000000000${n}`);
  const storage = storageBehindPolicy({ stored: new Set(paths) });
  let refreshFails = false;
  const getToken = async () => { if (refreshFails) throw new Error('synthetic refresh failure'); return MEMBER_TOKEN; };
  await withRealClient(storage, getToken, async (f) => {
    const got = [];
    for (const [i, p] of paths.entries()) {
      refreshFails = i === 1;
      const answer = await f.api.downloadDocumentBlob(p, { detail: true });
      got.push(answer.blob ? 'blob' : json(answer));
    }
    assert.deepEqual(got, ['blob', { failed: true }, 'blob']);
  });
  assert.deepEqual(storage.requests.map((r) => r.path), [paths[0], paths[2]], 'the download with no token was never sent');
});
