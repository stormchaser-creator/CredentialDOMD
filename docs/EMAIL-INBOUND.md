# Inbound email on credentialdomd.com (Resend receiving)

Written 2026-08-17. Nothing here has been enabled yet: DNS, Resend receiving, the
webhook, the migration and the function deploy are all owner steps below.

## What it does

| Address | Route | Result |
| --- | --- | --- |
| cme@credentialdomd.com | certificate intake | Sender must match the account: `profiles.email` (case-insensitive), or a confirmed row in `public.forwarding_addresses` (see below). PDF and image attachments are copied to Storage bucket `documents` at `<auth_user_id>/<doc id>` and a `documents` row is written with `type = 'cme-certificate-inbox'`, `mime_type` = real MIME, no `linked_to`. The app lists these first under "From your inbox, not filed yet" (Documents) with File with AI and Link actions. Sender gets a confirmation. Unknown sender gets one "not registered" reply per day, never for bounces or list mail. |
| docs@, requests@, packets@credentialdomd.com | document requests | Sender must match the account (same two-pass check and same sender authentication as cme@). The forwarded credentialer email is parsed for the original From/Subject/body and written to `public.document_requests`; PDF and image attachments become `documents` rows with `type = 'request-attachment-inbox'`. Physician gets a "Got it" reply from docs@ pointing at More > Requests. Details below. |
| anything else (support@, hello@, whit@, privacy@, ...) | relay | Whole message forwarded to stormchaser@elryx.com from whit@credentialdomd.com, subject prefixed `[credentialdomd.com <local>] `, original From/To/Date/Message-ID at the top of the body, attachments re-attached (10 per email, 10 MB per file, 20 MB per email), `reply_to` = original sender so a plain reply answers the physician. |

## Sender matching, both physician routes (2026-09-03)

`matchProfile()` looks in two places, in order:

1. `profiles.email`, the address typed in Settings.
2. `public.forwarding_addresses` where `verified_at is not null`: an extra
   address the physician registered and confirmed by clicking a link sent to
   that mailbox.

The second pass exists because credentialing mail arrives at a work address. A
physician who signed up as `name@gmail.com` and forwards from
`name@hospital.org` used to get the "not registered" reply; now the hospital
address routes to their account once they have confirmed it.

A physician manages these under **More > Settings > Email**
(`src/components/pages/SettingsSection.jsx`). That panel lists the account
address as the primary, lists every registered forwarding address with its
state, and adds, resends and removes through the forwarding-address function.
The unregistered replies and the confirmation page name it, because it now
exists. The Requests header names every confirmed address, not just the
account one (`src/components/features/RequestsInbox.jsx`).

**Deploy order matters here.** The two unregistered replies and the
confirmation page name More > Settings > Email. That pointer is only true once
the frontend carrying the panel is live, so `email-inbound` and
`forwarding-address` must be deployed WITH that frontend, not before it. Ahead
of it they promise a screen nobody can open, which is the exact fault the
pointers were pulled for in the first place.

One thing to be honest about.

* **Pass 1 is self-asserted.** A forwarding address is usable only after the
  mailbox owner clicks a link sent to it. `profiles.email` is not: any
  signed-in account may type any address into it (the profiles identity lock
  reverts `auth_user_id` and `access_status`, not `email`), and pass 1 returns
  first, so it outranks even a legitimately verified forwarding address.
  Closing this means re-locking the column, which
  `supabase/migrations/20260819_lock_access_status.sql` unlocked on purpose.
  The Settings panel now gives a physician another way to fix sender matching,
  so the argument for leaving the column open is weaker than it was, but
  `profiles.email` is also the CV header address and the reply-to on share
  emails, so a lock stops a physician editing all three. Owner's decision, not
  this feature's. Note also that `authenticated` holds table-level UPDATE on
  `public.profiles`, so a column-level `revoke update (email)` is a no-op; the
  lock has to be the trigger.

