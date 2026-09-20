# Support text draft recovery

## Scope

Baseline Help & feedback create/reply now retains text in account-scoped sessionStorage, including category/priority for a new ticket and a separate reply for each exact ticket UUID. Drafts restore after closing the support window or re-signing into the same account in the same tab. They expire after 24 hours (expired entries are removed on next access), are bounded to 51 entries per account, and can be discarded explicitly. Closing the browser tab may remove them. Unavailable storage produces a visible copy-your-text warning; switching the modal's tabs still keeps the mounted text.

Only text fields are stored. Attachments, filenames, screenshot data, context payloads, tokens, and operation IDs are excluded. Existing attachment payloads and upload functions are unchanged, including attachment-only replies. Explicit sign-out, account deletion, and server wipe clear this account's draft key. Involuntary session expiry retains it for the same account. No legacy-identity migration copies drafts.

A successful baseline send must return `{ok:true,id:<UUID>}` before removing a draft. Clearing compares the submitted revision, so a delayed response cannot remove newer edits. Closing/unmounting does not save an empty form or resurrect deliberately purged text. Account/session changes prevent old responses from changing the current modal. A stale-account callback cannot start a send.

HTTP 504 says: “We could not confirm receipt. Check Your tickets before retrying.” Support-only HTTP 401 copy describes verification uncertainty without asserting that the user is signed out. There are no automatic retries; the baseline endpoints have no new idempotency guarantee. The staged support-operations client, source flag, backend, authentication configuration, database, mail, and notification paths remain unchanged.

## Validation

- 49 support tests pass, including 14 new draft/actual-modal callback checks for failed sends, close/reopen, exact ticket and account isolation, stale callbacks, newer edits, receipt validation, inaccessible storage, purge lifecycle, and attachment-only replies.
- Existing attachment client/server checks: 52 + 166 passed.
- Existing device-secret checks: 196 passed; continuity recovery checks: 30 passed.
- Changed-source ESLint passes. `npm run build:site` passes.

All network responses are synthetic. No real support ticket or email was sent. Signed-in live submission still needs release verification by the owner; this change protects drafts and does not independently prove the deployment incident is resolved.
