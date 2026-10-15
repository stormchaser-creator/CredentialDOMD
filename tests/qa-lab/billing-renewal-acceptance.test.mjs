import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkCancelledRenewal } from '../../qa-lab/e2e/support/billing-renewal.mjs';

const periodEnd = '2030-01-01T04:05:06+00:00';
const subscription = {cancel_at_period_end:true,period_end:periodEnd};
const button = 'Cancel and get a refund';
const source = readFileSync(new URL('../../src/utils/membershipTiming.js', import.meta.url),'utf8').replaceAll('export ', '');
class BrowserDate extends Date {
  toLocaleString(_locale, options) { return super.toLocaleString('en-GB',{...options,timeZone:'Pacific/Honolulu'}); }
}
function currentCopy(value = periodEnd) {
  return vm.runInNewContext(`${source}\nmembershipRenewalCopy(access)`, {Date:BrowserDate,Intl,access:{purchasedOfferId:'core',billingRenewal:{cancelAtPeriodEnd:true,periodEnd:value}}});
}
function fixture({disclosure=currentCopy(),visible=true,count=1,extra='',row=subscription}={}) {
  const checks=[];let evaluations=0;
  const card=['Credential membership is active.',visible ? disclosure : '',button,extra].filter(Boolean).join('\n');
  const membership={innerText:async()=>card,getByText:pattern=>{
    const matches=pattern.test(disclosure||'') ? count : 0;
    return {waitFor:async()=>{if(!visible||matches!==1) throw Error('not one visible disclosure');},count:async()=>matches,isVisible:async()=>visible&&matches===1,innerText:async()=>disclosure};
  }};
  const page={getByRole:(role,options)=>{assert.equal(role,'region');assert.deepEqual(options,{name:'Membership'});return membership;},
    evaluate:async(fn,value)=>{evaluations++;return vm.runInNewContext(`(${fn.toString()})(value)`,{Date:BrowserDate,Intl,value});}};
  return {card,checks,run:()=>checkCancelledRenewal(page,{check:(name,passed,detail)=>checks.push({name,passed,detail})},row),evaluations:()=>evaluations};
}

test('legacy generic Cancel button passes the old matcher but fails cancellation acceptance', async()=>{
  const f=fixture({disclosure:null,extra:'It renews on January 1, 2030.'});
  assert.match(f.card,/(ends|end on|until|will not renew|cancel)/i,'the old whole-card matcher is demonstrably false green');
  await f.run();assert.deepEqual(f.checks.map(c=>c.passed),[false,false,false]);
});
test('current product copy passes with the persisted end formatted in a different browser locale and time zone',async()=>{
  const f=fixture();await f.run();assert.equal(f.evaluations(),1);assert.deepEqual(f.checks.map(c=>c.passed),[true,true,true]);
  assert.match(currentCopy(),/31 December 2029/,'browser time crosses the UTC day; not the Node or database calendar date');
});
for(const [name,change] of [['hidden disclosure',{visible:false}],['duplicate disclosures',{count:2}],['missing disclosure',{disclosure:null}]]) {
  test(`${name} never passes even though the Cancel button remains`,async()=>{
    const f=fixture(change);await f.run();assert.deepEqual(f.checks.map(c=>c.passed),[false,false,true]);
  });
}
test('a correct cancellation sentence with the wrong date fails the persisted period-end check',async()=>{
  const f=fixture({disclosure:currentCopy('2030-01-02T04:05:06Z')});await f.run();assert.deepEqual(f.checks.map(c=>c.passed),[true,false,true]);
});
test('missing or malformed stored dates cannot certify the displayed end',async()=>{
  for(const value of [undefined,null,'not-a-date']){
    const f=fixture({row:{cancel_at_period_end:true,period_end:value}});await f.run();assert.equal(f.checks[1].passed,false);assert.equal(f.evaluations(),0);
  }
  const f=fixture({row:{...subscription,cancel_at_period_end:false}});await f.run();assert.equal(f.checks[0].passed,false);
});
test('correct cancellation copy cannot hide a contradictory affirmative renewal line',async()=>{
  for(const extra of ['It renews on January 1, 2030.','Your membership will renew on January 1, 2030.']){
    const f=fixture({extra});await f.run();assert.deepEqual(f.checks.map(c=>c.passed),[true,true,false]);
  }
});
