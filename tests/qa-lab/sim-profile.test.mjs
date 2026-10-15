// The iOS Simulator profile (npm run qa:sim): the lab over HTTPS for Mobile
// Safari. Offline: no Simulator, no stack. Certificates are made in a temporary
// folder with openssl; key files are only checked for their mode, never read out.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CA_DAYS, LEAF_DAYS, caFiles, caProblem, ensureSimCertificates, leafProblem, opensslBin, trustCaInSimulator } from '../../qa-lab/lib/sim-tls.mjs';
import { createApiProxy } from '../../qa-lab/lib/api-proxy.mjs';
import { qaAppEnv } from '../../qa-lab/lib/app-env.mjs';
import { APP_PUBLIC_ORIGIN, DEFAULT_API_PORT, DEFAULT_APP_PORT, DEFAULT_MOCK_PORT, DEFAULT_SIM_API_PORT, DEFAULT_SIM_APP_PORT } from '../../qa-lab/lib/lab-config.mjs';
import { GENERATED_DIR, QA_APP_DIST, QA_VITE_CONFIG, SIM_APP_DIST } from '../../qa-lab/lib/paths.mjs';
import { anonKeyIdentity, isSimServer } from '../../qa-lab/sim.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DAY = 86400000;
const SIM_APP = 'https://127.0.0.1:54395';
const LAB_APP = 'http://127.0.0.1:54390';
const OPENSSL = opensslBin();
const haveOpenssl = spawnSync(OPENSSL, ['version'], { encoding: 'utf8' }).status === 0;

let dir;
let certs;
test.before(() => {
  if (!haveOpenssl) return;
  dir = mkdtempSync(path.join(tmpdir(), 'qa-sim-ca-'));
  certs = ensureSimCertificates({ dir: path.join(dir, 'ca') });
});
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('ports: the profile has ports of its own, apart from the running lab\'s', () => {
  const lab = [DEFAULT_MOCK_PORT, DEFAULT_API_PORT, DEFAULT_APP_PORT];
  for (const p of [DEFAULT_SIM_APP_PORT, DEFAULT_SIM_API_PORT]) assert.ok(!lab.includes(p), `${p} is a lab port`);
  assert.notEqual(DEFAULT_SIM_APP_PORT, DEFAULT_SIM_API_PORT, 'the API is another origin than the app');
});

