# Limited-launch client tests

Run the client checks with:

```sh
node --test tests/limited-launch/*.test.mjs
```

**170 tests pass, with zero skipped or TODO cases.** All external I/O is fake;
these tests do not call any network, account, provider or database service.

## Approved persistence repair

The owner explicitly approved isolated save/upload account-switch repair and
testing. The seven earlier executing TODO regressions are now required passing
checks, covering unknown prior document scope, uploads, document removal,
wrong-account retry queues, newly appended queue entries, tombstone completion,
and account switching during token minting.

- `persistence.test.mjs`: 41 actual-source/esbuild/VM cases with a fake Supabase
  client and synthetic identities. Includes normal-owner success/recovery,
  settings retries, storage operations, original document-byte preservation,
  no queue recreation after sign-out, and concurrent replay within one tab.
  Account-isolation checks run with membership enforcement both ON and OFF.
- `persistence-callers.test.mjs`: 16 actual AppContext function/effect cases.
  Covers stale cloud/local loading, document reconciliation, delayed React
  updates and a cache timer retaining its original account and load generation.
- `persistence-sdk.test.mjs`: 23 passing cases using the installed Supabase SDK and fake
  fetch. Verifies account checks during token minting and immediately before
  request dispatch, normal requests with the captured owner's token, and the
  account-deletion table and `functions.invoke` paths. Includes forged contexts,
  delayed error/success response bodies, selected parallel DELETE token waits,
  full sign-out, storage list/remove token and fetch boundaries,
  membership-independent deletion and no SDK/token work for offline or
  null-profile contexts.
- `persistence-deletion.test.mjs`: 36 actual-source confirmation/handler/provider
  cases. Confirmation binds to the owner when opened, and never follows a later
  account/session/profile/load-generation change. Covers delayed/thrown storage,
  local purge, table/server phases, duplicate clicks, stale/deferred UI reset,
  cancellation/reopening, normal deletion and local-only data rights. Required
  passing regressions cover start-before-purge, a queued pre-deletion cache
  callback while server deletion waits, generation/timer invalidation, and
  stale A start/reset preserving B's timer, cache generation and state.

The remaining 54 cases cover access, transport, invitations, checkout consent
and resume, diagnostic redaction, and rendered read-only records/exports.

## Limits and approval history

Passing local tests does not establish production Clerk, RLS/storage, billing,
or deployment readiness. The source gate remains OFF. A request already sent
while authorized may complete; later requests/effects stop on identity change.
Replay serialization covers callers in this tab, not cross-tab transactions.

Independent review reproduced a separate account-deletion caller race. After
automatic approval review rejected that broader path, the owner explicitly
authorized its isolated ownership repair and synthetic tests. Automatic review
subsequently rejected the final cache-start/reset safeguard, including one retry
with recovered approval context. The user then directly approved the
account-deletion and cache code repair and simulated tests; the narrow safeguard
was accepted, completed and tested. Earlier rejected partial proposals were not
applied blindly. Historical evidence remains private
at `/private/tmp/credentialdo-deletion-owner-review-20260919/`.

The existing `node scripts/delete-account.test.mjs` profile/deletion contract
suite also passes all 139 checks. No test invokes a real deletion or provider.

To compare private source snapshots without changing application code:

```sh
PERSISTENCE_SOURCE_FILE=/absolute/path/to/supabase.js node --test tests/limited-launch/persistence.test.mjs
APPCONTEXT_SOURCE_FILE=/absolute/path/to/AppContext.jsx node --test tests/limited-launch/persistence-callers.test.mjs
```

Earlier rejection evidence is retained unchanged under
`/private/tmp/credentialdo-limited-access-blocked-regressions/`; it records the
history before the owner's explicit save/upload repair authorization.
