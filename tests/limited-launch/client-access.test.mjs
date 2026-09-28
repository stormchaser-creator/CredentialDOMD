import test from 'node:test';
import assert from 'node:assert/strict';
import { accessAt, validateAccessSnapshot, createAccessAuthority, ACCESS_REFRESH_MS, allowsDataChange, canReviewBillingOffer, membershipReadOnly, accessVerifying, writeRefusalMessage, alertWriteRefused, RECONNECTING_MESSAGE, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const t = Date.parse('2026-09-19T12:00:00Z');
const fixture = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  evaluatedAt: new Date(t).toISOString(), enforcementEnabled: true, accessStatus: 'active',
  purchasedOfferId: 'core', billingEnabled: false,
  lifetime: { credential: false, practice: false },
  practiceTrial: { state: 'active', startsAt: '2026-09-05T12:00:01Z', endsAt: '2026-09-19T12:00:01Z', autoCharges: false },
  capabilities: { credential: { read: true, write: true, export: true }, practice: { read: true, write: true, export: true } },
});

test('trial expiry preserves paid Credential and both products read/export with a mismatched device clock', () => {
  const snapshot = fixture(), before = structuredClone(snapshot);
  const deviceReceipt = Date.parse('2040-01-01T00:00:00Z');
  const result = accessAt(snapshot, deviceReceipt, deviceReceipt + 1001);
  assert.equal(result.practiceTrial.state, 'expired');
  assert.equal(result.capabilities.practice.write, false);
  assert.equal(result.capabilities.credential.write, true);
  assert.deepEqual(result.capabilities.practice, { read: true, write: false, export: true });
  assert.equal(result.purchasedOfferId, 'core');
  assert.deepEqual(snapshot, before);
  assert.equal(result.practiceTrial.autoCharges, false);
});

test('lifetime and purchased Practice remain writable when an old trial reaches its end', () => {
  for (const mode of ['lifetime', 'purchased']) {
    const snapshot = fixture();
    if (mode === 'lifetime') snapshot.lifetime.practice = true;
    else snapshot.purchasedOfferId = 'core_locum';
    assert.equal(accessAt(snapshot, 0, 1001).capabilities.practice.write, true);
  }
});

test('stale or failed refresh retains readable exports but requires refreshed permission for writes', () => {
  let now = 0, actor = 'user_a';
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => actor, now: () => now });
  authority.reset(actor); authority.accept(actor, fixture());
  assert.equal(authority.allows('credential', 'write'), true);
  now = ACCESS_REFRESH_MS;
  assert.equal(authority.allows('credential', 'write'), false);
  assert.equal(authority.allows('practice', 'export'), true);
  authority.accept(actor, fixture()); authority.suspendWrites();
  assert.equal(authority.allows('credential', 'write'), false);
  assert.equal(authority.allows('credential', 'read'), true);
  authority.accept(actor, fixture());
  assert.equal(authority.allows('credential', 'write'), true);
});

test('account changes reject late responses and immediately remove the previous account capabilities', () => {
  let actor = 'user_a';
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => actor, now: () => 0 });
  authority.reset(actor); authority.accept(actor, fixture());
  actor = 'user_b';
  assert.equal(authority.allows('credential', 'write'), false);
  assert.equal(authority.state('user_a'), null);
  assert.equal(authority.accept('user_a', fixture()), false);
  authority.reset(actor);
  assert.equal(authority.allows('practice', 'export'), false);
  authority.accept(actor, fixture());
  assert.equal(authority.allows('practice', 'export'), true);
});

test('a document cannot escape expired Practice protection by moving its link to Credential', () => {
  const authority = createAccessAuthority({ enabled: true, now: () => 0 });
  authority.reset('user_a');
  const snapshot = fixture(); snapshot.capabilities.practice.write = false;
  authority.accept('user_a', snapshot);
  assert.equal(authority.allowsMutation('documents', { linkedTo: 'licenses:one' }, { linkedTo: 'locumContracts:two' }), false);
  assert.equal(authority.allowsMutation('documents', { linkedTo: 'invoices:two' }), false);
  assert.equal(authority.allowsMutation('documents', { linkedTo: 'licenses:one' }), true);
  assert.equal(authority.allowsMutation('invoices', {}), false);
});