test('certificates: a name-constrained root CA and a short-lived leaf for 127.0.0.1, ::1 and localhost; keys 0600 in a 0700 folder', { skip: !haveOpenssl && 'openssl not installed' }, () => {
  assert.deepEqual(certs.made, { ca: true, leaf: true });
  assert.equal(statSync(certs.dir).mode & 0o777, 0o700);
  for (const key of [certs.caKey, certs.key]) assert.equal(statSync(key).mode & 0o777, 0o600, `${path.basename(key)} must be 0600`);
  assert.equal(caProblem(certs), null);
  assert.equal(leafProblem(certs), null);
  const verify = spawnSync(OPENSSL, ['verify', '-CAfile', certs.caCert, certs.cert], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  const caText = spawnSync(OPENSSL, ['x509', '-in', certs.caCert, '-noout', '-text'], { encoding: 'utf8' }).stdout;
  assert.match(caText, /Name Constraints: critical/);
  assert.match(caText, /DNS:localhost/);
  assert.match(caText, /IP:127\.0\.0\.0\/255\.0\.0\.0/);
  assert.ok(LEAF_DAYS <= 200 && CA_DAYS > LEAF_DAYS);
  // Reused as they are on the next start.
  const again = ensureSimCertificates({ dir: certs.dir });
  assert.deepEqual(again.made, { ca: false, leaf: false });
  assert.equal(again.caFingerprint, certs.caFingerprint);
  // Made again when they near their end.
  assert.equal(leafProblem(certs, { now: Date.now() + (LEAF_DAYS - 10) * DAY }), 'expiring');
  assert.equal(caProblem(certs, { now: Date.now() + (CA_DAYS - 10) * DAY }), 'expiring');
  assert.equal(leafProblem(certs, { hosts: { dns: ['example.com'], ip: [] } }), 'does not cover example.com');
});

test('negative control: the CA cannot vouch for a host that is not this machine (name constraints)', { skip: !haveOpenssl && 'openssl not installed' }, () => {
  const work = mkdtempSync(path.join(dir, 'bad-'));
  const cnf = path.join(work, 'bad.cnf');
  writeFileSync(cnf, '[req]\ndistinguished_name = dn\n[dn]\n[v3]\nbasicConstraints = critical, CA:FALSE\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:credentialdomd.com\n');
  const key = path.join(work, 'bad.key');
  const csr = path.join(work, 'bad.csr');
  const pem = path.join(work, 'bad.pem');
  assert.equal(spawnSync(OPENSSL, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=credentialdomd.com', '-config', cnf]).status, 0);
  assert.equal(spawnSync(OPENSSL, ['x509', '-req', '-in', csr, '-CA', certs.caCert, '-CAkey', certs.caKey, '-set_serial', '7', '-days', '10', '-extfile', cnf, '-extensions', 'v3', '-out', pem]).status, 0);
  const verify = spawnSync(OPENSSL, ['verify', '-CAfile', certs.caCert, pem], { encoding: 'utf8' });
  assert.notEqual(verify.status, 0, 'a leaf for another host must not verify');
  assert.match(verify.stdout + verify.stderr, /subtree/i);
});

test('only the CA certificate goes to the Simulator, by UDID', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
  const files = caFiles('/x');
  trustCaInSimulator('0A1B2C3D-0000-4000-8000-00000000A001', files.caCert, { run });
  assert.deepEqual(calls[0].slice(0, 6), ['xcrun', 'simctl', 'keychain', '0A1B2C3D-0000-4000-8000-00000000A001', 'add-root-cert', '/x/ca.pem']);
  assert.throws(() => trustCaInSimulator('booted', files.caCert, { run }), /not a Simulator UDID/);
  assert.throws(() => trustCaInSimulator('0A1B2C3D-0000-4000-8000-00000000A001', files.caKey, { run }), /only the CA certificate/);
});

test('the API proxy over TLS: the https app origin presented as production, Allow-Origin renamed back; TLS checked against the CA', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  assert.throws(() => createApiProxy({ appOrigin: SIM_APP }), /needs the API proxy over TLS/);
  assert.throws(() => createApiProxy({ appOrigin: LAB_APP, tls: { key: 'k', cert: 'c' } }), /https lab app origin only/);
  assert.throws(() => createApiProxy({ appOrigin: 'https://credentialdomd.com', tls: { key: 'k', cert: 'c' } }), /lab app origin/);
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.origin);
    res.writeHead(200, { 'Access-Control-Allow-Origin': APP_PUBLIC_ORIGIN, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' });
    res.end('ok');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = createApiProxy({ port: 0, appOrigin: SIM_APP, target: `http://127.0.0.1:${upstream.address().port}`, tls: { key: readFileSync(certs.key), cert: readFileSync(certs.cert) }, log: () => {} });
  await proxy.listen();
  const url = `https://127.0.0.1:${proxy.server.address().port}/functions/v1/initialize-clerk-profile`;
  const ask = (opts) => new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'OPTIONS', headers: { Origin: SIM_APP, 'Access-Control-Request-Method': 'POST' }, ...opts }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('error', reject);
    req.end();
  });
  try {
    const res = await ask({ ca: readFileSync(certs.caCert) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], SIM_APP);
    assert.deepEqual(seen, [APP_PUBLIC_ORIGIN]);
    // A client that does not trust the lab CA refuses the connection, as Safari would without it.
    await assert.rejects(ask({ ca: [] }), /self[- ]signed|unable to (get|verify)|certificate/i);
  } finally {
    await new Promise((r) => proxy.server.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

test('the hosted stand-ins: the mock\'s http app origin becomes the profile\'s in redirects, form-action and links only', async () => {
  const { rewriteMockAnswer } = await import('../../qa-lab/app/vite.config.mjs');
  const body = `<a href="${LAB_APP}/app/?billing=complete">Back</a> <span>http://127.0.0.1:5439</span> ${LAB_APP}0`;
  const out = rewriteMockAnswer({
    headers: { location: `${LAB_APP}/app/?billing=complete`, 'content-security-policy': `form-action 'self' ${LAB_APP}; base-uri 'none'`, 'content-type': 'text/html; charset=utf-8', connection: 'keep-alive', 'transfer-encoding': 'chunked', 'x-other': LAB_APP },
    body: Buffer.from(body),
  }, { from: LAB_APP, to: SIM_APP });
  assert.equal(out.headers.location, `${SIM_APP}/app/?billing=complete`);
  assert.equal(out.headers['content-security-policy'], `form-action 'self' ${SIM_APP}; base-uri 'none'`);
  assert.equal(out.headers['x-other'], LAB_APP, 'other headers pass unchanged');
  assert.equal(out.headers.connection, undefined, 'no hop-by-hop header (HTTP/2 refuses them)');
  assert.equal(out.headers['transfer-encoding'], undefined);
  const text = out.body.toString('utf8');
  assert.ok(text.includes(`href="${SIM_APP}/app/?billing=complete"`));
  assert.ok(text.includes('http://127.0.0.1:5439<'), 'another origin is left alone');
  assert.ok(text.endsWith(`${LAB_APP}0`), 'an origin with a longer port is left alone');
  assert.equal(out.headers['content-length'], String(out.body.length));
  const bin = Buffer.from([0, 1, 2]);
  assert.equal(rewriteMockAnswer({ headers: { 'content-type': 'application/pdf' }, body: bin }, { from: LAB_APP, to: SIM_APP }).body, bin);
  assert.throws(() => rewriteMockAnswer({ headers: {}, body: '' }, { from: LAB_APP, to: 'https://credentialdomd.com' }), /two lab app origins/);
});

test('the profile\'s build: https API baked in, its own output folder, served over TLS; refusals', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const env = qaAppEnv({ appPort: 54395, apiPort: 54396, anonKey: 'anon', scheme: 'https', base: { PATH: process.env.PATH } });
  assert.equal(env.VITE_SUPABASE_URL, 'https://127.0.0.1:54396');
  assert.equal(qaAppEnv({ appPort: 54390, apiPort: 54385, anonKey: 'anon', base: {} }).VITE_SUPABASE_URL, 'http://127.0.0.1:54385', 'qa:lab\'s build is unchanged');
  assert.throws(() => qaAppEnv({ appPort: 1, apiPort: 2, anonKey: 'a', scheme: 'ftp' }), /http or https/);
  const keys = ['VITE_QA_LAB', 'VITE_SUPABASE_URL', 'QA_LAB_APP_PORT', 'QA_LAB_MOCK_URL', 'QA_LAB_APP_DIST', 'QA_LAB_TLS_CERT', 'QA_LAB_TLS_KEY', 'QA_LAB_APP_ORIGIN', 'QA_LAB_MOCK_APP_ORIGIN'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const set = (vars) => { for (const k of keys) delete process.env[k]; Object.assign(process.env, vars); };
  try {
    const { default: config, qaOutDir } = await import('../../qa-lab/app/vite.config.mjs');
    const sim = { VITE_QA_LAB: '1', VITE_SUPABASE_URL: 'https://127.0.0.1:54396', QA_LAB_APP_PORT: '54395', QA_LAB_MOCK_URL: 'http://127.0.0.1:54380', QA_LAB_APP_DIST: SIM_APP_DIST, QA_LAB_TLS_CERT: certs.cert, QA_LAB_TLS_KEY: certs.key, QA_LAB_APP_ORIGIN: SIM_APP, QA_LAB_MOCK_APP_ORIGIN: LAB_APP };
    set(sim);
    const served = config({ command: 'serve', mode: 'production' });
    assert.ok(served.preview.https?.cert && served.preview.https?.key, 'served over TLS');
    assert.equal(served.preview.cors, false, 'still no CORS middleware (PREVIEW_CORS)');
    assert.equal(served.preview.host, '127.0.0.1');
    assert.ok(served.plugins.some((p) => p?.name === 'qa-lab-mock-origin'), 'the hosted stand-ins\' origin is renamed');
    const built = config({ command: 'build', mode: 'production' });
    assert.equal(built.build.outDir, SIM_APP_DIST);
    assert.notEqual(built.build.outDir, QA_APP_DIST, 'never the running lab\'s app-dist');
    assert.equal(built.preview.https, undefined, 'a build reads no key');
    // The plain lab: no TLS, no rename, app-dist.
    set({ VITE_QA_LAB: '1', VITE_SUPABASE_URL: 'http://127.0.0.1:54385', QA_LAB_APP_PORT: '54390', QA_LAB_MOCK_URL: 'http://127.0.0.1:54380' });
    const lab = config({ command: 'serve', mode: 'production' });
    assert.equal(lab.preview.https, undefined);
    assert.ok(!lab.plugins.some((p) => p?.name === 'qa-lab-mock-origin'));
    assert.equal(config({ command: 'build', mode: 'production' }).build.outDir, QA_APP_DIST);
    // Refusals.
    set({ ...sim, VITE_SUPABASE_URL: 'https://127.0.0.1:54395' });
    assert.throws(() => config({ command: 'serve', mode: 'production' }), /another origin/);
    set({ ...sim, VITE_SUPABASE_URL: 'http://127.0.0.1:54396' });
    assert.throws(() => config({ command: 'serve', mode: 'production' }), /https API proxy/);
    set({ ...sim, QA_LAB_APP_ORIGIN: 'https://localhost:54395' });
    assert.throws(() => config({ command: 'serve', mode: 'production' }), /QA_LAB_APP_ORIGIN must be https:\/\/127\.0\.0\.1:54395/);
    set({ ...sim, QA_LAB_TLS_KEY: '' });
    assert.throws(() => config({ command: 'serve', mode: 'production' }), /go together/);
    for (const bad of [path.join(ROOT, 'dist'), GENERATED_DIR, path.join(GENERATED_DIR, '..', 'elsewhere')]) assert.throws(() => qaOutDir({ QA_LAB_APP_DIST: bad }), /under qa-lab\/\.generated/, bad);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('qa:sim:down stops only the profile\'s servers, never the lab\'s app server (same command line but the port)', () => {
  const vite = path.join(ROOT, 'node_modules', '.bin', 'vite');
  const api = path.join(ROOT, 'qa-lab', 'lib', 'api-proxy.mjs');
  assert.equal(isSimServer(`node ${vite} preview --config ${QA_VITE_CONFIG} --port 54395`, 'app', 54395), true);
  assert.equal(isSimServer(`node ${vite} preview --config ${QA_VITE_CONFIG}`, 'app', 54395), false, 'the running lab\'s vite preview');
  assert.equal(isSimServer(`node ${vite} preview --config ${QA_VITE_CONFIG} --port 543950`, 'app', 54395), false);
  assert.equal(isSimServer(`node ${api} --port 54396 --app-origin ${SIM_APP} --tls-cert a --tls-key b`, 'api', 54396), true);
  assert.equal(isSimServer(`node ${api} --port 54385 --app-origin ${LAB_APP}`, 'api', 54385), false, 'the running lab\'s API proxy');
  assert.equal(isSimServer(`node ${api} --port 54396 --app-origin ${SIM_APP} --tls-cert a --tls-key b`, 'app', 54396), false);
});

test('--no-build reuses a profile build for the same stack signer, though supabase status mints a new anon token each call', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (header, claims, sig) => `${b64(header)}.${b64(claims)}.${sig}`;
  const a = token({ alg: 'RS256', kid: 'lab-key-1' }, { iss: 'supabase-demo', role: 'anon', exp: 1983812996 }, 'sigA');
  const b = token({ alg: 'RS256', kid: 'lab-key-1' }, { iss: 'supabase-demo', role: 'anon', exp: 1983813001 }, 'sigB');
  assert.equal(anonKeyIdentity(a), anonKeyIdentity(b));
  assert.notEqual(anonKeyIdentity(a), anonKeyIdentity(token({ alg: 'RS256', kid: 'lab-key-2' }, { iss: 'supabase-demo', role: 'anon', exp: 1 }, 's')), 'another signing key needs a new build');
  assert.notEqual(anonKeyIdentity(a), anonKeyIdentity(token({ alg: 'RS256', kid: 'lab-key-1' }, { iss: 'supabase-demo', role: 'service_role', exp: 1 }, 's')));
  assert.equal(anonKeyIdentity('not a token'), null);
});

test('the HTTPS Simulator proxy keeps backup links secure and returns the exact signed download', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const signed = '/storage/v1/object/sign/backups/qa%20archive.zip?token=synthetic%2Btoken&download=qa.zip';
  const file = Buffer.from([80, 75, 3, 4, 0, 255, 7]);
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, encoding: req.headers['accept-encoding'] });
    if (req.url === signed) { res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(file); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': APP_PUBLIC_ORIGIN });
    res.end(JSON.stringify({ url: 'http://kong:8000' + signed }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createApiProxy({ port: 0, appOrigin: SIM_APP, target: `http://127.0.0.1:${upstream.address().port}`,
    tls: { key: readFileSync(certs.key), cert: readFileSync(certs.cert) }, log() {} });
  await proxy.listen();
  const origin = `https://127.0.0.1:${proxy.server.address().port}`;
  const ask = (url, method = 'GET') => new Promise((resolve, reject) => {
    const req = https.request(url, { method, ca: readFileSync(certs.caCert), headers: { Origin: SIM_APP, 'Accept-Encoding': 'gzip, br' } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => resolve({ body: Buffer.concat(chunks), status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
  try {
    const result = await ask(origin + '/functions/v1/backup-link', 'POST');
    assert.equal(result.status, 200); assert.equal(result.headers['access-control-allow-origin'], SIM_APP);
    const url = JSON.parse(result.body).url;
    assert.equal(url, origin + signed); assert.equal(seen[0].encoding, 'identity');
    const download = await ask(url);
    assert.equal(download.status, 200); assert.deepEqual(download.body, file);
    assert.equal(seen[1].path, signed); assert.equal(seen[1].encoding, 'gzip, br');
  } finally {
    await new Promise(resolve => { proxy.server.closeAllConnections(); proxy.server.close(resolve); });
    await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
  }
});