A verified forwarding address routes another person's forwarded mail and its
attachments into whichever account holds it, so the flow that creates one is
deliberately strict: `supabase/functions/forwarding-address/index.ts` refuses
an address that is any other account's `profiles.email` or is already verified
elsewhere, emails a single-use token that expires in 24 hours, stores only its
SHA-256 hash, and a partial unique index on `lower(email) where verified_at is
not null` makes one-account-per-verified-address a database fact rather than a
code path. Two accounts may hold the same address pending; the first to click
wins and the other's pending row is deleted. Migration:
`supabase/migrations/20260903c_forwarding_addresses.sql`.

The confirmation link is `https://credentialdomd.com/api/confirm-forwarding?token=...`,
the Worker relay (`cloudflare/credentialdomd-api/worker.js`) in front of the
function's GET. It is not the function URL because the Supabase functions
gateway rewrites HTML responses to `text/plain` under a sandbox CSP, and
because a first-party link survives hospital content filters.

Every message is recorded once in `public.inbound_emails` (unique `message_id`), which is
also the idempotency claim for Svix retries. Admin-only read. `route` is one of
`cme`, `docs`, `forward`.

Code: `supabase/functions/email-inbound/index.ts`, migrations
`supabase/migrations/20260817_inbound_emails.sql` and
`supabase/migrations/20260817_document_requests.sql`, app side `src/utils/inboxDocs.js`,
`src/components/features/DocumentsSection.jsx`, `src/components/features/CMESection.jsx`.

## Document requests (docs@)

The problem: a credentialer emails the physician "send your DEA, board cert, titers".
The app can build the packet (Vera's send_packet matches the checklist against
Documents) but the credentialer's email went unanswered. Now the physician forwards
that email, from the address on their profile, to `docs@credentialdomd.com`
(`requests@` and `packets@` are aliases, same route) and answers it from the app.

### Inbound (email-inbound, route `docs`)

1. Per-sender cap `CME_PER_SENDER_PER_HOUR` (20/hour, counted per route), then sender
   -> profile exactly as cme@. Unknown sender: one reply per day per route from docs@,
   text "This address is not registered to a CredentialDOMD account; forward the
   request from the email on your account, or add it in Settings (More > Settings >
   Email)." Never to automated mail. Same `Authentication-Results` drop as cme@.
2. Parse the ORIGINAL request out of the forwarded text (`text` body preferred,
   `stripHtml(html)` otherwise). `parseForwarded()`:
   * strips quoted-reply chevrons (`> `) from every line;
   * finds the client's marker (Gmail `---------- Forwarded message ---------`, Outlook
     `-----Original Message-----`, Apple Mail `Begin forwarded message:`, Lotus
     `----- Forwarded by ... -----`) and the `From:` line right after it; with no
     marker, the first `From:` line followed within 8 lines by another header line;
   * reads the header block: consecutive `From / Date / Sent / Subject / To / Cc /
     Reply-To / Message-ID` lines, indented continuations, up to two blank lines
     inside; a second `From:` ends the block (nested quote);
   * `from_addr` / `from_name` from the From value (`Name <a@b>`, `Name [mailto:a@b]`,
     bare address); `subject` from the Subject line with `Fwd:/FW:` prefixes removed
     (falls back to the inbound subject, prefixes removed); `original_message_id`
     from a Message-ID line when the client kept one (Outlook desktop sometimes does);
   * `body_text` = everything below the block, capped at 20,000 chars.
   Nothing matched: `from_addr` = the forwarding sender, `body_text` starts with
   "Requester address not found in the forwarded text; edit before replying" followed
   by the whole text, and the reply tells the physician to fix the To address in the app.
3. PDF and image attachments (the requester's checklist, rare) are stored with the
   same code path as cme@ (`storeAsDocuments`), `type = 'request-attachment-inbox'`,
   duplicates by name+size skipped.
4. Insert `document_requests` (service role): `user_id` = profile, `from_addr`,
   `from_name`, `subject`, `body_text`, `message_id` (of the forwarded email as
   received), `original_message_id`, `forwarded_by` = sender, `received_at`,
   `status = 'new'`, `inbound_ledger_id`.
5. Reply to the physician from `CredentialDOMD <docs@credentialdomd.com>`, subject
   `Re: <forwarded subject>`, threaded on the forwarded message id: "Got it. The request
   from <from_addr> is in your app under More > Requests. Open it to build the packet
   and reply by email." plus a line per note (attachments saved, skipped, requester
   not found). Ledger: `route = 'docs'`, `status = 'done'`, `attachment_count`,
   `profile_id`, detail carries the request id.

