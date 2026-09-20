# Launch email owner review hold

Source change only until the two Edge functions are explicitly deployed. No SQL, provider key, consent record, existing membership, or customer record is changed by this patch.

## What is held

- `send-welcome`: authenticated waitlist trigger requests return HTTP 409 with `held: true`, `sent: false`. The lead was saved before its AFTER INSERT trigger runs. The hold makes no database call and does not stamp `welcomed_at`.
- `send-invite`: authenticated admin requests return the same hold after email validation and before any lead lookup, allowlist write, profile activation, or provider request. Manual invitations, resends, existing accounts, and request fields claiming approval all remain held.
- The admin page shows the hold as unsent and keeps the form values and existing lead/account states. It requires an explicit `ok: true` response before showing success.

The shared helper is deliberately unconditional. There is no environment variable, request field, admin privilege, or deployment default that can enable sending. This is a hold, not a draft queue or completed approval system. It does not automatically resume or retry held welcome emails.

## What remains separate

Requested state guides (`send-guide`) remain unchanged. Its ten-minute sweep, manual admin path, and existing guide delivery still operate according to their deployed configuration. **Its current email footer promotes a free beta and needs owner review/correction for future requests.** Leaving this sender unchanged is not a claim that all current outbound emails are now individually approved.

Credential packet replies, inbound CME/contact/document confirmations, optional credentialer acknowledgments, forwarding-address verification, support replies, renewal reminders, backups, Clerk security mail, and private credential portal mail do not import this hold. Never remove `RESEND_API_KEY` or rotate the shared `WELCOME_HOOK_SECRET` as a shortcut: those controls are shared with unrelated operations. Direct admin account controls are also unchanged.

## Deployment review

1. Review this exact source diff and offline regression results.
2. Deploy only `send-welcome` and `send-invite` with the shared helper included. Preserve their existing gateway/auth settings. No migration is required.
3. Deploy the admin UI after the server hold, so its explanatory copy matches the server.
4. Confirm deployed source/version through read-only provider tooling. Do not submit a customer lead or send a test email to check the hold.
5. Inspect any provider-queued messages and already-running old invocations separately. This source hold cannot cancel a message already accepted by the provider. No such messages were inspected or canceled here.

Saved leads are retained. The welcome trigger does not create a retry queue; the eventual approved send must explicitly select the eligible, still-consenting unsent cohort. Do not clear timestamps or bulk replay triggers. There are intentionally no automatic access grants.

## Release requirements

Before replacing the hold, implement server-enforced approval bound to exact rendered subject/text/HTML, sender and reply address, links/attachments, policy version, and immutable private recipient-list version plus hash. Require the owner's explicit approval of both content and recipients, then explicit delivery authorization for that version. Any change invalidates approval. Test deliveries are also deliveries and require review.

Use a trusted outbox with atomic claims, idempotency, separate accepted/delivered outcomes, and no blind retries after an ambiguous provider response. Never accept approval booleans from clients. Do not reuse the old invitation body: it advertises unrestricted free/no-card beta and grants access before sending.

The owner has confirmed a 30-day free, no-card beta for people who signed up under the earlier wording, followed by explicit $99/year paid opt-in with no automatic charge. Existing eligible lifetime accounts retain lifetime access. New public visitors are offered future paid checkout by invitation; no new free Credential trial is implied. The separate included 30-day Practice trial still ends without an added charge unless explicitly purchased. Exact grandfathered cohort boundaries and trial-start timestamps must be reviewed before sending; this patch determines neither.

## Offline verification

`node --test tests/launch-email-review.test.mjs`

Runs the real Edge handler bodies with synthetic in-memory dependencies and the real unconditional hold. Asserts zero provider calls and zero database operations for held requests, including resend/approval-bypass attempts; checks auth and admin response interpretation. No real recipient or provider is used.

`node scripts/send-invite-consent.test.mjs`

Separately exercises dormant consent rules with a test-only null hold adapter so they remain protected for later implementation. That adapter is never available to production code.
