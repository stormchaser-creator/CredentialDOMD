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
      unfinishedRefund:async()=>null,claimLimitedCheckout:async()=>({state:'claimed',attempt_id:q.attempt_id,token:'syntheticLease',quote:structuredClone(q)}),pinPrice:async(...args)=>calls.push(['pin',...args]),saveCheckout:async(...args)=>calls.push(['save',...args]),closeCheckout:async()=>{},
      claimReconcile:async()=>({state:'claimed',token:'syntheticLease'}),releaseReconcile:async()=>calls.push(['release']),quoteByAttempt:async()=>q,settleLimited:async(...args)=>calls.push(['settle',...args]),
      // No refund request on record for a cancelled subscription (20261001041500).
      refundBySubscription:async()=>null,
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
    // Founding Credential includes Practice while active (owner, 2026-09-28); early-bird and standard keep the 30-day trial.
    const quote=await (await h.quote(request())).json();assert.equal(quote.annualCents,cents);assert.equal(quote.trialAutoCharges,false);
    assert.equal(quote.practiceIncluded,phase==='founding');assert.equal(quote.practiceTrialDays,phase==='founding'?0:30);
    const bundle=await(await h.quote(request({offerId:'core_locum'}))).json();assert.equal(bundle.annualCents,24500);assert.equal(bundle.practiceTrialDays,0);assert.equal(bundle.practiceIncluded,true);
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
test('a cancelled membership whose refund is unfinished is finished before a new purchase: no customer, no Checkout',async()=>{
  const f=fixture();
  const stripeCalls=[];
  f.deps.stripe=()=>new Proxy({},{get:(_,name)=>{stripeCalls.push(name);return f.stripe[name];}});
  f.deps.store.unfinishedRefund=async(profileId,live)=>{f.calls.push(['unfinished',profileId,live]);return{state:'requested',subscription_id:'sub_Old',subscription_canceled_at:'2026-09-29T18:00:00Z'};};
  const r=await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest());
  assert.equal(r.status,409);assert.equal((await r.json()).error,'refund_unfinished');
  assert.deepEqual(f.calls,[['unfinished',f.profile.id,false]]);assert.deepEqual(stripeCalls,[],'nothing reaches Stripe');
  f.deps.store.unfinishedRefund=async()=>null;
  assert.equal((await createLimitedLaunchHandlers(f.deps,config).checkout(paidRequest())).status,200,'with none open, the purchase goes ahead');
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

test('while a new self-service buyer\'s offer is founding the bundle is refused before any preview or provider call',async()=>{
  // Founding Credential includes Practice while active (20260928190000), so $245 would cost more for the same thing.
  const f=fixture();f.eligibility.bundle_available=false;const h=createLimitedLaunchHandlers(f.deps,config);
  let previews=0;const createPreview=f.deps.store.createPreview;f.deps.store.createPreview=async(...args)=>{previews++;return createPreview(...args);};
  const refused=await h.quote(request({offerId:'core_locum'}));assert.equal(refused.status,409);assert.deepEqual(await refused.json(),{error:'bundle_unavailable'});
  assert.equal(previews,0);
  const core=await(await h.quote(request())).json();assert.deepEqual([core.annualCents,core.practiceIncluded,core.practiceTrialDays],[9900,true,0]);
  // A bundle preview made before the migration cannot reach Stripe either.
  f.deps.store.previewById=async()=>({...f.preview,offer_id:'core_locum',price_phase:'standard',annual_cents:24500});
  const blocked=await h.checkout(paidRequest());assert.equal(blocked.status,409);assert.deepEqual(await blocked.json(),{error:'bundle_unavailable'});
  assert.deepEqual(f.calls,[],'no customer, claim, price pin or Checkout');
  // And the database's own refusal is passed on the same way.
  f.eligibility.bundle_available=true;f.deps.store.claimLimitedCheckout=async()=>({state:'bundle_unavailable'});
  const raced=await h.checkout(paidRequest());assert.equal(raced.status,409);assert.deepEqual(await raced.json(),{error:'bundle_unavailable'});
  assert.equal(f.calls.some(c=>['checkout','pin','save'].includes(c[0])),false);
  // Reviewed invitations, beta holders and buyers after founding: the bundle is offered.
  const offered=await h.quote(request({offerId:'core_locum'}));assert.equal(offered.status,200);assert.equal((await offered.json()).practiceIncluded,true);
});
test('access snapshot validates whether a paid membership includes Practice and whether the bundle is offered',async()=>{
  const base={schemaVersion:1,policyVersion:PUBLIC_BILLING_POLICY.version,enforcementEnabled:true,billingEnabled:true,purchasedOfferId:'core',practiceIncluded:true,bundleAvailable:false};
  let snapshot=base;const h=createAccessPolicyHandler({authenticate:async()=>({id:'profile',auth_user_id:'user_a'}),readOwnSnapshot:async()=>snapshot},{...PUBLIC_BILLING_POLICY,enforcementEnabled:true});
  assert.deepEqual(await(await h(request())).json(),base);
  for(const bad of [{practiceIncluded:'true'},{purchasedOfferId:null},{purchasedOfferId:'core_locum',practiceIncluded:false},{bundleAvailable:'no'}]){
    snapshot={...base,...bad};assert.equal((await h(request())).status,503,JSON.stringify(bad));
  }
  snapshot={...base,practiceIncluded:undefined,bundleAvailable:undefined};assert.equal((await h(request())).status,200,'an older snapshot without the fields is still read');
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
// BILL-011: Stripe finalizes a deferred subscription's first invoice at $0 and
// marks it paid at once (billing_cycle_anchor in the future, proration none).
function markDeferredOpening(f) {
  const start=f.sub.current_period_start;
  f.sub.latest_invoice='in_A';
  Object.assign(f.invoice,{billing_reason:'subscription_create',amount_paid:0,amount_due:0,amount_remaining:0,total:0,subtotal:0,status_transitions:{paid_at:start}});
  f.invoice.lines.data[0]={price:f.price.id,quantity:1,amount:0,period:{start,end:f.anchor},proration:false};
}
test('deferred purchase: every Checkout event with the paid $0 opening invoice settles as the scheduled membership',async()=>{
  for(const [type,object] of[['checkout.session.completed',{mode:'subscription',subscription:'sub_A',payment_status:'no_payment_required'}],['customer.subscription.created',{id:'sub_A'}],['invoice.paid',{id:'in_A',subscription:'sub_A'}]])for(const offerId of['core','core_locum']) {
    const f=deferredFixture(20*86400000,offerId);markDeferredOpening(f);f.event.type=type;f.event.data.object=object;
    const res=await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true));
    assert.equal(res.status,200,`${type} ${offerId}`);
    const settle=f.calls.find(c=>c[0]==='settle');assert.ok(settle,`${type} settles`);
    const [,args,,proof]=settle;assert.equal(proof,null);assert.equal(args.p_status,'active');assert.equal(args.p_billing_anchor,f.anchor);assert.equal(args.p_period_end,f.q.billing_start_at);
  }
});
// Stripe's classic billing mode (API 2024-04-10): a Dashboard cancellation date
// before the first charge resets billing_cycle_anchor to that moment and ends
// the current period at the date. It still settles as the scheduled
// membership with the quote's anchor, cancelled on that date.
function markClassicEarlyCancel(f, {invoice='opening'}={}) {
  const reset=Math.floor(now/1000)+3600, cancelAt=f.anchor-5*86400;
  Object.assign(f.sub,{billing_cycle_anchor:reset,cancel_at:cancelAt,cancel_at_period_end:false,current_period_start:reset,current_period_end:cancelAt});
  if(invoice==='opening') markDeferredOpening(f);
  if(invoice==='update') {markDeferredOpening(f);Object.assign(f.invoice,{billing_reason:'subscription_update',status_transitions:{paid_at:reset}});f.invoice.lines.data[0].period={start:reset,end:cancelAt};}
  f.event.type='customer.subscription.updated';f.event.data.object={id:f.sub.id};
  return cancelAt;
}
test('deferred purchase cancelled on an earlier date in classic billing mode settles, names the date, and mints no payment',async()=>{
  for(const invoice of['none','opening','update'])for(const offerId of['core','core_locum']) {
    const f=deferredFixture(20*86400000,offerId);const cancelAt=markClassicEarlyCancel(f,{invoice});
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,`${invoice} ${offerId}`);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');
    assert.equal(proof,null);assert.equal(args.p_billing_anchor,f.anchor,'the quote anchor, not the reset');
    assert.equal(args.p_cancel_at_period_end,true);
    assert.equal(args.p_cancel_at,new Date(cancelAt*1000).toISOString());assert.equal(args.p_period_end,args.p_cancel_at);
  }
});
test('classic early cancellation: only that exact shape relaxes the anchor, and a charge before the anchor still refuses',async()=>{
  for(const alter of[f=>{f.sub.cancel_at=f.anchor;f.sub.current_period_end=f.anchor;},f=>{f.sub.current_period_end=f.sub.cancel_at+1;},f=>{f.sub.billing_cycle_anchor=f.sub.cancel_at;},f=>{f.sub.metadata.billing_start_at=String(f.sub.billing_cycle_anchor);},
    f=>{f.invoice.amount_paid=9900;f.invoice.amount_due=9900;f.invoice.total=9900;},f=>{f.invoice.billing_reason='subscription_cycle';}]) {
    const f=deferredFixture();markClassicEarlyCancel(f,{invoice:'update'});alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,String(alter));assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  }
});
// Support then removes that cancellation date. Stripe keeps the reset anchor
// and the shortened period, so the subscription no longer cancels but renews
// at the old date, before the quoted first charge. It must settle as not
// cancelling (the card stops saying it cancels), flag support, and still
// mint no payment; the early charge itself never verifies as paid access.
test('classic early cancellation undone: settles as not cancelling with the quote anchor, flags support, mints no payment',async()=>{
  for(const invoice of['none','opening','update'])for(const offerId of['core','core_locum']) {
    const f=deferredFixture(20*86400000,offerId);const cancelAt=markClassicEarlyCancel(f,{invoice});
    const logs=[];f.deps.log=e=>logs.push(e);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,'the cancellation settles');
    assert.equal(f.calls.find(c=>c[0]==='settle')[1].p_cancel_at_period_end,true);
    assert.equal(logs.length,0,'a cancelling subscription is not flagged');
    f.calls.length=0;f.sub.cancel_at=null;f.event.id='evt_Undo';
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,`undo ${invoice} ${offerId}`);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');
    assert.equal(proof,null,'no payment');assert.equal(args.p_billing_anchor,f.anchor,'the quote anchor, not the reset');
    assert.equal(args.p_cancel_at_period_end,false);assert.equal(args.p_cancel_at,null);
    assert.equal(args.p_period_end,new Date(cancelAt*1000).toISOString(),'Stripe renews at the old date');
    assert.deepEqual(logs.map(e=>[e.event,e.code,e.status]),[['deferred_schedule_moved','deferred_schedule_moved',200]],'support is told');
  }
});
test('classic early cancellation undone: the early renewal Stripe then charges refuses with its own code and settles nothing',async()=>{
  const f=deferredFixture();const cancelAt=markClassicEarlyCancel(f,{invoice:'update'});f.sub.cancel_at=null;
  // Stripe renews at the old cancellation date: a paid year starting 5 days before the quoted first charge.
  const end=cancelAt+31536000;Object.assign(f.sub,{latest_invoice:'in_A',current_period_start:cancelAt,current_period_end:end});
  Object.assign(f.invoice,{billing_reason:'subscription_cycle',amount_paid:f.offer.unitAmount,amount_due:f.offer.unitAmount,total:f.offer.unitAmount,status_transitions:{paid_at:cancelAt}});
  Object.assign(f.invoice.lines.data[0],{amount:f.offer.unitAmount,proration:false,period:{start:cancelAt,end}});
  f.event.type='invoice.paid';f.event.data.object={subscription:f.sub.id};
  const logs=[];f.deps.log=e=>logs.push(e);
  assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503);
  assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  assert.deepEqual(logs.map(e=>[e.event,e.causeCode]),[['limited_billing_failure','deferred_schedule_moved']]);
});
test('classic early cancellation undone: only that shape relaxes the anchor',async()=>{
  for(const alter of[f=>{f.sub.current_period_end=f.anchor+1;},f=>{f.sub.billing_cycle_anchor=f.anchor+1;},f=>{f.sub.current_period_end=f.sub.billing_cycle_anchor;},
    f=>{f.sub.metadata.billing_start_at=String(f.sub.billing_cycle_anchor);},f=>{f.sub.trial_end=f.anchor;},f=>{f.invoice.amount_paid=9900;f.invoice.amount_due=9900;f.invoice.total=9900;}]) {
    const f=deferredFixture();markClassicEarlyCancel(f,{invoice:'update'});f.sub.cancel_at=null;f.deps.log=()=>{};alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,String(alter));assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  }
});
test('a deferred subscription on its quoted schedule is never flagged as moved',async()=>{
  const f=deferredFixture();markDeferredOpening(f);const logs=[];f.deps.log=e=>logs.push(e);
  assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
  assert.deepEqual(logs,[]);
});
test('deferred purchase: a $0 opening invoice never passes as a paid year, and anything else about it still refuses',async()=>{
  for(const alter of[f=>f.invoice.amount_paid=1,f=>f.invoice.amount_due=1,f=>f.invoice.total=1,f=>f.invoice.customer='cus_Other',f=>f.invoice.subscription='sub_Other',f=>f.invoice.livemode=true,f=>f.invoice.total_discount_amounts=[{amount:9900}],f=>f.sub.current_period_end=f.anchor+31536000,f=>f.sub.billing_cycle_anchor++]) {
    const f=deferredFixture();markDeferredOpening(f);alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503);assert.equal(f.calls.some(c=>c[0]==='settle'),false);
  }
  // Not deferred: a $0 opening invoice on an immediate purchase is still no exact paid membership.
  const f=fixture();Object.assign(f.invoice,{amount_paid:0,amount_due:0,total:0});
  assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503);assert.equal(f.calls.some(c=>c[0]==='settle'),false);
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
    // A completed session with no live subscription is closed and claimed
    // again (BILL-003); the database then refuses the past-anchor terms.
    else {assert.equal(response.status,409);assert.equal((await response.json()).error,'quote_expired');assert.equal(f.calls.filter(c=>c[0]==='close').length,1);}
    assert.equal(f.calls.some(c=>c[0]==='checkout'),false,'past-anchor receipt must never create a fresh Stripe session');
  }
});
// BILL-005: Stripe can end renewal with a cancellation date (cancel_at) while
// cancel_at_period_end stays false: a flexible-billing subscription cancelled
// at period end in the billing portal, or a Dashboard cancellation on a date.
// The webhook settles either as "will not renew", with the date it ends.
test('a cancellation date within the paid period settles as not renewing, with that date',async()=>{
  const portalUpdate=f=>{f.event.type='customer.subscription.updated';f.event.data.object={id:f.sub.id};};
  const cases=[
    ['flag only (classic portal)',f=>{f.sub.cancel_at_period_end=true;f.sub.cancel_at=f.sub.current_period_end;},true,'end'],
    ['cancel_at at period end, flag false (flexible portal)',f=>{f.sub.cancel_at_period_end=false;f.sub.cancel_at=f.sub.current_period_end;},true,'end'],
    ['cancel_at before period end (Dashboard date)',f=>{f.sub.cancel_at_period_end=false;f.sub.cancel_at=f.sub.current_period_end-86400*30;},true,'early'],
    ['cancel_at after period end: this period still renews',f=>{f.sub.cancel_at_period_end=false;f.sub.cancel_at=f.sub.current_period_end+86400*30;},false,null],
    ['renewing',f=>{f.sub.cancel_at_period_end=false;f.sub.cancel_at=null;},false,null],
  ];
  for(const [name,alter,canceling,at] of cases){
    const f=fixture();portalUpdate(f);alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,name);
    const [,args]=f.calls.find(c=>c[0]==='settle');
    assert.equal(args.p_cancel_at_period_end,canceling,name);
    const expected=at==='end'?new Date(f.sub.current_period_end*1000).toISOString():at==='early'?new Date((f.sub.current_period_end-86400*30)*1000).toISOString():null;
    assert.equal(args.p_cancel_at,expected,name);
    assert.equal(args.p_period_end,new Date(f.sub.current_period_end*1000).toISOString(),`${name}: the paid period is unchanged`);
  }
});
// Review finding on BILL-005: the same classic billing mode shape after the
// first charge. A Dashboard cancellation date inside a paid year resets
// billing_cycle_anchor to the moment of the update (after the quote anchor)
// and ends the current period at the date. Stripe may also leave a $0 or
// credit subscription_update invoice from the reset as the latest invoice.
// Each used to refuse with 503 on every event, the final deleted event too,
// so the card kept saying it renews.
function markClassicPaidCancel(f, {invoice='paid', anchor=f.anchor ?? null}={}) {
  const base=anchor ?? Math.floor(now/1000);
  const reset=base+100*86400, cancelAt=base+200*86400;
  // The year paid at the anchor (deferred) or at checkout (pay-first).
  f.invoice.lines.data[0].period={start:base,end:base+31536000};f.invoice.lines.data[0].proration=false;
  const paid=structuredClone(f.invoice);
  f.listed=[];f.paidInvoices=[paid];
  f.stripe.invoices.list=async params=>{f.listed.push(params);return{data:[...f.paidInvoices].reverse().map(i=>structuredClone(i)),has_more:false};};
  Object.assign(f.sub,{billing_cycle_anchor:reset,cancel_at:cancelAt,cancel_at_period_end:false,current_period_start:reset,current_period_end:cancelAt,latest_invoice:'in_A'});
  if(invoice==='update'||invoice==='credit') {
    Object.assign(f.invoice,{id:'in_Update',billing_reason:'subscription_update',amount_paid:0,amount_due:0,amount_remaining:0,total:invoice==='credit'?-2700:0,subtotal:invoice==='credit'?-2700:0,status_transitions:{paid_at:reset}});
    f.invoice.lines.data=[{price:f.price.id,quantity:1,amount:invoice==='credit'?-2700:0,period:{start:reset,end:cancelAt},proration:true}];
    f.sub.latest_invoice='in_Update';f.paidInvoices.push(structuredClone(f.invoice));
  }
  f.event.type='customer.subscription.updated';f.event.data.object={id:f.sub.id};
  return cancelAt;
}
// Review finding on b20d094c: the reset invoice is no payment, but settling it
// with no proof wrote membership_active false (20260921020000: eligible needs
// a proof), taking away the year the member paid for. The proof is now that
// year's own invoice, verified against the period now running; it never asks
// for the welcome email or the trial again.
function assertPaidYearProof(f, args, proof, invoice, label) {
  if(invoice==='paid') {
    assert.equal(proof.invoiceId,'in_A',label);assert.equal(f.listed.length,0,`${label}: the paid invoice is the latest, nothing is listed`);
  } else {
    assert.ok(proof,`${label}: a paid year, not a settlement without one`);
    assert.equal(proof.invoiceId,'in_A',`${label}: the paid year's invoice, never the reset invoice`);
    assert.equal(proof.initial,false,`${label}: no second welcome email or trial`);
    assert.deepEqual(f.listed,[{subscription:f.sub.id,status:'paid',limit:100,expand:['data.lines.data.price']}],label);
  }
  assert.equal(proof.annualCents,f.offer.unitAmount,label);
  assert.equal(proof.periodEnd,args.p_period_end,`${label}: the settled period, as the SQL requires`);
  assert.equal(proof.subscriptionId,f.sub.id,label);
}
test('a paid deferred membership cancelled mid-year in classic billing mode settles with that date, the quote anchor and the paid year',async()=>{
  for(const invoice of['paid','update','credit'])for(const offerId of['core','core_locum']) {
    const f=deferredFixture(20*86400000,offerId);markDeferredPaid(f);const cancelAt=markClassicPaidCancel(f,{invoice});
    const res=await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true));
    assert.equal(res.status,200,`${invoice} ${offerId}`);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');
    assert.equal(args.p_billing_anchor,f.anchor,'the quote anchor, not the reset');
    assert.equal(args.p_cancel_at_period_end,true);
    assert.equal(args.p_cancel_at,new Date(cancelAt*1000).toISOString());assert.equal(args.p_period_end,args.p_cancel_at);
    assertPaidYearProof(f,args,proof,invoice,`${invoice} ${offerId}`);
    assert.equal(proof.paidAt,new Date(f.anchor*1000).toISOString());
    if(invoice==='paid') assert.equal(proof.initial,true,'the paid invoice itself: as before');
    // The cancellation then happens: the final deleted event settles too.
    f.calls.length=0;f.sub.status='canceled';f.event.type='customer.subscription.deleted';f.event.id='evt_Deleted';
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,`deleted ${invoice} ${offerId}`);
    const [,ended,,none]=f.calls.find(c=>c[0]==='settle');assert.equal(ended.p_status,'canceled');assert.equal(none,null);assert.equal(ended.p_billing_anchor,f.anchor);
  }
});
test('a pay-first membership cancelled mid-year in classic billing mode settles with the paid year even when the reset invoice is the latest',async()=>{
  for(const invoice of['paid','update','credit'])for(const offerId of['core','core_locum']) {
    const f=fixture(offerId,offerId==='core'?'founding':'standard');const cancelAt=markClassicPaidCancel(f,{invoice,anchor:null});
    const res=await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true));
    assert.equal(res.status,200,`${invoice} ${offerId}`);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');
    assert.equal(args.p_cancel_at_period_end,true);assert.equal(args.p_cancel_at,new Date(cancelAt*1000).toISOString());
    assertPaidYearProof(f,args,proof,invoice,`${invoice} ${offerId}`);
  }
});
// Review finding on b20d094c: support removing that date again. Stripe keeps
// the reset anchor and the shortened period, with no cancel_at. It used to be
// refused (503) on every event: always for a deferred member, and for a
// pay-first one while the reset invoice was the latest.
function undoClassicPaidCancel(f, invoice) {
  f.sub.cancel_at=null;
  if(invoice!=='paid') {
    // The removal may finalize another $0 subscription_update invoice.
    f.invoice.id='in_Undo';f.invoice.total=0;f.invoice.subtotal=0;f.invoice.lines.data[0].amount=0;f.sub.latest_invoice='in_Undo';f.paidInvoices.push(structuredClone(f.invoice));
  }
  f.calls.length=0;f.listed.length=0;f.event.id='evt_Undo';
}
test('a paid-year cancellation date removed again settles as renewing, with the paid year, deferred and pay-first',async()=>{
  for(const deferred of[true,false])for(const invoice of['paid','update','credit'])for(const offerId of['core','core_locum']) {
    const label=`${deferred?'deferred':'pay-first'} ${invoice} ${offerId}`;
    const f=deferred?deferredFixture(20*86400000,offerId):fixture(offerId,offerId==='core'?'founding':'standard');
    if(deferred) markDeferredPaid(f);
    const cancelAt=markClassicPaidCancel(f,{invoice,anchor:deferred?f.anchor:null});
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,`set ${label}`);
    undoClassicPaidCancel(f,invoice);
    const logs=[];f.deps.log=entry=>logs.push(entry);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,`undo ${label}`);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');
    assert.equal(args.p_cancel_at_period_end,false,label);assert.equal(args.p_cancel_at,null,label);
    assert.equal(args.p_period_end,new Date(cancelAt*1000).toISOString(),`${label}: the period the reset left`);
    assert.equal(args.p_billing_anchor,deferred?f.anchor:null,label);
    assertPaidYearProof(f,args,proof,invoice,label);
    // Stripe renews at that period end, before the paid year's own end:
    // support is told (deferred: the quoted schedule moved).
    assert.deepEqual(logs.filter(l=>l.event==='deferred_schedule_moved').length,deferred?1:0,label);
    assert.deepEqual(logs.filter(l=>l.event==='limited_billing_failure'),[],label);
  }
});
// The renewal Stripe charges at the old date, as Stripe finalizes it: a
// credit the reset left on the customer balance (-2700) is spent on it, so it
// collects the year less that credit (starting_balance -2700, ending 0),
// while total and the line are still the whole year. A $0 reset leaves no
// credit and the renewal collects the year.
function classicRenewal(f, cancelAt, invoice) {
  const end=cancelAt+31536000, credit=invoice==='credit'?2700:0;
  Object.assign(f.sub,{current_period_start:cancelAt,current_period_end:end,latest_invoice:'in_Renewal'});
  Object.assign(f.invoice,{id:'in_Renewal',billing_reason:'subscription_cycle',amount_paid:f.offer.unitAmount-credit,amount_due:f.offer.unitAmount-credit,amount_remaining:0,total:f.offer.unitAmount,subtotal:f.offer.unitAmount,starting_balance:-credit,ending_balance:0,status_transitions:{paid_at:cancelAt+60}});
  f.invoice.lines.data=[{price:f.price.id,quantity:1,amount:f.offer.unitAmount,period:{start:cancelAt,end},proration:false}];
  f.event.type='invoice.paid';f.event.data.object={subscription:f.sub.id};
  f.calls.length=0;f.listed.length=0;f.event.id='evt_Renewal';
  return end;
}
test('after a removed paid-year cancellation date, the renewal Stripe charges at the old date settles as a renewal, the reset credit applied or not',async()=>{
  for(const deferred of[true,false])for(const invoice of['update','credit'])for(const offerId of['core','core_locum']) {
    const label=`${deferred?'deferred':'pay-first'} ${invoice} ${offerId}`;
    const f=deferred?deferredFixture(20*86400000,offerId):fixture(offerId,offerId==='core'?'founding':'standard');
    if(deferred) markDeferredPaid(f);
    const cancelAt=markClassicPaidCancel(f,{invoice,anchor:deferred?f.anchor:null});
    undoClassicPaidCancel(f,invoice);
    const end=classicRenewal(f,cancelAt,invoice);
    const logs=[];f.deps.log=entry=>logs.push(entry);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,label);
    const [,args,,proof]=f.calls.find(c=>c[0]==='settle');
    assert.equal(proof.invoiceId,'in_Renewal',label);assert.equal(proof.initial,false,'a renewal never asks');assert.equal(proof.periodEnd,args.p_period_end,label);
    assert.equal(args.p_period_end,new Date(end*1000).toISOString(),`${label}: access runs the renewed year, not to the old date`);
    assert.equal(proof.annualCents,f.offer.unitAmount,`${label}: the year's price, the credit is no discount`);
    assert.equal(f.listed.length,0,label);assert.equal(args.p_billing_anchor,deferred?f.anchor:null,label);
    assert.deepEqual(logs,[],`${label}: the renewed period is no longer the one the reset began`);
  }
});
test('a renewal paid in part from a credit settles only when the credit is exactly what Stripe applied',async()=>{
  const refused=[
    ['amount due is not the year less the credit',f=>{f.invoice.amount_due-=100;f.invoice.amount_paid-=100;}],
    ['the credit discounts the year itself',f=>{f.invoice.total-=2700;}],
    ['ending balance does not follow',f=>{f.invoice.ending_balance=-100;}],
    ['a debt on the balance',f=>{f.invoice.starting_balance=2700;}],
    ['a credit with no amount due recorded',f=>{f.invoice.amount_due=f.offer.unitAmount;}],
    ['a credit the renewal never spent',f=>{f.invoice.amount_due=f.offer.unitAmount;f.invoice.amount_paid=f.offer.unitAmount;f.invoice.ending_balance=-2700;}],
  ];
  for(const [name,alter] of refused) {
    const f=deferredFixture(20*86400000,'core');markDeferredPaid(f);const cancelAt=markClassicPaidCancel(f,{invoice:'credit'});
    undoClassicPaidCancel(f,'credit');classicRenewal(f,cancelAt,'credit');alter(f);
    const logs=[];f.deps.log=entry=>logs.push(entry);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,name);
    assert.ok(!f.calls.some(c=>c[0]==='settle'),name);
  }
  // A credit larger than the year: the renewal collects nothing and the
  // rest stays on the balance.
  const f=deferredFixture(20*86400000,'core');markDeferredPaid(f);const cancelAt=markClassicPaidCancel(f,{invoice:'credit'});
  undoClassicPaidCancel(f,'credit');classicRenewal(f,cancelAt,'credit');
  Object.assign(f.invoice,{starting_balance:-(f.offer.unitAmount+500),ending_balance:-500,amount_due:0,amount_paid:0});
  assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200);
  assert.equal(f.calls.find(c=>c[0]==='settle')[3].invoiceId,'in_Renewal');
});
test('a purchase after a cancellation that left a reset credit unspent: the first invoice spends it and the membership settles',async()=>{
  // A Dashboard cancellation date inside a paid year (classic mode) leaves a
  // credit on the customer; the subscription ends at the date with it unspent.
  // The member buys again (20260930001000), limited-checkout reuses the Stripe
  // customer, and Stripe spends the credit on the new subscription's first
  // invoice. That invoice was refused (503 on every delivery) while the member
  // had paid the year less the credit.
  for(const offerId of['core','core_locum']) {
    const f=fixture(offerId,offerId==='core'?'founding':'standard');const credit=2700;
    Object.assign(f.invoice,{amount_paid:f.offer.unitAmount-credit,amount_due:f.offer.unitAmount-credit,total:f.offer.unitAmount,subtotal:f.offer.unitAmount,starting_balance:-credit,ending_balance:0});
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,200,offerId);
    const settled=f.calls.find(c=>c[0]==='settle');
    assert.ok(settled,`${offerId}: settled`);
    assert.equal(settled[3].annualCents,f.offer.unitAmount,`${offerId}: the year's price, the credit is no discount`);
    assert.equal(settled[3].initial,true,`${offerId}: still the first purchase`);
  }
  // A credit larger than the year: nothing is collected, the rest stays.
  const g=fixture();
  Object.assign(g.invoice,{amount_paid:0,amount_due:0,total:g.offer.unitAmount,subtotal:g.offer.unitAmount,starting_balance:-(g.offer.unitAmount+500),ending_balance:-500});
  assert.equal((await createLimitedLaunchHandlers(g.deps,config).webhook(request({},true))).status,200);
  // Only the exact arithmetic: the same refusals a renewal gets.
  const refused=[
    ['amount due is not the year less the credit',f=>{f.invoice.amount_due-=100;f.invoice.amount_paid-=100;}],
    ['the credit discounts the year itself',f=>{f.invoice.total-=2700;}],
    ['ending balance does not follow',f=>{f.invoice.ending_balance=-100;}],
    ['a debt on the balance',f=>{f.invoice.starting_balance=2700;}],
    ['a credit the invoice never spent',f=>{f.invoice.amount_due=f.offer.unitAmount;f.invoice.amount_paid=f.offer.unitAmount;f.invoice.ending_balance=-2700;}],
    ['a credit on an invoice that is no annual payment',f=>{f.invoice.billing_reason='manual';}],
  ];
  for(const [name,alter] of refused) {
    const f=fixture();
    Object.assign(f.invoice,{amount_paid:f.offer.unitAmount-2700,amount_due:f.offer.unitAmount-2700,total:f.offer.unitAmount,subtotal:f.offer.unitAmount,starting_balance:-2700,ending_balance:0});
    alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,name);
    assert.ok(!f.calls.some(c=>c[0]==='settle'),name);
  }
});
test('classic mid-year cancellation: only that exact shape relaxes the anchor or skips the payment check',async()=>{
  const deferred=[
    ['cancel date is not the period end',f=>{f.sub.current_period_end=f.sub.cancel_at+1;}],
    ['reset after the cancel date',f=>{f.sub.billing_cycle_anchor=f.sub.cancel_at;}],
    ['no cancel date, a period from before the reset',f=>{f.sub.cancel_at=null;f.sub.current_period_start=f.sub.billing_cycle_anchor-1;}],
    ['metadata anchor moved',f=>{f.sub.metadata.billing_start_at=String(f.sub.billing_cycle_anchor);}],
    ['reset before the quote anchor',f=>{f.sub.billing_cycle_anchor=f.anchor-1;}],
    ['a trial',f=>{f.sub.trial_end=f.anchor;}],
  ];
  for(const [name,alter] of deferred)for(const invoice of['paid','update']) {
    const f=deferredFixture();markDeferredPaid(f);markClassicPaidCancel(f,{invoice});f.deps.log=()=>{};alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,`${name} ${invoice}`);assert.equal(f.calls.some(c=>c[0]==='settle'),false,name);
  }
  const paid=[
    ['paid year started after the reset',f=>{f.invoice.lines.data[0].period={start:f.sub.billing_cycle_anchor+1,end:f.sub.billing_cycle_anchor+1+31536000};}],
    ['paid year ends before the cancel date',f=>{f.invoice.lines.data[0].period.end=f.sub.cancel_at-1;}],
    ['paid before the quote anchor',f=>{f.invoice.status_transitions.paid_at=f.anchor-1;}],
  ];
  for(const [name,alter] of paid) {
    const f=deferredFixture();markDeferredPaid(f);markClassicPaidCancel(f,{invoice:'paid'});alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,name);assert.equal(f.calls.some(c=>c[0]==='settle'),false,name);
  }
  // The reset invoice is never verified as a payment, and the paid year
  // behind it must be found, cover the period and verify: otherwise the
  // event is refused (503) and the row settled before stays as it was.
  const update=[
    ['the update invoice took money',f=>{Object.assign(f.invoice,{amount_paid:9900,amount_due:9900,total:9900});}],
    ['the update invoice is still owed',f=>{f.invoice.amount_remaining=100;}],
    ['not cancelling, and no paid year covers the longer period',f=>{f.sub.cancel_at=null;f.sub.current_period_end=f.sub.billing_cycle_anchor+31536000;}],
    ['another customer\'s invoice',f=>{f.invoice.customer='cus_Other';}],
    ['another subscription\'s invoice',f=>{f.invoice.subscription='sub_Other';}],
    ['no paid year at all',f=>{f.paidInvoices=f.paidInvoices.filter(i=>i.id!=='in_A');}],
    ['the list has more than one page',f=>{const list=f.stripe.invoices.list;f.stripe.invoices.list=async p=>({...await list(p),has_more:true});}],
    ['the paid year began after the reset',f=>{f.paidInvoices[0].lines.data[0].period.start=f.sub.billing_cycle_anchor+1;}],
    ['the paid year ends before the period end',f=>{f.paidInvoices[0].lines.data[0].period.end=f.sub.current_period_end-1;}],
    ['the paid year was prorated',f=>{f.paidInvoices[0].lines.data[0].proration=true;}],
    ['the paid year underpaid',f=>{Object.assign(f.paidInvoices[0],{amount_paid:1});}],
    ['the paid year is another subscription\'s',f=>{f.paidInvoices[0].subscription='sub_Other';}],
    ['the paid year is another customer\'s',f=>{f.paidInvoices[0].customer='cus_Other';}],
  ];
  for(const [name,alter] of update) {
    const f=fixture();markClassicPaidCancel(f,{invoice:'update',anchor:null});f.deps.log=()=>{};alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,name);assert.equal(f.calls.some(c=>c[0]==='settle'),false,name);
  }
  const deferredUpdate=[
    ['the paid year was paid before the quote anchor',f=>{f.paidInvoices[0].status_transitions.paid_at=f.anchor-1;}],
    ['the paid year began before the quote anchor',f=>{f.paidInvoices[0].lines.data[0].period.start=f.anchor-1;}],
  ];
  for(const [name,alter] of deferredUpdate)for(const undo of[false,true]) {
    const f=deferredFixture();markDeferredPaid(f);markClassicPaidCancel(f,{invoice:'credit'});f.deps.log=()=>{};if(undo) f.sub.cancel_at=null;alter(f);
    assert.equal((await createLimitedLaunchHandlers(f.deps,config).webhook(request({},true))).status,503,`${name} ${undo}`);assert.equal(f.calls.some(c=>c[0]==='settle'),false,name);
  }
});
