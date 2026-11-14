// BILL-004, restated for the pricing the owner set on 2026-11-13. While
// founder places remain the site presents the Founder plan, $99/year with
// everything included. Once public-membership-offer reports the founders are
// sold out, no sentence on a public page may still offer $99: the pages show
// Credential at $149/year and Credential + Practice at $245/year. No state
// names the removed $199 tier. The pages are rendered with the production
// defaults and painted by the real public/membership-offer.js over a small
// text-only DOM built from the rendered HTML, then read as a visitor sees
// them in that state (tests/helpers/site-states.mjs). All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderPublicLaunch, publicLaunchHelp, markLiveOffer, FOUNDER_PLAN, FOUNDER_AVAILABILITY, AFTER_FOUNDERS } from '../scripts/public-launch-render.mjs';
import { inState, stateOf } from './helpers/site-states.mjs';
import { publicLaunchPresentation, FOUNDING_AVAILABILITY, FOUNDING_RATE_LOCK } from '../src/content/publicLaunch.mjs';
import { offerPresentation, sitePresentation, createOfferUpdater, phaseStructuredData } from '../public/membership-offer.js';
import { renderHelp } from '../scripts/build-help.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { renderWatchPages } from '../scripts/watch-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const view = publicLaunchPresentation();
const endpoint = 'https://synthetic.supabase.co/functions/v1/public-membership-offer';
const CENTS = { founding: 9900, earlybird: 14900 };
const reply = phase => ({ schemaVersion: 1, phase, annualCents: CENTS[phase], checkoutEnabled: true, availability: 'available', bundleAvailable: phase !== 'founding' });
const unescape = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escape = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** A DOM with just what membership-offer.js touches: text-only [data-membership-*] elements and JSON-LD scripts. */
function textDom(html) {
  const parts = [];
  const nodes = [];
  let last = 0;
  const re = /<(\w+)\b([^>]*)>([^<]*)<\/\1>/g;
  for (let m; (m = re.exec(html));) {
    const attr = m[2].match(/\bdata-membership-([a-z-]+)/)?.[1];
    const ld = m[1] === 'script' && /type="application\/ld\+json"/.test(m[2]);
    if (!attr && !ld) continue;
    parts.push(html.slice(last, m.index + m[0].indexOf('>') + 1));
    const node = { attr, ld, textContent: ld ? m[3] : unescape(m[3]) };
    nodes.push(node); parts.push(node);
    parts.push(`</${m[1]}>`);
    last = m.index + m[0].length;
  }
  parts.push(html.slice(last));
  return {
    querySelectorAll: selector => selector === 'script[type="application/ld+json"]' ? nodes.filter(n => n.ld)
      : nodes.filter(n => selector === `[data-membership-${n.attr}]`),
    html: () => parts.map(p => typeof p === 'string' ? p : p.ld ? p.textContent : escape(p.textContent)).join(''),
  };
}
const visibleText = html => unescape(html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const structured = html => [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => JSON.stringify(JSON.parse(m[1]))).join(' ');
// What may still name $99 once the founders are sold out: the promise to the
// earlier free-beta sign-ups, who keep their $99 opt-in.
const ALLOWED = /signed up under the earlier free-beta wording|opt in to \$99\/year Credential during the beta/;
const offering$99 = text => text.split(/(?<=[.!?])\s+/).filter(x => /\$99/.test(x) && !ALLOWED.test(x));
// Never, in any state: the removed tier and the old multi-plan wording.
const REMOVED = /\$199|early ?bird|standard Credential|Compare the plans|Founding Credential|free tier|Optional Practice/i;
// While founder places remain a visitor reads one plan and one price.
const LATER_PLANS = /\$149|\$245|Credential \+ Practice|Practice trial/i;

async function pages() {
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const out = {
    home: renderPublicLaunch(await read('landing/index.html'), 'home'),
    pricing: renderPublicLaunch(await read('landing/pricing.html'), 'pricing'),
    locums: renderPublicLaunch(await read('landing/locums.html'), 'locums'),
    security: renderPublicLaunch(await read('landing/security.html'), 'legal-navigation'),
    cme: renderPublicLaunch(await read('landing/cme.html'), 'cme'),
    help: renderPublicLaunch(renderHelp(publicLaunchHelp(help), await loadVideoCatalog(root)), 'help'),
  };
  for (const page of renderWatchPages(publicLaunchHelp(help), await loadVideoCatalog(root))) out[`watch ${page.id || page.path || ''}`] = renderPublicLaunch(page.html, 'watch-pages');
  return out;
}

test('the app view of the offer follows the checkout phase: $99 founding, then $149 Credential', () => {
  const founding = offerPresentation(reply('founding'));
  assert.equal(founding.availabilityOffer, FOUNDING_AVAILABILITY);
  assert.equal(founding.rateLock, ` ${FOUNDING_RATE_LOCK}`);
  assert.equal(founding.rateNote, view.foundingRate);
  const later = offerPresentation(reply('earlybird'));
  assert.equal(later.availabilityOffer, 'Credential is $149/year.');
  assert.equal(later.action, 'Join for $149 a year');
  assert.equal(later.heroHeadline, 'Credential: $149/year');
  assert.doesNotMatch(JSON.stringify(later), /early bird|standard|\$199|\$99/i);
  assert.throws(() => offerPresentation({ ...reply('earlybird'), phase: 'standard', annualCents: 19900 }), /Unavailable/);
});

test('the sentences membership-offer.js swaps are the ones the site prints, in both states', () => {
  const founder = sitePresentation(offerPresentation(reply('founding')));
  assert.equal(founder.availabilityOffer, FOUNDER_PLAN.offer);
  assert.equal(founder.rateLock, ` ${FOUNDER_PLAN.rateLock}`);
  assert.equal(founder.rateNote, FOUNDER_PLAN.rate);
  assert.equal(founder.headline, FOUNDER_PLAN.headline);
  assert.equal(founder.heroNote, FOUNDER_PLAN.heroNote);
  assert.equal(founder.price + founder.priceLabel, FOUNDER_PLAN.price + FOUNDER_PLAN.priceLabel);
  assert.equal(founder.phase, FOUNDER_PLAN.phase);
  assert.equal(founder.reviewAction, FOUNDER_PLAN.reviewAction);
  assert.ok(FOUNDER_AVAILABILITY.includes(FOUNDER_PLAN.offer));
  const soldOut = sitePresentation(offerPresentation(reply('earlybird')));
  assert.equal(soldOut.phaseKey, 'soldout');
  assert.equal(soldOut.headline, AFTER_FOUNDERS.headline);
  assert.equal(soldOut.heroHeadline, AFTER_FOUNDERS.headline);
  assert.equal(soldOut.heroNote, AFTER_FOUNDERS.heroNote);
  assert.equal(soldOut.availabilityOffer, AFTER_FOUNDERS.offer);
  assert.equal(soldOut.rateLock, ` ${AFTER_FOUNDERS.rateLock}`);
  assert.equal(soldOut.rateNote, AFTER_FOUNDERS.rate);
  assert.doesNotMatch(JSON.stringify(soldOut), /\$99|first 100/);
  assert.doesNotMatch(JSON.stringify(soldOut), REMOVED);
  assert.deepEqual([...new Set(JSON.stringify(soldOut).match(/\$\d+/g))].sort(), ['$149', '$245']);
  assert.deepEqual(AFTER_FOUNDERS.plans.map(plan => [plan.name, plan.price]), [['Credential', '$149'], ['Credential + Practice', '$245']]);
  for (const text of [AFTER_FOUNDERS.offer, AFTER_FOUNDERS.rate, AFTER_FOUNDERS.rateLock, AFTER_FOUNDERS.heroNote, ...AFTER_FOUNDERS.plans.flatMap(plan => plan.lines)]) {
    assert.doesNotMatch(text, /[-–—]/, `no hyphen or dash in public copy: ${text}`);
  }
  assert.throws(() => sitePresentation({ phaseKey: 'standard', status: 'x', action: 'y' }));
  assert.throws(() => sitePresentation(null));
});

test('every visible Founder offer sentence is inside the span the live offer repaints', async () => {
  for (const [name, html] of Object.entries(await pages())) {
    const bare = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').split(`<span data-membership-availability>${FOUNDER_PLAN.offer}</span>`).join('');
    assert.ok(!bare.replace(/<head>[\s\S]*?<\/head>/, '').includes(FOUNDER_PLAN.offer), `${name}: an unmarked "${FOUNDER_PLAN.offer}"`);
  }
  // Marking is idempotent and never touches a tag, an attribute or a script.
  const html = '<html><head><meta content="' + FOUNDER_PLAN.offer + '"></head><body><p>' + FOUNDER_PLAN.offer + '</p><script>"' + FOUNDER_PLAN.offer + '"</script></body></html>';
  const once = markLiveOffer(html, view);
  assert.equal(markLiveOffer(once, view), once);
  assert.equal(once.split('data-membership-availability').length, 2);
  assert.ok(once.includes(`<meta content="${FOUNDER_PLAN.offer}">`) && once.includes(`<script>"${FOUNDER_PLAN.offer}"</script>`));
});

const ANSWERS = {
  printed: [null, 'founding'],
  founding: [async () => Response.json(reply('founding')), 'founding'],
  offline: [async () => { throw Error('offline'); }, 'founding'],
  // A server still answering the removed tier is refused, so the page stays as printed.
  'removed tier': [async () => Response.json({ ...reply('earlybird'), phase: 'standard', annualCents: 19900 }), 'founding'],
  'sold out': [async () => Response.json(reply('earlybird')), 'soldout'],
  'sold out, paused': [async () => Response.json({ ...reply('earlybird'), checkoutEnabled: false, availability: 'paused' }), 'soldout'],
};
/** The page as a visitor reads it after the offer script has run against `fetchImpl`. */
async function seen(html, [fetchImpl, state]) {
  const dom = textDom(html);
  if (fetchImpl) await createOfferUpdater(dom, endpoint, { fetchImpl })();
  return inState(dom.html(), state);
}

test('no state of any public page names the removed $199 tier or the old plan wording', async () => {
  const rendered = await pages();
  for (const [label, answer] of Object.entries(ANSWERS)) {
    for (const [name, html] of Object.entries(rendered)) {
      const page = await seen(html, answer);
      assert.doesNotMatch(visibleText(page), REMOVED, `${name}, ${label}`);
      assert.doesNotMatch(structured(page), REMOVED, `${name} JSON-LD, ${label}`);
      assert.doesNotMatch(page.match(/<head>[\s\S]*?<\/head>/)?.[0].replace(/<style\b[\s\S]*?<\/style>/gi, '') || '', REMOVED, `${name} head, ${label}`);
      // Not even in markup a visitor does not see.
      assert.doesNotMatch(html.replace(/<style\b[\s\S]*?<\/style>/gi, ''), /\$199|standard Credential/i, `${name} source`);
    }
  }
});

test('while founder places remain, or with no usable answer, a visitor reads only the $99 Founder plan', async () => {
  const rendered = await pages();
  for (const label of ['printed', 'founding', 'offline', 'removed tier']) {
    for (const [name, html] of Object.entries(rendered)) {
      const page = await seen(html, ANSWERS[label]);
      assert.doesNotMatch(visibleText(page), LATER_PLANS, `${name}, ${label}`);
      assert.doesNotMatch(structured(page), LATER_PLANS, `${name} JSON-LD, ${label}`);
      if (name === 'home' || name === 'pricing') {
        assert.equal(page.split('<article class="price').length, 2, `${name}, ${label}: one card`);
        assert.ok(visibleText(page).includes('Founder plan: $99/year, everything included'), `${name}, ${label}`);
      }
    }
  }
});

test('once the founders are sold out the pages show Credential $149 and Credential + Practice $245, and nothing still offers $99', async () => {
  const rendered = await pages();
  for (const label of ['sold out', 'sold out, paused']) {
    for (const [name, html] of Object.entries(rendered)) {
      const page = await seen(html, ANSWERS[label]);
      assert.deepEqual(offering$99(visibleText(page)), [], `${name}, ${label}`);
      assert.deepEqual(offering$99(structured(page)), [], `${name} JSON-LD, ${label}`);
      assert.doesNotMatch(visibleText(page), /Founder plan: \$99|everything included, for the first 100/, `${name}, ${label}`);
      if (name === 'home' || name === 'pricing') {
        const cards = [...page.matchAll(/<article class="price[^"]*">([\s\S]*?)<\/article>/g)].map(m => visibleText(m[1]).trim());
        assert.equal(cards.length, 2, `${name}, ${label}: two cards`);
        assert.match(cards[0], /^Credential \$149 \/ year /);
        assert.match(cards[0], /30 day Practice trial/);
        assert.match(cards[1], /^Credential \+ Practice \$245 \/ year /);
        assert.match(cards[1], /30 day Practice trial/);
        for (const card of cards) assert.match(card, /Sign up today$/, 'each card ends in its signup button');
        assert.equal([...page.matchAll(/<article class="price[^"]*">[\s\S]*?<\/article>/g)].every(m => /<a class="btn-primary" href="\/app\/"><span data-membership-action>Sign up today<\/span><\/a>/.test(m[0])), true, 'to the app');
        assert.ok(visibleText(page).includes(AFTER_FOUNDERS.headline), `${name}: the plans heading`);
      }
      if (name === 'home') {
        assert.ok(visibleText(page).includes('Yes. Membership is open now.'));
        assert.ok(visibleText(page).includes(AFTER_FOUNDERS.offer), 'the FAQ answer states the two prices');
      }
      if (name === 'locums') assert.ok(visibleText(page).includes(AFTER_FOUNDERS.rate), 'the membership card and cost answer');
    }
  }
});

test('at founding, or with no answer, the stated $99 Founder sentences and structured data stay as printed', async () => {
  const rendered = await pages();
  for (const [name, html] of Object.entries(rendered)) {
    for (const fetchImpl of [async () => Response.json(reply('founding')), async () => { throw Error('offline'); }]) {
      const dom = textDom(html);
      const marked = ['availability', 'rate-lock', 'rate', 'headline', 'hero-headline', 'hero-note', 'price', 'price-label', 'phase'];
      const before = marked.flatMap(a => dom.querySelectorAll(`[data-membership-${a}]`).map(n => n.textContent));
      await createOfferUpdater(dom, endpoint, { fetchImpl })();
      const after = marked.flatMap(a => dom.querySelectorAll(`[data-membership-${a}]`).map(n => n.textContent));
      assert.deepEqual(after, before, name);
      assert.equal(structured(dom.html()), structured(html), `${name} JSON-LD`);
    }
  }
  const home = textDom(rendered.home);
  await createOfferUpdater(home, endpoint, { fetchImpl: async () => Response.json(reply('founding')) })();
  assert.ok(visibleText(home.html()).includes('The Founder plan is $99/year and includes everything: credential tracking and the Practice tools.'));
  assert.ok(visibleText(home.html()).includes('That annual rate stays locked for life while membership remains continuously active.'));
});

test('structured data follows the state from the page\'s original text, never from a painted one', () => {
  const original = JSON.stringify({ '@type': 'FAQPage', mainEntity: [{ acceptedAnswer: { text: `Yes. Membership is open now. ${FOUNDER_AVAILABILITY} ${FOUNDER_PLAN.rateLock}` } }, { acceptedAnswer: { text: FOUNDER_PLAN.rate } }] });
  const at = phase => sitePresentation(offerPresentation(reply(phase)));
  assert.equal(phaseStructuredData(original, at('founding')), original);
  const later = JSON.parse(phaseStructuredData(original, at('earlybird')));
  assert.equal(later.mainEntity[0].acceptedAnswer.text, `Yes. Membership is open now. ${FOUNDER_AVAILABILITY.replace(FOUNDER_PLAN.offer, AFTER_FOUNDERS.offer)} ${AFTER_FOUNDERS.rateLock}`);
  assert.equal(later.mainEntity[1].acceptedAnswer.text, AFTER_FOUNDERS.rate);
  assert.doesNotMatch(JSON.stringify(later), /\$99|\$199/);
  // Painting twice from the original gives the same text.
  assert.equal(phaseStructuredData(original, at('earlybird')), phaseStructuredData(original, at('earlybird')));
  assert.equal(phaseStructuredData('not json', at('earlybird')), 'not json');
});
