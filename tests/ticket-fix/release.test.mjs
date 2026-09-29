// G7 against a local HTTP server: the live build must descend from the fix
// and the bundle must carry the strings the diff added (and not the ones it
// removed) before anything may be called live.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyRelease, probeStrings, fetchBundle } from '../../scripts/ticket-fix/release.mjs';
import { project, sh } from './stage2-helpers.mjs';

function server(routes) {
  const hits = [];
  const s = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits.push(url.pathname);
    const body = routes[url.pathname];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(typeof body === 'function' ? body() : body);
  });
  return new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, hits, close: () => new Promise(r => s.close(r)) })));
}
const build = sha => JSON.stringify({ build: `20260928T1200-${sha.slice(0, 7)}` });
const INDEX = '<!doctype html><script type="module" crossorigin src="/app/assets/index-abc.js"></script><link rel="modulepreload" href="/app/assets/chunk-def.js">';

function fixture() {
  const p = project({ 'src/notice.js': "export const notice = 'Old synthetic notice text';\n" });
  const base = sh(p.repo, ['rev-parse', 'HEAD']);
  p.write(p.repo, { 'src/notice.js': "export const notice = 'New synthetic notice text';\n" });
  sh(p.repo, ['commit', '-qam', 'Synthetic fix']);
  const fix = sh(p.repo, ['rev-parse', 'HEAD']);
  p.write(p.repo, { 'src/later.js': 'export const later = 1;\n' });
  sh(p.repo, ['add', '-A']); sh(p.repo, ['commit', '-qm', 'Later']);
  const later = sh(p.repo, ['rev-parse', 'HEAD']);
  return { p, base, fix, later };
}
const fast = { timeoutMs: 200, intervalMs: 20, fetchOrigin: false, deployStatus: () => null };

test('probe strings: what the diff added to src and did not exist at base, and what it removed', () => {
  const { p, base, fix } = fixture();
  try {
    assert.deepEqual(probeStrings(p.repo, base, fix), { present: ['New synthetic notice text'], absent: ['Old synthetic notice text'] });
  } finally { p.cleanup(); }
});

test('a build that descends from the fix, with the new text and without the old, passes', async () => {
  const { p, base, fix, later } = fixture();
  const s = await server({ '/app/version.json': build(later), '/app/': INDEX, '/app/assets/index-abc.js': 'const a="New synthetic notice text";', '/app/assets/chunk-def.js': 'export{}' });
  try {
    const r = await verifyRelease({ dir: p.repo, fix, base, versionUrl: `${s.url}/app/version.json`, appUrl: `${s.url}/app/`, ...fast });
    assert.equal(r.verified, true, r.reason);
    assert.equal(r.deployed_commit, later);
    assert.deepEqual(r.probes.present, [{ text: 'New synthetic notice text', found: true }]);
    assert.deepEqual(r.probes.absent, [{ text: 'Old synthetic notice text', found: false }]);
    assert.ok(s.hits.includes('/app/assets/chunk-def.js'), 'modulepreload chunks are read too');
  } finally { await s.close(); p.cleanup(); }
});

test('an old build times out; a failed deploy stops at once', async () => {
  const { p, base, fix } = fixture();
  const s = await server({ '/app/version.json': build(base), '/app/': INDEX });
  try {
    const old = await verifyRelease({ dir: p.repo, fix, base, versionUrl: `${s.url}/app/version.json`, appUrl: `${s.url}/app/`, ...fast });
    assert.equal(old.verified, false);
    assert.match(old.reason, /did not contain the fix/);
    let polls = 0;
    const failed = await verifyRelease({ dir: p.repo, fix, base, versionUrl: `${s.url}/app/version.json`, appUrl: `${s.url}/app/`, ...fast, timeoutMs: 60000,
      deployStatus: () => (++polls >= 1 ? 'failure' : null) });
    assert.equal(failed.verified, false);
    assert.match(failed.reason, /deploy run for the fix commit failed/);
    assert.equal(polls, 1);
  } finally { await s.close(); p.cleanup(); }
});

