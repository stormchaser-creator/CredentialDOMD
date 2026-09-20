import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITED_LAUNCH, limitedOffer, limitedOffers, assertLimitedPrice } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';
import { prepareLimitedCatalog } from '../../scripts/prepare-limited-stripe-catalog.mjs';
import { createAccessPolicyHandler } from '../../supabase/functions/_shared/accessPolicyHandler.mjs';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { BILLING_CATALOG } from '../../supabase/functions/_shared/billingCatalog.mjs';

const config = { ...LIMITED_LAUNCH, billingEnabled: true, checkoutEnabled: true, invitationEnabled: true, productIds: { core:'prod_Credential',core_locum:'prod_Bundle' } };
const now = Date.parse('2026-09-19T18:00:00Z');
const request = (body = { offerId:'core' }, webhook = false) => new Request('https://functions.example', { method:'POST', headers:{'content-type':'application/json', ...(webhook ? {'stripe-signature':'synthetic'}:{})}, body:JSON.stringify(body) });
const paidRequest = (patch={}) => request({quoteId:'10000000-0000-4000-8000-000000000003',consentHash:'a'.repeat(64),consent:true,...patch});
function fixture(offerId='core',phase='founding') {
  const calls=[];
  const profile={id:'10000000-0000-4000-8000-000000000001',auth_user_id:'user_a',access_status:'pending',deleted_at:null};
  const offer=limitedOffer(offerId,phase,config.productIds);
  const product={id:offer.productId,active:true,livemode:false,metadata:{app:config.app,offer_id:offerId,pricing_policy_version:config.policyVersion,catalog_version:config.version}};
  const price={id:'price_Annual',product,active:true,livemode:false,currency:'usd',unit_amount:offer.unitAmount,type:'recurring',recurring:{interval:'year',interval_count:1,usage_type:'licensed'},lookup_key:offer.lookupKey,billing_scheme:'per_unit'};
  const account={profile_id:profile.id,livemode:false,stripe_customer_id:'cus_A'};
  const q={attempt_id:'10000000-0000-4000-8000-000000000002',profile_id:profile.id,clerk_subject:profile.auth_user_id,livemode:false,offer_id:offerId,price_phase:offer.pricePhase,annual_cents:offer.unitAmount,policy_version:config.policyVersion,price_id:price.id,product_id:product.id,created_at:new Date(now).toISOString()};
  const preview={...q,id:'10000000-0000-4000-8000-000000000003',consent_version:'terms1',consent_hash:'a'.repeat(64),consent_text:'Synthetic terms',expires_at:new Date(now+1800000).toISOString()};
  const eligibility={state:'eligible',checkout_enabled:true,price_phase:phase,expires_at:'2026-09-29T18:00:00Z'};
  const sub={id:'sub_A',customer:account.stripe_customer_id,livemode:false,status:'active',latest_invoice:'in_A',current_period_end:Math.floor(now/1000)+31536000,items:{data:[{quantity:1,price}]},metadata:{app:config.app,profile_id:profile.id,clerk_user_id:profile.auth_user_id,offer_id:offerId,catalog_version:config.version,pricing_policy_version:config.policyVersion,price_phase:offer.pricePhase,checkout_attempt_id:q.attempt_id}};
  const invoice={id:'in_A',customer:account.stripe_customer_id,subscription:sub.id,livemode:false,status:'paid',paid:true,billing_reason:'subscription_create',currency:'usd',amount_paid:offer.unitAmount,amount_due:offer.unitAmount,amount_remaining:0,total_discount_amounts:[],status_transitions:{paid_at:now/1000},lines:{has_more:false,data:[{price:price.id,quantity:1,amount:offer.unitAmount}]}};
  const event={id:'evt_A',created:now/1000,livemode:false,type:'invoice.paid',data:{object:{subscription:sub.id}}};
  const stripe={
    prices:{list:async()=>({data:[price],has_more:false}),retrieve:async()=>structuredClone(price)},
    customers:{retrieve:async()=>({id:account.stripe_customer_id,livemode:false,metadata:{app:config.app,profile_id:profile.id,clerk_user_id:profile.auth_user_id}}),create:async(...args)=>{calls.push(['customer',...args]);return{id:'cus_A',livemode:false};}},
    subscriptions:{list:async()=>({data:[],has_more:false}),retrieve:async()=>structuredClone(sub)},
    invoices:{retrieve:async()=>structuredClone(invoice)},
    checkout:{sessions:{create:async(...args)=>{calls.push(['checkout',...args]);return{id:'cs_A',livemode:false,url:'https://checkout.stripe.com/c/synthetic'};}}},
  };
  const deps={mode:'test',now:()=>now,assertConfigured:()=>{},authenticate:async()=>({profileId:profile.id,clerkSubject:'user_a'}),verifiedEmails:async()=>['member@example.invalid'],stripe:()=>stripe,verifyEvent:async()=>event,
    store:{profile:async()=>profile,previewById:async()=>preview,createPreview:async(id,subject,live,offerId)=>({...preview,offer_id:offerId,price_phase:offerId==='core_locum'?'standard':eligibility.price_phase,annual_cents:limitedOffer(offerId,eligibility.price_phase,config.productIds).unitAmount}),eligibility:async()=>eligibility,bindInvitation:async(...args)=>calls.push(['bind',...args]),account:async()=>account,bindAccount:async()=>account,accountByCustomer:async()=>account,
      claimLimitedCheckout:async()=>({state:'claimed',attempt_id:q.attempt_id,token:'syntheticLease',quote:structuredClone(q)}),pinPrice:async(...args)=>calls.push(['pin',...args]),saveCheckout:async(...args)=>calls.push(['save',...args]),closeCheckout:async()=>{},
      claimReconcile:async()=>({state:'claimed',token:'syntheticLease'}),releaseReconcile:async()=>calls.push(['release']),quoteByAttempt:async()=>q,settleLimited:async(...args)=>calls.push(['settle',...args]),
    }};
  return{deps,calls,profile,offer,price,q,preview,eligibility,sub,invoice,event,stripe};
}

