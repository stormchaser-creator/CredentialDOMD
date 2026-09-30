// BILL-004: past the founding cap (public-membership-offer answers early bird
// or standard) no sentence on a public page may still offer "Founding
// Credential is $99/year". The hero and price were repainted, but the
// availability sentence (plans subtitle, home FAQ, membership cards, footers,
// help notes) and its JSON-LD were static. The pages are rendered with the
// production defaults and painted by the real public/membership-offer.js over
// a small text-only DOM built from the rendered HTML. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderPublicLaunch, publicLaunchHelp, markLiveOffer } from '../scripts/public-launch-render.mjs';
import { publicLaunchPresentation, FOUNDING_AVAILABILITY, FOUNDING_RATE_LOCK } from '../src/content/publicLaunch.mjs';
import { offerPresentation, createOfferUpdater, phaseStructuredData } from '../public/membership-offer.js';
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
// What may still name $99 after the cap: the promised free-beta holders' opt-in
// (they keep founding), the package card's reason it is not sold to founding
// buyers, the price schedule, and the comparison grid's founding cell. The
// same list the QA journey allows.
const ALLOWED = /signed up under the earlier free-beta wording|opt in to \$99\/year Credential during the beta|not offered to founding buyers|After the 100 paid founding memberships|^\$99 a year for the first 100 paid founding members, Practice included|then \$149 early bird and \$199 standard/;
const offering$99 = text => text.split(/(?<=[.!?])\s+/).filter(x => /\$99/.test(x) && !ALLOWED.test(x));

async function pages() {
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const out = {
    home: renderPublicLaunch(await read('landing/index.html'), 'home'),
    locums: renderPublicLaunch(await read('landing/locums.html'), 'locums'),
    security: renderPublicLaunch(await read('landing/security.html'), 'legal-navigation'),
    cme: renderPublicLaunch(await read('landing/cme.html'), 'cme'),
    help: renderPublicLaunch(renderHelp(publicLaunchHelp(help), await loadVideoCatalog(root)), 'help'),
  };
  for (const page of renderWatchPages(publicLaunchHelp(help), await loadVideoCatalog(root))) out[`watch ${page.id || page.path || ''}`] = renderPublicLaunch(page.html, 'watch-pages');
  return out;
}

test('the founding sentences membership-offer.js swaps are the ones the site prints', () => {
  const founding = offerPresentation(reply('founding'));
  assert.equal(founding.availabilityOffer, FOUNDING_AVAILABILITY);
  assert.equal(founding.rateLock, ` ${FOUNDING_RATE_LOCK}`);
  assert.equal(founding.rateNote, view.foundingRate);
  assert.ok(view.availability.includes(FOUNDING_AVAILABILITY));
  for (const phase of ['earlybird', 'standard']) {
    const later = offerPresentation(reply(phase));
    assert.doesNotMatch(`${later.availabilityOffer}${later.rateLock}${later.rateNote}`, /\$99|first 100|founding/i, phase);
    assert.match(later.availabilityOffer, new RegExp(`\\$${CENTS[phase] / 100}/year`));
    assert.doesNotMatch(`${later.availabilityOffer}${later.rateLock}`, /[-–—]/, 'no hyphen or dash in public copy');
  }
  assert.equal(offerPresentation(reply('standard')).rateLock, '', 'the standard rate is not locked');
});

test('every visible founding availability sentence is inside the span the live offer repaints', async () => {
  for (const [name, html] of Object.entries(await pages())) {
    const bare = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').split(`<span data-membership-availability>${FOUNDING_AVAILABILITY}</span>`).join('');
    assert.ok(!bare.includes(FOUNDING_AVAILABILITY), `${name}: an unmarked "${FOUNDING_AVAILABILITY}"`);
  }
  // Marking is idempotent and never touches a tag, an attribute or a script.
  const html = '<html><head><meta content="' + FOUNDING_AVAILABILITY + '"></head><body><p>' + FOUNDING_AVAILABILITY + '</p><script>"' + FOUNDING_AVAILABILITY + '"</script></body></html>';
  const once = markLiveOffer(html, view);
  assert.equal(markLiveOffer(once, view), once);
  assert.equal(once.split('data-membership-availability').length, 2);
  assert.ok(once.includes(`<meta content="${FOUNDING_AVAILABILITY}">`) && once.includes(`<script>"${FOUNDING_AVAILABILITY}"</script>`));
});

test('at early bird and standard no sentence on any public page still offers $99, visible or structured', async () => {
  const rendered = await pages();
  for (const phase of ['earlybird', 'standard']) {
    for (const [name, html] of Object.entries(rendered)) {
      const dom = textDom(html);
      await createOfferUpdater(dom, endpoint, { fetchImpl: async () => Response.json(reply(phase)) })();
      const painted = dom.html();
      assert.deepEqual(offering$99(visibleText(painted)), [], `${name} at ${phase}`);
      assert.deepEqual(offering$99(structured(painted)), [], `${name} JSON-LD at ${phase}`);
      if (name === 'home') {
        const label = phase === 'earlybird' ? 'Early bird' : 'Standard';
        assert.ok(visibleText(painted).includes(`${label} Credential is $${CENTS[phase] / 100}/year.`), 'the live rate is stated instead');
        assert.ok(visibleText(painted).includes(`Yes. Membership is open now.`));
      }
    }
  }
});

test('at founding, or with no answer, the stated $99 policy sentences and structured data stay as printed', async () => {
  const rendered = await pages();
  for (const [name, html] of Object.entries(rendered)) {
    for (const fetchImpl of [async () => Response.json(reply('founding')), async () => { throw Error('offline'); }]) {
      const dom = textDom(html);
      const before = ['availability', 'rate-lock'].flatMap(a => dom.querySelectorAll(`[data-membership-${a}]`).map(n => n.textContent));
      await createOfferUpdater(dom, endpoint, { fetchImpl })();
      const after = ['availability', 'rate-lock'].flatMap(a => dom.querySelectorAll(`[data-membership-${a}]`).map(n => n.textContent));
      assert.deepEqual(after, before, name);
      assert.equal(structured(dom.html()), structured(html), `${name} JSON-LD`);
    }
  }
  const home = textDom(rendered.home);
  await createOfferUpdater(home, endpoint, { fetchImpl: async () => Response.json(reply('founding')) })();
  assert.match(visibleText(home.html()), /Founding Credential is \$99\/year for the first 100 paid founding members\./);
  assert.match(visibleText(home.html()), /That founding annual rate stays locked for life while membership remains continuously active\./);
});

test('structured data follows each phase from the page\'s original text, never from a painted one', () => {
  const original = JSON.stringify({ '@type': 'FAQPage', mainEntity: [{ acceptedAnswer: { text: `Yes. ${view.availability} ${FOUNDING_RATE_LOCK}` } }, { acceptedAnswer: { text: view.foundingRate } }] });
  assert.equal(phaseStructuredData(original, offerPresentation(reply('founding'))), original);
  const early = JSON.parse(phaseStructuredData(original, offerPresentation(reply('earlybird'))));
  assert.match(early.mainEntity[0].acceptedAnswer.text, /Early bird Credential is \$149\/year\. .* That early bird annual rate stays locked/);
  assert.match(early.mainEntity[1].acceptedAnswer.text, /^Early bird Credential: \$149\/year/);
  const standard = JSON.parse(phaseStructuredData(original, offerPresentation(reply('standard'))));
  assert.doesNotMatch(JSON.stringify(standard), /\$99|\$149|locked for life|founding/i);
  assert.equal(phaseStructuredData('not json', offerPresentation(reply('earlybird'))), 'not json');
});
