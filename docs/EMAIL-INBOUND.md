# Inbound email on credentialdomd.com (Resend receiving)

Written 2026-08-17. Nothing here has been enabled yet: DNS, Resend receiving, the
webhook, the migration and the function deploy are all owner steps below.

## What it does

| Address | Route | Result |
| --- | --- | --- |
| cme@credentialdomd.com | certificate intake | Sender must match `profiles.email` (case-insensitive). PDF and image attachments are copied to Storage bucket `documents` at `<auth_user_id>/<doc id>` and a `documents` row is written with `type = 'cme-certificate-inbox'`, `mime_type` = real MIME, no `linked_to`. The app lists these first under "From your inbox, not filed yet" (Documents) with File with AI and Link actions. Sender gets a confirmation. Unknown sender gets one "not registered" reply per day, never for bounces or list mail. |
| anything else (support@, hello@, whit@, privacy@, ...) | relay | Whole message forwarded to stormchaser@elryx.com from whit@credentialdomd.com, subject prefixed `[credentialdomd.com <local>] `, original From/To/Date/Message-ID at the top of the body, attachments re-attached (10 per email, 10 MB per file, 20 MB per email), `reply_to` = original sender so a plain reply answers the physician. |

Every message is recorded once in `public.inbound_emails` (unique `message_id`), which is
also the idempotency claim for Svix retries. Admin-only read.

Code: `supabase/functions/email-inbound/index.ts`, migration
`supabase/migrations/20260817_inbound_emails.sql`, app side `src/utils/inboxDocs.js`,
`src/components/features/DocumentsSection.jsx`, `src/components/features/CMESection.jsx`.

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

## Sender authentication (cme@ route)

The function trusts the From address only after checking the inbound path's `Authentication-Results` header: `dmarc=fail`, or `spf` and `dkim` both failing, drops the message with no upload and no reply (ledger status `failed`, detail starts with "sender authentication failed"). If the header is absent the message is treated as authenticated; that residual risk is bounded by the per-sender cap (20 messages/hour, 10 files each) and by the fact that dropped files land only in the matched physician's own inbox list, unfiled, where they are obvious.
