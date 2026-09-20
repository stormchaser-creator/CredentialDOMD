import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMembershipOfferHandler } from '../../supabase/functions/_shared/publicMembershipOffer.mjs';
import { expiredFoundingCheckoutProof } from '../../supabase/functions/_shared/foundingCheckout.mjs';

const endpoint = 'https://functions.example/public-membership-offer';
const request = (method='GET', origin='https://credentialdomd.com') => new Request(endpoint,{method,headers:origin?{origin}:{}});
const offer = {schemaVersion:1,phase:'founding',annualCents:9900,checkoutEnabled:true,availability:'available'};

test('anonymous public offer exposes only matching authoritative price and availability with no caching',async()=>{
  for(const [phase,annualCents] of [['founding',9900],['earlybird',14900],['standard',19900]])
    for(const availability of ['available','temporarily_full','paused']) {
      const expected={...offer,phase,annualCents,availability,checkoutEnabled:availability!=='paused'};
      const h=createPublicMembershipOfferHandler({readOffer:async()=>({...expected,email:'private@example.invalid',paidCount:42,remaining:58})});
      const response=await h(request());
      assert.equal(response.status,200);assert.deepEqual(await response.json(),expected);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'),'https://credentialdomd.com');
    }
});
test('foreign origins and writes never read policy; OPTIONS is bounded and authentication is unnecessary',async()=>{
  let reads=0;const h=createPublicMembershipOfferHandler({readOffer:async()=>{reads++;return offer;}});
  assert.equal((await h(request('GET','https://foreign.example'))).status,403);
  assert.equal((await h(request('POST'))).status,405);
  assert.equal((await h(request('OPTIONS'))).status,200);assert.equal(reads,0);
  assert.equal((await h(request('GET',null))).status,200);assert.equal(reads,1);
});
test('unavailable or inconsistent public policy never invents a founding price or remaining count',async()=>{
  for(const value of [null,{}, {...offer,phase:'unknown'}, {...offer,annualCents:14900}, {...offer,checkoutEnabled:'true'}, {...offer,availability:'sold_out'}, {...offer,availability:'paused'}, {...offer,checkoutEnabled:false}]) {
    const response=await createPublicMembershipOfferHandler({readOffer:async()=>value})(request());
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'membership_offer_unavailable'});
  }
  assert.equal((await createPublicMembershipOfferHandler({readOffer:async()=>{throw Error('private database detail');}})(request())).status,503);
});

function expiredFixture() {
  const config={app:'credentialdomd',version:'v2',policyVersion:'policy1'};
  const quote={public_founding_slot:1,offer_id:'core',price_phase:'founding',annual_cents:9900,profile_id:'profile1',clerk_subject:'user_one',livemode:false,attempt_id:'attempt1'};
  const account={profile_id:'profile1',livemode:false,stripe_customer_id:'cus_one'};
  const session={id:'cs_one',status:'expired',payment_status:'unpaid',mode:'subscription',subscription:null,livemode:false,customer:'cus_one',client_reference_id:'profile1',metadata:{app:'credentialdomd',catalog_version:'v2',pricing_policy_version:'policy1',checkout_attempt_id:'attempt1',profile_id:'profile1',clerk_user_id:'user_one',offer_id:'core',price_phase:'founding'}};
  return {config,quote,account,session};
}
test('only exact freshly expired unpaid subscription-less Checkout yields minimal release proof',()=>{
  const f=expiredFixture();
  assert.deepEqual(expiredFoundingCheckoutProof(f.session,f.quote,f.account,f.config),{session_id:'cs_one',customer_id:'cus_one',status:'expired',payment_status:'unpaid',subscription_id:null});
  f.session.customer={id:'cus_one'};assert.equal(expiredFoundingCheckoutProof(f.session,f.quote,f.account,f.config).customer_id,'cus_one');
});
test('paid, incomplete, foreign, unallocated and mode-mismatched Checkout cannot release a place',()=>{
  const mutations=[
    f=>f.session.status='open', f=>f.session.status='complete', f=>f.session.payment_status='paid',
    f=>f.session.subscription='sub_one', f=>delete f.session.subscription, f=>f.session.mode='payment',
    f=>f.session.livemode=true, f=>f.account.livemode=true, f=>f.account.profile_id='other',
    f=>f.session.customer='cus_other', f=>f.session.client_reference_id='other', f=>f.session.id='not_checkout',
    f=>f.quote.public_founding_slot=101, f=>delete f.quote.public_founding_slot,
    f=>f.quote.annual_cents=14900, f=>f.quote.offer_id='core_locum', f=>f.quote.price_phase='earlybird',
    ...['app','catalog_version','pricing_policy_version','checkout_attempt_id','profile_id','clerk_user_id','offer_id','price_phase'].map(key=>f=>{f.session.metadata[key]='other';}),
  ];
  for(const mutate of mutations) {const f=expiredFixture();mutate(f);assert.throws(()=>expiredFoundingCheckoutProof(f.session,f.quote,f.account,f.config));}
});
