import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createLimitedLaunchClient } from '../../src/utils/limitedLaunchClient.js';
import { createAccessAuthority, canReviewBillingOffer } from '../../src/utils/limitedLaunchAccess.js';
import { readLaunchInvitation } from '../../src/utils/launchInvitation.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { LIMITED_LAUNCH } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';

// Execute the actual membership click handler, actual client transport, and
// actual server handler together. Only auth/database/provider dependencies are
// synthetic; no network, card, mailbox or persistent account is touched.
const source = await readFile(new URL('../../src/components/pages/LimitedLaunchMembership.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  const review = async offerId => {');
const end = source.indexOf('  const purchase = async () => {', start);
assert.ok(start >= 0 && end > start);
const code = source.slice(start, end) + '\nglobalThis.reviewOffer = review;';
const accountId = 'user_syntheticA';
const profileId = '10000000-0000-4000-8000-000000000001';
const token = 'synthetic_saved_launch_token_A1b2c3d4e5f6g7h8j9';

function fixture({ invitationEnabled = false, renderedInvitationEnabled = invitationEnabled } = {}) {
  const calls = [], storage = new Map([['credentialdomd.launch_invitation', token]]);
  const invitation = readLaunchInvitation({ storage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key) } });
  const snapshot = {
    schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-20T12:00:00Z',
    enforcementEnabled: true, accessStatus: 'pending', purchasedOfferId: null,
    billingEnabled: true, checkoutEligible: true, pricePhase: 'earlybird', invitationActivationEnabled: invitationEnabled,
    lifetime: { credential: false, practice: false },
    freeBeta: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
    practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
    capabilities: { credential: { read: false, write: false, export: false }, practice: { read: false, write: false, export: false } },
  };
  const authority = createAccessAuthority({ enabled: true, now: () => 0, currentAccount: () => accountId });
  authority.reset(accountId); assert.equal(authority.accept(accountId, snapshot), true);
  const config = { ...LIMITED_LAUNCH, billingEnabled: true, checkoutEnabled: true, invitationEnabled,
    productIds: { core: 'prod_SyntheticCredential', core_locum: 'prod_SyntheticPractice' } };
  const handlers = createLimitedLaunchHandlers({
    mode: 'test', assertConfigured() {}, authenticate: async () => ({ profileId, clerkSubject: accountId }),
    verifiedEmails: async () => { calls.push(['verified-mailbox']); return ['synthetic@example.invalid']; },
    stripe() { throw Error('Quote must not initialize Stripe'); },
    store: {
      profile: async () => ({ id: profileId, auth_user_id: accountId, access_status: 'pending', deleted_at: null }),
      eligibility: async () => ({ state: 'eligible', checkout_enabled: true, price_phase: 'earlybird' }),
      bindInvitation: async () => {
        calls.push(['bind-invitation']);
        if (!invitationEnabled) throw Error('Synthetic protected manual invitation gate is OFF');
      },
      createPreview: async (_id, _subject, _live, offerId) => ({
        id: '10000000-0000-4000-8000-000000000002', offer_id: offerId,
        price_phase: offerId === 'core' ? 'earlybird' : 'standard', expires_at: '2026-09-20T12:10:00Z',
        consent_version: 'synthetic-v1', consent_hash: 'a'.repeat(64), consent_text: 'Synthetic annual membership consent.',
      }),
    },
  }, config);
  const session = { user: { id: accountId }, getToken: async () => 'synthetic-token' };
  const client = createLimitedLaunchClient({ accountId, enabled: true, url: 'https://synthetic.invalid', anonKey: 'synthetic-public-key', getSession: () => session,
    fetchImpl: async (url, options) => {
      assert.ok(url.endsWith('/billing-quote'));
      calls.push(['quote-body', JSON.parse(options.body)]);
      return handlers.quote(new Request(url, options));
    },
  });
  const output = { quote: null, message: null };
  const context = { busy: false, invitation, client, accountId, accessAuthority: authority,
    access: { ...snapshot, invitationActivationEnabled: renderedInvitationEnabled }, request: { current: 0 },
    currentlyPermitted: offerId => canReviewBillingOffer(authority.state(accountId), offerId), current: () => true,
    setBusy() {}, setConsent() {}, setMessage: value => { output.message = value; }, setQuote: value => { output.quote = value; }, messageFor: error => error.code,
  };
  vm.runInNewContext(code, context);
  return { calls, storage, output, authority, review: context.reviewOffer };
}

for (const [offerId, annualCents] of [['core', 14900], ['core_locum', 24500]]) {
  test(`public ${offerId} quote succeeds with stale saved token and both manual invitation gates OFF`, async () => {
    const f = fixture(); await f.review(offerId);
    assert.equal(f.output.message, null);
    assert.equal(f.output.quote?.annualCents, annualCents);
    assert.deepEqual(f.calls, [['quote-body', { offerId }]]);
    assert.equal(f.storage.get('credentialdomd.launch_invitation'), token, 'Unrelated pending invitation is preserved');
  });
}
test('latest protected authority disables token even when rendered snapshot still allowed manual invitations', async () => {
  const f = fixture({ renderedInvitationEnabled: true }); await f.review('core');
  assert.equal(f.output.quote?.annualCents, 14900);
  assert.deepEqual(f.calls, [['quote-body', { offerId: 'core' }]]);
});
test('explicitly enabled manual invitation path still sends saved token through verified binding', async () => {
  const f = fixture({ invitationEnabled: true }); await f.review('core');
  assert.equal(f.output.quote?.annualCents, 14900);
  assert.deepEqual(f.calls, [['quote-body', { offerId: 'core', invitationToken: token }], ['verified-mailbox'], ['bind-invitation']]);
});
test('stale membership authority cannot request an offer with or without an invitation', async () => {
  const f = fixture({ invitationEnabled: true }); f.authority.suspendWrites(); await f.review('core');
  assert.deepEqual(f.calls, []); assert.equal(f.output.quote, null);
});
