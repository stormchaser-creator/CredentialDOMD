// PUBLIC-008: the state renewal guides (landing/state-template.html, built
// into landing/states/<slug>.html by landing/states/generate.js) and the
// /states/ hub had no Support menu and no link to /help/ in their header,
// unlike / and /help/. The guides carry most of the public traffic; their
// only support path was a footer mailto. Their Home and Features links also
// pointed at the production host, which leaves a lab or staging copy.
//
// Every guide, the hub and the template now carry the same Support menu as
// the landing page (Help & videos, FAQ, Security), driven by the shared
// public/support-nav.css and support-nav.js (Esc closes it and returns focus).
// On a phone the rule that hides the header's plain links must not hide the
// menu's own links. The pages are regenerated from the template, so a guide
// that drifts from it fails here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { renderPublicLaunch } from '../scripts/public-launch-render.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const guides = (await readdir(new URL('../landing/states/', import.meta.url))).filter(f => f.endsWith('.html') && f !== 'index.html');
const pages = [['landing/state-template.html', 'state-guides'], ['landing/states/index.html', 'state-index'], ...guides.map(f => [`landing/states/${f}`, 'state-guides'])];

/** The header's markup. */
const header = html => { const m = /<header class="nav">([\s\S]*?)<\/header>/.exec(html); assert.ok(m, 'a header'); return m[1]; };

function assertSupportMenu(html, where) {
  const nav = header(html);
  const menu = /<details class="support-menu">\s*<summary>Support<\/summary>\s*<div class="support-links">([\s\S]*?)<\/div>\s*<\/details>/.exec(nav);
  assert.ok(menu, `${where}: the header has the Support menu`);
  const links = [...menu[1].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(links, [['/help/', 'Help &amp; videos'], ['/#faq', 'FAQ'], ['/security', 'Security &amp; data handling']], where);
  assert.match(html, /<link rel="stylesheet" href="\/support-nav\.css">/, `${where}: loads the menu's styles`);
  assert.match(html, /<script src="\/support-nav\.js" defer><\/script>/, `${where}: loads the menu's Esc and outside-click handling`);
  assert.doesNotMatch(nav, /href="https:\/\/credentialdomd\.com"|href="https:\/\/credentialdomd\.com\/#features"/, `${where}: Home and Features stay on this site`);
  assert.match(nav, /<a href="\/" class="nav-logo">/, where);
}

test(`the template, the hub and all ${guides.length} guides carry the Support menu in their header`, async () => {
  assert.equal(guides.length, 51);
  for (const [path] of pages) assertSupportMenu(await read(path), path);
});

test('on a phone the header hides its plain links, never the Support menu\'s links', async () => {
  for (const [path] of pages) {
    const html = await read(path);
    // A descendant rule (".nav-links a") also matched the menu's own links.
    assert.doesNotMatch(html, /\.nav-links a:not\(\.nav-cta\)\s*\{\s*display:\s*none/, `${path}: hides every link under the header`);
    assert.match(html, /\.nav-links > a:not\(\.nav-cta\) \{ display: none; \}/, path);
    // support-nav.css stacks the menu into the landing page's mobile drawer
    // below 1024px; this header has no drawer, so it stays a dropdown.
    assert.match(html, /\.nav \.nav-links \.support-links \{ position: absolute;/, path);
  }
});

test('launch mode keeps the menu (it is not a marketing slot)', async () => {
  const paid = { enabled: true, signupHref: '/signup/' };
  for (const [path, surface] of [['landing/states/texas.html', 'state-guides'], ['landing/states/index.html', 'state-index']]) {
    assertSupportMenu(renderPublicLaunch(await read(path), surface, paid), `${path} in launch mode`);
  }
});

test('every guide is the template rendered: the header block matches it', async () => {
  const template = header(await read('landing/state-template.html'));
  for (const f of guides) assert.equal(header(await read(`landing/states/${f}`)), template, `${f}: run node landing/states/generate.js`);
});
