import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The website's visit beacon is inlined in every public page, so it cannot be imported.
// These tests pull the script out of the shipped HTML and run it, which is the only way
// to know what a visitor's browser will actually send.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'landing');
// The script may open with the guard that skips a page switching to https
// (tests/https-redirect.test.mjs holds it to that); these locations carry no
// protocol or host, so the guard lets them through.
const BEACON = /<script>((?:if\(!\([^)]*\)\))?navigator\.sendBeacon&&navigator\.sendBeacon\('\/api\/pv',[^<]*)<\/script>/;

function beaconOf(file) {
  const found = fs.readFileSync(path.join(root, file), 'utf8').match(BEACON);
  assert.ok(found, `${file} carries no visit beacon`);
  return found[1];
}
function run(script, { pathname = '/states/texas', search = '', referrer = '' } = {}) {
  let sent;
  vm.runInNewContext(script, {
    navigator: { sendBeacon: (url, body) => { sent = [url, JSON.parse(body)]; return true; } },
    location: { pathname, search },
    document: { referrer },
  });
  return sent;
}

const pages = ['index.html', 'locums.html', 'state-template.html'];

test('a real referrer is sent unchanged, tagged link or not', () => {
  for (const page of pages) {
    const sent = run(beaconOf(page), { search: '?src=li', referrer: 'https://www.google.com/' });
    assert.equal(sent[0], '/api/pv');
    assert.equal(sent[1].r, 'https://www.google.com/', page);
  }
});
test('a link tagged src=li that arrives with no referrer is credited to linkedin.com', () => {
  for (const page of pages) {
    assert.equal(run(beaconOf(page), { search: '?src=li' })[1].r, 'https://www.linkedin.com/', page);
    assert.equal(run(beaconOf(page), { search: '?utm=x&src=li&y=1' })[1].r, 'https://www.linkedin.com/', page);
  }
});
test('no referrer and no tag stays direct, and look-alike parameters do not count', () => {
  for (const page of pages) {
    for (const search of ['', '?src=link', '?x=src=li', '?mysrc=li', '?src=li2']) {
      assert.equal(run(beaconOf(page), { search })[1].r, '', `${page} ${search}`);
    }
  }
});
test('the query string is never sent as the path', () => {
  const sent = run(beaconOf('state-template.html'), { pathname: '/states/texas.html', search: '?src=li' });
  assert.equal(sent[1].p, '/states/texas');
  assert.ok(!JSON.stringify(sent).includes('src=li'));
});
test('every generated state guide ships the same beacon as the template', () => {
  const expected = beaconOf('state-template.html');
  // states/index.html is the hand-written directory page, not a generated guide.
  const guides = fs.readdirSync(path.join(root, 'states')).filter((f) => f.endsWith('.html') && f !== 'index.html');
  assert.ok(guides.length >= 51, `expected at least 51 guides, found ${guides.length}`);
  for (const guide of guides) assert.equal(beaconOf(path.join('states', guide)), expected, guide);
  assert.equal(run(beaconOf(path.join('states', 'index.html')), { pathname: '/states/', search: '?src=li' })[1].r, 'https://www.linkedin.com/');
});

// Signup review 2026-10-07: five public pages sent no visit beacon (CME,
// help, privacy, security, terms), so their visits were never counted. They
// carry the same script now (scripts/visit-beacon.mjs), the generated ones
// from their builders, and track_pv counts their paths
// (migration 20261007120000_track_pv_public_pages.sql).
test('the CME, help, privacy, security and terms pages send the same beacon, with their own path', async () => {
  const { VISIT_BEACON_SOURCE } = await import('../scripts/visit-beacon.mjs');
  assert.equal(beaconOf('index.html'), VISIT_BEACON_SOURCE, 'one script for every page');
  for (const [page, pathname, sentPath] of [['cme.html', '/cme/', '/cme/'], ['help.html', '/help/', '/help/'], ['privacy.html', '/privacy', '/privacy'],
    ['security.html', '/security', '/security'], ['terms.html', '/terms.html', '/terms']]) {
    assert.equal(beaconOf(page), VISIT_BEACON_SOURCE, page);
    const sent = run(beaconOf(page), { pathname, search: '?src=li' });
    assert.deepEqual(sent, ['/api/pv', { p: sentPath, r: 'https://www.linkedin.com/' }], page);
  }
  // The app's own copies of the legal pages count under /app/.
  for (const page of ['privacy.html', 'terms.html']) {
    const copy = fs.readFileSync(path.join(root, '..', 'public', page), 'utf8');
    assert.ok(copy.includes(`<script>${VISIT_BEACON_SOURCE}</script>`), `public/${page}`);
  }
});