test('explicitly disabled routes fail closed before identity, database, provider or mailbox I/O',async()=>{
  const f=fixture();f.deps.authenticate=async()=>{throw Error('unexpected');};
  for(const fn of Object.values(createLimitedLaunchHandlers(f.deps, {...config,billingEnabled:false,checkoutEnabled:false,invitationEnabled:false})))assert.equal((await fn(request())).status,503);
  assert.deepEqual(f.calls,[]);
});
test('offline preview has three annual Credential amounts plus full-price bundle; IDs never guessed',async()=>{
  const plan=await prepareLimitedCatalog({request:async()=>{throw Error('unexpected');}});
  assert.deepEqual(plan.offers.map(o=>o.unitAmount),[9900,14900,19900,24500]);assert.ok(plan.offers.every(o=>o.productId===null));
  assert.deepEqual(limitedOffers(config.productIds).map(o=>o.unitAmount),[9900,14900,19900,24500]);
  await assert.rejects(prepareLimitedCatalog({mode:'live',apply:true}),/sandbox/);
});
test('matching sandbox bootstrap is repeatable and never modifies legacy objects',async()=>{
  const output=await prepareLimitedCatalog({apply:true,secretKey:'sk_test_synthetic',productIds:config.productIds,request:async(method,path)=>{
    assert.equal(method,'GET');assert.ok(!path.includes('_v1'));
    const bundle=path.includes('Bundle')||path.includes('core_locum');
    const phase=path.includes('_earlybird_')?'earlybird':path.includes('_founding_')?'founding':'standard';
    const f=fixture(bundle?'core_locum':'core',phase);
    const pid=bundle?'prod_Bundle':'prod_Credential';
    if(path.startsWith('/products/'))return {...f.price.product,id:pid,default_price:'price_Annual'};
    return{data:[f.price],has_more:false};
  }});
  assert.equal(output.stripe.length,4);
});
test('quote price comes from protected eligibility; bundle is never discounted',async()=>{
  for(const [phase,cents]of[['founding',9900],['earlybird',14900],['standard',19900]]){
    const f=fixture('core',phase);const h=createLimitedLaunchHandlers(f.deps,config);
    const quote=await (await h.quote(request())).json();assert.equal(quote.annualCents,cents);assert.equal(quote.trialAutoCharges,false);assert.equal(quote.practiceTrialDays,30);
    const bundle=await(await h.quote(request({offerId:'core_locum'}))).json();assert.equal(bundle.annualCents,24500);assert.equal(bundle.practiceTrialDays,0);
  }
});
test('new pending invitee buys the first paid annual term with card and no Stripe trial',async()=>{
  const f=fixture();assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest())).status,200);
  const [,args,opts]=f.calls.find(c=>c[0]==='checkout');assert.equal(args.payment_method_collection,'always');assert.deepEqual(args.payment_method_types,['card']);assert.equal(args.mode,'subscription');assert.deepEqual(args.line_items,[{price:'price_Annual',quantity:1}]);assert.equal(args.subscription_data.trial_period_days,undefined);assert.equal(args.metadata.price_phase,'founding');assert.equal(opts.idempotencyKey,`credentialdomd:checkout:${f.q.attempt_id}`);
});
test('lifetime, revoked and deleted accounts cause no Stripe/card creation',async()=>{
  for(const alter of[f=>f.eligibility.state='lifetime_access_already_granted',f=>f.profile.access_status='revoked',f=>f.profile.deleted_at='2026-01-01']){
    const f=fixture();alter(f);const r=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());assert.ok([403,409].includes(r.status));assert.deepEqual(f.calls,[]);
  }
});
test('profile relink after verified authentication cannot quote or buy as the new subject',async()=>{
  const f=fixture();f.profile.auth_user_id='user_b';
  const h=createLimitedLaunchHandlers(f.deps,config);
  assert.equal((await h.quote(request())).status,403);
  assert.equal((await h.checkout(paidRequest())).status,403);
  assert.deepEqual(f.calls,[]);
});
test('invitation token alone is insufficient; only backend-verified mailbox list reaches binding',async()=>{
  const f=fixture();f.deps.verifiedEmails=async()=>[];
  let r=await createLimitedLaunchHandlers(f.deps,config).quote(request({offerId:'core',invitationToken:'A'.repeat(43)}));assert.equal(r.status,409);assert.deepEqual(f.calls,[]);
  f.deps.verifiedEmails=async()=>['member@example.invalid'];r=await createLimitedLaunchHandlers(f.deps,config).quote(request({offerId:'core',invitationToken:'A'.repeat(43)}));assert.equal(r.status,200);
  const bind=f.calls.find(c=>c[0]==='bind');assert.match(bind[4],/^[a-f0-9]{64}$/);assert.deepEqual(bind[5],['member@example.invalid']);assert.ok(!JSON.stringify(bind).includes('A'.repeat(43)));
});
test('client-supplied prices, eligibility, quantities and metadata are rejected',async()=>{
  for(const patch of[{pricePhase:'founding'},{annualCents:1},{priceId:'price_Free'},{quantity:0},{profileId:'victim'},{email:'member@example.invalid'},{metadata:{}}]){
    const f=fixture();assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(request({offerId:'core',...patch}))).status,400);assert.deepEqual(f.calls,[]);
  }
});
test('unrelated products, discounts/cadence changes and inactive sale prices are rejected',()=>{
  const f=fixture();for(const patch of[{unit_amount:1},{product:'prod_Other'},{active:false},{recurring:{interval:'month',interval_count:1,usage_type:'licensed'}},{recurring:{interval:'year',interval_count:1,usage_type:'licensed',trial_period_days:30}}])assert.throws(()=>assertLimitedPrice({...f.price,...patch},f.offer,false));
});
test('existing subscription and uncertain attempt prevent a second Checkout',async()=>{
  const f=fixture();f.stripe.subscriptions.list=async()=>({data:[{status:'past_due'}],has_more:false});assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest())).status,409);assert.equal(f.calls.some(c=>c[0]==='checkout'),false);
  f.stripe.subscriptions.list=async()=>({data:[],has_more:false});f.deps.store.claimLimitedCheckout=async()=>({state:'reconciliation_required'});assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest())).status,503);
});
test('durable price and quote keep exact same Checkout parameters across retries',async()=>{
  const f=fixture();const h=createLimitedLaunchHandlers(f.deps,config);await h.checkout(paidRequest());f.eligibility.price_phase='standard';await h.checkout(paidRequest());
  const attempts=f.calls.filter(c=>c[0]==='checkout');assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);assert.equal(attempts[1][1].metadata.price_phase,'founding');
});
test('webhook uses fresh paid invoice and atomically settles first paid proof',async()=>{
  const f=fixture();assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
  const [,args,quote,proof]=f.calls.find(c=>c[0]==='settle');assert.equal(args.p_status,'active');assert.equal(quote,f.q.attempt_id);assert.equal(proof.initial,true);assert.equal(proof.annualCents,9900);assert.equal(proof.clerkSubject,'user_a');
});
test('open invoice, canceled state, delayed webhook and renewal cannot start a new trial',async()=>{
  for(const alter of[f=>{f.invoice.status='open';f.invoice.paid=false;},f=>f.sub.status='canceled',f=>f.invoice.billing_reason='subscription_cycle']){
    const f=fixture();alter(f);assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);const proof=f.calls.find(c=>c[0]==='settle')[3];assert.ok(proof===null||proof.initial===false);
  }
});
test('underpayment or changed current identity/quote never grants membership',async()=>{
  for(const alter of[f=>f.invoice.amount_paid=1,f=>f.sub.metadata.clerk_user_id='user_victim',f=>f.q.profile_id='victim',f=>f.q.price_id='price_Other']){
    const f=fixture();alter(f);assert.ok([409,503].includes((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status));assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  }
});
test('failed atomic settlement remains retryable; duplicate never resettles',async()=>{
  const f=fixture();f.deps.store.settleLimited=async()=>{throw Error('private failure');};const r=await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true));assert.equal(r.status,503);assert.equal((await r.json()).error,'billing_unavailable');
  f.deps.store.claimReconcile=async()=>({state:'duplicate'});assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
});
test('expired, foreign or altered quote/consent cannot create a Checkout',async()=>{
  for(const alter of[f=>f.preview.expires_at=new Date(now-1).toISOString(),f=>f.preview.profile_id='victim',f=>f.preview.clerk_subject='user_other',f=>f.preview.consent_hash='b'.repeat(64)]){
    const f=fixture();alter(f);const r=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());assert.equal(r.status,409);assert.equal((await r.json()).error,'quote_expired');assert.deepEqual(f.calls,[]);
  }
  const f=fixture();assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest({consent:false}))).status,400);
});
test('no-card beta activation does not require or invoke Stripe and exposes only server grant dates',async()=>{
  const f=fixture();f.eligibility.free_beta={state:'active',startsAt:'2026-09-19T18:00:00Z',endsAt:'2026-10-19T18:00:00Z',autoCharges:false};
  f.deps.assertConfigured=()=>{throw Error('Stripe config must not be accessed');};f.deps.stripe=()=>{throw Error('Stripe must not be accessed');};
  const h=createLimitedLaunchHandlers(f.deps,{...config,billingEnabled:false,checkoutEnabled:false,invitationEnabled:true});
  const r=await h.activate(request({invitationToken:'A'.repeat(43)}));assert.equal(r.status,200);const data=await r.json();assert.equal(data.cardRequired,false);assert.equal(data.subscriptionCreated,false);assert.deepEqual(data.freeBeta,f.eligibility.free_beta);assert.ok(f.calls.every(c=>c[0]==='bind'));
});
test('access snapshot retains authoritative billing eligibility and validated no-card beta',async()=>{
  const snapshot={schemaVersion:1,policyVersion:PUBLIC_BILLING_POLICY.version,enforcementEnabled:true,billingEnabled:true,checkoutEligible:true,pricePhase:'founding',freeBeta:{state:'expired',startsAt:'2026-08-01T00:00:00Z',endsAt:'2026-08-31T00:00:00Z',autoCharges:false}};
  const deps={authenticate:async()=>({id:'profile',auth_user_id:'user_a'}),readOwnSnapshot:async()=>snapshot};
  const h=createAccessPolicyHandler(deps,{...PUBLIC_BILLING_POLICY,enforcementEnabled:true});
  assert.deepEqual(await(await h(request())).json(),snapshot);
  snapshot.freeBeta.autoCharges=true;assert.equal((await h(request())).status,503);
});

