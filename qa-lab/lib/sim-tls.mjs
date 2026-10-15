// TLS for the iOS Simulator profile (npm run qa:sim, qa-lab/sim.mjs).
//
// iOS Safari (iOS 27 in the Simulator) upgrades the plain-HTTP lab's fetches to
// TLS on the same port, so every call fails ("Load failed", NSURLErrorDomain
// -1200). The profile serves the lab over HTTPS with a leaf certificate signed
// by a root CA made on this machine:
//
//   * the root CA is trusted by the Simulator only (`xcrun simctl keychain <udid>
//     add-root-cert`), never by this Mac's keychain;
//   * it carries name constraints, so even a leaked key could only vouch for
//     127.0.0.0/8, ::1 and localhost;
//   * the keys live outside the repository (QA_LAB_CA_DIR, default
//     ~/Library/Application Support/CredentialDOMD/qa-lab-ca/), in a 0700
//     folder, mode 0600, and are never printed: only openssl reads them, and
//     node only to check that a key matches its certificate.
//
// One CA per machine (every checkout shares it), so a Simulator trusts it once.
// The leaf lasts LEAF_DAYS and is made again when it nears its end, when the
// names it covers change, or when the CA is made again.
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SIM_TLS_HOSTS } from './lab-config.mjs';

export const CA_DAYS = 3650;
/** Under every lifetime limit Apple applies to TLS server certificates (825, 398, 200 days). */
export const LEAF_DAYS = 180;
/** A leaf (or CA) with less than this left is made again. */
export const RENEW_WITHIN_DAYS = 30;
const DAY = 86400000;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
export const CA_SUBJECT = '/O=CredentialDOMD QA lab (this machine only)/CN=CredentialDOMD QA lab local root CA';
export const LEAF_SUBJECT = '/O=CredentialDOMD QA lab (this machine only)/CN=localhost';

export function defaultCaDir(env = process.env) {
  return env.QA_LAB_CA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'CredentialDOMD', 'qa-lab-ca');
}

/** The files of one CA folder. Only *.pem are certificates; *.key are private keys (never read out). */
export function caFiles(dir = defaultCaDir()) {
  return { dir, caCert: path.join(dir, 'ca.pem'), caKey: path.join(dir, 'ca.key'), cert: path.join(dir, 'leaf.pem'), key: path.join(dir, 'leaf.key'), config: path.join(dir, 'openssl.cnf') };
}

/** Homebrew's OpenSSL 3 when present (macOS's /usr/bin/openssl is LibreSSL), else whatever `openssl` is on PATH. */
export function opensslBin(env = process.env, exists = existsSync) {
  if (env.OPENSSL) return env.OPENSSL;
  for (const p of ['/opt/homebrew/bin/openssl', '/usr/local/opt/openssl@3/bin/openssl']) if (exists(p)) return p;
  return 'openssl';
}

/** The openssl configuration: extensions only, no secret. */
export function opensslConfig(hosts = SIM_TLS_HOSTS) {
  const san = [...hosts.dns.map((d) => `DNS:${d}`), ...hosts.ip.map((ip) => `IP:${ip}`)].join(', ');
  const permitted = [
    ...hosts.dns.map((d) => `permitted;DNS:${d}`),
    ...hosts.ip.map((ip) => (ip.includes(':') ? `permitted;IP:${ip}/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff` : `permitted;IP:${ip.split('.')[0]}.0.0.0/255.0.0.0`)),
  ].join(', ');
  return `# Written by qa-lab/lib/sim-tls.mjs (the QA lab's iOS Simulator profile). Extensions only.
[req]
distinguished_name = dn
[dn]
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, ${permitted}
[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${san}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`;
}

function openssl(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`openssl could not run (${bin}): ${r.error.message}`);
  // stderr may name files and steps; it never holds key material.
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
}

function keyMatches(certFile, keyFile) {
  try { return new X509Certificate(readFileSync(certFile)).checkPrivateKey(createPrivateKey(readFileSync(keyFile))); } catch { return false; }
}

const daysLeft = (x509, now) => (Date.parse(x509.validTo) - now) / DAY;

/** Why the CA in `files` cannot be used (null when it can). */
export function caProblem(files, { now = Date.now() } = {}) {
  if (!existsSync(files.caCert) || !existsSync(files.caKey)) return 'missing';
  let ca;
  try { ca = new X509Certificate(readFileSync(files.caCert)); } catch { return 'unreadable'; }
  if (!ca.ca) return 'not a CA';
  if (!ca.verify(ca.publicKey)) return 'not self-signed';
  if (daysLeft(ca, now) < RENEW_WITHIN_DAYS) return 'expiring';
  if (!keyMatches(files.caCert, files.caKey)) return 'key does not match';
  return null;
}

