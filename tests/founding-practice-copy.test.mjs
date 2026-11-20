// What a buyer reads about Practice after the owner's 2026-09-28 decision:
// "$99 founding members get Practice free while a member." The landing hero,
// the $99 card, the competitor grid, the Practice paragraph on /, /locums,
// /help and /terms, and the public offer module the site and the app sign-in
// screen share. Early-bird and standard keep the 30 day trial. Public copy
// written for this change carries no hyphen and no dash.
// Owner, 2026-11-16: while founding lasts the site names one plan. /locums
// and /help print the Founder plan's Practice sentence alone, with no later
// price, package or trial; the Terms state the $99 founding price only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderPublicLaunch, publicLaunchHelp } from '../scripts/public-launch-render.mjs';
import { publicLaunchPresentation } from '../src/content/publicLaunch.mjs';
import { renderLegalPages } from '../scripts/generate-legal-pages.mjs';
import { offerPresentation, homePresentation } from '../public/membership-offer.js';
import { getLegalDocuments } from '../src/content/legalText.js';
import { MEMBERSHIP_COPY } from '../src/content/membershipCopy.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const view = publicLaunchPresentation();
const HEADLINE = 'Founding Credential: $99/year while Founder spots last, Practice included while you are a member';
const visible = html => html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
const PHASES = { founding: 9900, earlybird: 14900, standard: 19900 };
const reply = (phase, patch = {}) => ({ schemaVersion: 1, phase, annualCents: PHASES[phase], checkoutEnabled: true, availability: 'available', bundleAvailable: phase !== 'founding', ...patch });
const between = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

// Unified home page (2026-11-15): while Founder spots remain the page prints
// one plan, the $99 Founder plan with Credential and Practice, and no later
// price. The later plan's words arrive only from a validated live offer.
test('the landing hero and the $99 card say Practice is included while a member', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const hero = between(output, '<section class="hero"', '</section>');
  assert.match(visible(hero), /Founder plan: \$99\/year, everything included/);
  assert.match(visible(hero), /Your rate stays locked for life while your membership is active/);
  const card = between(output, '<div class="price-card" data-founder-only>', '<div class="terms">');
  assert.match(visible(card), /\$99\s*\/year/);
  assert.match(visible(card), /Practice: work log, RVUs, contracts, invoices and payments/);
  assert.match(visible(card), /Your \$99 rate locked for life while your membership is active/);
  // No later price is printed anywhere in the page: not $245 as a plan beside $99, nor $149 or $199.
  assert.doesNotMatch(output.replace(/<script type="module"[^>]*><\/script>/, ''), /\$\s?(?:149|199|245)\b/);
  assert.doesNotMatch(visible(output), /New paid Credential members receive a separate|Existing Credential members should contact support/);
  // The later phases' Practice trial paragraph is part of the plan shown after the founders.
  const later = between(output, '<div class="price-card" data-after-founders hidden>', '<div class="price-card" data-founder-only>');
  assert.ok(visible(later).includes(view.practiceTrial));
  assert.equal(output.split(view.practiceTrial).length, 2, 'once, and not in the Founder card');
  // The guarantee covers every membership: its own line under the plan cards.
  const plans = between(output, '<section class="alt" id="pricing">', '<section id="resources">');
  assert.ok(plans.indexOf(view.refundGuarantee) > plans.indexOf('<div class="terms">'), 'after the plan cards');
  assert.equal(output.split(view.refundGuarantee).length, 2, 'once');
});