test('interrupted pre-Basil Checkout resumes only its exact owned incomplete subscription',async()=>{
  const f=fixture();const prior={id:'cs_A',status:'open',customer:'cus_A',subscription:'sub_A',livemode:false,metadata:f.sub.metadata,url:'https://checkout.stripe.com/c/synthetic'};
  f.stripe.subscriptions.list=async()=>({data:[{id:'sub_A',status:'incomplete'}],has_more:false});
  f.deps.store.claimLimitedCheckout=async()=>({state:'existing',attempt_id:f.q.attempt_id,offer_id:'core',session_id:'cs_A',quote:f.q});
  f.stripe.checkout.sessions.retrieve=async()=>prior;
  const h=createLimitedLaunchHandlers(f.deps,config);
  assert.deepEqual(await(await h.checkout(paidRequest())).json(),{url:prior.url});
  assert.equal(f.calls.some(c=>c[0]==='checkout'),false);
  for(const patch of[{subscription:'sub_Other'},{status:'expired'},{customer:'cus_Other'}]){
    f.stripe.checkout.sessions.retrieve=async()=>({...prior,...patch});
    assert.equal((await h.checkout(paidRequest())).status,409);
  }
  f.deps.store.claimLimitedCheckout=async()=>({state:'claimed',attempt_id:f.q.attempt_id,quote:f.q});
  assert.equal((await h.checkout(paidRequest())).status,409);
  assert.equal(f.calls.some(c=>c[0]==='checkout'),false);
});
test('renewal and delayed first-payment settlement follow the pinned price after lookup transfer',async()=>{
  for(const reason of['subscription_create','subscription_cycle']){
    const f=fixture();f.invoice.billing_reason=reason;f.price.lookup_key=null;f.price.active=false;f.price.product.active=false;
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
    assert.equal(f.calls.find(c=>c[0]==='settle')[3].initial,reason==='subscription_create');
    assert.throws(()=>assertLimitedPrice(f.price,f.offer,false));
    f.calls.length=0;f.price.id='price_Replacement';
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,409);
    assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  }
});
test('oversized unfinished webhook stream promptly cancels and returns413',async()=>{
  const f=fixture();let canceled=false,verified=false,timer;
  f.deps.verifyEvent=async()=>{verified=true;throw Error('must not verify');};
  const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(262145));},cancel(){canceled=true;}});
  const req=new Request('https://functions.example',{method:'POST',body,duplex:'half'});
  try{
    const response=await Promise.race([createLimitedLaunchHandlers(f.deps,config).webhook(req),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('stream cancellation stalled')),1000);})]);
    assert.equal(response.status,413);assert.equal(canceled,true);assert.equal(verified,false);
  }finally{clearTimeout(timer);}
});
test('bounded raw webhook bytes still reach historical v1 settlement intact',async()=>{
  const f=fixture();const raw=JSON.stringify({synthetic:'legacy payload'}),seen=[];
  f.deps.verifyEvent=async(bytes)=>{seen.push(bytes);return f.event;};
  const old=BILLING_CATALOG.offers.core;
  f.profile.access_status='active';f.profile.founding_number=1;
  f.sub.metadata.catalog_version=BILLING_CATALOG.version;
  Object.assign(f.price,{unit_amount:old.unitAmount,lookup_key:old.lookupKey});
  Object.assign(f.price.product,{id:old.productId,metadata:{app:config.app,offer_id:'core',membership:'founding'}});
  f.deps.store.applySubscription=async(args)=>f.calls.push(['legacy',args]);
  const response=await createLimitedLaunchHandlers(f.deps,config).webhook(new Request('https://functions.example',{method:'POST',headers:{'stripe-signature':'synthetic'},body:raw}));
  assert.equal(response.status,200);assert.deepEqual(seen,[raw,raw]);assert.equal(f.calls.filter(c=>c[0]==='legacy').length,1);
});
test('database expiry after eligibility change requires new quote consent before provider mutation',async()=>{
  const f=fixture();f.deps.store.claimLimitedCheckout=async()=>({state:'quote_expired'});
  const response=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());
  assert.equal(response.status,409);assert.equal((await response.json()).error,'quote_expired');assert.equal(f.calls.some(c=>c[0]==='checkout'),false);
});
test('held public capacity blocks Core previews and cap races without changing consent to149; bundle remains245',async()=>{
  const f=fixture();f.eligibility.founding_state='reserved';const h=createLimitedLaunchHandlers(f.deps,config);
  const unavailable=await h.quote(request());assert.equal(unavailable.status,409);assert.deepEqual(await unavailable.json(),{error:'founding_capacity_pending'});
  const bundle=await h.quote(request({offerId:'core_locum'}));assert.equal(bundle.status,200);assert.equal((await bundle.json()).annualCents,24500);
  f.deps.store.claimLimitedCheckout=async()=>({state:'founding_capacity_pending'});
  const raced=await h.checkout(paidRequest());assert.equal(raced.status,409);assert.deepEqual(await raced.json(),{error:'founding_capacity_pending'});
  assert.equal(f.calls.some(c=>['checkout','pin','save'].includes(c[0])),false);
  f.eligibility.founding_state='held';assert.equal((await h.quote(request())).status,200);
});

