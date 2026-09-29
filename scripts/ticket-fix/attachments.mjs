#!/usr/bin/env node
// G6: every attachment on the ticket reaches the model as a local file, and
// "reviewed" means the model's own tool events show it read that file
// (design G6, stage 3).
//
// Until stage 3 the model got storage paths only (access "not_loaded") and
// nothing ever set "reviewed": screenshot tickets were worked without the
// screenshot (5bef10ac, 5f9b744d, 95e6425f), and one reply said "there is no
// attachment" about a 409 KB PNG that was there (a36aeef3).
//
//   node attachments.mjs fetch --context FILE --out DIR --manifest FILE
//        (TICKET_DATABASE_TOKEN in the environment: the runner's management token)
//
// The runner runs this after --load and before run.mjs, as its own process:
// the only one that holds a storage credential, and it exits before any model
// session starts. It downloads every attachment on the target ticket and its
// messages, and the newest MAX_RELATED on the customer's related tickets,
// from the private "documents" bucket; checks the magic bytes (PNG, JPEG,
// GIF, WebP, HEIC/HEIF, PDF); converts HEIC to PNG and shrinks any image
// over MAX_DIMENSION pixels with /usr/bin/sips; refuses anything over
// MAX_BYTES; and writes att-<n>.<ext> (mode 0600) into DIR, an owner-only
// directory the sessions of this ticket may read and nothing else may. The
// manifest (the host's record: path, sha256, type, access) goes to the run's
// private directory. A download that fails is "unavailable" with a reason and
// becomes internal work for the runner, never a request to the customer.
//
// The management token lists the project's API keys (the service key); the
// key is held in this process's memory for the downloads only: never written,
// never logged, never in an error, never passed on. Log lines carry the
// ticket id and the storage path, nothing else.
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, realpathSync, existsSync, lstatSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_EXEC, sandboxAvailable, sandboxProfile } from './sandbox.mjs';

export const PROJECT = 'hkpnnsjcwprrwobmpqyy';
export const BUCKET = 'documents';
// Storage accepts 5 MB per file (ticketAttachment.ts); anything larger is not ours.
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_RELATED = 6;
export const MAX_TARGET = 30;
export const MAX_DIMENSION = 2000;
// The run's attachment root (ticket-agent.sh: mktemp next to the run
// directory), named so the sessions' denial of credentialdomd-ticket-* does
// not cover it; each ticket gets its own subdirectory, removed after its run.
export const ATTACH_ROOT_PREFIX = 'credentialdomd-attachments.';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// The object layout under the bucket (supabase/functions/_shared/ticketAttachment.ts):
// tickets/<ticket>/<file> or tickets/<ticket>/replies/<file>, and nothing else.
export function validStoragePath(storagePath, ticketId) {
  if (typeof storagePath !== 'string' || !UUID.test(ticketId || '') || storagePath.length > 300) return false;
  const parts = storagePath.split('/');
  if (parts[0] !== 'tickets' || parts[1] !== ticketId) return false;
  if (parts.length === 3) return NAME.test(parts[2]);
  return parts.length === 4 && parts[2] === 'replies' && NAME.test(parts[3]);
}

// Magic bytes. A declared type or an extension is never trusted.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);
export function sniff(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const at = (offset, text) => b.length >= offset + text.length && b.toString('latin1', offset, offset + text.length) === text;
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { media_type: 'image/png', ext: 'png', image: true };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { media_type: 'image/jpeg', ext: 'jpg', image: true };
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { media_type: 'image/gif', ext: 'gif', image: true };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { media_type: 'image/webp', ext: 'webp', image: true };
  if (at(0, '%PDF-')) return { media_type: 'application/pdf', ext: 'pdf', image: false };
  if (at(4, 'ftyp') && b.length >= 12 && HEIF_BRANDS.has(b.toString('latin1', 8, 12))) return { media_type: 'image/heic', ext: 'heic', image: true, heic: true };
  return null;
}