test('a missing added string, or a removed string still in the bundle, fails', async () => {
  const { p, base, fix } = fixture();
  const s = await server({ '/app/version.json': build(fix), '/app/': INDEX, '/app/assets/index-abc.js': 'const a="Old synthetic notice text";', '/app/assets/chunk-def.js': '' });
  try {
    const r = await verifyRelease({ dir: p.repo, fix, base, versionUrl: `${s.url}/app/version.json`, appUrl: `${s.url}/app/`, ...fast });
    assert.equal(r.verified, false);
    assert.equal(r.reason, '1 added string(s) missing from the live bundle, 1 removed string(s) still in it');
    const text = await fetchBundle(globalThis.fetch, `${s.url}/app/`);
    assert.match(text, /Old synthetic notice text/);
  } finally { await s.close(); p.cleanup(); }
});

// Finding 17: probes come from string literals and JSX text on code lines,
// never comments, import paths or code fragments, and the gates keep only
// what the head build contains.
import { probeCandidates, releaseCandidates, decodeEntities } from '../../scripts/ticket-fix/release.mjs';

test('probe candidates skip comments, import specifiers, paths and code fragments, and decode HTML entities', () => {
  const lines = [
    '// Coverage times can be stated in. A block of text in a comment',
    '  /* Another synthetic comment with enough words */',
    "import { coverageBlocks } from '../../utils/coverageBlocks';",
    "export { thing } from './synthetic/thing.js';",
    "  <div style={{ gap: 4, paddingTop: i ? 10 : 0 }}>The member&apos;s Home cards</div>",
    "  const late = items.filter(a => a.b < c ? 'yes' : 'no');",
    "const notice = 'New synthetic notice text'; // it's the new notice",
    "const zone = 'America/Chicago';",
    'const t = `Hello ${name}, welcome`;',
  ];
  assert.deepEqual([...probeCandidates(lines)], ["The member's Home cards", 'New synthetic notice text']);
  assert.equal(decodeEntities('A &amp; B &quot;C&quot; &#39;D&#39; &lt;E&gt;'), 'A & B "C" \'D\' <E>');
});

test('the gates keep an added probe only if the head build has it, and a removed one only if it does not', () => {
  const p = project({ 'src/notice.js': "export const notice = 'Old synthetic notice text';\nexport const other = 'Unchanged synthetic text';\n" });
  try {
    const base = sh(p.repo, ['rev-parse', 'HEAD']);
    p.write(p.repo, { 'src/notice.js': "// A comment the minifier drops entirely\nexport const notice = 'New synthetic notice text';\nexport const hidden = 'Dead code the bundler drops';\nexport const other = 'Unchanged synthetic text';\n" });
    sh(p.repo, ['commit', '-qam', 'Synthetic fix']);
    const fix = sh(p.repo, ['rev-parse', 'HEAD']);
    const built = 'const a="New synthetic notice text",b="Unchanged synthetic text";';
    assert.deepEqual(releaseCandidates({ dir: p.repo, base, fix, builtText: built }), { present: ['New synthetic notice text'], absent: ['Old synthetic notice text'] });
    assert.deepEqual(releaseCandidates({ dir: p.repo, base, fix, builtText: `${built}"Old synthetic notice text"` }).absent, [], 'a removed string the build still has from elsewhere is no probe');
    assert.deepEqual(releaseCandidates({ dir: p.repo, base, fix, builtText: null }), { present: [], absent: [], note: 'no head build to choose probes from' });
  } finally { p.cleanup(); }
});

test('the release check uses the probes the gates chose', async () => {
  const { p, base, fix, later } = fixture();
  const s = await server({ '/app/version.json': build(later), '/app/': INDEX, '/app/assets/index-abc.js': 'const a="Chosen synthetic probe";', '/app/assets/chunk-def.js': '' });
  try {
    const r = await verifyRelease({ dir: p.repo, fix, base, versionUrl: `${s.url}/app/version.json`, appUrl: `${s.url}/app/`, ...fast, probes: { present: ['Chosen synthetic probe'], absent: [] } });
    assert.equal(r.verified, true, r.reason);
    assert.deepEqual(r.probes.present, [{ text: 'Chosen synthetic probe', found: true }]);
  } finally { await s.close(); p.cleanup(); }
});
