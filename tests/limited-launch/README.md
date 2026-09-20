# Limited-launch client tests

Run the client checks with:

```sh
node --test tests/limited-launch/*.test.mjs
```

**114 tests pass, with zero skipped or TODO cases.** All external I/O is fake;
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
- `persistence-sdk.test.mjs`: 3 cases using the installed Supabase SDK and fake
  fetch. Verifies account checks during token minting and immediately before
  request dispatch, plus a normal request with the captured owner's token.

The remaining 54 cases cover access, transport, invitations, checkout consent
and resume, diagnostic redaction, and rendered read-only records/exports.

## Limits and separate blocked work

Passing local tests does not establish production Clerk, RLS/storage, billing,
or deployment readiness. The source gate remains OFF. A request already sent
while authorized may complete; later requests/effects stop on identity change.
Replay serialization covers callers in this tab, not cross-tab transactions.

Independent review reproduced a separate existing account-deletion caller race.
Automatic approval review rejected the deletion-helper proposal as beyond the
explicit save/upload scope. No deletion-path patch was applied or retried.
Its review-only synthetic reproduction remains outside this passing suite at
`/private/tmp/credentialdo-deletion-owner-review-20260919/`.

To compare private source snapshots without changing application code:

```sh
PERSISTENCE_SOURCE_FILE=/absolute/path/to/supabase.js node --test tests/limited-launch/persistence.test.mjs
APPCONTEXT_SOURCE_FILE=/absolute/path/to/AppContext.jsx node --test tests/limited-launch/persistence-callers.test.mjs
```

Earlier rejection evidence is retained unchanged under
`/private/tmp/credentialdo-limited-access-blocked-regressions/`; it records the
history before the owner's explicit save/upload repair authorization.
