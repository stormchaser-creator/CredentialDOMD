import test from 'node:test';
import assert from 'node:assert/strict';
import { accessAt, validateAccessSnapshot, createAccessAuthority, ACCESS_REFRESH_MS, allowsDataChange, canReviewBillingOffer, membershipReadOnly, accessVerifying, writeRefusalMessage, alertWriteRefused, RECONNECTING_MESSAGE, OUTDATED_MESSAGE, membershipWriteError, scopesForWrite, writeAllowedNow } from '../../src/utils/limitedLaunchAccess.js';
import { BASE_KEYS } from '../../src/utils/storageScope.js';
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
  // No answer this session: the device's remembered answer decides, and with
  // none at all the archive waits for the first answer.
  assert.equal(membershipReadOnly(null, 'practice'), true, 'nothing to go on: the archive, as before any answer');
  assert.equal(membershipReadOnly(null, 'practice', { credential: true, practice: true }), false);
  assert.equal(membershipReadOnly(null, 'practice', { credential: true, practice: false }), true);
  assert.equal(membershipReadOnly(null, 'credential', { credential: true, practice: false }), false);
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

// Review of ticket fe321c16's fix: a refusal said "Reconnecting, try again"
// to a member the last answer had made read-only, on the same page as the
// archive saying so.
test('a refusal is "reconnecting" only for a scope the last answer did not deny', () => {
  let now = 0, clock = 1e12;
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => 'user_a', now: () => now, memory: null });
  authority.reset('user_a');
  const beta = fixture(); beta.purchasedOfferId = null; beta.practiceTrial = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
  beta.capabilities.credential.write = false; beta.capabilities.practice.write = false;
  authority.accept('user_a', beta);
  now = ACCESS_REFRESH_MS + 1;
  assert.equal(authority.state().needsRefresh, true);
  assert.equal(accessVerifying(authority, 'credential'), false);
  assert.equal(accessVerifying(authority, 'practice'), false);
  assert.equal(accessVerifying(authority), false, 'no scope is open');
  const shown = [];
  alertWriteRefused({ authority, scope: 'credential', alert: m => shown.push(m), now: () => (clock += 5000) });
  assert.deepEqual(shown, [membershipWriteError().message], 'starring a record says read-only, as the archive does');
  // Credential paid, Practice ended: a Credential change is reconnecting, a Practice one is not.
  const core = fixture(); core.practiceTrial = { state: 'none', startsAt: null, endsAt: null, autoCharges: false }; core.capabilities.practice.write = false;
  now = 0; authority.accept('user_a', core); now = ACCESS_REFRESH_MS + 1;
  assert.equal(writeRefusalMessage(authority, 'credential'), RECONNECTING_MESSAGE);
  assert.equal(writeRefusalMessage(authority, 'practice'), membershipWriteError().message);
  assert.equal(writeRefusalMessage(authority, ['credential', 'practice']), membershipWriteError().message, 'a new unfiled file needs both');
  assert.equal(accessVerifying(authority), true, 'one scope is still open');
});

test('each write names the scopes it needs, for its refusal', () => {
  assert.deepEqual(scopesForWrite('workLog', { id: 'w' }), ['practice']);
  assert.deepEqual(scopesForWrite('licenses', { id: 'l' }), ['credential']);
  assert.deepEqual(scopesForWrite('documents', { id: 'd', linkedTo: '' }), ['credential', 'practice']);
  assert.deepEqual(scopesForWrite('documents', { id: 'd', linkedTo: 'invoices:i' }), ['practice']);
  assert.deepEqual(scopesForWrite('documents', { id: 'd', linkedTo: 'licenses:l' }, { id: 'd', linkedTo: 'invoices:i' }), ['credential', 'practice']);
});

