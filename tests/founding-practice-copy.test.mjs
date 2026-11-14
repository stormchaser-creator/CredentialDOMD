// What a buyer reads about Practice. Owner decision 2026-09-28: "$99 founding
// members get Practice free while a member." Owner decision 2026-11-13: the
// public site presents that as ONE plan, the Founder plan, $99/year with
// everything included, on one card; no other tier, package or trial is shown
// on a marketing page. The app's sign in screen, its checkout and /terms keep
// the checkout policy's wording (unchanged here). Public copy written for
// these changes carries no hyphen and no dash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderPublicLaunch, publicLaunchHelp, FOUNDER_PLAN, FOUNDER_AVAILABILITY } from '../scripts/public-launch-render.mjs';
import { publicLaunchPresentation } from '../src/content/publicLaunch.mjs';
import { renderLegalPages } from '../scripts/generate-legal-pages.mjs';
import { offerPresentation, sitePresentation } from '../public/membership-offer.js';
import { getLegalDocuments } from '../src/content/legalText.js';
import { MEMBERSHIP_COPY } from '../src/content/membershipCopy.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const view = publicLaunchPresentation();
const SITE_HEADLINE = 'Founder plan: $99/year, everything included';
const OTHER_TIERS = /\$149|\$199|\$245|early ?bird|Credential \+ Practice|Practice trial|Compare the plans|Optional Practice|Founding Credential/i;
const HEADLINE = 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member';
const visible = html => html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
const PHASES = { founding: 9900, earlybird: 14900, standard: 19900 };
const reply = (phase, patch = {}) => ({ schemaVersion: 1, phase, annualCents: PHASES[phase], checkoutEnabled: true, availability: 'available', bundleAvailable: phase !== 'founding', ...patch });
const between = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test('the landing hero and the one Founder card say everything is included, Practice tools too', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const hero = output.slice(output.indexOf('<section class="hero"'), output.indexOf('<!-- ============ HOW IT WORKS'));
  assert.ok(hero.includes(`data-membership-hero-headline style="font-size:23px;font-weight:750;line-height:1.3;margin:0 0 8px;">${SITE_HEADLINE}</p>`));
  const plans = between(output, '<section id="planned-pricing"', '<!-- ============ GUARANTEE');
  assert.equal(plans.split('<article').length, 2, 'one card');
  assert.ok(plans.includes(`<span data-membership-headline>${SITE_HEADLINE}</span>`));
  const card = between(plans, '<article', '</article>');
  assert.ok(card.includes('<h3 class="feature-title"><span data-membership-phase>Founder plan</span></h3>'));
  assert.ok(card.includes('<b data-membership-price>$99</b><span data-membership-price-label> / year</span>'));
  assert.match(visible(card), /Everything is included:/);
  assert.match(visible(card), /Practice tools: contracts, work logs, invoices and payment tracking/);
  assert.match(card, /<a [^>]*href="\/app\/"[^>]*><span data-membership-action>Create your account<\/span><\/a>/);
  assert.doesNotMatch(visible(output), OTHER_TIERS);
  assert.doesNotMatch(visible(output), /New paid Credential members receive a separate|Existing Credential members should contact support/);
  assert.match(visible(output), /Practice tools\s*, included/);
  assert.match(output, /<ul class="ticks includes" data-founder-only>/, "hidden by membership-offer.js once the plan is full");
  // The guarantee covers the membership: its own line under the card.
  assert.ok(plans.indexOf(view.refundGuarantee) > plans.indexOf('</article>'), 'after the card');
  assert.equal(plans.split(view.refundGuarantee).length, 2, 'once');
});

test('the Founder card\'s rate paragraph is replaced, with no other price, once checkout is no longer founding', async () => {
  const output = renderPublicLaunch(await read('landing/index.html'), 'home');
  const card = between(between(output, '<section id="planned-pricing"', '<!-- ============ GUARANTEE'), '<article', '</article>');
  assert.ok(card.includes('<span data-membership-rate>'), 'the paragraph membership-offer.js repaints');
  assert.ok(visible(card).replace(/\s+/g, ' ').includes(FOUNDER_PLAN.rate), 'and it prints the Founder rate sentence');
  assert.equal(sitePresentation(offerPresentation(reply('founding'))).rateNote, FOUNDER_PLAN.rate, 'no flicker at founding');
  for (const phase of ['earlybird', 'standard']) {
    const full = sitePresentation(offerPresentation(reply(phase)));
    assert.match(full.rateNote, /^All 100 Founder places have been taken\./);
    assert.doesNotMatch(JSON.stringify(full), /\$\d|first 100|Practice included|trial/i, phase);
    assert.equal(full.bundleLabel, undefined, 'the site view has no package label');
  }
  // The app view (sign in screen) is untouched.
  assert.equal(offerPresentation(reply('founding')).rateNote, view.foundingRate);
  assert.equal(offerPresentation(reply('founding')).bundleLabel, ' / year, after founding');
});

