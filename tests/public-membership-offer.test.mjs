import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicOffer, offerPresentation, sitePresentation, createOfferUpdater } from '../public/membership-offer.js';
import { publicMembershipEndpoint, renderPublicLaunch } from '../scripts/public-launch-render.mjs';
import { readFile } from 'node:fs/promises';

const endpoint = 'https://synthetic.supabase.co/functions/v1/public-membership-offer';
const offer = (phase = 'founding', availability = 'available') => ({schemaVersion:1, phase,
  annualCents:{founding:9900,earlybird:14900}[phase], checkoutEnabled:availability !== 'paused', availability});
// Owner decisions 2026-11-13: $99 Founder plan while founder places remain,
// then Credential $149 and Credential + Practice $245. Nothing the site
// paints, in any phase or failure, names the removed $199 tier.
const REMOVED_TIER = /\$199|standard|early ?bird/i;
const SOLD_OUT = 'Credential: $149/year. Credential + Practice: $245/year';
const deferred = () => { let resolve; return {promise:new Promise(done => {resolve=done;}),resolve}; };
const root = () => {
  const actions = [{textContent:'Membership signup'}], statuses = [{textContent:'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.'}];
  const nodes = Object.fromEntries(['headline','price','price-label','heading','phase','review-action','hero-headline','hero-note','rate','bundle-label'].map(key=>[key,[{textContent:''}]]));
  const founderOnly = [{hidden:false}], afterFounders = [{hidden:true}];
  return {actions,statuses,nodes,founderOnly,afterFounders,querySelectorAll:selector=>selector === '[data-membership-action]' ? actions
    : selector === '[data-founder-only]' ? founderOnly : selector === '[data-after-founders]' ? afterFounders
    : selector === '[data-membership-status]' ? statuses : nodes[selector.slice(17,-1)] || []};
};

test('the site paints the Founder plan while founder places remain, then the two plans; a later failure keeps them', async () => {
  const dom=root();let current=offer();
  const refresh=createOfferUpdater(dom,endpoint,{fetchImpl:async()=>Response.json(current)});
  await refresh();
  assert.equal(dom.nodes.price[0].textContent,'$99');
  assert.equal(dom.nodes['price-label'][0].textContent,' / year');
  assert.equal(dom.nodes.headline[0].textContent,'Founder plan: $99/year, everything included');
  assert.equal(dom.nodes['hero-headline'][0].textContent,'Founder plan: $99/year, everything included');
  assert.equal(dom.nodes.heading[0].textContent,'Sign up today');
  assert.equal(dom.nodes.phase[0].textContent,'Founder plan');
  assert.match(dom.nodes.rate[0].textContent,/^One plan with everything included, for the first 100 paid members\./);
  assert.equal(dom.nodes['bundle-label'][0].textContent,'', 'no package label is painted');
  assert.deepEqual([dom.founderOnly[0].hidden,dom.afterFounders[0].hidden],[false,true],'the Founder card shows, the two plan cards stay hidden');
  assert.doesNotMatch(JSON.stringify(dom), /\$149|\$245/, 'no later price while founder places remain');
  assert.doesNotMatch(JSON.stringify(dom), REMOVED_TIER);
  // The server reports the founders are sold out.
  current=offer('earlybird');await refresh();
  assert.deepEqual([dom.founderOnly[0].hidden,dom.afterFounders[0].hidden],[true,false],'the two plan cards replace the Founder card');
  assert.equal(dom.nodes.headline[0].textContent,SOLD_OUT);
  assert.equal(dom.nodes['hero-headline'][0].textContent,SOLD_OUT);
  assert.equal(dom.nodes['hero-note'][0].textContent,'The 100 Founder places are taken. Credential includes a 30 day Practice trial.');
  assert.equal(dom.nodes.phase[0].textContent,'Membership');
  assert.equal(dom.nodes.rate[0].textContent,'Credential is $149/year with one 30 day Practice trial when your first annual payment is confirmed. Credential + Practice is $245/year. The app confirms your offer before you choose to pay.');
  assert.doesNotMatch(JSON.stringify(dom), /\$99|first 100/, 'no sentence still offers the Founder price');
  assert.doesNotMatch(JSON.stringify(dom), REMOVED_TIER);
  assert.deepEqual([...new Set(JSON.stringify(dom).match(/\$\d+/g))].sort(), ['$149','$245'], 'the only two prices');
  current={};await refresh();
  assert.equal(dom.nodes.headline[0].textContent,SOLD_OUT, 'a later failure keeps the sold-out state');
  assert.deepEqual([dom.founderOnly[0].hidden,dom.afterFounders[0].hidden],[true,false]);
  assert.doesNotMatch(JSON.stringify(dom), /\$99|\$199/);
});