// Which attachments this run delivers: every one on the target ticket and its
// messages (up to MAX_TARGET), then the newest MAX_RELATED on related
// tickets. Each gets a stable local id att-<n> in this order.
export function selectAttachments(context, { relatedLimit = MAX_RELATED, targetLimit = MAX_TARGET } = {}) {
  const when = new Map();
  for (const ticket of context?.tickets ?? []) {
    when.set(ticket.id, ticket.created_at ?? '');
    for (const message of ticket.messages ?? []) when.set(message.id, message.created_at ?? '');
  }
  const seen = new Set();
  const all = (context?.attachments ?? []).filter(a => {
    const key = `${a.ticket_id}|${a.storage_path}`;
    if (typeof a?.storage_path !== 'string' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const target = all.filter(a => a.ticket_id === context.target_id);
  const related = all.filter(a => a.ticket_id !== context.target_id)
    .sort((a, b) => String(when.get(b.source_id) ?? '').localeCompare(String(when.get(a.source_id) ?? '')));
  const chosen = [...target.map((a, i) => ({ ...a, target: true, over_limit: i >= targetLimit })), ...related.slice(0, relatedLimit).map(a => ({ ...a, target: false, over_limit: false }))];
  return chosen.map((a, i) => ({ id: `att-${i + 1}`, ticket_id: a.ticket_id, source_id: a.source_id, storage_path: a.storage_path, target: a.target, over_limit: a.over_limit,
    path_valid: validStoragePath(a.storage_path, a.ticket_id) }));
}

// Width and height from the header bytes (PNG, GIF, JPEG, WebP), so the
// common images are sized without handing them to an image library.
export function imageSize(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const kind = sniff(b)?.media_type;
  try {
    if (kind === 'image/png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (kind === 'image/gif' && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (kind === 'image/webp' && b.length >= 30) {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    }
    if (kind === 'image/jpeg') {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { return null; }
  return null;
}

// /usr/bin/sips converts HEIC to PNG and shrinks an image over the limit. It
// parses a file a customer uploaded, so it runs under the gates sandbox (no
// network, no credential, writes only the ticket's attachment folder) wherever
// sandbox-exec exists. sips writes through a temporary file directly in the
// user temporary directory and ignores TMPDIR, so files directly in that
// directory are open to it, except the runner's own (credentialdomd-*).
// Tests pass their own converter.
export const SIPS = '/usr/bin/sips';
function userTempDir() {
  const r = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try { return realpathSync(r.stdout.trim()); } catch { return null; }
}
export function sipsIn(dir) {
  let profile = null;
  const run = args => {
    if (dir && sandboxAvailable()) {
      if (!profile) {
        const temp = userTempDir();
        if (!temp || !/^[\w/.-]+$/.test(temp)) return { status: 1, stdout: '' };
        const home = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'credentialdomd-sips-'));
        profile = path.join(home, 'sips.sb');
        const esc = temp.replace(/[.]/g, '\\.');
        writeFileSync(profile, `${sandboxProfile({ kind: 'gates', writable: [dir] })};; sips's own temporary file, directly in the user temporary directory
(allow file-read* file-write* (regex #"^${esc}/[^/]+$"))
(deny file-read* file-write* (regex #"^${esc}/credentialdomd-"))
`, { mode: 0o600 });
      }
      return spawnSync(SANDBOX_EXEC, ['-f', profile, SIPS, ...args], { encoding: 'utf8', timeout: 60000, cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } });
    }
    return spawnSync(SIPS, args, { encoding: 'utf8', timeout: 60000 });
  };
  return {
    toPng(input, output) { if (run(['-s', 'format', 'png', input, '--out', output]).status !== 0) throw Error('sips could not convert the image'); },
    dimensions(file) {
      const r = run(['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
      if (r.status !== 0) return null;
      const width = Number(/pixelWidth:\s*(\d+)/.exec(r.stdout)?.[1]);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(r.stdout)?.[1]);
      return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
    },
    shrink(file, max) { if (run(['-Z', String(max), file]).status !== 0) throw Error('sips could not resize the image'); },
    done() { if (profile) rmSync(path.dirname(profile), { recursive: true, force: true }); profile = null; },
  };
}

async function ownerDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error(`${dir} must be an owner-only directory`);
}

// Downloads, checks and writes one run's attachments. fetchObject(path) ->
// Buffer, or throws. Never throws for one attachment: that one is
// "unavailable" with a reason. log gets ticket id and storage path only.
export async function deliverAttachments({ context, outDir, fetchObject, convert = null, log = () => {}, maxBytes = MAX_BYTES, maxDimension = MAX_DIMENSION,
  relatedLimit = MAX_RELATED, targetLimit = MAX_TARGET }) {
  if (!UUID.test(context?.target_id || '')) throw Error('The context names no target ticket');
  if (!path.isAbsolute(outDir || '')) throw Error('The attachment directory must be absolute');
  await ownerDir(outDir);
  const dir = realpathSync(outDir);
  const own = convert ? null : sipsIn(dir);
  convert ??= own;
  try { return await deliverInto({ context, dir, fetchObject, convert, log, maxBytes, maxDimension, relatedLimit, targetLimit }); }
  finally { own?.done(); }
}
async function deliverInto({ context, dir, fetchObject, convert, log, maxBytes, maxDimension, relatedLimit, targetLimit }) {
  const out = [];
  for (const entry of selectAttachments(context, { relatedLimit, targetLimit })) {
    const record = { ...entry, access: 'unavailable', local_path: null, media_type: null, bytes: null, sha256: null, original_sha256: null, converted: false, reason: null };
    const done = (reason = null) => {
      record.reason = reason;
      if (!reason) record.access = 'delivered';
      out.push(record);
      log(`${stamp()} ATTACHMENT — ${context.target_id} ${entry.storage_path}: ${reason ? `unavailable (${reason})` : `delivered as ${entry.id}`}`);
    };
    if (entry.over_limit) { done(`more than ${targetLimit} attachments on the ticket`); continue; }
    if (!entry.path_valid) { done('the path is outside the ticket folder'); continue; }
    let bytes;
    try { bytes = await fetchObject(entry.storage_path); } catch (error) { done(`download failed: ${String(error?.message ?? error).slice(0, 120)}`); continue; }
    if (!Buffer.isBuffer(bytes) || !bytes.length) { done('the download was empty'); continue; }
    if (bytes.length > maxBytes) { done(`larger than ${Math.round(maxBytes / 1048576)} MB`); continue; }
    const kind = sniff(bytes);
    if (!kind) { done('not an image or a PDF'); continue; }
    record.original_sha256 = sha256(bytes);
    try {
      let file = path.join(dir, `${entry.id}.${kind.ext}`);
      await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      let type = kind;
      if (kind.heic) {
        const png = path.join(dir, `${entry.id}.png`);
        convert.toPng(file, png);
        await fs.rm(file, { force: true });
        file = png;
        type = sniff(readFileSync(file));
        if (type?.media_type !== 'image/png') throw Error('the HEIC conversion did not produce a PNG');
        record.converted = true;
      }
      if (type.image) {
        const size = imageSize(readFileSync(file)) ?? convert.dimensions(file);
        if (size && Math.max(size.width, size.height) > maxDimension) { convert.shrink(file, maxDimension); record.converted = true; }
      }
      await fs.chmod(file, 0o600);
      const delivered = readFileSync(file);
      if (delivered.length > maxBytes) { await fs.rm(file, { force: true }); done(`larger than ${Math.round(maxBytes / 1048576)} MB after conversion`); continue; }
      Object.assign(record, { local_path: file, media_type: type.media_type, bytes: delivered.length, sha256: sha256(delivered) });
      done();
    } catch (error) {
      done(`could not be prepared: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  return { version: 1, ticket_id: context.target_id, dir, created_at: new Date().toISOString(), attachments: out };
}

// The service key from the management API's key listing. Legacy projects list
// { name: 'service_role', api_key: <JWT> }; newer ones { type: 'secret',
// api_key: 'sb_secret_...' } (revealed with ?reveal=true). Anything else: none.
export function pickServiceKey(rows) {
  if (!Array.isArray(rows)) return null;
  const legacy = rows.find(r => r?.name === 'service_role' && typeof r.api_key === 'string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(r.api_key));
  if (legacy) return legacy.api_key;
  const secret = rows.find(r => r?.type === 'secret' && typeof r.api_key === 'string' && /^sb_secret_[\w-]{16,}$/.test(r.api_key));
  return secret ? secret.api_key : null;
}
// A downloader for the documents bucket, keyed through the management token.
// Errors carry status codes only.
export function storageFetcher({ token, fetchImpl = globalThis.fetch, project = PROJECT, maxBytes = MAX_BYTES }) {
  if (typeof token !== 'string' || !token) throw Error('A management token is required');
  let key = null;
  const serviceKey = async () => {
    if (key) return key;
    const response = await fetchImpl(`https://api.supabase.com/v1/projects/${project}/api-keys?reveal=true`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`the key listing returned ${response.status}`);
    let rows;
    try { rows = JSON.parse(await response.text()); } catch { throw Error('the key listing was not JSON'); }
    key = pickServiceKey(rows);
    if (!key) throw Error('the key listing has no service key');
    return key;
  };
  return async storagePath => {
    const k = await serviceKey();
    const url = `https://${project}.supabase.co/storage/v1/object/${BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
    // A secret key goes in apikey only; a legacy service JWT in both.
    const headers = k.startsWith('sb_secret_') ? { apikey: k } : { apikey: k, Authorization: `Bearer ${k}` };
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`storage returned ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw Error('larger than the limit');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw Error('larger than the limit');
    return bytes;
  };
}

// The host's manifest, read back by run.mjs: an owner-only file whose every
// delivered entry is a file in the attachment directory with its recorded
// sha256. Anything else is refused (nothing is delivered).
export function readManifest(file, { ticketId, dir }) {
  if (!file || !existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw Error('The attachment manifest must be an owner-only file');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest?.version !== 1 || manifest.ticket_id !== ticketId || !Array.isArray(manifest.attachments)) throw Error('The attachment manifest is for another ticket');
  const root = dir ? realpathSync(dir) : null;
  for (const a of manifest.attachments) {
    if (!/^att-\d{1,3}$/.test(a.id || '') || typeof a.storage_path !== 'string' || !['delivered', 'unavailable'].includes(a.access)) throw Error('Unusable attachment manifest entry');
    if (a.access !== 'delivered') continue;
    if (!root || path.dirname(a.local_path) !== root || !existsSync(a.local_path) || sha256(readFileSync(a.local_path)) !== a.sha256) throw Error('A delivered attachment does not match its manifest');
  }
  return manifest;
}

// "Reviewed" is proven, never claimed: the session's own tool events (the
// CLI's stream on its stdout, which nothing the session runs can write to)
// show a Read of that exact path that did not fail. reads: [{ file_path, ok }].
export function reviewedIds(manifest, reads) {
  const norm = p => { try { return realpathSync(p); } catch { return path.resolve(String(p)); } };
  const ok = new Set((reads ?? []).filter(r => r && r.ok && typeof r.file_path === 'string' && path.isAbsolute(r.file_path)).map(r => norm(r.file_path)));
  return new Set((manifest?.attachments ?? []).filter(a => a.access === 'delivered' && a.local_path && ok.has(norm(a.local_path))).map(a => a.id));
}

// The attachment inventory as the model sees it: ids, where each came from,
// the local path to Read and what the host knows. Never the bytes.
export function modelView(manifest, reviewed = new Set()) {
  return (manifest?.attachments ?? []).map(a => ({ attachment: a.id, ticket_id: a.ticket_id, source_id: a.source_id, storage_path: a.storage_path, target: a.target,
    access: a.access === 'delivered' ? (reviewed.has(a.id) ? 'reviewed' : 'delivered') : 'unavailable', ...(a.access === 'delivered' ? { local_path: a.local_path, media_type: a.media_type } : { reason: a.reason }) }));
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!/^--[a-z-]+$/.test(key) || argv[i + 1] === undefined) throw Error(`Unexpected argument ${key}`);
    options[key.slice(2)] = argv[i + 1];
  }
  return options;
}
export async function main(argv, { env = process.env, fetchImpl = globalThis.fetch, log = line => console.log(line), convert = null } = {}) {
  const [command, ...rest] = argv;
  const o = parseArgs(rest);
  if (command !== 'fetch' || !['context', 'out', 'manifest'].every(k => path.isAbsolute(o[k] || ''))) throw Error('Usage: attachments.mjs fetch --context FILE --out DIR --manifest FILE (absolute paths)');
  const context = JSON.parse(readFileSync(o.context, 'utf8'));
  let fetchObject;
  const wanted = selectAttachments(context).filter(a => a.path_valid && !a.over_limit).length;
  try { fetchObject = wanted ? storageFetcher({ token: env.TICKET_DATABASE_TOKEN, fetchImpl }) : async () => { throw Error('nothing to fetch'); }; }
  catch (error) { const reason = String(error.message); fetchObject = async () => { throw Error(reason); }; }
  const manifest = await deliverAttachments({ context, outDir: o.out, fetchObject, convert, log });
  const temporary = `${o.manifest}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, o.manifest);
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.log(`${stamp()} ERROR — attachments: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
    process.exitCode = 1;
  });
}
