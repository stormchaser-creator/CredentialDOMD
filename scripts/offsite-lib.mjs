// Shared pieces for offsite-backup.mjs and offsite-restore.mjs.
//
// Everything that touches a credential lives here so the two scripts never
// handle a secret directly. Rules the callers rely on:
//   - the management token and the service_role key stay in memory;
//   - the archive passphrase reaches openssl over a private pipe (fd 3), never
//     the command line or the environment;
//   - error messages are truncated and never echo request bodies.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOOL_VERSION = '1.0.0';
export const ARCHIVE_FORMAT = 1;
export const OPENSSL = '/opt/homebrew/bin/openssl';
export const TAR = '/usr/bin/tar';
export const MGMT_API = 'https://api.supabase.com/v1';
export const KEYCHAIN_TOKEN_LABEL = 'Supabase CLI';
export const KEYCHAIN_PASS_SERVICE = 'CredentialDOMD Backup Key';
export const OPENSSL_ARGS = ['-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-salt'];

const execFileP = promisify(execFile);

// ---------------------------------------------------------------- keychain

async function readKeychain(flag, name) {
  try {
    const { stdout } = await execFileP('/usr/bin/security', ['find-generic-password', flag, name, '-w']);
    const value = stdout.replace(/\r?\n$/, '');
    if (!value) throw new Error('empty');
    return value;
  } catch {
    throw new Error(`keychain item "${name}" is not readable (needs the gui session, not cron)`);
  }
}

export const readManagementToken = () => readKeychain('-l', KEYCHAIN_TOKEN_LABEL);
export const readPassphrase = () => readKeychain('-s', KEYCHAIN_PASS_SERVICE);

// ---------------------------------------------------------- management API

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shortMessage(data) {
  const m = typeof data === 'object' && data && data.message ? data.message : String(data);
  return m.replace(/\s+/g, ' ').slice(0, 400);
}

export function managementClient(token) {
  async function call(method, route, body, attempt = 0) {
    const res = await fetch(`${MGMT_API}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (res.ok) return data;
    // 429 and transient 5xx: back off and retry (the management API allows
    // roughly 60 requests a minute).
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const wait = Math.max(retryAfter * 1000, 5000 * 2 ** attempt);
      await sleep(wait);
      return call(method, route, body, attempt + 1);
    }
    const err = new Error(`${method} ${route} -> HTTP ${res.status}: ${shortMessage(data)}`);
    err.status = res.status;
    throw err;
  }
  return {
    call,
    query: (ref, sql) => call('POST', `/projects/${ref}/database/query`, { query: sql }),
    async serviceRoleKey(ref) {
      const keys = await call('GET', `/projects/${ref}/api-keys`);
      const list = Array.isArray(keys) ? keys : [];
      const pick = list.find((k) => k.name === 'service_role' && k.api_key)
        || list.find((k) => k.type === 'secret' && k.api_key);
      if (!pick) throw new Error(`no service_role key returned for project ${ref}`);
      return pick.api_key;
    },
    async projectUrl(ref) {
      return `https://${ref}.supabase.co`;
    },
  };
}

// --------------------------------------------------------------- storage API

export function storageClient(projectUrl, serviceKey) {
  const base = `${projectUrl}/storage/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function request(method, route, { body, extraHeaders = {}, attempt = 0 } = {}) {
    const res = await fetch(`${base}${route}`, { method, headers: { ...headers, ...extraHeaders }, body });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(3000 * 2 ** attempt);
      return request(method, route, { body, extraHeaders, attempt: attempt + 1 });
    }
    let detail = '';
    try { detail = shortMessage(await res.json()); } catch { /* body may be empty */ }
    const err = new Error(`storage ${method} ${route.split('?')[0].replace(/\/object\/.*$/, '/object/...')} -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }

  return {
    // One level of a bucket: files have an id, folders come back with id null.
    async list(bucket, prefix, limit, offset) {
      const res = await request('POST', `/object/list/${bucket}`, {
        body: JSON.stringify({ prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } }),
        extraHeaders: { 'Content-Type': 'application/json' },
      });
      return res.json();
    },
    // Every object under a bucket, recursing into folders.
    async listAll(bucket, prefix = '') {
      const out = [];
      const limit = 1000;
      let offset = 0;
      for (;;) {
        const page = await this.list(bucket, prefix, limit, offset);
        for (const entry of page) {
          const full = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.id === null || entry.id === undefined) {
            out.push(...await this.listAll(bucket, full));
          } else {
            out.push({
              bucket,
              path: full,
              size: Number(entry.metadata?.size ?? entry.metadata?.contentLength ?? -1),
              updated_at: entry.updated_at || null,
              etag: entry.metadata?.eTag || null,
              mimetype: entry.metadata?.mimetype || 'application/octet-stream',
            });
          }
        }
        if (page.length < limit) break;
        offset += limit;
      }
      return out;
    },
    // Stream one object to disk, hashing as it goes. Returns { bytes, sha256 }.
    async download(bucket, objectPath, destFile) {
      const res = await request('GET', `/object/${bucket}/${encodePath(objectPath)}`);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const out = fs.createWriteStream(destFile, { mode: 0o600 });
      await new Promise((resolve, reject) => {
        out.on('error', reject);
        out.on('finish', resolve);
        (async () => {
          try {
            for await (const chunk of res.body) {
              hash.update(chunk);
              bytes += chunk.length;
              if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            }
            out.end();
          } catch (e) { out.destroy(e); reject(e); }
        })();
      });
      return { bytes, sha256: hash.digest('hex') };
    },
    async createBucket(spec) {
      return request('POST', '/bucket', {
        body: JSON.stringify(spec),
        extraHeaders: { 'Content-Type': 'application/json' },
      });
    },
    // Upload without overwriting; a 409 means the object already exists.
    async upload(bucket, objectPath, data, mimetype) {
      return request('POST', `/object/${bucket}/${encodePath(objectPath)}`, {
        body: data,
        extraHeaders: { 'Content-Type': mimetype || 'application/octet-stream', 'x-upsert': 'false' },
      });
    },
  };
}

