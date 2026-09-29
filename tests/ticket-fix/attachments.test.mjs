// G6 (stage 3): every attachment on the ticket delivered as a local file by
// the host, checked by its bytes, and "reviewed" only when the session's own
// tool events show a Read of that file. Synthetic images only; no network
// (every fetch is a stub), no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, existsSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { validStoragePath, sniff, imageSize, selectAttachments, deliverAttachments, pickServiceKey, storageFetcher, readManifest, reviewedIds, modelView, main,
  MAX_RELATED, PROJECT } from '../../scripts/ticket-fix/attachments.mjs';
import { streamCollector } from '../../scripts/ticket-fix/worker.mjs';
import { sandboxAvailable } from '../../scripts/ticket-fix/sandbox.mjs';
import { uuid, privateDir } from './helpers.mjs';

const T = uuid(6001), R = uuid(6002), OWNER = uuid(9201), M1 = uuid(6101);
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n% synthetic\n');
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(12)]);
// Key shapes are built at run time, so no token-shaped literal sits in the
// public repository; none of them is a real key.
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const LEGACY_KEY = [b64({ alg: 'HS256' }), b64({ role: 'service_role' }), b64('synthetic-signature')].join('.');
const NEW_KEY = ['sb', 'secret', 'syntheticSYNTHETIC0123456789'].join('_');

function ctx(paths = [`tickets/${T}/screenshot.png`], related = []) {
  return { target_id: T, owner_id: OWNER, tickets: [
    { id: T, created_at: '2026-09-28T10:00:00Z', messages: [{ id: M1, created_at: '2026-09-28T11:00:00Z' }] },
    { id: R, created_at: '2026-09-20T10:00:00Z', messages: [] }],
  attachments: [...paths.map((p, i) => ({ ticket_id: T, source_id: i === 1 ? M1 : T, storage_path: p })), ...related.map(r => ({ ticket_id: R, source_id: R, storage_path: r }))] };
}
// A PNG whose header says 3000 px wide (the host sizes images from their headers).
const BIG_PNG = Buffer.from(PNG); BIG_PNG.writeUInt32BE(3000, 16);
// Its shrink really shrinks (the host measures again afterwards): a PNG's
// header is rewritten, anything else is reported at the new size.
const stubConvert = (calls = []) => {
  const shrunk = new Set();
  return {
    toPng(input, output) { calls.push(['toPng', path.basename(input)]); writeFileSync(output, BIG_PNG); },
    dimensions(file) { calls.push(['dimensions', path.basename(file)]); return shrunk.has(file) ? { width: 2000, height: 667 } : { width: 3000, height: 1000 }; },
    shrink(file, max) {
      calls.push(['shrink', path.basename(file), max]);
      shrunk.add(file);
      const bytes = readFileSync(file);
      if (sniff(bytes)?.media_type === 'image/png') { bytes.writeUInt32BE(max, 16); writeFileSync(file, bytes); }
    },
  };
};

test('only paths in the ticket\'s own folder; the bytes decide the type, never the name', () => {
  assert.equal(validStoragePath(`tickets/${T}/screenshot.png`, T), true);
  assert.equal(validStoragePath(`tickets/${T}/replies/${M1}-2.jpg`, T), true);
  for (const bad of [`tickets/${T}/../${R}/screenshot.png`, `tickets/${R}/screenshot.png`, `tickets/${T}/a/b/c.png`, `/tickets/${T}/x.png`, `tickets/${T}/.hidden`, 'documents/other.png', `tickets/${T}/`])
    assert.equal(validStoragePath(bad, T), false, bad);
  assert.deepEqual([PNG, JPEG, PDF, HEIC, Buffer.from('GIF89a....'), Buffer.from('RIFF\0\0\0\0WEBPVP8 ')].map(b => sniff(b)?.media_type),
    ['image/png', 'image/jpeg', 'application/pdf', 'image/heic', 'image/gif', 'image/webp']);
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script>')), null);
  // Sizes come from the headers, so common images never reach an image library.
  assert.deepEqual(imageSize(PNG), { width: 1, height: 1 });
  assert.deepEqual(imageSize(BIG_PNG), { width: 3000, height: 1 });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x20, 0x03, 0x58, 0x02])]);
  assert.deepEqual(imageSize(gif), { width: 800, height: 600 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { width: 800, height: 600 });
  const webp = Buffer.alloc(30); webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1'); webp.writeUIntLE(2999, 24, 3); webp.writeUIntLE(99, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 3000, height: 100 });
  assert.equal(imageSize(PDF), null);
  assert.equal(sniff(Buffer.from('PK\u0003\u0004 word document')), null, 'a Word file is not delivered as an image');
});

