# CredentialDoMD privacy documentation

Updated September 18, 2026.

The maintained public policy is [`landing/privacy.html`](../landing/privacy.html), published at [credentialdomd.com/privacy](https://credentialdomd.com/privacy). The plain-language explanation is [`landing/security.html`](../landing/security.html), published at [credentialdomd.com/security](https://credentialdomd.com/security).

This file replaces an obsolete April draft. That draft contained unverified corporate, legal-review, audit-log, vendor-agreement, certification and retention claims and must not be used as launch copy.

## Service operator

CredentialDoMD is operated by **Eric Whitney, DO, A Professional Corporation**. Eric Whitney, DO administers the service for the corporation. The operator identity was confirmed on September 18, 2026 from the merchant business settings and the matching formation record. Maintain this identity in the canonical `src/content/legalText.js`; regenerate both landing and public policy copies after edits.

## Current technical facts for maintaining those pages

- Clerk manages sign-in. Supabase stores professional records and uploaded files; account access policies are designed to separate users' records. The operator has administrative access for support and operations.
- The app caches records in per-account browser storage for offline use. Cached record access does not imply every uploaded document is available offline.
- Private notes use separate local browser storage through `src/utils/privateVault.js`. They do not normally sync to the server, enter invoices, go to AI providers, or enter cloud backups. They are not separately encrypted by the app. Manual export creates a readable JSON file; explicit sign-out and clearing browser storage can erase the local copy.
- `src/utils/aiClient.js` supports shared server-held Gemini and Anthropic keys and optional personal device-held keys. Personal-key requests go directly to the provider. Shared access is subject to availability and usage controls.
- Vera defaults to Gemini and optionally uses Claude through `src/utils/assistant.js`. The assistant receives user input, conversation context, a record summary and attachments relevant to the request. Other scanning and dictation features send their supplied content to the selected provider.
- Document and identifier screening is a limited safeguard. It cannot guarantee that patient information is absent or removed before processing. Do not claim that the service never handles PHI, or infer legal status from intended use.
- Support tickets, attachments, feedback and assistant activity logs can be reviewed by the operator and handled with AI tooling.
- Record export and private-note export are separate operations. Exports may contain sensitive information and need careful handling.

## Publishing rules

Describe deployed behavior. Do not convert a source-code control into a guarantee of isolation or perfect screening. Do not claim HIPAA compliance, a BAA, security certification, complete audit logging, legal review, vendor agreements, fixed incident-response promises or specific retention periods without verified support. Review the public policy when providers, hosting, storage, sharing or retention behavior changes.