### Table `public.document_requests`

`id, user_id -> profiles(id) cascade, from_addr not null, from_name, subject,
body_text, message_id, original_message_id, forwarded_by, received_at, status
('new' | 'replied' | 'dismissed', default new), replied_at, reply_email_id, doc_ids
jsonb [], inbound_ledger_id, created_at, updated_at`. Index
`(user_id, status, received_at desc)`. RLS: owner select and update
(`user_id = current_profile_id()`), admin select (`is_admin(current_profile_id())`),
no client insert (service role writes; email-inbound inserts, send-packet-email
updates). The same migration widens `inbound_emails.route` to allow `docs`.

### send-packet-email (edge function, deploy with `--no-verify-jwt`)

Caller identity: `_shared/clerkAuth.ts` `clerkProfile(req)` (Clerk JWT in
`Authorization: Bearer`). CORS as reply-ticket.

Request `POST { request_id?: uuid, to: string, cc_self?: boolean, subject: string,
text: string, doc_ids: string[] }`

Response `200 { ok: true, email_id, attached: n, skipped: [filenames] }` or
`{ error }` with status:

| Status | When |
| --- | --- |
| 400 | bad JSON; `to` not an email; empty subject or over 200 chars; `text` over 5000 chars; bad `request_id` / `doc_ids` shape; profile has no email ("Add your email in Settings first"); doc_ids given but none could be attached |
| 401 | no or invalid Clerk token |
| 403 | a doc_id or the request_id is not the caller's |
| 429 | 30 sends in the last hour (share_log rows with `method = 'email'`) |
| 502 | Resend refused the send |

Rules implemented:

* every doc_id must satisfy `documents.user_id = profileId`; bytes are downloaded from
  bucket `documents` at `documents.storage_path` (fallback `<auth_user_id>/<doc id>`)
  with the service role;
* cap 10 files and 25 MB total after base64, in the caller's order; the rest are
  skipped and their filenames returned in `skipped`; duplicate filenames get ` (2)`;
  `content_type` from `mime_type`, then `type` when it is a MIME, then the extension;
* `from` = `"<profiles.name>, <profiles.degree_type> via CredentialDOMD"
  <docs@credentialdomd.com>` (degree omitted when empty; `"CredentialDOMD"` when the
  name is empty; the display name is quoted because it contains a comma);
* `reply_to` = `profiles.email` (400 when empty), `cc` = `[profiles.email]` when
  `cc_self`;
* `request_id`, when given, must be the caller's; `In-Reply-To` / `References` are set
  from `original_message_id`, else `message_id` (skipped when it is a synthetic
  `resend:<id>`);
* body = `text` + blank line + footer "Sent from CredentialDOMD on behalf of <name>.
  Reply to this email to reach <name> directly." (name falls back to the email);
* on success: `document_requests` -> `status = 'replied'`, `replied_at`,
  `reply_email_id`, `doc_ids` = ids actually attached; and always one `share_log` row
  `{ user_id, item_name: "Email packet (<n> files)", section: "documents", method:
  "email", recipient: to, sent_at: now(), item_id: null }`.
* an empty `doc_ids` is accepted (a reply with no attachment); `attached` is then 0.

Deploy:
```
supabase functions deploy send-packet-email --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
```
`RESEND_API_KEY` is reused; no new secret. Apply
`supabase/migrations/20260817_document_requests.sql` before deploying either
function: until it is applied, a docs@ message fails at the ledger insert (route
check) and Resend keeps retrying it.

