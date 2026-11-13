// The shared public-site header and footer (scripts/site-chrome.mjs): one
// navigation for every marketing page, sign-in and signup both to the app,
// and the pages that keep their own layout lose only their old chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { applySiteChrome, siteHeader, siteFooter } from '../scripts/site-chrome.mjs';
import { fileURLToPath } from 'node:url';
import { renderPublicLaunch, publicLaunchHelp } from '../scripts/public-launch-render.mjs';
import { renderWatchPages } from '../scripts/watch-pages.mjs';
import { renderHelp } from '../scripts/build-help.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { httpsRedirectProblem } from '../scripts/https-redirect.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const OFF = Object.freeze({ enabled: false, signupHref: null });
const links = html => [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => [match[1], match[2].replace(/<[^>]+>/g, '').trim()]);

test('the header sends Sign in and Create your account to the app, and keeps the approved navigation', () => {
  const header = siteHeader({ current: 'pricing' });
  assert.deepEqual(links(header), [['/', 'CredentialDOMD'], ['/', 'Home'], ['/#how-it-works', 'How it works'], ['/states/', 'State guides'],
    ['/pricing', 'Pricing'], ['/#faq', 'FAQ'], ['/app/', 'Sign in'], ['/app/', 'Create your account']]);
  assert.match(header, /<a href="\/pricing" aria-current="page">Pricing<\/a>/);
  // The signup label is the one public/membership-offer.js repaints for the live phase.
  assert.match(header, /<a class="cdm-cta" href="\/app\/"><span data-membership-action>Create your account<\/span><\/a>/);
  assert.doesNotMatch(header, /\$\d/, 'no price is written into the header');
  // No inline styles (the CME page forbids them) and no element the older page styles select.
  assert.doesNotMatch(header + siteFooter(), /\sstyle=|<(?:nav|header|footer|ul|li|h[1-6])\b/);
});

test('waitlist mode keeps the waitlist request in the header', () => {
  const header = siteHeader({ mode: OFF });
  assert.match(header, /<a class="cdm-cta" href="\/#join">Join the waitlist<\/a>/);
  assert.match(header, /<a href="\/app\/">Sign in<\/a>/);
});

test('the footer links the public resources, the policies and support', () => {
  const hrefs = links(siteFooter()).map(([href]) => href);
  for (const href of ['/states/', '/pricing', '/locums', '/cme/', '/help', '/security', '/privacy', '/terms', '/credits', 'mailto:support@credentialdomd.com']) assert.ok(hrefs.includes(href), href);
});