test('the /locums membership card states the one plan, keeps the guarantee, and shows no package or trial', async () => {
  const output = renderPublicLaunch(await read('landing/locums.html'), 'locums');
  const card = visible(between(output, '<div class="beta-card', '</div>'));
  const at = text => card.indexOf(text);
  assert.ok(at('One plan with everything included, for the first 100 paid members.') >= 0, 'the plan first');
  assert.ok(at(view.refundGuarantee) > at('One plan with everything included'), 'the guarantee is in the card');
  assert.ok(between(output, '<div class="beta-card', '</div>').includes('<span data-membership-rate>'));
  assert.ok(!card.includes(view.fullPackage) && !card.includes(view.practiceTrial));
  assert.doesNotMatch(visible(output), OTHER_TIERS);
  assert.doesNotMatch(output.match(/<head>[\s\S]*?<\/head>/)[0].replace(/<style\b[\s\S]*?<\/style>/gi, ''), OTHER_TIERS, 'metadata and structured data too');
});

test('the home page no longer says "No free trial" against the Practice trial', async () => {
  // The redesigned home page has no competitor grid; the plans cards carry the offer.
  const source = await read('landing/index.html');
  assert.doesNotMatch(source, /No free trial|<td class="us">/);
});

test('the site says Practice is included on /locums and /help; /terms keeps the checkout policy wording', async () => {
  const locums = visible(renderPublicLaunch(await read('landing/locums.html'), 'locums')).replace(/\s+/g, ' ');
  assert.ok(locums.includes(FOUNDER_AVAILABILITY), '/locums invitation line and cost answer');
  assert.ok(!locums.includes(view.practiceTrial));
  const help = publicLaunchHelp(JSON.parse(await read('public/knowledge/credentialdo-help.json')));
  const practice = help.articles.find(article => article.id === 'locum-contract').availability;
  assert.ok(practice.startsWith(FOUNDER_PLAN.practice), '/help');
  assert.ok(!practice.includes(view.practiceTrial) && !practice.includes(view.fullPackage));
  assert.doesNotMatch(JSON.stringify(help), OTHER_TIERS, 'no help article names another tier');
  // /terms is the app's contract text (src/content/legalText.js). It is not
  // site marketing copy and still states what checkout sells.
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
  for (const text of [view.foundingOffer, view.foundingRate, view.fullPackage, view.practiceTrial, offerPresentation({ schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available' }).heroHeadline]) {
    assert.doesNotMatch(text, /[-–—]/, text);
  }
});

test('the rendered price blocks carry no hyphen or dash, and the app and /terms spell "early bird" one way', async () => {
  const NO_HYPHEN = /[-–—]/;
  const home = renderPublicLaunch(await read('landing/index.html'), 'home');
  // The pricing heading and the plan card, as a visitor reads them.
  const plans = visible(between(home, '<section id="planned-pricing"', view.refundGuarantee));
  assert.match(plans, /The Founder plan is \$99\/year and includes everything/);
  assert.doesNotMatch(plans, NO_HYPHEN, plans);
  const meta = home.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.match(meta, /Founder plan: \$99\/year, everything included\./);
  assert.doesNotMatch(meta, /\$149|\$199|early bird|standard/i);
  assert.doesNotMatch(meta, NO_HYPHEN, meta);
  // The /locums card's price paragraphs.
  const locums = renderPublicLaunch(await read('landing/locums.html'), 'locums');
  const card = visible(between(locums, '<div class="beta-card', view.promisedBeta.slice(0, 40)));
  assert.doesNotMatch(card.replace(view.refundGuarantee, ''), NO_HYPHEN, card);
  // Every string the site paints, in every state, and every string the app reads.
  for (const phase of Object.keys(PHASES)) {
    for (const [key, text] of Object.entries(offerPresentation(reply(phase)))) assert.doesNotMatch(text, NO_HYPHEN, `${phase} ${key}: ${text}`);
    for (const [key, text] of Object.entries(sitePresentation(offerPresentation(reply(phase))))) assert.doesNotMatch(text, NO_HYPHEN, `site ${phase} ${key}: ${text}`);
  }
  for (const text of Object.values(FOUNDER_PLAN)) if (text !== FOUNDER_PLAN.team) assert.doesNotMatch(text, NO_HYPHEN, text);
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