test('malformed grants and claimed active capabilities on a revoked account are rejected', () => {
  for (const patch of [
    s => { s.capabilities.practice.write = 'true'; },
    s => { s.practiceTrial.autoCharges = true; },
    s => { s.practiceTrial.endsAt = s.practiceTrial.startsAt; },
    s => { s.accessStatus = 'revoked'; },
    s => { s.policyVersion = 'unrecognized'; },
  ]) {
    const value = fixture(); patch(value);
    assert.throws(() => validateAccessSnapshot(value), /could not be verified/);
  }
  assert.equal(validateAccessSnapshot(fixture()).practiceTrial.endsAt, fixture().practiceTrial.endsAt);
});

test('default-off authority preserves beta behavior; enabled authority does not treat disabled enforcement as permission', () => {
  const disabled = createAccessAuthority({ enabled: false });
  assert.equal(disabled.allowsMutation('invoices', {}), true);
  const enabled = createAccessAuthority({ enabled: true, now: () => 0 });
  enabled.reset('user_a');
  const snapshot = fixture(); snapshot.enforcementEnabled = false;
  enabled.accept('user_a', snapshot);
  assert.equal(enabled.allowsMutation('licenses', {}), false);
  assert.equal(enabled.allows('practice', 'export'), true);
});


test('grandfathered beta expiry preserves lifetime and separate paid Credential Practice trial', () => {
  const initial = fixture();
  initial.purchasedOfferId = null;
  initial.practiceTrial = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
  initial.freeBeta = { state: 'active', startsAt: '2026-08-20T12:00:01Z', endsAt: '2026-09-19T12:00:01Z', autoCharges: false };
  const expired = accessAt(initial, 100, 1101);
  assert.equal(expired.freeBeta.state, 'expired');
  assert.deepEqual(expired.capabilities, {credential:{read:true,write:false,export:true},practice:{read:true,write:false,export:true}});
  assert.equal(initial.freeBeta.state, 'active');
  initial.lifetime = { credential:true, practice:true };
  assert.equal(accessAt(initial, 100, 1101).capabilities.practice.write, true);
  initial.lifetime = { credential:false, practice:false };
  initial.purchasedOfferId = 'core'; initial.practiceTrial = fixture().practiceTrial;
  initial.practiceTrial.endsAt = '2026-09-20T12:00:00Z';
  const paid = accessAt(initial, 100, 1101);
  assert.equal(paid.capabilities.credential.write, true);
  assert.equal(paid.capabilities.practice.write, true);
});

test('atomic restore preflight denies mixed writes and deletions without modifying any saved data', () => {
  const authority = createAccessAuthority({ enabled:true, now:()=>0 });
  authority.reset('user_a'); const snapshot = fixture(); snapshot.capabilities.practice.write = false;
  authority.accept('user_a', snapshot);
  const previous = {settings:{theme:'dark',name:'Saved name'},licenses:[{id:'license',name:'Saved'}],invoices:[{id:'invoice',totalAmount:1200}],documents:[{id:'document',linkedTo:'invoices:invoice'}]};
  const backup = structuredClone(previous);
  assert.equal(allowsDataChange(previous, {...previous, licenses:[{id:'license',name:'Changed'}]}, authority),true);
  assert.equal(allowsDataChange(previous, {...previous, invoices:[]},authority),false);
  assert.equal(allowsDataChange(previous, {...previous, documents:[{id:'document',linkedTo:'licenses:license'}]},authority),false);
  assert.equal(allowsDataChange(previous, {...previous, settings:{...previous.settings,theme:'light'}},authority),true);
  assert.deepEqual(previous, backup);
  snapshot.capabilities.credential.write = false; authority.accept('user_a',snapshot);
  assert.equal(allowsDataChange(previous,{...previous,settings:{...previous.settings,name:'Changed'}},authority),false);
  assert.equal(allowsDataChange(previous,{...previous,settings:{...previous.settings,theme:'light'}},authority),true);
});

