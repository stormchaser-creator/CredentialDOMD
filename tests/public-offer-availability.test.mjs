// BILL-004, restated for the one-plan site (owner decision 2026-11-13): the
// site presents the Founder plan, $99/year with everything included. If
// public-membership-offer answers a later phase, no sentence on a public page
// may still offer $99, and none may name another tier or another price: the
// page says the Founder plan is full and that the app shows the current price
// before payment. The pages are rendered with the production defaults and
// painted by the real public/membership-offer.js over a small text-only DOM
// built from the rendered HTML. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderPublicLaunch, publicLaunchHelp, markLiveOffer, FOUNDER_PLAN, FOUNDER_AVAILABILITY } from '../scripts/public-launch-render.mjs';
import { publicLaunchPresentation, FOUNDING_AVAILABILITY, FOUNDING_RATE_LOCK } from '../src/content/publicLaunch.mjs';
import { offerPresentation, sitePresentation, createOfferUpdater, phaseStructuredData } from '../public/membership-offer.js';
import { renderHelp } from '../scripts/build-help.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { renderWatchPages } from '../scripts/watch-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const view = publicLaunchPresentation();
const endpoint = 'https://synthetic.supabase.co/functions/v1/public-membership-offer';
const CENTS = { founding: 9900, earlybird: 14900, standard: 19900 };
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
// What may still name $99 once the Founder plan is full: the promise to the
// earlier free-beta sign-ups, who keep their $99 opt-in.
const ALLOWED = /signed up under the earlier free-beta wording|opt in to \$99\/year Credential during the beta/;
const offering$99 = text => text.split(/(?<=[.!?])\s+/).filter(x => /\$99/.test(x) && !ALLOWED.test(x));
// Nothing the site shows, in any state, names another tier or its price.
const OTHER_TIERS = /\$149|\$199|\$245|early ?bird|standard Credential|Credential \+ Practice|Compare the plans|Founding Credential|Practice trial|free tier/i;

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

test('the app view of the offer is unchanged: it still follows the checkout phase', () => {
  const founding = offerPresentation(reply('founding'));
  assert.equal(founding.availabilityOffer, FOUNDING_AVAILABILITY);
  assert.equal(founding.rateLock, ` ${FOUNDING_RATE_LOCK}`);
  assert.equal(founding.rateNote, view.foundingRate);
  for (const phase of ['earlybird', 'standard']) {
    const later = offerPresentation(reply(phase));
    assert.match(later.availabilityOffer, new RegExp(`\\$${CENTS[phase] / 100}/year`));
    assert.equal(later.action, `Join for $${CENTS[phase] / 100} a year`);
  }
});

test('the Founder sentences membership-offer.js swaps are the ones the site prints', () => {
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
  for (const phase of ['earlybird', 'standard']) {
    const full = sitePresentation(offerPresentation(reply(phase)));
    assert.doesNotMatch(JSON.stringify(full), /\$\d|first 100/, `${phase}: no price at all`);
    assert.doesNotMatch(JSON.stringify(full), OTHER_TIERS, phase);
    assert.doesNotMatch(`${full.availabilityOffer}${full.rateNote}${full.status}`, /[-–—]/, 'no hyphen or dash in public copy');
    assert.equal(full.rateLock, '');
  }
  assert.throws(() => sitePresentation({ phaseKey: 'gold', status: 'x', action: 'y' }));
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

test('no public page names another tier or price: as printed, at founding, with no answer, or once the plan is full', async () => {
  const rendered = await pages();
  const answers = { printed: null, founding: async () => Response.json(reply('founding')), offline: async () => { throw Error('offline'); },
    earlybird: async () => Response.json(reply('earlybird')), standard: async () => Response.json(reply('standard')),
    paused: async () => Response.json({ ...reply('standard'), checkoutEnabled: false, availability: 'paused' }) };
  for (const [state, fetchImpl] of Object.entries(answers)) {
    for (const [name, html] of Object.entries(rendered)) {
      const dom = textDom(html);
      if (fetchImpl) await createOfferUpdater(dom, endpoint, { fetchImpl })();
      const painted = dom.html();
      assert.doesNotMatch(visibleText(painted), OTHER_TIERS, `${name} ${state}`);
      assert.doesNotMatch(structured(painted), OTHER_TIERS, `${name} JSON-LD ${state}`);
      assert.doesNotMatch(painted.match(/<head>[\s\S]*?<\/head>/)?.[0].replace(/<style\b[\s\S]*?<\/style>/gi, '') || '', OTHER_TIERS, `${name} head ${state}`);
    }
  }
});

test('once checkout has left the founding phase no sentence on any public page still offers $99, visible or structured', async () => {
  const rendered = await pages();
  for (const phase of ['earlybird', 'standard']) {
    for (const [name, html] of Object.entries(rendered)) {
      const dom = textDom(html);
      await createOfferUpdater(dom, endpoint, { fetchImpl: async () => Response.json(reply(phase)) })();
      const painted = dom.html();
      assert.deepEqual(offering$99(visibleText(painted)), [], `${name} at ${phase}`);
      assert.deepEqual(offering$99(structured(painted)), [], `${name} JSON-LD at ${phase}`);
      if (name === 'home' || name === 'pricing') {
        assert.ok(visibleText(painted).includes('The Founder plan is full'), `${name}: says the plan is full`);
        assert.ok(visibleText(painted).includes('the app shows the current membership price before you choose to pay'), name);
      }
      if (name === 'home') assert.ok(visibleText(painted).includes('Yes. Membership is open now.'));
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
  for (const phase of ['earlybird', 'standard']) {
    const full = JSON.parse(phaseStructuredData(original, at(phase)));
    assert.match(full.mainEntity[0].acceptedAnswer.text, /The Founder plan is full; the app shows the current membership price before you choose to pay\./);
    assert.match(full.mainEntity[1].acceptedAnswer.text, /^All 100 Founder places have been taken\./);
    assert.doesNotMatch(JSON.stringify(full), /\$\d|locked for life/);
    // Painting twice from the original gives the same text.
    assert.equal(phaseStructuredData(original, at(phase)), phaseStructuredData(original, at(phase)));
  }
  assert.equal(phaseStructuredData('not json', at('earlybird')), 'not json');
});
