// What a buyer reads about Practice after the owner's 2026-09-28 decision:
// "$99 founding members get Practice free while a member." The landing hero,
// the $99 card, the competitor grid, the Practice paragraph on /, /locums,
// /help and /terms, and the public offer module the site and the app sign-in
// screen share. Early-bird and standard keep the 30 day trial. Public copy
// written for this change carries no hyphen and no dash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderPublicLaunch, publicLaunchHelp } from '../scripts/public-launch-render.mjs';
import { publicLaunchPresentation } from '../src/content/publicLaunch.mjs';
import { renderLegalPages } from '../scripts/generate-legal-pages.mjs';
import { offerPresentation } from '../public/membership-offer.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const view = publicLaunchPresentation();
const HEADLINE = 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member';
const visible = html => html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');

test('the landing hero and the $99 card say Practice is included while a member', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const hero = output.slice(output.indexOf('<section class="hero"'), output.indexOf('<!-- ============ PROBLEM'));
  assert.ok(hero.includes(`data-membership-hero-headline style="font-size:23px;font-weight:750;line-height:1.3;margin:0 0 8px;">${HEADLINE}</p>`));
  const card = output.slice(output.indexOf('<h3 class="feature-title">Credential</h3>'), output.indexOf('<h3 class="feature-title">Credential + Practice</h3>'));
  assert.ok(card.includes(HEADLINE), 'the $99 card');
  const bundle = output.slice(output.indexOf('<h3 class="feature-title">Credential + Practice</h3>'), output.indexOf('<!-- ============ GUARANTEE'));
  assert.match(visible(bundle), /While founding places remain it is not offered at public signup, because founding Credential already includes Practice\./);
  assert.match(visible(bundle), /Founding Credential members have Practice included for as long as their membership stays active\./);
  assert.match(visible(bundle), /Early bird and standard Credential members receive a separate 30 day Practice trial/);
  assert.doesNotMatch(visible(output), /New paid Credential members receive a separate|Existing Credential members should contact support/);
});

test('the competitor grid no longer says "No free trial" against the Practice trial', async () => {
  const source = await read('landing/index.html');
  assert.doesNotMatch(source, /No free trial/);
  const cell = source.match(/<td class="us">(\$99 a year[^<]*)<\/td>/)[1];
  assert.equal(cell, '$99 a year for the first 100 paid founding members, Practice included while you are a member. Then $149, then $199, each with a 30 day Practice trial. You pay up front, and you can ask for that year back in full at any time.');
});

test('the Practice paragraph is the same on /locums, /help and /terms, and the terms date moved', async () => {
  const locums = visible(renderPublicLaunch(await read('landing/locums.html'), 'locums'));
  assert.ok(locums.includes(view.practiceTrial), '/locums card and cost answer');
  const help = publicLaunchHelp(JSON.parse(await read('public/knowledge/credentialdo-help.json')));
  assert.ok(help.articles.find(article => article.id === 'locum-contract').availability.includes(view.practiceTrial), '/help');
  const terms = renderLegalPages()['terms.html'];
  assert.ok(visible(terms).includes(view.practiceTrial), '/terms');
  assert.match(terms, /Last updated September 28, 2026/);
  // The committed pages are the generator's output.
  assert.equal(await read('landing/terms.html'), terms);
  assert.equal(await read('public/terms.html'), terms);
});

test('the public offer module paints the same headline, and refuses a reply that offers the bundle during founding', () => {
  const founding = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available' };
  assert.equal(offerPresentation(founding).heroHeadline, HEADLINE);
  assert.equal(offerPresentation({ ...founding, bundleAvailable: false }).heroHeadline, HEADLINE);
  assert.match(offerPresentation(founding).headline, /Practice included while you are a member\.$/);
  assert.throws(() => offerPresentation({ ...founding, bundleAvailable: true }));
  const earlybird = offerPresentation({ ...founding, phase: 'earlybird', annualCents: 14900, bundleAvailable: true });
  assert.doesNotMatch(`${earlybird.heroHeadline} ${earlybird.headline}`, /Practice included/);
  assert.throws(() => offerPresentation({ ...founding, phase: 'earlybird', annualCents: 14900, bundleAvailable: false }));
});

test('no hyphen or dash in the public copy written for this change', async () => {
  const cell = (await read('landing/index.html')).match(/<td class="us">(\$99 a year[^<]*)<\/td>/)[1];
  for (const text of [view.foundingOffer, view.foundingRate, view.fullPackage, view.practiceTrial, cell, offerPresentation({ schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available' }).heroHeadline]) {
    assert.doesNotMatch(text, /[-–—]/, text);
  }
});