function expiredFoundingFixture() {
  const f=fixture();f.q.public_founding_slot=1;
  const session={id:'cs_Expired',status:'expired',payment_status:'unpaid',mode:'subscription',subscription:null,customer:'cus_A',livemode:false,client_reference_id:f.profile.id,metadata:f.sub.metadata};
  f.event.type='checkout.session.expired';f.event.data.object={id:session.id};
  f.stripe.checkout.sessions.retrieve=async(id)=>{f.calls.push(['retrieveCheckout',id]);return structuredClone(session);};
  f.deps.store.releaseFoundingCheckout=async(...args)=>{f.calls.push(['releaseFounding',...args]);return true;};
  return {...f,session};
}
test('expired-session webhook requires signature and fresh provider state before release, without paid settlement',async()=>{
  const f=expiredFoundingFixture();const h=createLimitedLaunchHandlers(f.deps,config);
  assert.equal((await h.webhook(request({},true))).status,200);
  assert.equal(f.calls.filter(c=>c[0]==='retrieveCheckout').length,1);
  const release=f.calls.find(c=>c[0]==='releaseFounding');assert.deepEqual(release.slice(1,5),[f.profile.id,'user_a',false,f.q.attempt_id]);
  assert.deepEqual(release[5],{session_id:'cs_Expired',customer_id:'cus_A',status:'expired',payment_status:'unpaid',subscription_id:null});
  assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  f.calls.length=0;f.deps.verifyEvent=async()=>{throw Error('invalid');};assert.equal((await h.webhook(request({},true))).status,400);assert.deepEqual(f.calls,[]);
});
test('old expired event cannot release a now-paid, open or subscription-bound Checkout',async()=>{
  for(const patch of [{status:'open'},{status:'complete',payment_status:'paid',subscription:'sub_A'},{subscription:'sub_A'},{payment_status:'paid'}]) {
    const f=expiredFoundingFixture();Object.assign(f.session,patch);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
    assert.equal(f.calls.some(c=>c[0]==='releaseFounding'),false);
  }
});
test('expired webhook ignores unrelated catalogs and unallocated quotes, rejects wrong owner or mode',async()=>{
  for(const mutate of [f=>f.session.metadata.catalog_version='other',f=>delete f.q.public_founding_slot]) {
    const f=expiredFoundingFixture();mutate(f);assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);assert.equal(f.calls.some(c=>c[0]==='releaseFounding'),false);
  }
  for(const mutate of [f=>f.session.id='cs_Other',f=>f.session.client_reference_id='other',f=>f.session.metadata.clerk_user_id='user_other',f=>f.event.livemode=true,f=>f.session.livemode=true]) {
    const f=expiredFoundingFixture();mutate(f);assert.ok([400,503].includes((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status));assert.equal(f.calls.some(c=>c[0]==='releaseFounding'),false);
  }
});
test('same-owner expired Checkout releases through proof before new claim; uncertain release creates nothing',async()=>{
  for(const released of [true,false]) {
    const f=expiredFoundingFixture();let claimCount=0;
    f.deps.store.releaseFoundingCheckout=async(...args)=>{f.calls.push(['releaseFounding',...args]);return released;};
    f.deps.store.claimLimitedCheckout=async()=>{
      f.calls.push(['claim',++claimCount]);
      return claimCount===1?{state:'existing',attempt_id:f.q.attempt_id,offer_id:'core',session_id:f.session.id,quote:f.q}
        :{state:'claimed',attempt_id:f.q.attempt_id,token:'lease',quote:f.q};
    };
    const response=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());
    assert.equal(response.status,released?200:503);
    assert.equal(claimCount,released?2:1);
    assert.equal(f.calls.some(c=>c[0]==='checkout'),released);
    if(released)assert.ok(f.calls.findIndex(c=>c[0]==='releaseFounding')<f.calls.findIndex(c=>c[0]==='claim'&&c[1]===2));
  }
});
test('access snapshot exposes validated saved-session resume separately from new-purchase eligibility',async()=>{
  const snapshot={schemaVersion:1,policyVersion:PUBLIC_BILLING_POLICY.version,enforcementEnabled:true,billingEnabled:true,checkoutEligible:false,checkoutResumeAvailable:true,checkoutResumeOfferId:'core'};
  const deps={authenticate:async()=>({id:'profile',auth_user_id:'user_a'}),readOwnSnapshot:async()=>snapshot};
  const h=createAccessPolicyHandler(deps,{...PUBLIC_BILLING_POLICY,enforcementEnabled:true});
  assert.deepEqual(await(await h(request())).json(),snapshot);
  snapshot.checkoutResumeOfferId='unreviewed';assert.equal((await h(request())).status,503);
});