// ------------------------------------------------------------- tar + openssl

function spawnWithPassphrase(cmd, args, passphrase, stdio) {
  // fd 3 carries the passphrase; openssl reads it with -pass fd:3.
  const child = spawn(cmd, args, { stdio: [...stdio, 'pipe'] });
  child.stdio[3].on('error', () => {});
  child.stdio[3].end(`${passphrase}\n`);
  return child;
}

function waitExit(child, name) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
    });
  });
}

// tar the given (cwd, entries) pairs into one encrypted file.
// sources: [{ cwd, entries: ['manifest.json', 'schema', ...] }, ...]
export async function createEncryptedTar(sources, outFile, passphrase) {
  const tarArgs = ['-cf', '-', '--no-xattrs', '--no-mac-metadata'];
  for (const s of sources) tarArgs.push('-C', s.cwd, ...s.entries);
  const tar = spawn(TAR, tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const enc = spawnWithPassphrase(OPENSSL, ['enc', ...OPENSSL_ARGS, '-pass', 'fd:3', '-out', outFile], passphrase, ['pipe', 'ignore', 'pipe']);
  tar.stdout.pipe(enc.stdin);
  await Promise.all([waitExit(tar, 'tar'), waitExit(enc, 'openssl enc')]);
}

// Decrypt an archive into destDir (which must exist).
export async function extractEncryptedTar(archiveFile, destDir, passphrase) {
  const dec = spawnWithPassphrase(OPENSSL, ['enc', '-d', ...OPENSSL_ARGS, '-pass', 'fd:3', '-in', archiveFile], passphrase, ['ignore', 'pipe', 'pipe']);
  const tar = spawn(TAR, ['-xf', '-', '-C', destDir], { stdio: ['pipe', 'ignore', 'pipe'] });
  dec.stdout.pipe(tar.stdin);
  await Promise.all([waitExit(dec, 'openssl dec'), waitExit(tar, 'tar')]);
}

// List the entries of an encrypted archive without extracting it.
export async function listEncryptedTar(archiveFile, passphrase) {
  const dec = spawnWithPassphrase(OPENSSL, ['enc', '-d', ...OPENSSL_ARGS, '-pass', 'fd:3', '-in', archiveFile], passphrase, ['ignore', 'pipe', 'pipe']);
  const tar = spawn(TAR, ['-tf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  dec.stdout.pipe(tar.stdin);
  let out = '';
  tar.stdout.on('data', (d) => { out += d; });
  await Promise.all([waitExit(dec, 'openssl dec'), waitExit(tar, 'tar')]);
  return out.split('\n').filter(Boolean);
}

// ------------------------------------------------------------------ helpers

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function localDate(d = new Date()) {
  return localStamp(d).slice(0, 10);
}

// Reject object keys that could escape the objects tree.
export function safeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

export const ARCHIVE_NAME_RE = /^\d{4}-\d{2}-\d{2}\.tar\.enc$/;

export async function newestArchive(dir) {
  const names = (await fsp.readdir(dir).catch(() => []))
    .filter((n) => ARCHIVE_NAME_RE.test(n))
    .sort();
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

export function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Dollar-quote a string for embedding in SQL, choosing a tag absent from it.
export function dollarQuote(text) {
  let tag = '$ofs$';
  let n = 0;
  while (text.includes(tag)) { n += 1; tag = `$ofs${n}$`; }
  return `${tag}${text}${tag}`;
}