test('which files: every one on the ticket and its messages first, then the newest related ones up to the limit', () => {
  const related = Array.from({ length: MAX_RELATED + 3 }, (_, i) => `tickets/${R}/screenshot-${i + 2}.png`);
  const picked = selectAttachments(ctx([`tickets/${T}/screenshot.png`, `tickets/${T}/replies/${M1}.jpg`, `tickets/${T}/screenshot.png`], related));
  assert.deepEqual(picked.slice(0, 2).map(a => [a.id, a.target, a.source_id]), [['att-1', true, T], ['att-2', true, M1]], 'duplicates are dropped');
  assert.equal(picked.filter(a => !a.target).length, MAX_RELATED);
  assert.equal(picked.length, 2 + MAX_RELATED);
});

test('the host downloads, checks and writes each file privately; anything wrong is unavailable (retried) or unsupported (never retried) with a reason, never asked for again; the log has id and path only', async () => {
  const dir = privateDir('ticket-attach-');
  const logs = [], fetched = [], calls = [];
  const objects = { [`tickets/${T}/screenshot.png`]: PNG, [`tickets/${T}/replies/${M1}.jpg`]: JPEG, [`tickets/${T}/screenshot-2.png`]: Buffer.from('<html>not an image</html>'),
    [`tickets/${T}/screenshot-3.png`]: Buffer.alloc(200, 1), [`tickets/${T}/screenshot-4.heic`]: HEIC, [`tickets/${T}/doc.pdf`]: PDF };
  try {
    const context = ctx([`tickets/${T}/screenshot.png`, `tickets/${T}/replies/${M1}.jpg`, `tickets/${T}/screenshot-2.png`, `tickets/${T}/screenshot-3.png`,
      `tickets/${T}/screenshot-4.heic`, `tickets/${T}/doc.pdf`, `tickets/${T}/missing.png`, `tickets/${R}/elsewhere.png`]);
    const manifest = await deliverAttachments({ context, outDir: path.join(dir.dir, T), convert: stubConvert(calls), log: l => logs.push(l), maxBytes: 100,
      fetchObject: async p => { fetched.push(p); if (!objects[p]) throw Error('storage returned 404'); return objects[p]; } });
    const by = Object.fromEntries(manifest.attachments.map(a => [a.storage_path, a]));
    assert.equal(by[`tickets/${T}/screenshot.png`].access, 'delivered');
    assert.equal(by[`tickets/${T}/screenshot.png`].media_type, 'image/png');
    assert.equal(by[`tickets/${T}/replies/${M1}.jpg`].media_type, 'image/jpeg');
    assert.equal(by[`tickets/${T}/screenshot-2.png`].reason, 'not an image or a PDF');
    assert.equal(by[`tickets/${T}/screenshot-3.png`].reason, 'larger than 0 MB');
    // The same bytes would fail the same way next run: never retried.
    assert.deepEqual([by[`tickets/${T}/screenshot-2.png`].access, by[`tickets/${T}/screenshot-3.png`].access, by[`tickets/${T}/missing.png`].access], ['unsupported', 'unsupported', 'unavailable']);
    assert.equal(by[`tickets/${T}/doc.pdf`].media_type, 'application/pdf');
    assert.equal(by[`tickets/${T}/missing.png`].reason, 'download failed: storage returned 404');
    // HEIC becomes PNG; a large image (here the converted one) is shrunk to 2000 px.
    const heic = by[`tickets/${T}/screenshot-4.heic`];
    assert.equal(heic.media_type, 'image/png');
    assert.equal(heic.converted, true);
    assert.equal(path.extname(heic.local_path), '.png');
    assert.ok(calls.some(c => c[0] === 'toPng') && calls.some(c => c[0] === 'shrink' && c[2] === 2000));
    // A path from another ticket's folder is never fetched.
    const outside = manifest.attachments.find(a => a.storage_path === `tickets/${R}/elsewhere.png`);
    assert.equal(outside.reason, 'the path is outside the ticket folder');
    assert.ok(!fetched.includes(`tickets/${R}/elsewhere.png`));
    // Private files in a private directory, each matching its sha256.
    assert.equal(statSync(path.join(dir.dir, T)).mode & 0o777, 0o700);
    for (const a of manifest.attachments.filter(x => x.access === 'delivered')) {
      assert.equal(statSync(a.local_path).mode & 0o777, 0o600);
      assert.equal(path.dirname(a.local_path), realpathSync(path.join(dir.dir, T)));
    }
    assert.equal(logs.length, manifest.attachments.length);
    for (const line of logs) assert.match(line, new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d ATTACHMENT — ${T} tickets/[0-9a-f-]{36}/[\\w./-]+: (?:delivered as att-\\d+|(?:unavailable|unsupported) \\([\\w :.-]+\\))$`), line);
    // The manifest is read back only if nothing changed since.
    const file = path.join(dir.dir, 'manifest.json');
    writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
    assert.equal(readManifest(file, { ticketId: T, dir: path.join(dir.dir, T) }).attachments.length, manifest.attachments.length);
    assert.throws(() => readManifest(file, { ticketId: R, dir: path.join(dir.dir, T) }), /for another ticket/);
    writeFileSync(by[`tickets/${T}/screenshot.png`].local_path, JPEG);
    assert.throws(() => readManifest(file, { ticketId: T, dir: path.join(dir.dir, T) }), /does not match its manifest/);
    chmodSync(file, 0o644);
    assert.throws(() => readManifest(file, { ticketId: T, dir: path.join(dir.dir, T) }), /owner-only/);
    assert.equal(readManifest(path.join(dir.dir, 'none.json'), { ticketId: T, dir: dir.dir }), null);
  } finally { dir.cleanup(); }
});

// Inside another sandbox (the ticket gates run this suite in one) sandbox-exec
// cannot nest, and sips cannot write its temporary file: skipped there.
test('the real sips, sandboxed where sandbox-exec exists: HEIC becomes PNG and a 2400 px image is shrunk to 2000 (macOS)',
  { skip: !existsSync('/usr/bin/sips') ? 'needs /usr/bin/sips' : !sandboxAvailable() ? 'needs sandbox-exec (not inside another sandbox)' : false }, async () => {
  const dir = privateDir('ticket-sips-');
  try {
    const png = path.join(dir.dir, 'in.png');
    writeFileSync(png, PNG);
    const big = path.join(dir.dir, 'big.png');
    if (spawnSync('/usr/bin/sips', ['-z', '2400', '2400', png, '--out', big], { encoding: 'utf8' }).status === 0) {
      const shrunk = await deliverAttachments({ context: ctx([`tickets/${T}/big.png`]), outDir: path.join(dir.dir, 'big', T), fetchObject: async () => readFileSync(big) });
      assert.equal(shrunk.attachments[0].access, 'delivered', shrunk.attachments[0].reason);
      assert.equal(shrunk.attachments[0].converted, true);
      assert.deepEqual(imageSize(readFileSync(shrunk.attachments[0].local_path)), { width: 2000, height: 2000 });
    }
    const heic = path.join(dir.dir, 'in.heic');
    const made = spawnSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', heic], { encoding: 'utf8' });
    if (made.status !== 0 || !existsSync(heic)) return; // this macOS cannot write HEIC; the conversion path is covered by the stub
    const manifest = await deliverAttachments({ context: ctx([`tickets/${T}/photo.heic`]), outDir: path.join(dir.dir, T), fetchObject: async () => readFileSync(heic) });
    assert.equal(manifest.attachments[0].access, 'delivered', manifest.attachments[0].reason);
    assert.equal(manifest.attachments[0].media_type, 'image/png');
    assert.equal(sniff(readFileSync(manifest.attachments[0].local_path)).media_type, 'image/png');
  } finally { dir.cleanup(); }
});

test('the storage key comes from the management token\'s key listing, is used for the download only, and never appears in an error', async () => {
  assert.equal(pickServiceKey([{ name: 'anon', api_key: 'eyJa.eyJb.c2ln' }, { name: 'service_role', api_key: LEGACY_KEY }]), LEGACY_KEY);
  assert.equal(pickServiceKey([{ name: 'publishable', type: 'publishable', api_key: 'sb_publishable_x' }, { name: 'default', type: 'secret', api_key: NEW_KEY }]), NEW_KEY);
  assert.equal(pickServiceKey([{ name: 'service_role', api_key: null }, { type: 'secret', api_key: 'sb_secret_…' }]), null, 'a redacted key is not a key');
  assert.equal(pickServiceKey({ error: 'x' }), null);
  const requests = [];
  const fake = (keys, status = 200) => async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url.startsWith('https://api.supabase.com/')) return new Response(JSON.stringify(keys), { status: keys ? 200 : 403 });
    return status === 200 ? new Response(PNG, { status: 200, headers: { 'Content-Length': String(PNG.length) } }) : new Response('nope', { status });
  };
  const legacy = storageFetcher({ token: 'synthetic-management-token', fetchImpl: fake([{ name: 'service_role', api_key: LEGACY_KEY }]) });
  assert.deepEqual(await legacy(`tickets/${T}/screenshot.png`), PNG);
  assert.equal(requests[0].url, `https://api.supabase.com/v1/projects/${PROJECT}/api-keys?reveal=true`);
  assert.equal(requests[0].headers.Authorization, 'Bearer synthetic-management-token');
  assert.equal(requests[1].url, `https://${PROJECT}.supabase.co/storage/v1/object/documents/tickets/${T}/screenshot.png`);
  assert.deepEqual(requests[1].headers, { apikey: LEGACY_KEY, Authorization: `Bearer ${LEGACY_KEY}` });
  await legacy(`tickets/${T}/other.png`);
  assert.equal(requests.filter(r => r.url.includes('api-keys')).length, 1, 'the key is listed once per process');
  requests.length = 0;
  await storageFetcher({ token: 't', fetchImpl: fake([{ type: 'secret', api_key: NEW_KEY }]) })(`tickets/${T}/a b.png`);
  assert.deepEqual(requests[1].headers, { apikey: NEW_KEY }, 'a secret key goes in apikey only');
  assert.match(requests[1].url, /tickets\/[0-9a-f-]+\/a%20b\.png$/);
  for (const [fetcher, why] of [[storageFetcher({ token: 'synthetic-management-token', fetchImpl: fake(null) }), /key listing returned 403/],
    [storageFetcher({ token: 't', fetchImpl: fake([{ name: 'anon', api_key: 'eyJa.eyJb.c2ln' }]) }), /no service key/],
    [storageFetcher({ token: 't', fetchImpl: fake([{ name: 'service_role', api_key: LEGACY_KEY }], 404) }), /storage returned 404/],
    [storageFetcher({ token: 't', fetchImpl: fake([{ name: 'service_role', api_key: LEGACY_KEY }]), maxBytes: 10 }), /larger than the limit/]]) {
    await assert.rejects(fetcher(`tickets/${T}/x.png`), error => why.test(error.message) && !error.message.includes(LEGACY_KEY) && !error.message.includes('synthetic-management-token'));
  }
});

test('the CLI writes an owner-only manifest; a ticket with no attachments makes no request at all', async () => {
  const dir = privateDir('ticket-attach-cli-');
  try {
    const contextFile = path.join(dir.dir, 'context.json');
    writeFileSync(contextFile, JSON.stringify(ctx([])), { mode: 0o600 });
    const none = path.join(dir.dir, 'none.json');
    await main(['fetch', '--context', contextFile, '--out', path.join(dir.dir, 'att', T), '--manifest', none],
      { env: {}, fetchImpl: async () => { throw Error('no request may be made'); }, log: () => {} });
    assert.deepEqual(JSON.parse(readFileSync(none, 'utf8')).attachments, []);
    writeFileSync(contextFile, JSON.stringify(ctx()), { mode: 0o600 });
    const file = path.join(dir.dir, 'manifest.json');
    const logs = [];
    await main(['fetch', '--context', contextFile, '--out', path.join(dir.dir, 'att2', T), '--manifest', file],
      { env: { TICKET_DATABASE_TOKEN: 'synthetic-management-token' }, log: l => logs.push(l), fetchImpl: async url => (url.includes('api-keys')
        ? new Response(JSON.stringify([{ name: 'service_role', api_key: LEGACY_KEY }])) : new Response(PNG)) });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(manifest.attachments[0].access, 'delivered');
    assert.ok(!readFileSync(file, 'utf8').includes(LEGACY_KEY));
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`ATTACHMENT — ${T} tickets/${T}/screenshot\\.png: delivered as att-1$`));
    // No token: every file is unavailable, the run goes on.
    const again = path.join(dir.dir, 'again.json');
    await main(['fetch', '--context', contextFile, '--out', path.join(dir.dir, 'att3', T), '--manifest', again], { env: {}, log: () => {}, fetchImpl: async () => { throw Error('unreachable'); } });
    assert.match(JSON.parse(readFileSync(again, 'utf8')).attachments[0].reason, /download failed: A management token is required/);
    await assert.rejects(main(['fetch', '--context', 'relative.json', '--out', dir.dir, '--manifest', file]), /absolute paths/);
  } finally { dir.cleanup(); }
});