Test: forward a credentialer email from your profile address to
docs@credentialdomd.com; expect the "Got it. The request from ..." reply and a
`document_requests` row with `from_addr` = the credentialer, `status = 'new'`. Then in
the app, More > Requests, pick documents and Reply by email; expect the credentialer to
receive it from "<Name>, <Degree> via CredentialDOMD", `reply_to` = your address, the
row flips to `replied`, and a share_log row with `method = 'email'` appears.

## How Resend receiving works (from resend.com/docs, loaded 2026-08-17)

* Receiving is per domain. Once enabled, Resend receives mail for **every** local part at
  that domain (`anything@credentialdomd.com`) and POSTs one webhook per message.
* Enable for an existing verified domain: Domains page, open the domain, use the toggle
  in the receiving section. A modal then shows the MX record to add. After adding it,
  click "I've added the record" and wait for the receiving record to show "verified".
  Sending verification is not repeated.
  API alternative: `PATCH https://api.resend.com/domains/{domain_id}` with body
  `{"capabilities":{"receiving":"enabled"}}` (`capabilities.receiving` is documented as
  `'enabled' | 'disabled'`). Our domain id: `b176dbb8-c8c8-44a5-85a5-5feca530ee38`,
  region `us-east-1`, current capabilities: sending enabled, receiving disabled.
* MX record: the docs say "copy the MX record" from the Domains page (or read it back
  from `GET /domains/{id}` `records` after enabling). The docs do not print a fixed
  value; the knowledge-base example for a us-east-1 domain is
  `inbound-smtp.us-east-1.amazonaws.com`. Priority: Resend only requires that its record
  is the **lowest priority value** on that name (mail goes to the lowest number; equal
  numbers are picked at random). Use the exact value and priority the modal shows.
* Subdomain: Resend recommends a subdomain (`sub.yourdomain.tld`) **when the root domain
  already has MX records serving a real inbox**, so existing mail is not hijacked. Our
  apex MX points at Cloudflare Email Routing with no rules and no destination, so nothing
  is served today and `cme@credentialdomd.com` (apex) is achievable by replacing that
  MX. See DNS below.
* Webhook: Webhooks page, Add Webhook, endpoint URL, event type `email.received`. The
  event payload is metadata only (`email_id`, `from` as bare address, `to[]`, `cc`,
  `bcc`, `received_for`, `message_id`, `subject`, attachment names/types). Body,
  headers and files are fetched afterwards:
  * `GET https://api.resend.com/emails/receiving/{email_id}` returns `html`, `text`,
    `headers`, `reply_to`, `message_id`, `raw.download_url` (signed, expires) and
    attachment metadata; `?html_format=cid` keeps `cid:` image references.
  * `GET https://api.resend.com/emails/receiving/{email_id}/attachments` returns each
    attachment with `download_url` (valid 1 hour) and `size`.
  * `GET https://api.resend.com/emails/receiving/{email_id}/attachments/{attachment_id}`
    for one file.
* Signature: Svix. Headers `svix-id`, `svix-timestamp`, `svix-signature`; verify the raw
  request body with the webhook's signing secret (`whsec_...`, shown on the webhook
  details page and returned by create/retrieve/list webhook API calls). We use the
  `svix` library, same as clerk-webhook.