test('registered original document scope protects persistence and unknown deletions fail closed', () => {
  const authority = createAccessAuthority({ enabled:true, now:()=>0 });
  authority.reset('user_a'); const snapshot = fixture(); snapshot.capabilities.practice.write = false;
  authority.accept('user_a', snapshot);
  authority.registerRecords('user_a',{documents:[{id:'doc',linkedTo:'invoices:one'}]});
  assert.equal(authority.allowsMutation('documents',{id:'doc',linkedTo:'licenses:one'}),false);
  assert.equal(authority.allowsMutation('documents',{id:'unknown'}),false);
  authority.reset('user_b');
  assert.equal(authority.allowsMutation('documents',{id:'doc',linkedTo:'licenses:one'}),false);
});

test('resume validates its optional flag and exact offer pair without granting product access', () => {
  for (const offerId of ['core', 'core_locum']) {
    const snapshot = fixture();
    snapshot.purchasedOfferId = null; snapshot.billingEnabled = true; snapshot.checkoutEligible = false;
    snapshot.checkoutResumeAvailable = true; snapshot.checkoutResumeOfferId = offerId;
    snapshot.capabilities.credential.write = false; snapshot.capabilities.practice.write = false;
    const checked = validateAccessSnapshot(snapshot);
    assert.equal(canReviewBillingOffer(checked, offerId), true);
    assert.equal(canReviewBillingOffer(checked, offerId === 'core' ? 'core_locum' : 'core'), false);
    assert.deepEqual(checked.capabilities, snapshot.capabilities);
    // Even conflicting new-purchase eligibility cannot open an alternative while resuming.
    checked.checkoutEligible = true;
    assert.equal(canReviewBillingOffer(checked, offerId === 'core' ? 'core_locum' : 'core'), false);
  }
  assert.doesNotThrow(() => validateAccessSnapshot(fixture()));
  assert.doesNotThrow(() => validateAccessSnapshot({...fixture(), checkoutResumeAvailable:false, checkoutResumeOfferId:null}));
});

test('malformed resume fields and disabled billing cannot authorize a saved offer', () => {
  const base = {...fixture(), purchasedOfferId:null, billingEnabled:true, checkoutEligible:false};
  for (const patch of [
    {checkoutResumeAvailable:'true',checkoutResumeOfferId:'core'},
    {checkoutResumeAvailable:true,checkoutResumeOfferId:null},
    {checkoutResumeAvailable:true,checkoutResumeOfferId:'enterprise'},
    {checkoutResumeAvailable:false,checkoutResumeOfferId:'core'},
    {checkoutResumeOfferId:'core'},
    {checkoutResumeAvailable:true,checkoutResumeOfferId:'core',billingEnabled:false},
  ]) assert.throws(() => validateAccessSnapshot({...base,...patch}), /could not be verified/);
});

test('resume stops on stale membership, paid/lifetime/scheduled status, revocation, or account switch', () => {
  const base = {...fixture(),purchasedOfferId:null,billingEnabled:true,checkoutEligible:false,checkoutResumeAvailable:true,checkoutResumeOfferId:'core'};
  for (const patch of [
    {needsRefresh:true}, {billingEnabled:false}, {accessStatus:'revoked'}, {purchasedOfferId:'core'},
    {lifetime:{credential:true,practice:true}}, {scheduledMembership:{offerId:'core'}},
  ]) assert.equal(canReviewBillingOffer({...base,...patch},'core'),false);
  let actor='user_a';
  const authority=createAccessAuthority({enabled:true,currentAccount:()=>actor,now:()=>0});
  authority.reset(actor); authority.accept(actor,base);
  assert.equal(canReviewBillingOffer(authority.state(actor),'core'),true);
  actor='user_b';
  assert.equal(canReviewBillingOffer(authority.state('user_a'),'core'),false);
  assert.equal(authority.accept('user_a',base),false);
});