test('"reviewed" is proven by the session\'s own Read events of that exact file, never claimed', async () => {
  const dir = privateDir('ticket-reviewed-');
  try {
    mkdirSync(path.join(dir.dir, T), { mode: 0o700 });
    const manifest = await deliverAttachments({ context: ctx([`tickets/${T}/screenshot.png`, `tickets/${T}/replies/${M1}.jpg`]), outDir: path.join(dir.dir, T),
      fetchObject: async p => (p.endsWith('.png') ? PNG : JPEG), convert: { toPng() {}, dimensions: () => ({ width: 10, height: 10 }), shrink() {} } });
    const [png, jpg] = manifest.attachments;
    // The CLI's stream: a Read that succeeded, one refused by permissions, and
    // one of a different file.
    const stream = streamCollector();
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: png.local_path } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'image', source: { type: 'base64', data: PNG.toString('base64') } }] }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: jpg.local_path } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r2', is_error: true, content: '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: path.join(dir.dir, 'elsewhere.png') } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r3', content: 'ok' }] } },
      { type: 'result', structured_output: { ok: true }, session_id: 'x' }];
    const text = lines.map(l => JSON.stringify(l)).join('\n');
    for (let i = 0; i < text.length; i += 7) stream.feed(text.slice(i, i + 7)); // split anywhere, as a pipe does
    const { reads, result } = stream.end();
    assert.deepEqual(result.structured_output, { ok: true });
    assert.deepEqual(reads.map(r => r.ok), [true, false, true]);
    assert.deepEqual([...reviewedIds(manifest, reads)], ['att-1']);
    assert.deepEqual([...reviewedIds(manifest, [{ file_path: path.relative(process.cwd(), png.local_path), ok: true }])], [], 'a relative path is not a proof');
    const view = modelView(manifest, reviewedIds(manifest, reads));
    assert.deepEqual(view.map(v => [v.attachment, v.access]), [['att-1', 'reviewed'], ['att-2', 'delivered']]);
    assert.ok(!JSON.stringify(view).includes(PNG.toString('base64')), 'the model view never carries the bytes');
  } finally { dir.cleanup(); }
});