test('the $99 card\'s rate paragraph is replaced once the live phase is no longer founding', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  // The later plan's card is printed empty and hidden; the live offer fills it.
  assert.match(output, /<div class="price-card" data-after-founders hidden>\s*<span class="badge" data-home-plan><\/span>\s*<div class="price"><span data-home-price><\/span><small>\/year<\/small><\/div>\s*<p data-home-rate><\/p>\s*<p data-home-bundle><\/p>/);
  assert.equal(offerPresentation(reply('founding')).rateNote, view.foundingRate, 'no flicker at founding');
  assert.deepEqual(homePresentation(offerPresentation(reply('founding'))), { founding: true, spots: '', plan: '', price: '', headline: '', note: '', rate: '', bundle: '',
    status: 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.' });
  for (const phase of ['earlybird', 'standard']) {
    const later = offerPresentation(reply(phase));
    assert.match(later.rateNote, new RegExp(`^${phase === 'earlybird' ? 'Early bird' : 'Standard'} Credential: \\$${PHASES[phase] / 100}/year, with one 30 day Practice trial`));
    assert.doesNotMatch(later.rateNote, /Practice included|\$99|first 100|founding/i, phase);
    assert.equal(later.bundleLabel, ' / year total');
    const home = homePresentation(later);
    assert.equal(home.founding, false);
    assert.equal(home.rate, later.rateNote);
    assert.equal(home.price, `$${PHASES[phase] / 100}`);
    assert.equal(home.bundle, view.bundleOffer);
    assert.doesNotMatch(Object.values(home).join(' '), /Practice included|\$99|first 100|founding/i, phase);
  }
  assert.equal(offerPresentation(reply('founding')).bundleLabel, ' / year, after founding');
});

test('the /locums membership card leads with the $99 founding offer, names no package or later price, and keeps the guarantee', async () => {
  const output = renderPublicLaunch(await read('landing/locums.html'), 'locums');
  const card = visible(between(output, '<div class="beta-card', '</div>'));
  const at = text => card.indexOf(text);
  assert.ok(at(view.foundingRate) >= 0 && at(view.foundingPractice) > at(view.foundingRate), 'founding first');
  assert.equal(at(view.fullPackage), -1, 'no package beside the Founder plan');
  assert.equal(at(view.practiceTrial), -1, 'no later members\' trial');
  assert.doesNotMatch(visible(output), /\$\s?(?:149|199|245)\b|early bird|Create your account/i);
  assert.ok(at(view.refundGuarantee) > at(view.foundingPractice), 'the guarantee is in the card');
  assert.ok(between(output, '<div class="beta-card', '</div>').includes('<span data-membership-rate>'));
});

test('the home page no longer says "No free trial" against the Practice trial', async () => {
  // The competitor grid left with the unified home page; the claim must not come back in any form.
  assert.doesNotMatch(await read('landing/index.html'), /No free trial/);
});

test('the Founder plan\'s Practice sentence is the same on /locums, /help and /terms, and the terms keep their trial paragraph', async () => {
  const locums = visible(renderPublicLaunch(await read('landing/locums.html'), 'locums'));
  assert.ok(locums.includes(view.foundingPractice) && !locums.includes(view.practiceTrial), '/locums card and cost answer');
  const help = publicLaunchHelp(JSON.parse(await read('public/knowledge/credentialdo-help.json')));
  assert.ok(help.articles.find(article => article.id === 'locum-contract').availability.includes(view.foundingPractice), '/help');
  const terms = renderLegalPages()['terms.html'];
  assert.ok(visible(terms).includes(view.practiceTrial), '/terms');
  assert.match(terms, /Last updated November 16, 2026/);
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
  for (const text of [view.foundingOffer, view.foundingRate, view.fullPackage, view.practiceTrial, offerPresentation({ schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available' }).heroHeadline]) {
    assert.doesNotMatch(text, /[-–—]/, text);
  }
});

test('the rendered price blocks spell "early bird" one way and carry no hyphen or dash', async () => {
  const NO_HYPHEN = /[-–—]/;
  const home = renderPublicLaunch(await read('landing/index.html'), 'home');
  // The home page prints no later price while founding lasts, in the page or its description.
  assert.doesNotMatch(home.replace(/<script type="module"[^>]*><\/script>/, ''), /\$\s?(?:149|199|245)\b/);
  const meta = home.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.match(meta, /\$99\/yr Founder plan/);
  // The /locums card's price paragraphs.
  const locums = renderPublicLaunch(await read('landing/locums.html'), 'locums');
  const card = visible(between(locums, '<div class="beta-card', view.promisedBeta.slice(0, 40)));
  assert.doesNotMatch(card.replace(view.refundGuarantee, ''), NO_HYPHEN, card);
  // Every string the live offer paints, in every phase: hero, sign-in headline, card labels.
  for (const phase of Object.keys(PHASES)) {
    for (const [key, text] of Object.entries(offerPresentation(reply(phase)))) assert.doesNotMatch(text, NO_HYPHEN, `${phase} ${key}: ${text}`);
  }
  assert.equal(offerPresentation(reply('earlybird')).headline, 'Early bird Credential: $149/year.');
  assert.equal(offerPresentation(reply('earlybird')).priceLabel, ' / year, early bird Credential');
  // The pricing blocks of /terms section 1 and the in-app price answers.
  const terms = getLegalDocuments().terms.sections[0].blocks;
  const pricing = terms.slice(3, 6);
  // Owner approved, 2026-11-16: the $99 founding terms, with no later price.
  assert.match(pricing[0], /^Paid founding members get Credential for \$99 per year while Founder spots last\. Founding members keep their annual rate for life/);
  assert.equal(pricing[1], 'Founding Credential at $99 per year includes Practice while you are a member.');
  assert.doesNotMatch(terms.join(' '), /\$\s?(?:149|199|245)\b/);
  for (const text of [...pricing, view.earlyBirdRateLock, view.bundleOffer,
    MEMBERSHIP_COPY.credentialPrices, MEMBERSHIP_COPY.rateLock, MEMBERSHIP_COPY.bundleOffer, MEMBERSHIP_COPY.bundleDuringFounding]) {
    assert.doesNotMatch(text, NO_HYPHEN, text);
  }
});
