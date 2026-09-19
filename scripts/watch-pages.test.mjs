import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadVideoCatalog, WATCH_PAGES, watchHref } from './help-videos.mjs';
import { renderHelp } from './build-help.mjs';
import { renderWatchPages, addWatchPagesToSitemap } from './watch-pages.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
const catalog = await loadVideoCatalog(root);

test('exactly three dedicated pages present one reviewed video, unique metadata and source text', () => {
  const pages = renderWatchPages(help, catalog);
  assert.deepEqual(pages.map(page => page.id), ['locum-invoice', 'import-cme', 'review-cme']);
  assert.equal(new Set(pages.map(page => page.html.match(/<title>(.*?)<\/title>/)[1])).size, 3);
  for (const page of pages) {
    const article = help.articles.find(article => article.id === page.id);
    assert.equal(page.href, watchHref(page.id));
    assert.equal((page.html.match(/<video\b/g) || []).length, 1);
    assert.equal((page.html.match(/<h1>/g) || []).length, 1);
    assert.ok(page.html.indexOf('<video ') < page.html.indexOf('<details'), 'primary video is outside collapsed content');
    assert.ok(page.html.includes(`Written guide reviewed ${article.updatedAt}`));
    assert.ok(page.html.includes('Synthetic data; no live messages or payments.'));
    assert.match(page.html, /<track kind="captions"/);
    assert.match(page.html, /Billing is off/);
    assert.match(page.html, /href="\/#join"/);
    assert.doesNotMatch(page.html, /<script\b|\bautoplay\b|<iframe\b|VideoObject|uploadDate/);
    assert.ok(page.html.includes(catalog.tutorials.find(video => video.id === page.id).transcriptText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')));
  }
});

test('absent or partial catalogs advertise only their approved watch pages', () => {
  assert.deepEqual(renderWatchPages(help, null), []);
  assert.doesNotMatch(renderHelp(help), /Open this video guide on its own page/);
  const partial = structuredClone(catalog);
  partial.tutorials = partial.tutorials.filter(video => video.id === 'import-cme');
  assert.deepEqual(renderWatchPages(help, partial).map(page => page.id), ['import-cme']);
  const html = renderHelp(help, partial);
  assert.match(html, /href="\/help\/import-cme\/"/);
  assert.doesNotMatch(html, /href="\/help\/review-cme\/"|href="\/help\/locum-invoice\/"/);
  assert.match(renderWatchPages(help, partial)[0].html, /href="\/help#review-cme"/);
  const invalid = structuredClone(catalog);
  invalid.status = 'draft';
  assert.throws(() => renderWatchPages(help, invalid), /approved tutorials/);
});

test('missing guide or loaded transcript fails rather than publishing an incomplete watch page', () => {
  const altered = structuredClone(help);
  altered.articles = altered.articles.filter(article => article.id !== 'import-cme');
  for (const article of altered.articles) article.related = article.related.filter(id => id !== 'import-cme');
  assert.throws(() => renderWatchPages(altered, catalog), /no reviewed guide/);
  const unloaded = structuredClone(catalog);
  delete unloaded.tutorials.find(video => video.id === 'locum-invoice').transcriptText;
  assert.throws(() => renderWatchPages(help, unloaded), /Missing loaded transcript/);
});

test('article and transcript markup remains inert in title, description, steps and player', () => {
  const altered = structuredClone(help), media = structuredClone(catalog);
  const article = altered.articles.find(article => article.id === 'import-cme');
  article.summary = '"><script>alert(1)</script>';
  article.steps[0] = '<img src=x onerror=alert(1)>';
  media.tutorials.find(video => video.id === article.id).transcriptText = '</div><script>alert(2)</script>';
  const html = renderWatchPages(altered, media).find(page => page.id === article.id).html;
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.doesNotMatch(html, /<script\b|<img src=x/);
});

test('sitemap adds actual watch pages once and keeps source dates unchanged', async () => {
  const sitemap = await read('public/sitemap.xml');
  const pages = renderWatchPages(help, catalog);
  const rendered = addWatchPagesToSitemap(sitemap, pages);
  for (const page of pages) assert.equal(rendered.split(`<loc>https://credentialdomd.com${page.href}</loc>`).length - 1, 1);
  assert.equal(addWatchPagesToSitemap(sitemap, []), sitemap);
  assert.throws(() => addWatchPagesToSitemap(rendered, pages), /Duplicate/);
  assert.throws(() => addWatchPagesToSitemap('broken', pages), /Invalid sitemap/);
  assert.throws(() => addWatchPagesToSitemap(sitemap, [{ id: '../private', href: '/private/', updatedAt: '2026-09-19' }]), /Invalid watch/);
  const originalDates = [...sitemap.matchAll(/<loc>(https:\/\/credentialdomd.com\/states\/[^<]*)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)];
  assert.equal(originalDates.length, 52);
  for (const [, url, date] of originalDates) {
    assert.equal(date, '2026-08-19');
    assert.ok(rendered.includes(`<loc>${url}</loc>\n    <lastmod>${date}</lastmod>`));
  }
});

test('homepage uses saved-record status and illustrative generic CME examples', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /80&ndash;100: On track/);
  assert.match(html, /does not confirm board approval/);
  assert.match(html, /Illustrative demos of app workflows/);
  assert.doesNotMatch(html, /Colorado's 30-hour|Substance Use: 0\/2h|Fully Compliant|Not concept art|30 hrs to go/);
  assert.match(html, /id="join"/);
  assert.equal(WATCH_PAGES.length, 3);
});