test('public phase updates use only validated annual prices and distinguish capacity holds from a sales pause', () => {
  for (const [phase,amount] of [['founding',99],['earlybird',149]]) {
    // Funnel 2026-10-14: the signup button names the live annual price.
    assert.equal(offerPresentation(offer(phase)).action, `Join for $${amount} a year`);
    assert.equal(offerPresentation(offer(phase)).renewal, `$${amount} at checkout, then $${amount} each year while this subscription remains active. Cancel before renewal to avoid the next annual charge.`);
    assert.match(offerPresentation(offer(phase)).reviewAction, new RegExp(amount));
  }
  assert.match(offerPresentation(offer('founding','temporarily_full')).status, /temporarily unavailable/);
  // No price button or renewal line when nothing can be paid today.
  assert.equal(offerPresentation(offer('founding','temporarily_full')).action, 'Create your account');
  assert.equal(offerPresentation(offer('founding','temporarily_full')).renewal, null);
  assert.equal(offerPresentation(offer('earlybird','paused')).renewal, null);
  assert.match(offerPresentation(offer('earlybird','paused')).status, /checkout is paused/);
  // The removed $199 tier is refused by name and by amount: nothing is painted from it.
  for (const patch of [{schemaVersion:2},{phase:'<img src=x>'},{annualCents:1},{annualCents:14900},{phase:'standard',annualCents:19900},{phase:'earlybird',annualCents:19900},{annualCents:19900},
    {checkoutEnabled:'true'},{availability:'unknown'},{checkoutEnabled:false},{availability:'paused'},
    {phase:'earlybird',annualCents:14900,availability:'temporarily_full'}]) {
    assert.throws(()=>offerPresentation({...offer(),...patch}));
  }
});

test('a verified pause keeps the right plans on the page and says checkout is paused', async () => {
  for (const phase of ['founding', 'earlybird']) {
    const dom = root();
    await createOfferUpdater(dom, endpoint, { fetchImpl: async () => Response.json(offer(phase, 'paused')) })();
    assert.match(dom.statuses[0].textContent, /Paid checkout is paused/);
    // PUBLIC-001: a paused account is held until checkout reopens, and the page says so.
    assert.match(dom.statuses[0].textContent, /If you sign up today, your account opens when checkout reopens and your payment completes\./);
    assert.equal(dom.actions[0].textContent, 'Sign up today');
    if (phase === 'founding') {
      assert.equal(dom.nodes.price[0].textContent, '$99');
      assert.equal(dom.nodes['review-action'][0].textContent, 'See the Founder plan');
      assert.equal(dom.afterFounders[0].hidden, true);
    } else {
      assert.equal(dom.nodes['hero-headline'][0].textContent, SOLD_OUT);
      assert.equal(dom.afterFounders[0].hidden, false);
      assert.doesNotMatch(JSON.stringify(dom), /\$99/);
    }
    assert.doesNotMatch(JSON.stringify(dom), REMOVED_TIER);
  }
  const held = offerPresentation(offer('founding', 'temporarily_full'));
  assert.equal(held.price, '$99');
  assert.match(held.status, /temporarily unavailable/);
  assert.match(held.status, /does not reserve/);
  assert.doesNotMatch(held.status, /spots left|places remaining|available now/i);
  const site = sitePresentation(held);
  assert.equal(site.status, 'Founder plan checkout is temporarily unavailable. Signing up does not reserve a place.');
  assert.equal(site.action, 'Sign up today');
});