/** Why the leaf in `files` cannot be used with the CA there (null when it can). */
export function leafProblem(files, { now = Date.now(), hosts = SIM_TLS_HOSTS } = {}) {
  if (!existsSync(files.cert) || !existsSync(files.key)) return 'missing';
  let leaf; let ca;
  try { leaf = new X509Certificate(readFileSync(files.cert)); ca = new X509Certificate(readFileSync(files.caCert)); } catch { return 'unreadable'; }
  if (leaf.ca) return 'a CA, not a leaf';
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return 'not signed by this CA';
  if (daysLeft(leaf, now) < RENEW_WITHIN_DAYS) return 'expiring';
  if ((Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY > LEAF_DAYS + 1) return 'lasts too long';
  if (!(leaf.keyUsage || []).includes(SERVER_AUTH)) return 'no serverAuth';
  for (const d of hosts.dns) if (!leaf.checkHost(d, { subject: 'never' })) return `does not cover ${d}`;
  for (const ip of hosts.ip) if (!leaf.checkIP(ip)) return `does not cover ${ip}`;
  if (!keyMatches(files.cert, files.key)) return 'key does not match';
  return null;
}

/**
 * Makes (or reuses) the root CA and the leaf in `dir`. Returns the file paths,
 * the CA's SHA-256 fingerprint, the leaf's end date, and what was made now.
 */
export function ensureSimCertificates({ dir = defaultCaDir(), bin = opensslBin(), now = Date.now(), hosts = SIM_TLS_HOSTS, log = () => {} } = {}) {
  const files = caFiles(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(files.config, opensslConfig(hosts));
  const made = { ca: false, leaf: false };
  const caWhy = caProblem(files, { now });
  if (caWhy) {
    log(`qa-sim: making the local root CA (${caWhy})`);
    for (const f of [files.caCert, files.caKey, files.cert, files.key]) rmSync(f, { force: true });
    openssl(bin, ['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS),
      '-keyout', files.caKey, '-out', files.caCert, '-subj', CA_SUBJECT, '-config', files.config, '-extensions', 'v3_ca'], dir);
    chmodSync(files.caKey, 0o600);
    made.ca = true;
  }
  const leafWhy = leafProblem(files, { now, hosts });
  if (leafWhy) {
    log(`qa-sim: making the leaf certificate for ${[...hosts.ip, ...hosts.dns].join(', ')} (${leafWhy})`);
    const csr = path.join(dir, 'leaf.csr');
    for (const f of [files.cert, files.key, csr]) rmSync(f, { force: true });
    try {
      openssl(bin, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', files.key, '-out', csr, '-subj', LEAF_SUBJECT, '-config', files.config], dir);
      chmodSync(files.key, 0o600);
      openssl(bin, ['x509', '-req', '-in', csr, '-CA', files.caCert, '-CAkey', files.caKey, '-set_serial', `0x${randomBytes(16).toString('hex')}`,
        '-days', String(LEAF_DAYS), '-sha256', '-extfile', files.config, '-extensions', 'v3_leaf', '-out', files.cert], dir);
    } finally {
      rmSync(csr, { force: true });
    }
    made.leaf = true;
    const again = leafProblem(files, { now, hosts });
    if (again) throw new Error(`the new leaf certificate is not usable: ${again}`);
  }
  for (const f of [files.caKey, files.key]) chmodSync(f, 0o600);
  const ca = new X509Certificate(readFileSync(files.caCert));
  const leaf = new X509Certificate(readFileSync(files.cert));
  return { ...files, caFingerprint: ca.fingerprint256, leafValidTo: new Date(leaf.validTo).toISOString(), made };
}

// ── The Simulator's trust store ──────────────────────────────────────────────
const XCODE_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

/** `xcrun simctl ...` with Xcode's developer folder (the Command Line Tools have no simctl). */
export function simctl(args, { env = process.env, run = spawnSync } = {}) {
  const e = { ...env };
  if (!e.DEVELOPER_DIR && existsSync(XCODE_DEVELOPER_DIR)) e.DEVELOPER_DIR = XCODE_DEVELOPER_DIR;
  return run('xcrun', ['simctl', ...args], { encoding: 'utf8', env: e });
}

/** Booted iOS Simulators ({ udid, name, runtime }); [] when simctl is unavailable. */
export function bootedIosSimulators({ run } = {}) {
  const r = simctl(['list', 'devices', 'booted', '-j'], { run });
  if (!r || r.status !== 0) return [];
  try {
    const out = [];
    for (const [runtime, devices] of Object.entries(JSON.parse(r.stdout).devices || {})) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devices) if (d.state === 'Booted') out.push({ udid: d.udid, name: d.name, runtime: runtime.replace(/^.*SimRuntime\./, '') });
    }
    return out;
  } catch { return []; }
}

/** Trusts the CA certificate (never a key) in one Simulator's root store. */
export function trustCaInSimulator(udid, caCert, { run } = {}) {
  if (!/^[0-9A-F-]{36}$/i.test(udid)) throw new Error(`not a Simulator UDID: ${udid}`);
  if (!caCert.endsWith('.pem')) throw new Error('only the CA certificate (.pem) goes to the Simulator');
  const r = simctl(['keychain', udid, 'add-root-cert', caCert], { run });
  if (!r || r.status !== 0) throw new Error(`simctl keychain ${udid} add-root-cert failed: ${(r?.stderr || '').trim()}`);
}
