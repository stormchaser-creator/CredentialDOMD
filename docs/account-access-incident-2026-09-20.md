# Account access incident — September 20, 2026

## Confirmed failures and repairs

The production login transition left existing members unable to find their login identities. The reviewed reserved-email import now provisions the existing real identifiers without creating duplicate application profiles. Mailbox verification still happens through Clerk. Source identities, sealed continuity evidence and saved records must remain intact. Imported login identities do not carry the old passwords; password continuity is a separate unfinished task.

After an existing member verified their mailbox, the original profile and lifetime grants were correctly present, but the membership request failed. `createLimitedLaunchClient.entitlements()` used a default Clerk token while `billing-entitlements` forwarded that token into PostgREST. The default token did not provide the database role required by the authenticated-only `credentialdo_access_snapshot()` function. Live logs showed HTTP401/Postgres42501 for this request. Effective database privileges were correct: authenticated and service_role could execute; anon could not.

The repair uses the already-configured Supabase JWT template **only for the membership snapshot**. It retains account/session checks, deadlines and normal tokens for other endpoints. It does not widen anonymous privileges, impersonate a customer, or bypass row-level security. Supabase requires `role: authenticated` for this integration: [Supabase Clerk documentation](https://supabase.com/docs/guides/auth/third-party/clerk), [Clerk integration documentation](https://clerk.com/docs/guides/development/integrations/databases/supabase), checked September 20, 2026. The existing template is the bounded incident repair; a later integration migration requires separate acceptance testing.

The missing snapshot made `isPro` and write permissions false even after records loaded, replacing normal workspaces with read-only archives. This explains missing tools, but does not prove that an archive displayed zero records. Actual browser collection requests and the second case-log page returned HTTP200; independent read-only database checks confirmed the original records and lifetime capabilities. A real user-visible retest is still required before declaring restoration complete.

Separately, a reproduced loading bug treated failed collections as empty defaults, cached incomplete data, and could unlink documents using an incomplete set of record IDs. The new loading guard requires the expected profile and all requested collection arrays before hydration, cache replacement, or link repair. Incomplete reads show a records-loading error with retry guidance; genuinely empty successful accounts and explicit offline access still work. This safeguard does not repair a failed network request.

The earlier identity initialization failure now emits only an allowlisted stage/cause/status support reference. Raw responses, receipts, credentials and on-device contents are excluded from that diagnostic.

## Validation and remaining acceptance

- Integrated account, token, persistence, loading and CME tests: 120 passed; production build and precache validation passed.
- Synthetic rendering executes the real subscription derivation, Practice routing and read-only archive. It proves a failed snapshot hides normal tools while preserving records, and a valid lifetime snapshot restores those tools without changing the records.
- Independent review confirmed the loading guard's account-switch and overlapping-load protections. A failed snapshot cannot replace a known-good local cache with defaults.
- Original customer records, identifiers and stored-object metadata were compared privately. Customer identifiers and private evidence are intentionally excluded from this document.
- Claude independently reviewed the token forwarding mechanism and the CME probe problem. His earlier cache-clearing suggestion was rejected and withdrawn; no cache clearing was performed.
- A scan found one additional token-forwarding endpoint, legacy `track-event`. Its helper accepts a Supabase client, with no active call sites found in `src`; the endpoint still uses legacy Supabase Auth `getUser()` and needs a separate telemetry review. It is outside the repaired membership path.
- Keep paid checkout and invitations paused until actual account display, support and payment acceptance pass. Do not report a completed recovery from builds or database counts alone.

## Incident handling

Never ask an existing member to recreate their account or re-enter records. Do not clear local storage, reset identities, grant anonymous database access, or silently discard a recovery conflict. Device-only notes and pending writes may have no other copy. Keep a failed load visibly distinct from an empty account.