// Ticket fe321c16: an old snapshot or a failed check is "verifying", never a
// membership decision. Writes stay refused; the archive waits for the server.
test('an old or failed check keeps the server entitlement for the screens and still refuses every write', () => {
  let now = 0;
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => 'user_a', now: () => now });
  authority.reset('user_a');
  const snapshot = fixture(); snapshot.practiceTrial = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
  authority.accept('user_a', snapshot);
  assert.deepEqual(authority.state().entitled, { credential: true, practice: true });
  assert.equal(accessVerifying(authority), false);
  now = ACCESS_REFRESH_MS + 1;
  const stale = authority.state();
  assert.equal(stale.needsRefresh, true);
  assert.deepEqual(stale.entitled, { credential: true, practice: true });
  assert.equal(stale.capabilities.practice.write, false);
  assert.equal(membershipReadOnly(stale, 'practice'), false);
  assert.equal(authority.allowsMutation('workLog', { id: 'w' }), false);
  assert.equal(accessVerifying(authority), true);
  assert.equal(writeRefusalMessage(authority), RECONNECTING_MESSAGE);
  now = 0; authority.accept('user_a', snapshot); authority.suspendWrites();
  assert.deepEqual(authority.state().entitled, { credential: true, practice: true });
  assert.equal(authority.allows('credential', 'write'), false);
  assert.equal(membershipReadOnly(authority.state(), 'credential'), false);
});

test('only the server answer makes a scope read-only: a denial, an ended trial, or disabled enforcement', () => {
  const denied = fixture(); denied.practiceTrial = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
  denied.capabilities.practice.write = false;
  const fresh = accessAt(denied, 0, 0);
  assert.equal(membershipReadOnly(fresh, 'practice'), true);
  assert.equal(membershipReadOnly(fresh, 'credential'), false);
  // Still read-only while that denial is re-checked: no flicker to the editors.
  assert.equal(membershipReadOnly(accessAt(denied, 0, ACCESS_REFRESH_MS + 1), 'practice'), true);
  const trialEnded = accessAt(fixture(), 0, 1001);
  assert.equal(trialEnded.entitled.practice, false);
  const off = fixture(); off.enforcementEnabled = false;
  assert.deepEqual(accessAt(off, 0, 0).entitled, { credential: false, practice: false });
  assert.equal(membershipReadOnly(null, 'practice'), false, 'no answer yet is verifying, not read-only');
  assert.equal(membershipReadOnly({ needsRefresh: true, capabilities: { practice: { write: false } } }, 'practice'), false);
  assert.equal(membershipReadOnly({ capabilities: { practice: { write: false } } }, 'practice'), true);
});

test('a refused change says so once per burst, reconnecting while verifying and read-only otherwise', () => {
  let clock = 1_000_000;
  const shown = [];
  const verifying = { enabled: true, state: () => ({ needsRefresh: true }) };
  const denied = { enabled: true, state: () => ({ needsRefresh: false }) };
  assert.equal(alertWriteRefused({ authority: verifying, alert: m => shown.push(m), now: () => clock }), true);
  for (let i = 0; i < 20; i++) alertWriteRefused({ authority: verifying, alert: m => shown.push(m), now: () => clock });
  assert.deepEqual(shown, [RECONNECTING_MESSAGE], 'a bulk import refused while reconnecting says it once');
  clock += 3000;
  alertWriteRefused({ authority: denied, alert: m => shown.push(m), now: () => clock });
  assert.deepEqual(shown, [RECONNECTING_MESSAGE, membershipWriteError().message]);
  assert.doesNotMatch(RECONNECTING_MESSAGE, /\u{2014}/u);
  assert.equal(accessVerifying({ enabled: false, state: () => null }), false);
  assert.equal(accessVerifying({ enabled: true, state: () => null }), true);
});