test('redesigned pages mark where the chrome goes and are indexable unless they say otherwise', async () => {
  for (const [page, surface, current] of [['index', 'home', 'home'], ['pricing', 'pricing', 'pricing'], ['credits', null, null]]) {
    const source = await read(`landing/${page}.html`);
    const output = applySiteChrome(surface ? renderPublicLaunch(source, surface) : source, { current });
    assert.match(output, /<html data-site-chrome="page"/, page);
    assert.equal((output.match(/class="cdm-header"/g) || []).length, 1, page);
    assert.equal((output.match(/class="cdm-footer"/g) || []).length, 1, page);
    assert.doesNotMatch(output, /site-chrome:(?:header|footer)|fonts\.googleapis\.com|workers\.dev|Design preview/, page);
    assert.equal(httpsRedirectProblem(output), null, page);
    assert.equal(/name="robots" content="noindex/.test(output), page === 'credits', page);
    assert.match(output, new RegExp(`<link rel="canonical" href="https://credentialdomd\\.com/${page === 'index' ? '' : page}">`), page);
  }
});

test('/pricing repaints every price for the live phase and sends signup to the app', async () => {
  const output = renderPublicLaunch(await read('landing/pricing.html'), 'pricing', undefined, { offerEndpoint: 'https://synthetic.supabase.co/functions/v1/public-membership-offer' });
  assert.match(output, /<b data-membership-price>\$99<\/b><span data-membership-price-label>/);
  assert.match(output, /\$245<span data-membership-bundle-label>/);
  for (const hook of ['headline', 'availability', 'rate', 'status', 'action']) assert.match(output, new RegExp(`data-membership-${hook}\\b`), hook);
  assert.match(output, /<script type="module" src="\/membership-offer\.js" data-membership-endpoint="https:\/\/synthetic\.supabase\.co\/functions\/v1\/public-membership-offer"><\/script>/);
  // Every amount on the page comes from a launch slot (the same reviewed
  // strings as the home page's plans); the page itself writes no price.
  const own = (await read('landing/pricing.html')).replace(/<!-- public-launch:([a-z-]+) -->[\s\S]*?<!-- \/public-launch:\1 -->/g, '');
  assert.doesNotMatch(own, /\$\d/, 'no price outside a launch slot');
  assert.ok(links(output).filter(([href, text]) => href === '/app/' && text === 'Create your account').length >= 2);
});

test('pages that keep their layout lose only their old navigation and footer', async () => {
  const states = (await readdir(new URL('../landing/states/', import.meta.url))).filter(name => name.endsWith('.html'));
  assert.equal(states.length, 52);
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const pages = [['landing/locums.html', 'locums'], ['landing/help.html', 'help'], ['landing/cme.html', 'cme'],
    ['landing/security.html', 'legal-navigation'], ['landing/privacy.html', 'legal-navigation'], ['landing/terms.html', 'legal-navigation'],
    ...states.map(name => [`landing/states/${name}`, name === 'index.html' ? 'state-index' : 'state-guides'])];
  const catalog = await loadVideoCatalog(fileURLToPath(new URL('..', import.meta.url)));
  const published = publicLaunchHelp(help);
  const sources = await Promise.all(pages.map(async ([path, surface]) => [path, renderPublicLaunch(surface === 'help' ? renderHelp(published, catalog) : await read(path), surface)]));
  const watch = renderWatchPages(published, catalog);
  assert.equal(watch.length, 3);
  for (const page of watch) sources.push([`help/${page.id}`, renderPublicLaunch(page.html, 'watch-pages')]);
  const main = html => html.slice(html.search(/<main\b|<section\b|<div class="breadcrumb"/), html.lastIndexOf('<footer'));
  for (const [path, rendered] of sources) {
    const output = applySiteChrome(rendered, { current: path.includes('/states/') ? 'states' : null });
    assert.match(output, /<html data-site-chrome="legacy"/, path);
    assert.equal((output.match(/class="cdm-header"/g) || []).length, 1, path);
    assert.equal((output.match(/class="cdm-footer"/g) || []).length, 1, path);
    assert.doesNotMatch(output, /<footer\b|class="nav-inner"|class="topnav"|fonts\.googleapis\.com/, path);
    assert.equal(httpsRedirectProblem(output), null, path);
    // Everything between the old navigation and the old footer is still there, byte for byte.
    assert.ok(output.includes(main(rendered)), `${path}: content unchanged`);
    for (const tag of ['title', 'canonical', 'application/ld+json']) {
      const count = text => text.split(tag).length;
      assert.equal(count(output.slice(0, output.indexOf('</head>'))), count(rendered.slice(0, rendered.indexOf('</head>'))), `${path}: ${tag}`);
    }
    if (/Content-Security-Policy/.test(rendered)) assert.match(output, /font-src 'self'/, path);
  }
  // A state guide keeps its board disclaimer, and help keeps the offer sentence, in the new footer.
  const guide = applySiteChrome(renderPublicLaunch(await read('landing/states/texas.html'), 'state-guides'));
  assert.match(guide.slice(guide.indexOf('class="cdm-footer"')), /class="cdm-foot-note"><strong>Disclaimer:<\/strong>/);
  assert.equal((guide.match(/<form class="guide-form"/g) || []).length, (await read('landing/states/texas.html')).match(/<form class="guide-form"/g).length);
  const helpPage = applySiteChrome(renderPublicLaunch(renderHelp(published, catalog), 'help'));
  assert.match(helpPage.slice(helpPage.indexOf('class="cdm-footer"')), /data-membership-availability/);
});

test('chrome is applied once, and an unknown navigation stops the build', () => {
  const page = '<!doctype html><html><head><meta charset="utf-8"></head><body><!-- site-chrome:header --><main></main><!-- site-chrome:footer --></body></html>';
  assert.throws(() => applySiteChrome(applySiteChrome(page)), /already applied/);
  assert.throws(() => applySiteChrome('<!doctype html><html><head></head><body><nav class="other"></nav><footer></footer></body></html>'), /no navigation to replace/);
  assert.equal(applySiteChrome('synthetic'), 'synthetic');
});