* Limits found in the docs: received emails count as 1 email each against the account
  quota (Free: 100/day and 3,000/month, sent + received; paid plans monthly quota only);
  API rate limit 10 requests/second per team; outbound emails, attachments included,
  max 40 MB after base64. The docs loaded do not state a separate inbound message size
  cap; the function caps what it stores/re-attaches at 10 MB per file, 20 MB per email,
  10 files. Receiving is described for Free accounts (quota text covers "free
  accounts"); no page says it needs a paid plan.
* Reply threading: send with header `In-Reply-To` = received `message_id` and a `Re:`
  subject (the function does this for cme@ replies).

## Owner steps (in this order)

1. Apply the migration (creates `public.inbound_emails`, admin-only RLS):
   `supabase db push --project-ref hkpnnsjcwprrwobmpqyy` (or run
   `supabase/migrations/20260817_inbound_emails.sql` via the management API).
2. Create the webhook first so you have the secret before the function goes live:
   Resend, Webhooks, Add Webhook,
   URL `https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/email-inbound`,
   event `email.received`, Add. Copy the signing secret.
   API alternative (returns `signing_secret`):
   ```
   RS=$(security find-generic-password -l "Resend CredentialDOMD" -w)
   curl -X POST https://api.resend.com/webhooks -H "Authorization: Bearer $RS" \
     -H "Content-Type: application/json" \
     -d '{"endpoint":"https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/email-inbound","events":["email.received"]}'
   ```
   Note: this Resend team already has one webhook (ANMG-CallSync, other team). Leave it.
3. Set secrets and deploy (verify_jwt off, Resend sends no Supabase JWT):
   ```
   supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxx --project-ref hkpnnsjcwprrwobmpqyy
   supabase functions deploy email-inbound --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
   ```
   `RESEND_API_KEY` is already set for the send-* functions and is reused.
4. Enable receiving on the domain (dashboard toggle on the credentialdomd.com domain
   page, or `PATCH https://api.resend.com/domains/b176dbb8-c8c8-44a5-85a5-5feca530ee38`
   with `{"capabilities":{"receiving":"enabled"}}`). Read the MX host and priority from
   the modal or from `GET /domains/b176dbb8-...` `records`.
5. DNS on Cloudflare (zone credentialdomd.com), apex name `@`:
   * delete the three MX records `route1.mx.cloudflare.net` (81), `route2` (58),
     `route3` (94) (Cloudflare Email Routing; unused, no rules, no destination), or
     first disable Email Routing in the Cloudflare dashboard, which removes them;
   * add one MX record: name `@`, value and priority exactly as Resend shows;
   * leave the `send` MX/TXT records and the DKIM TXT untouched (sending);
   * the apex TXT `v=spf1 include:_spf.mx.cloudflare.net ~all` is Cloudflare Email
     Routing's; harmless to keep, optional cleanup once routing is gone.
   Then click "I've added the record" in Resend and wait for "verified".
   Alternative if you would rather not touch the apex: enable receiving on a subdomain
   (for example `inbox.credentialdomd.com`) and change `INBOX_DOMAIN` and
   `CME_INBOX_ADDRESS` in the code; the function already accepts any subdomain of
   credentialdomd.com when picking the routed address, but the app hint and reply
   texts name the apex address.
6. Test: from the address on your profile, forward a certificate email to
   cme@credentialdomd.com; expect a "Got it: 1 certificate added to your Documents"
   reply and, after refreshing the app, the file under "From your inbox, not filed
   yet". Then mail support@credentialdomd.com from any address; expect it in
   stormchaser@elryx.com with subject `[credentialdomd.com support] ...`, and hit reply
   to confirm reply_to points at the sender. Rows appear in `inbound_emails`.
7. Side effect to know: replies to whit@credentialdomd.com (the From on every app
   email) now land in stormchaser@elryx.com via the relay instead of bouncing.

## Caps in the function

`GLOBAL_PER_10MIN` 120 (429 beyond, Resend retries), `CME_PER_SENDER_PER_HOUR` 20 (excess
recorded, no reply), `UNREG_REPLY_PER_DAY` 1, `MAX_FILES` 10, `MAX_FILE_BYTES` 10 MB,
`MAX_TOTAL_BYTES` 20 MB, inline images under 40 KB are treated as signature logos on the
cme route. All in `supabase/functions/email-inbound/index.ts`.

## Sender authentication (cme@ and docs@ routes)

The function trusts the From address only after checking the inbound path's `Authentication-Results` header: `dmarc=fail`, or `spf` and `dkim` both failing, drops the message with no upload and no reply (ledger status `failed`, detail starts with "sender authentication failed"). If the header is absent the message is treated as authenticated; that residual risk is bounded by the per-sender cap (20 messages/hour per route, 10 files each) and by the fact that dropped files land only in the matched physician's own inbox list, unfiled, where they are obvious. On the docs@ route a forged forward would only add a request row to the physician's own Requests list, which they can dismiss; nothing is sent to a third party without the physician pressing Reply by email in the app.