function deferredFixture(remainingMs=20*86400000, offerId='core') {
  const f=fixture(offerId,offerId==='core'?'founding':'standard');
  const betaEnd=now+remainingMs, anchor=Math.ceil(betaEnd/1000);
  for(const row of[f.q,f.preview]) {row.beta_ends_at=new Date(betaEnd).toISOString();row.billing_start_at=new Date(anchor*1000).toISOString();}
  f.eligibility.free_beta={state:'active',startsAt:new Date(betaEnd-30*86400000).toISOString(),endsAt:f.q.beta_ends_at,autoCharges:false};
  Object.assign(f.sub,{billing_cycle_anchor:anchor,collection_method:'charge_automatically',cancel_at_period_end:false,current_period_start:Math.floor(now/1000),current_period_end:anchor,latest_invoice:null});
  f.sub.metadata.billing_start_at=String(anchor);
  f.event.type='checkout.session.completed';f.event.data.object={mode:'subscription',subscription:f.sub.id,payment_status:'no_payment_required'};
  return {...f,anchor};
}
function markDeferredPaid(f, {renewal=false, delay=0}={}) {
  const start=f.anchor+(renewal?31536000:0), end=start+31536000;
  Object.assign(f.sub,{latest_invoice:'in_A',current_period_start:start,current_period_end:end});
  f.invoice.billing_reason='subscription_cycle';f.invoice.status_transitions.paid_at=start+delay;
  f.invoice.lines.data[0].period={start,end};f.invoice.lines.data[0].proration=false;
  f.event.type='invoice.paid';f.event.data.object={subscription:f.sub.id};
}
test('active historical beta explicitly opts in with card, zero now and original fixed annual anchor including last minute',async()=>{
  for(const remaining of[20*86400000,47*3600000,3600000,60000])for(const offerId of['core','core_locum']) {
    const f=deferredFixture(remaining,offerId),h=createLimitedLaunchHandlers(f.deps,config);
    const preview=await(await h.quote(request({offerId}))).json();
    assert.equal(preview.paymentTiming,'after_beta');assert.equal(preview.paymentAtCheckout,false);assert.equal(preview.amountDueNowCents,0);
    assert.equal(preview.firstChargeAt,f.q.billing_start_at);assert.equal(preview.betaEndsAt,f.q.beta_ends_at);
    assert.equal(preview.annualCents,offerId==='core'?9900:24500);
    assert.equal((await h.checkout(paidRequest())).status,200);
    const [,args]=f.calls.find(c=>c[0]==='checkout');
    assert.equal(args.mode,'subscription');assert.equal(args.payment_method_collection,'always');assert.deepEqual(args.payment_method_types,['card']);
    assert.equal(args.subscription_data.billing_cycle_anchor,f.anchor);assert.equal(args.subscription_data.proration_behavior,'none');
    assert.equal(args.subscription_data.trial_end,undefined);assert.equal(args.subscription_data.trial_period_days,undefined);
    assert.equal(args.metadata.billing_start_at,String(f.anchor));assert.equal(args.line_items[0].price,'price_Annual');
    assert.ok(args.custom_text.submit.message.includes(f.q.billing_start_at.replace('T',' ').replace('.000Z',' UTC')));
    assert.match(args.custom_text.submit.message,/\$0 due before/);assert.match(args.custom_text.submit.message,/Checkout completes if later/);assert.ok(args.custom_text.submit.message.length<1200);
    assert.equal(f.eligibility.free_beta.endsAt,f.q.beta_ends_at);
  }
});
test('deferred provider parameters and idempotency stay identical across retries, never restart beta',async()=>{
  const f=deferredFixture();const h=createLimitedLaunchHandlers(f.deps,config);
  await h.checkout(paidRequest());f.deps.now=()=>now+60000;await h.checkout(paidRequest());
  const calls=f.calls.filter(c=>c[0]==='checkout');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
});
test('active beta cannot use immediate-charge, client-supplied or tampered timing; lifetime remains excluded',async()=>{
  for(const alter of[f=>{f.preview.beta_ends_at=null;f.preview.billing_start_at=null;},f=>{f.q.billing_start_at=new Date(f.anchor*1000+1000).toISOString();},f=>{f.preview.billing_start_at=new Date(f.anchor*1000-1000).toISOString();},f=>{f.eligibility.free_beta.endsAt=new Date(f.anchor*1000+86400000).toISOString();},f=>{f.eligibility.free_beta.state='none';},f=>{f.eligibility.state='lifetime_access_already_granted';}]) {
    const f=deferredFixture();alter(f);const res=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());
    assert.ok([409,503].includes(res.status));assert.equal(f.calls.some(c=>c[0]==='checkout'),false);
  }
  const f=deferredFixture();assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest({billingStartAt:new Date(now).toISOString()}))).status,400);
});
test('new Checkout crossing its immutable beta anchor requires refreshed consent, including time spent in provider reads',async()=>{
  for(const crossDuringRead of[false,true]) {
    const f=deferredFixture(60000);let time=now;f.deps.now=()=>time;
    if(crossDuringRead) f.deps.store.pinPrice=async()=>{time=f.anchor*1000;}; else time=f.anchor*1000;
    const res=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());
    assert.equal(res.status,409);assert.equal((await res.json()).error,'quote_expired');assert.equal(f.calls.some(c=>c[0]==='checkout'),false);
  }
});
test('no-payment-required completion is recorded without a paid membership, receipt or Practice trial',async()=>{
  const f=deferredFixture();assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
  const [,args,,proof]=f.calls.find(c=>c[0]==='settle');assert.equal(proof,null);assert.equal(args.p_billing_anchor,f.anchor);assert.equal(args.p_period_end,f.q.billing_start_at);assert.equal(args.p_cancel_at_period_end,false);
});
test('first full invoice starts annual period at original anchor even when card payment completes later',async()=>{
  for(const delay of[0,3600,86400*3])for(const offer of['core','core_locum']) {
    const f=deferredFixture(60000,offer);markDeferredPaid(f,{delay});
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');assert.equal(proof.initial,true);assert.equal(proof.annualCents,offer==='core'?9900:24500);
    assert.equal(proof.paidAt,new Date((f.anchor+delay)*1000).toISOString());assert.equal(proof.periodEnd,new Date((f.anchor+31536000)*1000).toISOString());assert.equal(args.p_billing_anchor,f.anchor);
  }
});
test('deferred renewal retains immutable original anchor without a second initial Practice trial',async()=>{
  const f=deferredFixture();markDeferredPaid(f,{renewal:true});
  assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
  assert.equal(f.calls.find(c=>c[0]==='settle')[3].initial,false);
});
test('scheduled cancellation and first-payment failure never mint paid evidence',async()=>{
  for(const alter of[f=>{f.sub.cancel_at_period_end=true;},f=>{f.sub.status='canceled';},f=>{f.sub.status='past_due';f.sub.current_period_end=f.anchor+31536000;f.sub.latest_invoice='in_A';f.invoice.status='open';f.invoice.paid=false;}]) {
    const f=deferredFixture();alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');assert.equal(proof,null);assert.equal(args.p_cancel_at_period_end,f.sub.cancel_at_period_end);
  }
});
test('deferred settlement rejects shifted anchor, early payment, partial periods, trials and monetary mismatch',async()=>{
  for(const alter of[f=>f.sub.billing_cycle_anchor++,f=>f.sub.metadata.billing_start_at='1',f=>f.sub.trial_end=f.anchor,f=>f.sub.collection_method='send_invoice',f=>f.sub.pause_collection={behavior:'void'},f=>delete f.sub.cancel_at_period_end,f=>f.sub.current_period_start=f.anchor-1,f=>f.invoice.status_transitions.paid_at=f.anchor-1,f=>f.invoice.lines.data[0].period.start++,f=>f.invoice.lines.data[0].period.end--,f=>f.invoice.lines.data[0].proration=true,f=>f.invoice.amount_paid=0,f=>f.invoice.amount_paid=1,f=>f.invoice.amount_due=1,f=>f.invoice.total_discount_amounts=[{amount:1}],f=>f.invoice.lines.data[0].amount=1]) {
    const f=deferredFixture();markDeferredPaid(f);alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503);assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  }
});
test('existing scheduled/active subscription blocks second card Checkout even before first paid invoice',async()=>{
  const f=deferredFixture();f.stripe.subscriptions.list=async()=>({data:[f.sub],has_more:false});
  assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest())).status,409);assert.equal(f.calls.some(c=>c[0]==='checkout'),false);
});
test('scheduled membership snapshot is bounded, internally consistent and never grants through checkout eligibility',async()=>{
  const scheduled={offerId:'core',startsAt:'2026-10-19T18:00:00Z',annualCents:9900,currency:'usd',interval:'year',status:'scheduled',cancelAtPeriodEnd:false,firstChargeCanceled:false};
  const snapshot={schemaVersion:1,policyVersion:config.policyVersion,enforcementEnabled:true,billingEnabled:true,checkoutEligible:false,pricePhase:'founding',purchasedOfferId:null,scheduledMembership:scheduled};
  const deps={authenticate:async()=>({id:'synthetic',auth_user_id:'user_a'}),readOwnSnapshot:async()=>snapshot};
  const h=createAccessPolicyHandler(deps,{...PUBLIC_BILLING_POLICY,enforcementEnabled:true});
  assert.equal((await h(request({}))).status,200);
  for(const change of[{status:'canceling'},{cancelAtPeriodEnd:true},{annualCents:1},{startsAt:'invalid'},{offerId:'free'},{status:'active'},{firstChargeCanceled:true}]) {
    snapshot.scheduledMembership={...scheduled,...change};assert.equal((await h(request({}))).status,503);
  }
  snapshot.scheduledMembership={...scheduled,status:'canceling',cancelAtPeriodEnd:true};assert.equal((await h(request({}))).status,200);
  snapshot.checkoutEligible=true;assert.equal((await h(request({}))).status,503);
  snapshot.checkoutEligible=false;snapshot.checkoutResumeAvailable=true;snapshot.checkoutResumeOfferId='core';assert.equal((await h(request({}))).status,503);
  snapshot.scheduledMembership=null;assert.equal((await h(request({}))).status,200);
});
test('expired beta can resume only the already-owned open deferred Checkout under its original explicit terms',async()=>{
  for(const providerState of['open','expired','complete']) {
    const f=deferredFixture(60000);f.deps.now=()=>f.anchor*1000+1000;f.eligibility.free_beta.state='expired';f.preview.expires_at=new Date(f.anchor*1000+1800000).toISOString();
    let claims=0;
    f.deps.store.claimLimitedCheckout=async()=> ++claims===1 ? {state:'existing',attempt_id:f.q.attempt_id,offer_id:f.q.offer_id,session_id:'cs_Saved',quote:f.q} : {state:'quote_expired'};
    f.stripe.checkout.sessions.retrieve=async()=>({id:'cs_Saved',customer:'cus_A',livemode:false,status:providerState,url:'https://checkout.stripe.com/c/original',subscription:null,metadata:{checkout_attempt_id:f.q.attempt_id,clerk_user_id:'user_a',catalog_version:config.version}});
    f.deps.store.closeCheckout=async(...args)=>f.calls.push(['close',...args]);
    const response=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());
    if(providerState==='open') {assert.equal(response.status,200);assert.equal((await response.json()).url,'https://checkout.stripe.com/c/original');assert.equal(f.calls.some(c=>c[0]==='close'),false);}
    else {assert.equal(response.status,409);assert.equal((await response.json()).error,providerState==='complete'?'subscription_already_exists':'quote_expired');assert.equal(f.calls.filter(c=>c[0]==='close').length,1);}
    assert.equal(f.calls.some(c=>c[0]==='checkout'),false,'past-anchor receipt must never create a fresh Stripe session');
  }
});