test('public GET sends no identity or authorization and never caches or redirects', async () => {
  let request;
  const result = await fetchPublicOffer(endpoint,{fetchImpl:async(...args)=>{request=args;return Response.json(offer());}});
  assert.match(result.status,/Your account opens when payment completes/);
  assert.match(result.status,/100% money back guarantee/);
  assert.doesNotMatch(result.status,/[-\u2013\u2014]/, "public copy carries no hyphen or dash");
  assert.doesNotMatch(result.status,/Creating an account/);
  assert.equal(request[0],endpoint);
  assert.deepEqual(request[1].headers,{Accept:'application/json'});
  for (const [key,value] of Object.entries({method:'GET',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})) assert.equal(request[1][key],value);
  assert.equal(request[1].body,undefined);
});

test('fetch and stalled or oversized bodies are bounded, with no success from HTML or HTTP errors', async () => {
  for (const fetchImpl of [()=>new Promise(()=>{}),async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}}),
    async()=>new Response('x'.repeat(2049),{headers:{'content-type':'application/json'}}),
    async()=>new Response('<html>OK</html>'),async()=>Response.json(offer(),{status:503})]) {
    await assert.rejects(fetchPublicOffer(endpoint,{fetchImpl,timeoutMs:10}));
  }
});

test('unknown configuration shows the Founder plan, while a later failure preserves a verified sold-out state', async () => {
  const dom=root();let calls=0;
  const refresh=createOfferUpdater(dom,endpoint,{fetchImpl:async()=>{calls++;return calls===1?Response.json(offer('earlybird')):Response.json({}, {status:503});}});
  await refresh();assert.equal(dom.nodes['review-action'][0].textContent,'See membership plans');
  await refresh();assert.equal(dom.actions[0].textContent,'Sign up today');
  assert.equal(dom.nodes.headline[0].textContent, SOLD_OUT);
  assert.equal(dom.afterFounders[0].hidden, false);
  assert.equal(dom.statuses[0].textContent,'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.');
  // No endpoint, a refused reply (the removed tier) or no network: the page stays as printed, the Founder plan.
  for (const fetchImpl of [null, async()=>Response.json({...offer('earlybird'),phase:'standard',annualCents:19900}), async()=>{throw Error('offline');}]) {
    const fresh=root();
    await createOfferUpdater(fresh,fetchImpl?endpoint:undefined,{fetchImpl:fetchImpl||(()=>{throw Error('Must not fetch');})})();
    assert.equal(fresh.statuses[0].textContent,'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.');
    assert.equal(fresh.nodes.price[0].textContent, '$99');
    assert.equal(fresh.nodes.headline[0].textContent, 'Founder plan: $99/year, everything included');
    assert.deepEqual([fresh.founderOnly[0].hidden,fresh.afterFounders[0].hidden],[false,true]);
    assert.doesNotMatch(JSON.stringify(fresh), /\$149|\$199|\$245/);
  }
});

test('a sold-out Founder plan never flashes back to $99 during a slow or failed refresh', async () => {
  const dom = root(), waiting = deferred(); let calls = 0;
  const refresh = createOfferUpdater(dom, endpoint, { fetchImpl: () => ++calls === 1 ? Promise.resolve(Response.json(offer('earlybird'))) : waiting.promise });
  await refresh();
  const pending = refresh();
  assert.equal(dom.nodes.headline[0].textContent, SOLD_OUT, 'the in-flight view retains the last validated state');
  assert.match(dom.statuses[0].textContent, /confirmed before payment/i);
  assert.doesNotMatch(JSON.stringify(dom), /\$99|first 100/);
  waiting.resolve(Response.json({}, { status: 503 }));
  await pending;
  assert.equal(dom.nodes.headline[0].textContent, SOLD_OUT);
  assert.equal(dom.afterFounders[0].hidden, false);
  assert.doesNotMatch(JSON.stringify(dom), /\$99|first 100/);
});

test('a stale earlier public response cannot replace a later phase and all rendering uses text', async () => {
  const first=deferred(),dom=root();let count=0;
  const refresh=createOfferUpdater(dom,endpoint,{fetchImpl:()=>++count===1?first.promise:Promise.resolve(Response.json(offer('earlybird')))});
  const old=refresh();await refresh();first.resolve(Response.json(offer()));await old;
  assert.equal(dom.nodes['review-action'][0].textContent,'See membership plans');
  assert.equal(dom.nodes.headline[0].textContent,SOLD_OUT);
  assert.equal(Object.hasOwn(dom.actions[0],'innerHTML'),false);
});

