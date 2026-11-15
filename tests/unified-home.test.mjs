// The unified home page (owner approval 2026-11-15), rendered with the
// production defaults and painted by the real public/membership-offer.js.
//
// While founder places remain it shows one plan, the $99 Founder plan; every
// signup link says "Sign up today" (header: "Sign up" and "Log in"); and it
// never says "Create your account" or names a later price. Once a validated
// reply says founding is over, the Founder card gives way to that reply's
// plan. A count of founder places appears only when the server sends one.
// All replies here are synthetic; nothing is fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderPublicLaunch } from '../scripts/public-launch-render.mjs';
import { createOfferUpdater, offerPresentation, homePresentation, homeStructuredData, founderSpotsText } from '../public/membership-offer.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const endpoint = 'https://synthetic.supabase.co/functions/v1/public-membership-offer';
const CENTS = { founding: 9900, earlybird: 14900, standard: 19900 };
const reply = (phase, patch = {}) => ({ schemaVersion: 1, phase, annualCents: CENTS[phase], checkoutEnabled: true, availability: 'available', bundleAvailable: phase !== 'founding', ...patch });
const STATIC_SPOTS = 'Limited to the first 100 founders';
const unescape = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A small element tree: enough for attribute selectors, hidden and textContent. */
function dom(html) {
  const VOID = new Set(['meta', 'link', 'img', 'source', 'br', 'input', 'hr']);
  const root = { tag: '#root', attrs: {}, children: [], hidden: false };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>|<\/(\w+)>|<(\w+)\b([^>]*)>|([^<]+)/g;
  const attrsOf = text => Object.fromEntries([...text.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']));
  for (let m; (m = re.exec(html));) {
    const top = stack[stack.length - 1];
    if (m[1]) top.children.push({ tag: m[1], attrs: attrsOf(m[2]), children: [{ text: m[3] }], raw: true });
    else if (m[4]) { if (stack.length > 1 && top.tag === m[4]) stack.pop(); }
    else if (m[5]) {
      const node = { tag: m[5], attrs: attrsOf(m[6]), children: [] };
      node.hidden = 'hidden' in node.attrs;
      top.children.push(node);
      if (!VOID.has(m[5]) && !/^!/.test(m[5])) stack.push(node);
    } else if (m[7] !== undefined) top.children.push({ text: m[7] });
  }
  const all = [];
  (function walk(node) { for (const child of node.children || []) if (child.tag) { all.push(child); walk(child); } })(root);
  for (const node of all) {
    Object.defineProperty(node, 'textContent', {
      get() { return node.children.map(child => child.tag ? child.textContent : node.raw ? child.text : unescape(child.text)).join(''); },
      set(value) { node.children = [{ text: String(value), literal: true }]; },
    });
  }
  const text = (node, out) => {
    for (const child of node.children || []) {
      if (!child.tag) out.push(child.literal ? child.text : unescape(child.text));
      else if (!child.hidden && child.tag !== 'script' && child.tag !== 'style' && child.tag !== 'head') text(child, out);
    }
    return out;
  };
  return {
    querySelectorAll: selector => {
      if (selector === 'script[type="application/ld+json"]') return all.filter(n => n.tag === 'script' && n.attrs.type === 'application/ld+json');
      const attr = selector.match(/^\[([\w-]+)\]$/)?.[1];
      return attr ? all.filter(n => attr in n.attrs) : [];
    },
    /** What a visitor can read: hidden elements, scripts and the head left out. */
    visible: () => text(root, []).join(' ').replace(/\s+/g, ' '),
    links: label => all.filter(n => n.tag === 'a' && n.textContent.trim() === label),
    structured: () => all.filter(n => n.tag === 'script' && n.attrs.type === 'application/ld+json').map(n => JSON.parse(n.textContent)),
  };
}

const page = async () => dom(renderPublicLaunch(await read('landing/index.html'), 'home'));
const paint = async (document, answer) => {
  const refresh = createOfferUpdater(document, endpoint, { fetchImpl: async () => { if (answer.current instanceof Error) throw answer.current; return Response.json(answer.current); } });
  await refresh();
  return refresh;
};
const spots = document => document.querySelectorAll('[data-founder-spots]').map(n => n.textContent);
const graph = document => document.structured().flatMap(item => item['@graph'] || [item]);
const LATER_PRICE = /\$\s?(?:149|199|245)\b/;
const OLD_LABEL = /create (?:your |an )?account|join for \$/i;

function assertFounderState(document, label) {
  const visible = document.visible();
  assert.match(visible, /Founder plan: \$99\/year, everything included/, label);
  assert.match(visible, /One plan\. Everything included\./, label);
  assert.match(visible, /DOs, MDs, NPs and PAs/, label);
  assert.doesNotMatch(visible, LATER_PRICE, label);
  assert.doesNotMatch(visible, OLD_LABEL, label);
  assert.doesNotMatch(visible, /The 100 Founder places are taken|Early bird|Standard Credential/, label);
  for (const node of document.querySelectorAll('[data-founder-only]')) assert.equal(node.hidden, false, label);
  for (const node of document.querySelectorAll('[data-after-founders]')) assert.equal(node.hidden, true, label);
  const offer = graph(document).find(item => item['@type'] === 'SoftwareApplication').offers;
  assert.deepEqual([offer.name, offer.price], ['Founder plan', '99'], label);
  assert.doesNotMatch(JSON.stringify(document.structured()), LATER_PRICE, label);
}

function assertSignupLinks(document, label) {
  assert.equal(document.links('Sign up today').length, 5, label);
  assert.equal(document.links('Sign up').length, 2, label);
  for (const link of [...document.links('Sign up today'), ...document.links('Sign up'), ...document.links('Log in')]) assert.equal(link.attrs.href, '/app/', label);
  assert.ok(document.links('Log in').length >= 3, label);
}

test('as printed, and with a founding reply, the page is the Founder plan with "Sign up today"', async () => {
  const printed = await page();
  assertFounderState(printed, 'printed');
  assertSignupLinks(printed, 'printed');
  assert.deepEqual(spots(printed), [STATIC_SPOTS, STATIC_SPOTS]);
  // What the live endpoint answers today: founding, no count.
  const live = await page();
  await paint(live, { current: reply('founding') });
  assertFounderState(live, 'founding');
  assertSignupLinks(live, 'founding');
  assert.deepEqual(spots(live), [STATIC_SPOTS, STATIC_SPOTS], 'no number without one from the server');
  assert.deepEqual(live.structured(), printed.structured(), 'structured data untouched');
  assert.equal(live.visible(), printed.visible(), 'nothing a visitor reads changes');
});

test('the founder count appears only as a whole number from 1 to 100 that the server sent', async () => {
  assert.equal(founderSpotsText(37), '37 of 100 founder spots left');
  const document = await page();
  const answer = { current: reply('founding', { founderSpotsLeft: 37 }) };
  const refresh = await paint(document, answer);
  assert.deepEqual(spots(document), ['37 of 100 founder spots left', '37 of 100 founder spots left']);
  assertFounderState(document, 'with a count');
  for (const bad of [0, 101, -1, 3.5, '37', null, true, [37]]) {
    answer.current = reply('founding', { founderSpotsLeft: bad }); await refresh();
    assert.deepEqual(spots(document), [STATIC_SPOTS, STATIC_SPOTS], `${JSON.stringify(bad)} is not believed`);
  }
  // A count is never kept once it cannot be confirmed, and never shown beside "temporarily unavailable".
  answer.current = reply('founding', { founderSpotsLeft: 12 }); await refresh();
  assert.deepEqual(spots(document), ['12 of 100 founder spots left', '12 of 100 founder spots left']);
  answer.current = Error('offline'); await refresh();
  assert.deepEqual(spots(document), [STATIC_SPOTS, STATIC_SPOTS]);
  answer.current = reply('founding', { founderSpotsLeft: 12, availability: 'temporarily_full' }); await refresh();
  assert.deepEqual(spots(document), [STATIC_SPOTS, STATIC_SPOTS]);
});

test('paused and temporarily full keep the Founder plan and say so in sign up wording', async () => {
  const document = await page();
  const status = () => document.querySelectorAll('[data-home-status]').map(n => n.textContent);
  assert.deepEqual(status(), ['Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.']);
  const answer = { current: reply('founding', { availability: 'temporarily_full' }) };
  const refresh = await paint(document, answer);
  assert.deepEqual(status(), ['Founder plan checkout is temporarily unavailable. Signing up does not reserve a place.']);
  assertFounderState(document, 'temporarily full');
  answer.current = reply('founding', { availability: 'paused', checkoutEnabled: false }); await refresh();
  assert.deepEqual(status(), ['Paid checkout is paused, so no payment is taken now. If you sign up today, your account opens when checkout reopens and your payment completes.']);
  assertFounderState(document, 'paused');
  assertSignupLinks(document, 'paused');
});

test('once a validated reply says founding is over, the page shows that plan and no longer offers $99', async () => {
  for (const phase of ['earlybird', 'standard']) {
    const document = await page();
    const answer = { current: reply(phase) };
    const refresh = await paint(document, answer);
    const name = phase === 'earlybird' ? 'Early bird' : 'Standard';
    const price = `$${CENTS[phase] / 100}`;
    const visible = document.visible();
    for (const node of document.querySelectorAll('[data-founder-only]')) assert.equal(node.hidden, true, phase);
    for (const node of document.querySelectorAll('[data-after-founders]')) assert.equal(node.hidden, false, phase);
    assert.ok(visible.includes(`${name} Credential: ${price}/year`), `${phase}: the live plan is stated`);
    assert.ok(visible.includes('The 100 Founder places are taken.'), phase);
    assert.ok(visible.includes(offerPresentation(reply(phase)).rateNote), phase);
    assert.ok(visible.includes('Credential + Practice is $245/year total at first purchase, with no early bird discount.'), phase);
    assert.doesNotMatch(visible, /Founder plan|One plan\. Everything included|first 100 founders|keep this price for life/, phase);
    // The only $99 left is the earlier free-beta promise, which those members keep.
    const still99 = visible.split(/(?<=[.!?])\s+/).filter(x => /\$99/.test(x) && !/opt in to \$99\/year Credential during the beta/.test(x));
    assert.deepEqual(still99, [], phase);
    assert.doesNotMatch(visible, OLD_LABEL, phase);
    assertSignupLinks(document, phase);
    assert.deepEqual(spots(document).filter(text => /\d+ of 100/.test(text)), [], phase);
    // Structured data follows, from the page's original text.
    const offer = graph(document).find(item => item['@type'] === 'SoftwareApplication').offers;
    assert.deepEqual([offer.name, offer.price, offer.priceCurrency], [`${name} Credential`, String(CENTS[phase] / 100), 'USD'], phase);
    const cost = graph(document).find(item => item['@type'] === 'FAQPage').mainEntity.find(item => item.name === 'How much does it cost?').acceptedAnswer.text;
    assert.equal(cost, `${offerPresentation(reply(phase)).rateNote} Card required at checkout.`, phase);
    assert.doesNotMatch(JSON.stringify(graph(document).filter(item => ['SoftwareApplication', 'FAQPage'].includes(item['@type']))), /\$99|"99"|Founder plan|first 100/, phase);
    // A network failure must not turn an observed later phase back into the $99 Founder plan.
    answer.current = Error('offline'); await refresh();
    assert.ok(document.visible().includes(`${name} Credential: ${price}/year`), `${phase}: kept while unconfirmed`);
    for (const node of document.querySelectorAll('[data-founder-only]')) assert.equal(node.hidden, true, `${phase} offline`);
    // And founding, if the server says so again, is the printed page again.
    answer.current = reply('founding'); await refresh();
    assertFounderState(document, `${phase} then founding`);
  }
});

test('a reply that fails validation, or no reply, leaves the page as printed', async () => {
  const printed = (await page()).visible();
  for (const current of [Error('offline'), reply('founding', { annualCents: 14900 }), reply('earlybird', { annualCents: 9900 }), reply('earlybird', { bundleAvailable: false }),
    { ...reply('standard'), schemaVersion: 2 }, reply('earlybird', { availability: 'temporarily_full' }), { phase: 'soldout' }, 'Create your account']) {
    const document = await page();
    await paint(document, { current });
    assert.equal(document.visible(), printed, JSON.stringify(current instanceof Error ? current.message : current));
    assertFounderState(document, 'refused reply');
  }
});

test('the home view of an offer never carries the app button\'s label or a price the reply did not validate', () => {
  for (const phase of Object.keys(CENTS)) {
    for (const patch of [{}, { availability: 'paused', checkoutEnabled: false }]) {
      const home = homePresentation(offerPresentation(reply(phase, patch)));
      assert.doesNotMatch(Object.values(home).join(' '), OLD_LABEL, phase);
      if (phase === 'founding') assert.doesNotMatch(Object.values(home).join(' '), LATER_PRICE);
      else assert.equal(home.price, `$${CENTS[phase] / 100}`);
    }
  }
  const original = JSON.stringify({ '@graph': [{ '@type': 'SoftwareApplication', offers: { '@type': 'Offer', name: 'Founder plan', price: '99' } }] });
  assert.equal(homeStructuredData(original, offerPresentation(reply('founding'))), original);
  assert.equal(homeStructuredData('not json', offerPresentation(reply('earlybird'))), 'not json');
  // A page without the unified home's graph (every other page) is left alone.
  const other = JSON.stringify({ '@type': 'FAQPage', mainEntity: [] });
  assert.equal(homeStructuredData(other, offerPresentation(reply('earlybird'))), other);
});

test('the page keeps its beacon, https switch, canonical address, founder section and the promises made earlier', async () => {
  const source = await read('landing/index.html');
  const output = renderPublicLaunch(source, 'home');
  assert.match(output, /<script id="https-redirect">/);
  assert.equal(output.split("navigator.sendBeacon('/api/pv'").length, 2, 'one visit beacon');
  assert.match(output, /<link rel="canonical" href="https:\/\/credentialdomd\.com\/">/);
  assert.match(output, /<meta name="robots" content="index, follow, max-image-preview:large">/);
  assert.match(output, /<title>CredentialDOMD \| License &amp; CME Tracking for DOs, MDs, NPs and PAs<\/title>/);
  assert.match(output, /<meta name="google-site-verification" content="oOvY112WjVU0IZcRGgx9cbKIpe1CFoiXG7bXDgK4sX4">/);
  assert.doesNotMatch(output, /noindex|Preview for Dr\. Whitney|founder-spots\.js|supabase\.co/, 'no preview leftovers and no hard-coded endpoint');
  // The founder section from 7d2e9922: same anchor, same portrait files, same alt text.
  const founder = output.slice(output.indexOf('<section class="founder" id="founder"'), output.indexOf('<section class="alt" id="pricing">'));
  assert.match(founder, /srcset="\/images\/eric-whitney-formal-square-400\.webp 400w, \/images\/eric-whitney-formal-square-800\.webp 800w"/);
  assert.match(founder, /alt="Dr\. Eric Whitney, DO"/);
  assert.doesNotMatch(founder, /physicians first/);
  // Promises the previous home page made stay on the page.
  const visible = dom(output).visible();
  for (const promise of ['CredentialDOMD is an early release. Some workflows are less polished',
    'Founding members help shape what comes next.',
    'request a full refund of your most recent annual membership payment, including a renewal payment, at any time. There is no request deadline or prorating.',
    'You do not need to delete your account, saved records or reports to request a refund.',
    'Eligible people who signed up under the earlier free-beta wording receive 30 days free with no card',
    'If you never opt in, there is no automatic charge and nothing to cancel.',
    'keep Credential and Practice free for life',
    'It is not primary source verification.']) assert.ok(visible.includes(promise), promise);
  assert.match(output, /href="\/privacy"/); assert.match(output, /href="\/terms"/); assert.match(output, /href="\/security"/);
  assert.match(output, /mailto:support@credentialdomd\.com/);
  // No uppercase styling anywhere a credential abbreviation could be shown.
  assert.doesNotMatch(await read('public/unified.css'), /text-transform/);
});
