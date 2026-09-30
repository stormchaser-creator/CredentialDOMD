// AUTH-008 (the portal half): 'Manage an existing subscription' on Access
// paused, or any manage() call, on an account with no billing account. The
// portal answers 404 billing_account_not_found; the client mapped every code
// it did not list to membership_information_unavailable, and manage() caught
// everything with "Billing management could not open. Please try again.",
// which retrying never fixes and which never says there is no subscription.
//
// The real client over a synthetic fetch, and the real manage() body from
// useSubscription in a vm. No network, provider or account.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createLimitedLaunchClient } from '../../src/utils/limitedLaunchClient.js';

function client(status, body) {
  const session = { user: { id: 'user_synthetic_paused' }, getToken: async () => 'synthetic-auth-token' };
  return createLimitedLaunchClient({
    accountId: session.user.id, enabled: true, url: 'https://membership.invalid', anonKey: 'synthetic-public-key',
    getSession: () => session, fetchImpl: async () => Response.json(body, { status }), timeoutMs: 1000,
  });
}

test('the portal refusal for an account with no billing account reaches the caller by name', async () => {
  await assert.rejects(client(404, { error: 'billing_account_not_found' }).portal(), { code: 'billing_account_not_found' });
  await assert.rejects(client(503, { error: 'billing_unavailable' }).portal(), { code: 'billing_unavailable' });
});

const source = await readFile(new URL('../../src/hooks/useSubscription.js', import.meta.url), 'utf8');
const start = source.indexOf('  const manage = useCallback(');
const end = source.indexOf('  // Derived state.', start);
function manage(portalError) {
  const alerts = [];
  const context = {
    useCallback: fn => fn, LIMITED_LAUNCH_ACCESS_ENABLED: true, userId: 'user_synthetic_paused', hasSubscription: false,
    createLimitedLaunchClient: () => ({ portal: async () => { throw portalError; } }),
    window: { alert: message => alerts.push(message), location: { assign() { throw Error('no navigation'); } } },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.manage = manage;`, context);
  return { run: context.manage, alerts };
}

test('no billing account: the member is told there is no subscription, not to try again', async () => {
  const m = manage(Object.assign(Error('not found'), { code: 'billing_account_not_found' }));
  const result = await m.run();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_subscription');
  assert.equal(m.alerts.length, 1);
  assert.match(m.alerts[0], /no subscription on this account/);
  assert.match(m.alerts[0], /support@credentialdomd\.com/);
  assert.doesNotMatch(m.alerts[0], /try again|—/i);
});

test('an outage still says try again', async () => {
  const m = manage(Object.assign(Error('down'), { code: 'billing_unavailable' }));
  await m.run();
  assert.match(m.alerts[0], /Billing management could not open\. Please try again\./);
});
