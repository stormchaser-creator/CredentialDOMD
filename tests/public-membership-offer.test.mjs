import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicOffer, offerPresentation, createOfferUpdater } from '../public/membership-offer.js';
import { publicMembershipEndpoint, renderPublicLaunch } from '../scripts/public-launch-render.mjs';
import { readFile } from 'node:fs/promises';

const endpoint = 'https://synthetic.supabase.co/functions/v1/public-membership-offer';
const offer = (phase = 'founding', availability = 'available') => ({schemaVersion:1, phase,
  annualCents:{founding:9900,earlybird:14900,standard:19900}[phase], checkoutEnabled:availability !== 'paused', availability});
const deferred = () => { let resolve; return {promise:new Promise(done => {resolve=done;}),resolve}; };
const root = () => {
  const actions = [{textContent:'Membership signup'}], statuses = [{textContent:'Your offer is confirmed before payment. Creating an account does not reserve a founding place.'}];
  const nodes = Object.fromEntries(['headline','price','price-label','heading','phase','review-action','hero-headline','hero-note'].map(key=>[key,[{textContent:''}]]));
  return {actions,statuses,nodes,querySelectorAll:selector=>selector === '[data-membership-action]' ? actions
    : selector === '[data-membership-status]' ? statuses : nodes[selector.slice(17,-1)] || []};
};

test('each current-offer element follows all phases and later failures retain the last validated price', async () => {
  const dom=root();let current=offer();
  const refresh=createOfferUpdater(dom,endpoint,{fetchImpl:async()=>Response.json(current)});
  for (const phase of ['founding','earlybird','standard']) {
    current=offer(phase);await refresh();
    const label=phase==='founding'?'Founding':phase==='earlybird'?'Early-bird':'Standard';
    assert.equal(dom.nodes.price[0].textContent,`$${current.annualCents/100}`);
    assert.match(dom.nodes.headline[0].textContent,new RegExp(label));
    assert.equal(dom.nodes.heading[0].textContent,'Create your account');
    assert.equal(dom.nodes.phase[0].textContent,`${label} membership`);
    assert.equal(dom.nodes['price-label'][0].textContent,` / year, ${label.toLowerCase()} Credential`);
    if(phase!=='founding') assert.doesNotMatch(JSON.stringify(dom.nodes),/\$99|first 100/);
  }
  current={};await refresh();
  assert.equal(dom.nodes.price[0].textContent,'$199');
  assert.match(dom.nodes.headline[0].textContent,/Standard Credential: \$199\/year/);
  assert.match(dom.statuses[0].textContent,/confirmed before payment/i);
  assert.doesNotMatch(JSON.stringify(dom.nodes), /\$99|first 100/);
});

test('public phase updates use only validated annual prices and distinguish capacity holds from a sales pause', () => {
  for (const [phase,amount] of [['founding',99],['earlybird',149],['standard',199]]) {
    assert.equal(offerPresentation(offer(phase)).action, 'Create your account');
    assert.match(offerPresentation(offer(phase)).reviewAction, new RegExp(amount));
  }
  assert.match(offerPresentation(offer('founding','temporarily_full')).status, /temporarily unavailable/);
  assert.match(offerPresentation(offer('earlybird','paused')).status, /checkout is paused/);
  for (const patch of [{schemaVersion:2},{phase:'<img src=x>'},{annualCents:1},{annualCents:14900},
    {checkoutEnabled:'true'},{availability:'unknown'},{checkoutEnabled:false},{availability:'paused'},
    {phase:'earlybird',annualCents:14900,availability:'temporarily_full'}]) {
    assert.throws(()=>offerPresentation({...offer(),...patch}));
  }
});

test('a verified pause retains the actual phase and price instead of hiding them behind login', async () => {
  for (const [phase, price] of [['founding','$99'], ['earlybird','$149'], ['standard','$199']]) {
    const dom = root();
    await createOfferUpdater(dom, endpoint, { fetchImpl: async () => Response.json(offer(phase, 'paused')) })();
    assert.equal(dom.nodes.price[0].textContent, price);
    assert.ok(dom.nodes['hero-headline'][0].textContent.includes(`${price}/year`));
    assert.match(dom.statuses[0].textContent, /Paid checkout is paused/);
    assert.match(dom.statuses[0].textContent, /no payment will be taken/);
    assert.equal(dom.actions[0].textContent, 'Create your account');
    if (phase === 'founding') assert.equal(dom.nodes['review-action'][0].textContent, 'See the $99 founding plan');
    else assert.doesNotMatch(JSON.stringify(dom.nodes), /\$99|first 100|founding/i);
  }
  const held = offerPresentation(offer('founding', 'temporarily_full'));
  assert.equal(held.price, '$99');
  assert.match(held.status, /temporarily unavailable/);
  assert.match(held.status, /does not reserve/);
  assert.doesNotMatch(held.status, /spots left|places remaining|available now/i);
});

