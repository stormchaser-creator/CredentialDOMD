# Limited-launch client tests

Run the synthetic client checks with:

```sh
node --test tests/limited-launch/*.test.mjs
```

All persistence I/O is mocked. The persistence tests execute the real source
through the repository's existing esbuild/VM test pattern, with synthetic
identities, an in-memory queue and a fake Supabase client. They do not call any
network, account, customer, provider or database service.

## Outstanding persistence regressions

`persistence.test.mjs` contains seven explicit TODO cases. Their callbacks run
and reproduce the failures; a successful test-runner exit does **not** mean
these cases pass or that access enforcement is ready to activate.

1. An unknown previous document can supply a Credential link even when Practice
   access has expired. A trusted prior document is required to verify both scopes.
2. Account switching during document upload does not stop the following metadata
   write. The file operation and subsequent row must remain pinned to one owner.
3. Account switching during document removal does not stop the following
   metadata delete.
4. Failed previous-account updates can use the new account's queue namespace.
5. Replay rewrites its initial queue snapshot, dropping operations appended
   while it awaits a cloud request.
6. Replay drops a delete even when its tombstone write fails. The same case also
   contains an account-switch replay check; that later assertion is not reached
   until the tombstone failure is fixed.
7. An account switch during token minting does not stop request dispatch.

These remain unresolved because automatic approval review rejected the proposed
persistence edits. The source gate remains off. No pending edit was applied to
save/delete/storage behavior as part of this regression report.

Two ordinary persistence checks currently pass: denied Practice writes preserve
existing queued work without adding mutations, and disabled launch access
preserves ordinary offline queueing. The other transport/invitation/access tests
remain separate from these known persistence limitations.

To compare an existing private source snapshot without changing application code:

```sh
PERSISTENCE_SOURCE_FILE=/absolute/path/to/supabase.js node --test tests/limited-launch/persistence.test.mjs
```

Private review evidence and exact automatic-review refusals are kept under
`/private/tmp/credentialdo-limited-access-blocked-regressions/`.
