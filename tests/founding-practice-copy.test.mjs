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
import { getLegalDocuments } from '../src/content/legalText.js';
import { MEMBERSHIP_COPY } from '../src/content/membershipCopy.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const view = publicLaunchPresentation();
const HEADLINE = 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member';
const visible = html => html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
const PHASES = { founding: 9900, earlybird: 14900, standard: 19900 };
const reply = (phase, patch = {}) => ({ schemaVersion: 1, phase, annualCents: PHASES[phase], checkoutEnabled: true, availability: 'available', bundleAvailable: phase !== 'founding', ...patch });
const between = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test('the landing hero and the $99 card say Practice is included while a member', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const hero = output.slice(output.indexOf('<section class="hero"'), output.indexOf('<!-- ============ PROBLEM'));
  assert.ok(hero.includes(`data-membership-hero-headline style="font-size:23px;font-weight:750;line-height:1.3;margin:0 0 8px;">${HEADLINE}</p>`));
  const card = output.slice(output.indexOf('<h3 class="feature-title">Credential</h3>'), output.indexOf('<h3 class="feature-title">Credential + Practice</h3>'));
  assert.ok(card.includes(HEADLINE), 'the $99 card');
  const bundle = output.slice(output.indexOf('<h3 class="feature-title">Credential + Practice</h3>'), output.indexOf('</article>', output.indexOf('<h3 class="feature-title">Credential + Practice</h3>')));
  // While founding lasts, $245 reads as the later price, not a plan beside $99.
  assert.ok(bundle.includes('$245<span data-membership-bundle-label> / year, after founding</span>'));
  assert.doesNotMatch(visible(bundle), /\$245\s+\/ year total/);
  assert.match(visible(bundle), /Credential \+ Practice is \$245\/year total at first purchase, with no early bird discount\. It is not offered to founding buyers, because founding Credential at \$99\/year already includes Practice while you are a member\./);
  assert.doesNotMatch(visible(bundle), /no founding|money.back/i, 'no founding discount claim, and the guarantee is not inside a card that is not sold');
  assert.match(visible(bundle), /Founding Credential members have Practice included for as long as their membership stays active\./);
  assert.match(visible(bundle), /Early bird and standard Credential members receive a separate 30 day Practice trial/);
  assert.doesNotMatch(visible(output), /New paid Credential members receive a separate|Existing Credential members should contact support/);
  // The guarantee covers every membership: its own line under the plan cards.
  const plans = between(output, '<section id="planned-pricing"', '<!-- ============ GUARANTEE');
  const grid = plans.indexOf('</article>', plans.indexOf('<h3 class="feature-title">Credential + Practice</h3>'));
  assert.ok(plans.indexOf(view.refundGuarantee) > grid, 'after both cards');
  assert.equal(plans.split(view.refundGuarantee).length, 2, 'once');
});

test('the $99 card\'s rate paragraph is replaced once the live phase is no longer founding', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const card = output.slice(output.indexOf('<h3 class="feature-title">Credential</h3>'), output.indexOf('<h3 class="feature-title">Credential + Practice</h3>'));
  assert.ok(card.includes(`<span data-membership-rate>${view.foundingRate}</span>`), 'the static paragraph is the one membership-offer.js repaints');
  assert.equal(offerPresentation(reply('founding')).rateNote, view.foundingRate, 'no flicker at founding');
  for (const phase of ['earlybird', 'standard']) {
    const later = offerPresentation(reply(phase));
    assert.match(later.rateNote, new RegExp(`^${phase === 'earlybird' ? 'Early bird' : 'Standard'} Credential: \\$${PHASES[phase] / 100}/year, with one 30 day Practice trial`));
    assert.doesNotMatch(later.rateNote, /Practice included|\$99|first 100|founding/i, phase);
    assert.equal(later.bundleLabel, ' / year total');
  }
  assert.equal(offerPresentation(reply('founding')).bundleLabel, ' / year, after founding');
  // A later phase painted over the page leaves no founding Practice claim in either card.
  const painted = output.replace(/(<span data-membership-rate>)[^<]*(<\/span>)/, `$1${offerPresentation(reply('earlybird')).rateNote}$2`);
  const earlyCard = painted.slice(painted.indexOf('<h3 class="feature-title">Credential</h3>'), painted.indexOf('<h3 class="feature-title">Credential + Practice</h3>'));
  assert.doesNotMatch(visible(earlyCard).replace(/<[^>]+>/g, ''), /Practice included while you are a member/);
});

test('the /locums membership card leads with the $99 founding offer, then the package, and keeps the guarantee', async () => {
  const output = renderPublicLaunch(await read('landing/locums.html'), 'locums');
  const card = visible(between(output, '<div class="beta-card', '</div>'));
  const at = text => card.indexOf(text);
  assert.ok(at(view.foundingRate) >= 0 && at(view.fullPackage) > at(view.foundingRate), 'founding first');
  assert.ok(at(view.practiceTrial) > at(view.fullPackage));
  assert.ok(at(view.refundGuarantee) > at(view.practiceTrial), 'the guarantee is in the card');
  assert.ok(between(output, '<div class="beta-card', '</div>').includes('<span data-membership-rate>'));
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

test('the rendered price blocks spell "early bird" one way and carry no hyphen or dash', async () => {
  const NO_HYPHEN = /[-–—]/;
  const home = renderPublicLaunch(await read('landing/index.html'), 'home');
  // The pricing heading and both plan cards, as a visitor reads them.
  const plans = visible(between(home, '<section id="planned-pricing"', view.refundGuarantee));
  assert.match(plans, /early bird Credential is \$149\/year/);
  assert.doesNotMatch(plans, NO_HYPHEN, plans);
  const meta = home.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.match(meta, /then \$149 early bird and \$199 standard/);
  assert.doesNotMatch(meta, NO_HYPHEN, meta);
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
  assert.match(pricing[0], /the early bird price is \$149 per year/);
  assert.match(pricing[0], /Founding and early bird members keep their annual rate/);
  for (const text of [...pricing, view.rateComparison, view.earlyBirdRateLock, view.bundleOffer,
    MEMBERSHIP_COPY.credentialPrices, MEMBERSHIP_COPY.rateLock, MEMBERSHIP_COPY.bundleOffer, MEMBERSHIP_COPY.bundleDuringFounding]) {
    assert.doesNotMatch(text, NO_HYPHEN, text);
  }
});