test('the device remembers the last answer per account, updates it when a trial ends, and never lets it authorize a write', () => {
  let now = 0, actor = 'user_a';
  const saved = new Map();
  const memory = { read: id => saved.get(id) ?? null, write: (id, value) => saved.set(id, { ...value }) };
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => actor, now: () => now, memory });
  // Before reset (the first render of a sign-in), the device's copy is read through.
  saved.set('user_a', { credential: true, practice: false });
  assert.deepEqual(authority.remembered('user_a'), { credential: true, practice: false });
  authority.reset('user_a');
  assert.deepEqual(authority.remembered(), { credential: true, practice: false });
  assert.equal(authority.state(), null);
  assert.equal(authority.allows('credential', 'write'), false, 'a remembered answer never authorizes a write');
  const snapshot = fixture();
  authority.accept('user_a', snapshot);
  assert.deepEqual(saved.get('user_a'), { credential: true, practice: true });
  now = 1001; // the Practice trial ends while the app is open
  authority.state();
  assert.deepEqual(saved.get('user_a'), { credential: true, practice: false });
  actor = 'user_b';
  assert.equal(authority.remembered('user_a'), null, 'not while another account is signed in');
  // The key it uses is one the sign-out purge removes.
  assert.equal(BASE_KEYS.accessAnswer, 'credentialdomd-access-answer');
});

test('an answer is refreshed before it would go stale; its freshness is reported', () => {
  const snapshot = fixture(); snapshot.practiceTrial = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
  assert.equal(accessAt(snapshot, 0, 1000).freshForMs, ACCESS_REFRESH_MS - 1000);
  assert.equal(accessAt(snapshot, 0, ACCESS_REFRESH_MS + 5).freshForMs, 0);
});

test('an unreadable answer (an out-of-date build) is refused as such, not as reconnecting', () => {
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => 'user_a', now: () => 0, memory: null });
  authority.reset('user_a');
  authority.suspendWrites({ outdated: true });
  assert.equal(authority.outdated(), true);
  assert.equal(writeRefusalMessage(authority, 'practice'), OUTDATED_MESSAGE);
  assert.doesNotMatch(OUTDATED_MESSAGE, /\u{2014}/u);
  authority.accept('user_a', fixture());
  assert.equal(authority.outdated(), false);
});

test('an invoice is only sent when its record would be saved: writeAllowedNow refuses first, with the refusal message', () => {
  let now = 0;
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => 'user_a', now: () => now, memory: null });
  authority.reset('user_a');
  const checks = [];
  authority.setRecheck(() => checks.push('check'));
  const shown = [];
  const snapshot = fixture(); snapshot.practiceTrial = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
  authority.accept('user_a', snapshot);
  assert.equal(writeAllowedNow('practice', { authority, alert: m => shown.push(m), now: () => 1e13 }), true);
  now = ACCESS_REFRESH_MS + 1;
  assert.equal(writeAllowedNow('practice', { authority, alert: m => shown.push(m), now: () => 2e13 }), false);
  assert.deepEqual(shown, [RECONNECTING_MESSAGE]);
  assert.deepEqual(checks, ['check'], 'and a check starts at once');
});

test('the share-sheet invoice sends ask first, and record the invoice before marking anything billed', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = path => readFile(new URL(`../../src/components/features/locum/${path}`, import.meta.url), 'utf8');
  const work = await read('WorkLog.jsx'), duty = await read('DutyLog.jsx'), expenses = await read('Expenses.jsx');
  assert.match(work, /const sendInvoice = useCallback\(async \(format\) => \{\n(?:\s*\/\/.*\n)*\s*if \(!writeAllowedNow\("practice"\)\) return;/);
  assert.match(work, /if \(!writeAllowedNow\("practice"\)\) return; await copyToClipboard\(invoicePreview\.text\); markBilledAndLog\("clipboard"\);/);
  assert.match(duty, /const sendDutyInvoice = async \(format\) => \{\n(?:\s*\/\/.*\n)*\s*if \(!writeAllowedNow\("practice"\)\) return;/);
  assert.match(duty, /if \(!writeAllowedNow\("practice"\)\) return; copyToClipboard\(invoicePreview\.text\); markDutyBilled\("copy"\);/);
  assert.match(expenses, /if \(!writeAllowedNow\("practice"\)\) return;\n\s*setBusy\(true\);/);
  for (const [name, source, marker] of [['WorkLog', work, 'editItem("workLog", { ...e, invoiceId: invId })'], ['DutyLog', duty, 'editItem("dutyDays", { ...d, invoiceId: invId })'], ['Expenses', expenses, 'editItem("travelExpenses", { ...e, invoiceId })']]) {
    const recorded = source.indexOf('recorded === false');
    assert.ok(recorded > 0 && recorded < source.indexOf(marker), `${name} checks the invoice record before marking entries billed`);
  }
});