test('packaging config allows only the exact public endpoint and CSP permits only that new connection', async () => {
  assert.equal(publicMembershipEndpoint('https://synthetic.supabase.co'),endpoint);
  assert.equal(publicMembershipEndpoint(undefined),null);
  for (const url of ['http://synthetic.supabase.co','https://evil.invalid','https://synthetic.supabase.co/path','https://user@synthetic.supabase.co','https://synthetic.supabase.co?key=secret']) assert.throws(()=>publicMembershipEndpoint(url));
  const source=await readFile(new URL('../landing/cme.html',import.meta.url),'utf8');
  const html=renderPublicLaunch(source,'cme',undefined,{offerEndpoint:endpoint});
  // The page's own origin is there for its visit beacon (POST /api/pv, scripts/visit-beacon.mjs); nothing else.
  assert.ok(html.includes(`connect-src 'self' ${endpoint};`));
  assert.ok(html.includes(`data-membership-endpoint="${endpoint}"`));
  assert.equal((html.match(/src="\/membership-offer.js"/g)||[]).length,1);
});

test('a page view asks for the offer once, and only a back forward cache restore asks again', async () => {
  // The page bootstrap runs at import, so it is loaded fresh against stub page globals.
  const listeners = {}, calls = [];
  const saved = Object.fromEntries(['document', 'window', 'fetch', 'setInterval'].map(key => [key, globalThis[key]]));
  globalThis.window = { addEventListener: (type, listener) => { (listeners[`window:${type}`] ||= []).push(listener); } };
  globalThis.document = {
    visibilityState: 'visible',
    querySelector: selector => selector === 'script[data-membership-endpoint]' ? { dataset: { membershipEndpoint: endpoint } } : null,
    querySelectorAll: () => [],
    addEventListener: (type, listener) => { (listeners[`document:${type}`] ||= []).push(listener); },
  };
  globalThis.fetch = async url => { calls.push(url); return Response.json(offer()); };
  globalThis.setInterval = () => 0;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    await import(`../public/membership-offer.js?page-bootstrap=${Date.now()}`);
    await settle();
    assert.deepEqual(calls, [endpoint], 'the page asks once when it loads');
    // Browsers fire pageshow with persisted false on every first load, after the module ran.
    for (const listener of listeners['window:pageshow']) listener({ persisted: false });
    await settle();
    assert.equal(calls.length, 1, 'the first load pageshow does not send a second request');
    for (const listener of listeners['window:pageshow']) listener({ persisted: true });
    await settle();
    assert.equal(calls.length, 2, 'a page restored from the back forward cache asks again');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('every signup button on the site says "Sign up today" in every state, and never a price', async () => {
  const dom = root(); let current = offer();
  const refresh = createOfferUpdater(dom, endpoint, { fetchImpl: async () => { if (current instanceof Error) throw current; return Response.json(current); } });
  for (const next of [offer(), Error('offline'), offer('founding', 'temporarily_full'), offer('earlybird'), Error('offline'), offer('earlybird', 'paused')]) {
    current = next; await refresh();
    assert.equal(dom.actions[0].textContent, 'Sign up today');
    assert.equal(dom.nodes.heading[0].textContent, 'Sign up today');
    assert.doesNotMatch(dom.statuses[0].textContent, /[Cc]reat(?:e|ing) (?:an|your) account|account you create/);
  }
  // The app's sign up screen still reads the live price from the same module (src/utils/authOffer.js).
  assert.equal(offerPresentation(offer('earlybird')).action, 'Join for $149 a year');
  // The static page's own label before any answer (scripts/public-launch-render.mjs) is the plain one.
  const html = renderPublicLaunch(await readFile(new URL('../landing/index.html', import.meta.url), 'utf8'), 'home');
  assert.doesNotMatch(html, /Join for \$\d+/, 'no price is hardcoded on a button');
});
