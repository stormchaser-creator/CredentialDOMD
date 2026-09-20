import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PUBLIC_BILLING_POLICY, CREDENTIAL_PRICE_PHASES, getPublicBillingOffer, getPublicBillingOffers, canonicalCohortMembers, verifiedCorePurchase } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { createAccessPolicyHandler } from '../../supabase/functions/_shared/accessPolicyHandler.mjs';
const pid='10000000-0000-4000-8000-000000000001';
function fixture(phase='founding') {
  const offer=getPublicBillingOffer('core',phase), amount=offer.unitAmount;
  const price={id:'price_a',product:offer.productId,lookup_key:offer.lookupKey,unit_amount:amount,currency:'usd',livemode:false,type:'recurring',recurring:{interval:'year',interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit'};
  return {livemode:false,profile:{id:pid,auth_user_id:'user_a',access_status:'active'},account:{profile_id:pid,livemode:false,stripe_customer_id:'cus_a'},
    subscription:{id:'sub_a',customer:'cus_a',livemode:false,status:'active',current_period_end:1900000000,items:{data:[{price,quantity:1}]},metadata:{app:'credentialdomd',profile_id:pid,clerk_user_id:'user_a',offer_id:'core',pricing_policy_version:PUBLIC_BILLING_POLICY.version,price_phase:phase}},
    invoice:{id:'in_a',customer:'cus_a',subscription:'sub_a',livemode:false,status:'paid',paid:true,billing_reason:'subscription_create',currency:'usd',status_transitions:{paid_at:1800000000},amount_paid:amount,amount_due:amount,amount_remaining:0,lines:{has_more:false,data:[{price:'price_a',quantity:1,amount}]}}};
}
test('authoritative planned prices and product scopes never introduce automatic trial billing',()=>{
  assert.deepEqual(CREDENTIAL_PRICE_PHASES,{founding:9900,earlybird:14900,standard:19900});
  for(const phase of Object.keys(CREDENTIAL_PRICE_PHASES)){
    const [core,full]=getPublicBillingOffers(phase);
    assert.equal(core.unitAmount,CREDENTIAL_PRICE_PHASES[phase]); assert.equal(core.annualCents,core.unitAmount);
    assert.equal(full.unitAmount,24500); assert.equal(full.annualCents,24500);assert.equal(full.priceLockedWhileActive,false);
    assert.equal(core.practiceTrialDays,30);assert.equal(full.practiceTrialDays,0);assert.equal(core.trialAutoCharges,false);
    assert.equal(core.priceLockedWhileActive,phase!=='standard');
  }
  assert.equal(PUBLIC_BILLING_POLICY.billingEnabled,false);assert.equal(PUBLIC_BILLING_POLICY.checkoutEnabled,false);assert.equal(PUBLIC_BILLING_POLICY.enforcementEnabled,true);
  assert.equal(PUBLIC_BILLING_POLICY.pricePhase,'founding');assert.equal(PUBLIC_BILLING_POLICY.publicFoundingCapacity,100);
  assert.throws(()=>getPublicBillingOffer('core','madeup'));assert.equal(getPublicBillingOffer('free'),null);
});
test('cohort canonicalization binds immutable identity pairs and rejects duplicates or malformed data',()=>{
  const a={profileId:pid,clerkSubject:'user_a'},b={profileId:'10000000-0000-4000-8000-000000000002',clerkSubject:'user_b'};
  assert.equal(canonicalCohortMembers([b,a]),canonicalCohortMembers([a,b]));
  assert.equal(createHash('sha256').update(canonicalCohortMembers([a,b])).digest('hex').length,64);
  for(const members of [[],[a,a],[a,{...b,clerkSubject:'user_a'}],[{...a,profileId:'email@example.com'}],[{...a,clerkSubject:'user_"injected'}]])assert.throws(()=>canonicalCohortMembers(members));
});
test('exact paid initial core invoice produces a proof for all phases and both invoice shapes',()=>{
  for(const phase of Object.keys(CREDENTIAL_PRICE_PHASES))for(const basil of [false,true]){
    const f=fixture(phase);if(basil){delete f.invoice.subscription;f.invoice.parent={type:'subscription_details',subscription_details:{subscription:'sub_a'}};}
    const proof=verifiedCorePurchase(f);assert.equal(proof.annualCents,CREDENTIAL_PRICE_PHASES[phase]);assert.equal(proof.paidAt,'2027-01-15T08:00:00.000Z');assert.equal(proof.clerkSubject,'user_a');
  }
});
test('unpaid, renewals, trials, discounts, bad bindings, modes, lines and prices cannot authorize a grant',()=>{
  for(const mutate of [f=>f.invoice.paid=false,f=>f.invoice.status='open',f=>f.invoice.billing_reason='subscription_cycle',f=>f.subscription.trial_end=1800000100,f=>f.invoice.total_discount_amounts=[{amount:1}],f=>f.invoice.total_discount_amounts={},f=>delete f.subscription.items.data[0].price.id,f=>f.subscription.items.data[0].price.product='prod_other',f=>f.invoice.amount_paid=1,f=>f.profile.access_status='revoked',f=>f.account.profile_id='other',f=>f.subscription.metadata.clerk_user_id='user_other',f=>f.subscription.metadata.price_phase='standard',f=>f.subscription.metadata.pricing_policy_version='old',f=>f.invoice.livemode=true,f=>f.invoice.customer='cus_other',f=>f.invoice.subscription='sub_other',f=>f.invoice.lines.has_more=true,f=>f.invoice.lines.data[0].price='price_other',f=>f.invoice.lines.data[0].quantity=2,f=>f.subscription.items.data[0].price.unit_amount='9900',f=>f.invoice.status_transitions.paid_at=Infinity,f=>f.invoice.status_transitions.paid_at='1800000000',f=>f.subscription.current_period_end=1]){
    const f=fixture();mutate(f);assert.throws(()=>verifiedCorePurchase(f));
  }
});
test('disabled adapter preserves active beta access without querying new tables, has no-store headers',async()=>{
  let reads=0;
  const handler=createAccessPolicyHandler({authenticate:async()=>({id:pid,auth_user_id:'user_a',access_status:'active'}),readOwnSnapshot:async()=>{reads++;throw Error('unapplied');}},{...PUBLIC_BILLING_POLICY,enforcementEnabled:false});
  const res=await handler(new Request('https://example.com',{method:'POST'}));const data=await res.json();
  assert.equal(res.status,200);assert.equal(reads,0);assert.equal(data.enforcementEnabled,false);assert.equal(data.capabilities.practice.write,true);assert.equal(data.billingEnabled,false);assert.equal(data.practiceTrial.autoCharges,false);assert.equal(res.headers.get('cache-control'),'no-store');
});
test('adapter rejects unbound or revoked access, foreign origin and incomplete cutover without leaking errors',async()=>{
  const req=()=>new Request('https://example.com',{method:'POST'});
  assert.equal((await createAccessPolicyHandler({authenticate:async()=>null})(req())).status,401);
  const h=createAccessPolicyHandler({authenticate:async()=>({id:pid,auth_user_id:'user_a',access_status:'revoked'})},{...PUBLIC_BILLING_POLICY,enforcementEnabled:false});
  assert.equal((await (await h(req())).json()).capabilities.practice.read,false);
  assert.equal((await h(new Request('https://example.com',{method:'POST',headers:{Origin:'https://other.example'}}))).status,403);
  const activated=createAccessPolicyHandler({authenticate:async()=>({id:pid,auth_user_id:'user_a'}),readOwnSnapshot:async()=>({schemaVersion:1,enforcementEnabled:false})},{...PUBLIC_BILLING_POLICY,enforcementEnabled:true});
  assert.deepEqual(await (await activated(req())).json(),{error:'access_policy_unavailable'});
});
