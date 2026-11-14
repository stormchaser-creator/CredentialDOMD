// Owner decisions, 2026-11-13, for the public site:
// 1. One plan. The site presents the Founder plan, $99/year, everything
//    included (credential tracking and the Practice tools), on one card. The
//    static page and public/membership-offer.js say the same sentences.
// 2. Audience. CredentialDOMD is for physicians (MD/DO), nurse practitioners
//    and physician assistants. The state guides stay physician board guides:
//    one line says NP and PA requirements differ by board; no NP or PA board
//    requirement is stated.
// The app (src/) is not changed by either decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
const readFileSyncSafe = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
import { renderPublicLaunch, FOUNDER_PLAN, AUDIENCE, NP_PA_QUESTION, NP_PA_ANSWER } from '../scripts/public-launch-render.mjs';
import { offerPresentation, sitePresentation } from '../public/membership-offer.js';
import { DEGREES } from '../src/constants/professions.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const visible = html => html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const jsonLd = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
const founding = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available', bundleAvailable: false };

test('the static Founder plan and the one the live offer paints are the same words', () => {
  const live = sitePresentation(offerPresentation(founding));
  assert.equal(live.headline, FOUNDER_PLAN.headline);
  assert.equal(live.heroHeadline, FOUNDER_PLAN.headline);
  assert.equal(live.price, FOUNDER_PLAN.price);
  assert.equal(live.priceLabel, FOUNDER_PLAN.priceLabel);
  assert.equal(live.rateNote, FOUNDER_PLAN.rate);
  assert.equal(live.availabilityOffer, FOUNDER_PLAN.offer);
  assert.equal(live.rateLock.trim(), FOUNDER_PLAN.rateLock);
  assert.equal(live.heroNote, FOUNDER_PLAN.heroNote);
  assert.equal(live.phase, FOUNDER_PLAN.phase);
  assert.match(FOUNDER_PLAN.headline, /^Founder plan: \$99\/year, everything included$/);
});

test('a page still carrying a slot for another tier does not build', async () => {
  const home = await read('landing/index.html');
  for (const slot of ['rate-comparison', 'full-price', 'full-package', 'practice-trial']) {
    assert.doesNotMatch(home, new RegExp(`public-launch:${slot}`));
    assert.throws(() => renderPublicLaunch(home.replace('</main>', `<p><!-- public-launch:${slot} -->x<!-- /public-launch:${slot} --></p></main>`), 'home'), /Retired public launch slot/);
  }
  for (const page of ['pricing', 'locums', 'help', 'cme', 'security']) assert.doesNotMatch(await read(`landing/${page}.html`), /public-launch:(?:rate-comparison|full-price|full-package|practice-trial)/, page);
});

test('the home page names physicians, NPs and PAs in its copy, metadata and structured data', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const head = output.slice(0, output.indexOf('</head>'));
  assert.match(head, /<title>CredentialDOMD \| Credentials, licenses and CME for physicians, NPs &amp; PAs<\/title>/);
  assert.match(head, /<meta property="og:title" content="CredentialDOMD \| Credentials, licenses and CME for physicians, NPs &amp; PAs">/);
  for (const name of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
    const content = head.match(new RegExp(`<meta ${name} content="([^"]*)">`))[1];
    assert.match(content, /NPs and PAs|nurse practitioners and physician assistants/, name);
    assert.doesNotMatch(content, /optional Practice|MDs and DOs,/i, name);
  }
  const app = jsonLd(output).find(item => item['@type'] === 'SoftwareApplication');
  assert.deepEqual(app.audience, { '@type': 'Audience', audienceType: 'Physicians (MD and DO), nurse practitioners (NP) and physician assistants (PA)' });
  assert.match(jsonLd(output).find(item => item['@type'] === 'Organization').description, /physicians, NPs and PAs/);
  const text = visible(output);
  assert.ok(text.includes(`For ${AUDIENCE}`), 'hero badge');
  assert.match(text, /For physicians, nurse practitioners and physician assistants\./);
  assert.match(text, /Choose your profession \(MD, DO, NP or PA\)/);
  assert.match(text, /NCCPA, AANPCB and ANCC certification for PAs and NPs/);
  assert.ok(text.includes(NP_PA_QUESTION) && text.includes(NP_PA_ANSWER), 'the FAQ entry');
  assert.equal(output.split(`<summary>${NP_PA_QUESTION}</summary>`).length, 2);
  // The founder wording is the live site's, not the draft.
  assert.match(text, /Built by Dr\. Eric Whitney, DO, a practicing neurosurgeon who uses it for his own credentials\./);
  assert.doesNotMatch(text, /licensed in several states/i);
});

test('the founder countdown is printed empty and hidden: on the home hero by the signup button, on the home card and on /pricing', async () => {
  const HOOK = '<p class="spots" data-membership-spots role="status" aria-live="polite" hidden></p>';
  const home = renderPublicLaunch(await read('landing/index.html'), 'home');
  assert.equal(home.split(HOOK).length, 3, 'two places on the home page');
  assert.match(home, new RegExp(`<div data-hero-signup[^>]*>${HOOK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<a class="btn-primary" href="/app/"`), 'right above the hero signup button');
  const card = home.slice(home.indexOf('<div class="prices prices-one" data-founder-only>'), home.indexOf('<div class="prices" data-after-founders hidden>'));
  assert.equal(card.split(HOOK).length, 2, 'in the Founder card');
  const pricing = renderPublicLaunch(await read('landing/pricing.html'), 'pricing');
  assert.equal(pricing.split(HOOK).length, 2, 'once on /pricing, in the Founder card');
  // No number, and no count wording, is ever written into a page: only the server's answer fills it.
  for (const page of [home, pricing]) assert.doesNotMatch(page.replace(/<script\b[\s\S]*?<\/script>/gi, ''), /\d+ of 100|spots left|places left/i);
  const without = readFileSyncSafe('landing/pricing.html').replace(/<!-- public-launch:founder-spots -->[\s\S]*?<!-- \/public-launch:founder-spots -->/, '');
  assert.throws(() => renderPublicLaunch(without, 'pricing'), /Incomplete pricing migration: founder-spots/);
});

test('the professions the site names are the ones the app lets a member choose', () => {
  assert.deepEqual([...DEGREES].sort(), ['DO', 'MD', 'NP', 'PA']);
  for (const degree of DEGREES) assert.ok(AUDIENCE.includes(`${degree}s`), degree);
});

test('state guides stay physician guides: each carries the one NP and PA line, once', async () => {
  const LINE = 'NP and PA requirements differ by board; the CredentialDOMD app tracks NP and PA licenses too.';
  const files = (await readdir(new URL('../landing/states/', import.meta.url))).filter(file => file.endsWith('.html'));
  assert.equal(files.length, 52);
  for (const file of files) {
    const html = await read(`landing/states/${file}`);
    assert.equal(html.split(LINE).length, 2, file);
    assert.equal(html.split('np-pa-note').length, 2, file);
    assert.match(html, /(?:This is a|These are) physician \(MD and DO\) guides?\./, file);
  }
});

test('the home page says "Log in", never "Sign in", and the link still goes to the app', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  assert.match(output, /Already a member\? <a href="\/app\/">Log in<\/a>/);
  assert.doesNotMatch(visible(output), /Sign in\b/);
});