test('public GET sends no identity or authorization and never caches or redirects', async () => {
  let request;
  const result = await fetchPublicOffer(endpoint,{fetchImpl:async(...args)=>{request=args;return Response.json(offer());}});
  assert.match(result.status,/does not reserve a founding place/);
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

test('unknown configuration uses qualified founding policy, while a later failure preserves the verified phase', async () => {
  const dom=root();let calls=0;
  const refresh=createOfferUpdater(dom,endpoint,{fetchImpl:async()=>{calls++;return calls===1?Response.json(offer('earlybird')):Response.json({}, {status:503});}});
  await refresh();assert.match(dom.nodes['review-action'][0].textContent,/149/);
  await refresh();assert.equal(dom.actions[0].textContent,'Create your account');
  assert.equal(dom.nodes.price[0].textContent, '$149');
  assert.equal(dom.statuses[0].textContent,'Your offer is confirmed before payment. Creating an account does not reserve a founding place.');
  await createOfferUpdater(dom,undefined,{fetchImpl:()=>{throw Error('Must not fetch');}})();
  assert.equal(dom.statuses[0].textContent,'Your offer is confirmed before payment. Creating an account does not reserve a founding place.');
  assert.equal(dom.nodes.price[0].textContent, '$99');
  assert.match(dom.nodes.headline[0].textContent, /First 100 paid founding memberships/);
});

test('later-phase prices never flash back to $99 during a slow or failed refresh', async () => {
  for (const phase of ['earlybird', 'standard']) {
    const dom = root(), waiting = deferred(); let calls = 0;
    const refresh = createOfferUpdater(dom, endpoint, { fetchImpl: () => ++calls === 1 ? Promise.resolve(Response.json(offer(phase))) : waiting.promise });
    await refresh();
    const expected = dom.nodes.price[0].textContent;
    const pending = refresh();
    assert.equal(dom.nodes.price[0].textContent, expected, 'the in-flight view retains the last validated phase');
    assert.match(dom.statuses[0].textContent, /confirmed before payment/i);
    assert.doesNotMatch(JSON.stringify(dom.nodes), /\$99|first 100/);
    waiting.resolve(Response.json({}, { status: 503 }));
    await pending;
    assert.equal(dom.nodes.price[0].textContent, expected);
    assert.match(dom.statuses[0].textContent, /confirmed before payment/i);
    assert.doesNotMatch(JSON.stringify(dom.nodes), /\$99|first 100/);
  }
});

test('a stale earlier public response cannot replace a later phase and all rendering uses text', async () => {
  const first=deferred(),dom=root();let count=0;
  const refresh=createOfferUpdater(dom,endpoint,{fetchImpl:()=>++count===1?first.promise:Promise.resolve(Response.json(offer('earlybird')))});
  const old=refresh();await refresh();first.resolve(Response.json(offer()));await old;
  assert.equal(dom.nodes['review-action'][0].textContent,'See the $149/year plan');
  assert.equal(Object.hasOwn(dom.actions[0],'innerHTML'),false);
});

test('packaging config allows only the exact public endpoint and CSP permits only that new connection', async () => {
  assert.equal(publicMembershipEndpoint('https://synthetic.supabase.co'),endpoint);
  assert.equal(publicMembershipEndpoint(undefined),null);
  for (const url of ['http://synthetic.supabase.co','https://evil.invalid','https://synthetic.supabase.co/path','https://user@synthetic.supabase.co','https://synthetic.supabase.co?key=secret']) assert.throws(()=>publicMembershipEndpoint(url));
  const source=await readFile(new URL('../landing/cme.html',import.meta.url),'utf8');
  const html=renderPublicLaunch(source,'cme',undefined,{offerEndpoint:endpoint});
  assert.ok(html.includes(`connect-src ${endpoint};`));
  assert.ok(html.includes(`data-membership-endpoint="${endpoint}"`));
  assert.equal((html.match(/src="\/membership-offer.js"/g)||[]).length,1);
});
