# Inbound email on credentialdomd.com (Resend receiving)

Written 2026-08-17; live since early September 2026 (DNS, Resend receiving, the
webhook, the migrations and the function deploys are all in place). The owner
steps below are kept as the record of how it was set up. Updated 2026-09-12 for
the packet proposal, the requester acknowledgement and the one-tap approve path.

## What it does

| Address | Route | Result |
| --- | --- | --- |
| cme@credentialdomd.com | certificate intake | Sender must match the account: `profiles.email` (case-insensitive), or a confirmed row in `public.forwarding_addresses` (see below). PDF and image attachments are copied to Storage bucket `documents` at `<auth_user_id>/<doc id>` and a `documents` row is written with `type = 'cme-certificate-inbox'`, `mime_type` = real MIME, no `linked_to`. The app lists these first under "From your inbox, not filed yet" (Documents) with File with AI and Link actions. Sender gets a confirmation. Unknown sender gets one "not registered" reply per day, never for bounces or list mail. |
| docs@, requests@, packets@credentialdomd.com | document requests | Sender must match the account (same two-pass check as cme@; authentication evidence read from the raw message, top-most header). The forwarded credentialer email is parsed for the original From/Subject/body and written to `public.document_requests`; PDF and image attachments become `documents` rows with `type = 'request-attachment-inbox'`. On arrival the packet proposal is built and stored on the row, the physician gets a summary from docs@, and the requester gets a short acknowledgement on the physician's behalf when every guard passes. The app shows one button, Approve and send. Details below. |
| anything else (support@, hello@, whit@, privacy@, ...) | relay | Whole message forwarded to stormchaser@elryx.com from whit@credentialdomd.com, subject prefixed `[credentialdomd.com <local>] `, original From/To/Date/Message-ID at the top of the body, attachments re-attached (10 per email, 10 MB per file, 20 MB per email), `reply_to` = original sender so a plain reply answers the physician. |

## Sender matching, both physician routes (2026-09-03)

`matchProfile()` looks in two places, **proven first**:

1. `public.forwarding_addresses` where `verified_at is not null`: an extra
   address the physician registered and confirmed by opening a link sent to that
   mailbox and pressing Confirm.
2. `profiles.email`, the address typed in Settings.

Pass 1 exists because credentialing mail arrives at a work address. A physician
who signed up as `name@gmail.com` and forwards from `name@hospital.org` used to
get the "not registered" reply; now the hospital address routes to their account
once they have confirmed it.

**The order was the other way round until 2026-09-03, and that was a takeover.**
A confirmed address is evidence somebody read that mailbox. `profiles.email` is
a text box nobody checks. While the text box won, an account that simply typed
`name@hospital.org` into its own profile outranked the account that had
confirmed `name@hospital.org` by reading the mailbox, and the forwarded document
went to the one that typed it. Proven now beats asserted.

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

Two things to be honest about.

* **Pass 2 is still self-asserted, it just no longer outranks proof.** Any
  signed-in account may type any address into `profiles.email` (the identity
  lock freezes `auth_user_id` and `access_status`, not `email`, and
  `20260819_lock_access_status.sql` removed the trigger that used to revert
  it). What stops two accounts claiming the same address is a unique index on
  `lower(email)` (`supabase/migrations/20260903e_profiles_email_unique.sql`).
  It is an index and not a column lock because `authenticated` holds
  **table-level** UPDATE on `public.profiles`, which makes a column-level
  `revoke update (email)` a no-op, and because `profiles.email` is also the CV
  header address and the reply-to on share emails, so a trigger lock would stop
  a physician editing all three. A duplicate now surfaces as a 23505 that
  `saveSettings` reports rather than queueing for retry.

* **Addresses are compared as written**, after case folding and trimming only.
  Gmail dots and `+tags` are not canonicalized, so `first.last@gmail.com`,
  `firstlast@gmail.com` and `first.last+cme@gmail.com` are three addresses and
  each has to be confirmed on its own. Deciding per provider which mailboxes are
  the same mailbox, and being wrong, hands one account another account's
  credentialing mail; the cost of not deciding is one extra confirmation.

A verified forwarding address routes another person's forwarded mail and its
attachments into whichever account holds it, so the flow that creates one is
deliberately strict. `supabase/functions/forwarding-address/index.ts` refuses an
address that is any other account's `profiles.email` or is already verified
elsewhere, emails a single-use token that expires in **2 hours**, and stores
only its SHA-256 hash. A partial unique index on `lower(email) where verified_at
is not null` makes one-account-per-verified-address a database fact rather than
a code path. Two accounts may hold the same address pending; the first to
confirm wins and the other's pending row is deleted.

Rows are created **only** by that function, with the service role: migration
`20260903d_forwarding_addresses_no_client_insert.sql` revoked the client INSERT
grant `20260903c` had handed to `authenticated`. With the grant, a signed-in
caller could write a row straight through PostgREST with any address in it,
skipping every rule in `refuseAdd`, and then call the function's `resend` action
on the row they now owned, which mailed a confirmation link to that address from
our sending domain. `resend` now also re-runs the address rules against the
address stored on the row, so neither half depends on the other holding.

The daily cap (10 confirmation emails per account) is claimed through
`public.forwarding_address_claim_send`
(`supabase/migrations/20260903f_forwarding_send_claim.sql`), which counts and
records the send under one advisory lock. The old read-count / send / record
sequence let two simultaneous requests both read the same count and both send.
The slot is claimed before Resend is called and deleted if the send fails.

Migrations: `supabase/migrations/20260903c_forwarding_addresses.sql`, then
`20260903d_forwarding_addresses_no_client_insert.sql`,
`20260903e_profiles_email_unique.sql` and `20260903f_forwarding_send_claim.sql`.

The confirmation link is `https://credentialdomd.com/api/confirm-forwarding?token=...`,
the Worker relay (`cloudflare/credentialdomd-api/worker.js`) in front of the
function. It is not the function URL because the Supabase functions gateway
rewrites HTML responses to `text/plain` under a sandbox CSP, and because a
first-party link survives hospital content filters.

**Opening the link confirms nothing.** The GET renders a page whose only control
is a Confirm button that POSTs the token back to the same path; the POST is what
writes. That split exists because the audience is hospital mailboxes, and those
sit behind link rewriters (Microsoft Safe Links, Proofpoint URL Defense,
Mimecast, Barracuda) that fetch a link to judge it, often at delivery and before
a human has read the message. While confirming was a GET, that fetch was the
confirmation: the address got attached to the requesting account with the
mailbox owner doing nothing, which is the feature's whole property defeated by
the feature's own audience. Scanners GET and HEAD; they do not submit forms. The
relay therefore forwards both methods on that path.

Unknown, expired and already-used tokens render one byte-identical "no longer
valid" page, from the GET and the POST alike.

Every message is recorded once in `public.inbound_emails` (unique `message_id`), which is
also the idempotency claim for Svix retries. Admin-only read. `route` is one of
`cme`, `docs`, `forward`.

Code: `supabase/functions/email-inbound/index.ts`, migrations
`supabase/migrations/20260817_inbound_emails.sql` and
`supabase/migrations/20260817_document_requests.sql`, app side `src/utils/inboxDocs.js`,
`src/components/features/DocumentsSection.jsx`, `src/components/features/CMESection.jsx`.

## Document requests (docs@)

The problem: a credentialer emails the physician "send your DEA, board cert, titers".
The app could build the packet, but the credentialer's email went unanswered and the
physician had seven taps between the forward and the send. Now the physician forwards
that email, from the address on their profile or any confirmed forwarding address, to
`docs@credentialdomd.com` (`requests@` and `packets@` are aliases, same route), and
that forward is the last thing they type. The function matches the asks against the
file, tells the physician what it found, acknowledges the requester, and the app shows
one button.

### Inbound (email-inbound, route `docs`)

1. Per-sender cap `CME_PER_SENDER_PER_HOUR` (20/hour, counted per route), then sender
   -> profile exactly as cme@.
2. **Automated senders get nothing.** Right after the message is fetched, a sender
   `isAutomatedSender` recognises (`Auto-Submitted` other than `no`, `Precedence`
   bulk/list/junk/auto_reply, `X-Auto-Response-Suppress`, `List-Id`,
   `List-Unsubscribe`, or a mailer-daemon / postmaster / no-reply / bounce local part)
   finishes the ledger row `done`, detail "automated sender, no reply", and the
   function returns `{ result: "automated" }` with no request row, no proposal and no
   email. This route sends two emails per message, and an out-of-office reply to
   either one arrives here looking like a new forward; left alone it became a request
   row with nothing in it and a third email. The contacts@ route has the same check.
3. Unknown sender: one reply per day per route from docs@, text "This address is not
   registered to a CredentialDOMD account; forward the request from the email on your
   account, or add it in Settings (More > Settings > Email)." Never to automated mail.
4. **Authentication evidence comes from the raw message, not the header map.**
   Resend's retrieve endpoint returns `headers` as a name-to-string object in which
   duplicate headers collapse to one value, and which occurrence wins is undocumented;
   a sender who typed their own `Authentication-Results: mx.resend.com; dmarc=pass`
   into a message could have been the one that was read. It also returns `raw` as
   `{ download_url, expires_at }` (a signed URL; there is no parameter to inline it).
   `authResultsFrom` fetches the first 256 KB of that file (`Range` requested, cut
   client-side if ignored) and `topAuthenticationResults` (in
   `_shared/requestFlow.ts`, tested) returns the **top-most** `Authentication-Results`
   header of the block before the first blank line, continuation lines unfolded. The
   receiving MTA prepends its own header above anything the sender wrote, so the
   top-most one is the MTA's. Verdicts are read per clause (`authVerdicts`, tested):
   only the `method=result` token that opens a clause counts, never the text after
   it, because the MTA copies sender-chosen identifiers in beside its verdicts
   (`smtp.mailfrom=`, `smtp.helo=`, `header.i=`) and each accepts `=`, so a genuine
   header can read `spf=pass smtp.mailfrom=dmarc=pass@attacker.example; dmarc=none`;
   a substring test once read that as `dmarc=pass`. The filing check
   (`senderAuthFailure`, now also in `_shared/requestFlow.ts`) reads the same
   parser. A raw message with no such header yields "" (a no for
   the acknowledgement; a pass for filing, as below). The two readings are kept apart
   (`authEvidence` in `_shared/requestFlow.ts`, tested): the raw top-most header is the
   ONLY positive evidence the acknowledgement reads, and when `raw` is absent from the
   response or cannot be read (an expired signed URL, a 4xx, a dropped connection) the
   acknowledgement is refused and the refusal logged. For a while the header map stood
   in on exactly that path, which put the forgeable value back where it had been
   removed from on every transient failure. The header map, ARC included, is read only
   for the explicit-failure drop (`dmarc=fail`, or `spf` and `dkim` both failing, in
   EITHER the raw top-most header or the map: ledger `failed`, detail starts "sender
   authentication failed", nothing stored, nothing sent), the same strictness cme@ and
   contacts@ have. Optional secret `INBOUND_AUTHSERV_IDS` (comma-separated) pins the
   acknowledgement to headers whose authserv-id (the token before the first semicolon,
   version dropped) is on the list; unset, any top-most header counts.
5. Parse the ORIGINAL request out of the forwarded text (`text` body preferred,
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
   by the whole text; the summary says so and the app's Approve button is disabled
   until the address is typed into the Requester's email field on the request.
6. PDF and image attachments (the requester's checklist, rare) are stored with the
   same code path as cme@ (`storeAsDocuments`), `type = 'request-attachment-inbox'`,
   duplicates by name+size skipped. Inbox-typed documents are kept out of the
   matcher's catalogue so the requester's own checklist is never proposed back to
   them as the physician's CV.
7. Insert `document_requests` (service role): `user_id` = profile, `from_addr`,
   `from_name`, `subject`, `body_text`, `message_id` (of the forwarded email as
   received), `original_message_id`, `forwarded_by` = sender, `received_at`,
   `status = 'new'`, `inbound_ledger_id`.
8. **The proposal.** Every asked-for item is parsed out of the subject and body and
   matched against the physician's documents by `_shared/requestPacket.ts` (rules, not
   AI; the client copy `src/utils/requestPacket.js` is proven byte-identical by
   `scripts/request-packet-shared.test.mjs`). The catalogue joins `documents.linked_to`
   (`"<section>:<record id>"`) to one query per record table in `RECORD_TABLES`,
   including `locum_contracts` and `travel_expenses`, which the matcher never attaches
   but must resolve, otherwise their files read as unlinked and the CV rule, which
   matches any unlinked file by name, offered a signed locum agreement for a CV. The
   result `{ v, method, items, docIds, missing, coverNote }` is written to
   `proposal` / `proposal_at`. A matcher failure leaves them null and the request
   intact; the app then falls back to the hand-built reply.
9. **The physician's summary**, from `CredentialDOMD <docs@credentialdomd.com>`,
   subject `Re: <forwarded subject>`, threaded on the forwarded message id
   (`physicianSummaryText`): who asked, one line per ask with what was found ("not on
   file", "follows separately", "not recognised"), "Packet ready: N documents. Open the
   app and tap Approve and send", and the link `https://credentialdomd.com/app/#requests
   (opens your requests)`. When the requester's address was not found and there is
   nothing to list, it opens "Got it. A document request came in, but the requester's
   address was not found in the forwarded text." and names the Requester's email field
   on the request as the next step (that screen has no Review; an earlier wording said
   "tap Review" and a physician looked for it).
   Attachment notes (saved, skipped, failed) follow.
10. **The requester's acknowledgement**, from `"<Name>, <Degree> via CredentialDOMD"
    <docs@credentialdomd.com>`, `reply_to` = the physician (the confirmed forwarding
    address the request came from when that is not the profile email, else the
    profile email), threaded on the requester's own Message-ID when the forward kept
    one. Text (`ackText`): "Hello <first>, This confirms that your request [for N
    items] to <physician> was received on <Month D, YYYY>. Any documents will come
    from this address; a reply to this email reaches <physician> directly. Regards,
    <Name>, <Degree>". It promises nothing about sending: the physician has not
    approved anything yet. This is mail from our domain to an address the forwarded
    text chose, under the physician's name, so it goes out only when **every** guard
    passes:
    * the forward is **positively** authenticated: the top-most `Authentication-Results`
      (step 4) says `dmarc=pass`, or `spf=pass` together with a `dkim=pass` whose
      signing domain aligns with the sender's. No header is a no. (Filing the request
      needs only "no explicit failure"; this needs proof.) With `INBOUND_AUTHSERV_IDS`
      set, the header must also be the trusted MTA's;
    * the requester was found in the forwarded text (otherwise the address on the row
      is the physician's own);
    * the requester is not a `credentialdomd.com` address or a subdomain of one (a
      forward of one of our own replies, or a loop);
    * the requester is not the forwarding address, the profile email, or any of the
      physician's confirmed forwarding addresses (they mailed themselves the
      checklist);
    * the requester is not a machine mailbox (no-reply@, do-not-reply@, postmaster@,
      mailer-daemon@, bounce@, notifications@ and their variants, prefix match);
    * `profiles.ack_requests` is not false (the physician's switch, default on, in
      More > Settings);
    * the profile has a name (a nameless acknowledgement reads as spam);
    * at most once per message: `ack_sent_at` is checked on the physician's OTHER rows
      with the same `message_id` or `original_message_id` (a redelivered webhook
      inserts a fresh row; the same request forwarded twice does too);
    * at most `ACK_PER_PROFILE_PER_DAY` (10) per account per 24 hours, counted on the
      **ledger**: `inbound_emails` rows with `profile_id` = the account, `route = 'docs'`,
      `detail ILIKE '%ack sent%'`. It was counted on `document_requests.ack_sent_at`,
      and RLS lets the owner UPDATE any column of their own rows, so a signed-in script
      clearing that column lifted the cap; the ledger is service-role only and the
      detail carries "ack sent" for exactly the messages whose acknowledgement went out
      (no other outcome is worded with those two words);
    * never to an automated sender (step 2 ends the route before any of this).
    **Intent before send.** `ack_sent_at` (and `updated_at`) is written on the row
    BEFORE Resend is called and cleared only when Resend answers not-ok. It used to be
    written after, and a webhook retry after a timeout could acknowledge twice: the
    first attempt had sent and been cut off before the write, so the retry found no
    record and sent again. A stamp that cannot be written means no send.
11. Ledger: `route = 'docs'`, `status = 'done'`, `attachment_count`, `profile_id`, detail
    `request <id>, <ack outcome>, from <addr>[ (requester not found)], proposal N doc(s),
    M missing, attachments ...`. The ack outcome is one of `ack sent`, `ack failed: <status>`,
    `ack skipped: <reason>`, and it sits right after the id so the 500-character cut
    cannot remove it.

### Table `public.document_requests`

`id, user_id -> profiles(id) cascade, from_addr not null, from_name, subject,
body_text, message_id, original_message_id, forwarded_by, received_at, status
('new' | 'replied' | 'dismissed', default new), replied_at, reply_email_id, doc_ids
jsonb [], inbound_ledger_id, proposal jsonb, proposal_at, ack_sent_at, created_at,
updated_at`. Index `(user_id, status, received_at desc)`. RLS: owner select and update
(`user_id = current_profile_id()`, any column), admin select
(`is_admin(current_profile_id())`), no client insert (service role writes;
email-inbound inserts, send-packet-email updates). Because the owner can update any
column, nothing that limits what docs@ sends to a third party is counted on this
table; see the ledger cap above. `profiles.ack_requests boolean not null default true`
is the physician's switch for the acknowledgement. Migrations
`20260817_document_requests.sql` (also widens `inbound_emails.route` to allow `docs`)
and `20260911_request_packet_proposal.sql`.

### In the app

Home (banner) and More > Requests (`src/components/features/RequestsInbox.jsx`, pieces
in `src/components/features/RequestPacket.js`) show the proposal: the count line, a
line per ask, the note, and one button, **Approve and send**, which POSTs
`{ request_id, approve: true, cc_self: true, doc_ids, text }` to send-packet-email with
exactly what the screen showed. A stale proposal (a newer document uploaded, a proposed
one deleted) is rebuilt on the client with the same rules and written back; the tap
sends what is on screen either way. Review in full opens the hand-built modal for
everything else. A requester address the forward did not carry is typed into a
**Requester's email** field rendered above the same button on the request (open, type,
one tap); the tap writes it to `from_addr` (owners may update any column) and then calls
send-packet-email, so the function reads the row it just wrote. The modal is not the
path for that case: its Send never enables with zero documents, and the summary email
for a not-found request with nothing on file pointed exactly there.

Two guards on the client-side rebuild, both found the hard way. The write-back lands
only on a row still `status = 'new'` whose `proposal_at` is the one the rebuild replaced
(a zero-row result drops the row from the written set; a rebuild on one device once
overwrote the proposal on a row another device had just sent, so the record of what the
credentialer was told no longer matched the email). And nothing is rebuilt unless the
file loaded **from the cloud** and, for the gone-document rule, the device can see a
document list at all (a fresh laptop whose cloud load failed rebuilt a correct
five-document proposal as "nothing on file" and persisted it for every device).

### send-packet-email (edge function, deploy with `--no-verify-jwt`)

Caller identity: `_shared/clerkAuth.ts` `clerkProfile(req)` (Clerk JWT in
`Authorization: Bearer`). CORS as reply-ticket. Two ways in, one send path.

**Hand-built** `POST { request_id?: uuid, to: string, cc_self?: boolean, subject: string,
text: string, doc_ids: string[] }`: the modal, the physician chose everything. An empty
`doc_ids` is accepted (a reply with no attachment). When `request_id` is given the row
must be the caller's and is marked replied after the send, whatever its status was: a
row already `replied` is exactly what "Reply again by email" sends from, on purpose.

**Approve** `POST { request_id: uuid, approve: true, cc_self?: boolean, subject?: string,
text?: string, doc_ids?: uuid[] }` (validated by `approveRequestBody` in
`_shared/requestFlow.ts`, tested). The row supplies the recipient (`from_addr`);
`doc_ids` and `text` are what the app showed and win over the stored proposal, which
stands in only when they are absent (an older client). `text: ""` is an empty note;
`doc_ids: []` is a text-only reply. Subject defaults to `Re: <request subject>` with
stored Re:/Fwd: prefixes peeled; `cc_self` defaults on. In order:

1. 403 when the row is not the caller's; 400 when it was dismissed.
2. 400 "Nothing is proposed for this request yet" when the resolved list is empty AND
   the stored proposal has no items AND the call carries no note of its own. An empty
   list with at least one item, or with a non-empty `text`, goes out as the note alone,
   no attachments, documents query skipped. The note counts because the row can hold no
   proposal while the screen shows one the client rebuilt and failed to write back; the
   button then read "Send reply (nothing to attach)" and every tap was refused.
3. 400 when `from_addr` is the physician's own sending address (profile email,
   forwarding sender, or any confirmed forwarding address): the forward carried no
   `From:` and the address is a placeholder; sending would mail the packet back to the
   physician. The error names the Requester's email field on the request. 400 for a
   `credentialdomd.com` recipient.
4. 429 at 30 sends in the hour (share_log, `method = 'email'`).
5. Documents resolved: a proposed id that no longer belongs to the caller is skipped
   and reported as "a document no longer on file", not refused (the list came from
   the caller's own proposal); 400 when none of them resolve.
6. **Stale note**: 400 "A proposed document is no longer on file, so the note no longer
   matches the packet. Open the request; the app rebuilds it." when at least one id was
   skipped as gone AND the text being sent equals the stored `proposal.coverNote`
   (trimmed, CRLF-normalised). That note lists the missing document as attached. A note
   the client wrote (different text) is taken as deliberate; an empty stored note names
   nothing and is not checked.
7. **The claim.** Before a single byte is fetched:
   `update document_requests set status = 'replied', replied_at = now, updated_at = now
   where id = ? and user_id = caller and status = 'new' returning id`. Two devices
   showing the same button, or one tap retried on a slow network, arrive with the same
   id; the row moves for exactly one of them. When nothing comes back the row is
   re-read: `dismissed` gives the 400 above, anything else gives **409**
   `{ error: "Already sent on <Month D, YYYY>. To send another copy, open the request and
   use Reply again by email." }` (date from `replied_at`; "Already sent." when it is
   null).
8. Bytes pulled from Storage, caps applied; then the send. **Every definite failure
   after the claim hands it back** (`status = 'new'`, `replied_at = null`): nothing could
   be attached (400), Resend answered not-ok (502), or an error thrown before the POST
   (500), so a refused send leaves the button live. **An unknown outcome keeps it.**
   When the POST to Resend throws (the connection dropped after the body went out, an
   edge timeout) the packet may already be on its way; the catch-all used to release
   the claim on that throw too, the button came back live under "Try again", and a
   second tap mailed the credentialer the whole packet twice with the second send
   holding the only record. Now the row is completed as replied with
   `reply_email_id = null` and `doc_ids` = what was attached, the `share_log` row is
   written so the hourly cap counts it, and the response is 502 "The send could not be
   confirmed. Check the Replied tab before sending again; Reply again by email sends
   another copy." (email-inbound treats its acknowledgement the same way: the stamp
   stays on a throw.)
9. On success the row gets `reply_email_id` and `doc_ids` = ids actually attached
   (status and `replied_at` re-stamped), and a `share_log` row is written as before.

Response `200 { ok: true, email_id, attached: n, skipped: [filenames], to }` or
`{ error }` with status:

| Status | When |
| --- | --- |
| 400 | bad JSON; `to` not an email or a credentialdomd.com address; empty subject or over 200 chars; `text` over 5000 chars; bad `request_id` / `doc_ids` shape; profile has no email ("Add your email in Settings first"); request dismissed; nothing proposed; requester address is the physician's own; none of the proposed documents on file; stale note; doc_ids given but none could be attached |
| 401 | no or invalid Clerk token |
| 403 | a doc_id (hand-built path) or the request_id is not the caller's |
| 409 | approve path: the row was already claimed or replied ("Already sent on ...") |
| 429 | 30 sends in the last hour (share_log rows with `method = 'email'`) |
| 502 | Resend refused the send (claim released), or the send could not be confirmed (claim kept, row replied with `reply_email_id` null) |

Rules implemented on both paths:

* every doc_id must satisfy `documents.user_id = profileId`; bytes are downloaded from
  bucket `documents` at `documents.storage_path` (fallback `<auth_user_id>/<doc id>`)
  with the service role, and only from inside the caller's own folder;
* cap 10 files and 25 MB total after base64, in the caller's order; the rest are
  skipped and their filenames returned in `skipped`; duplicate filenames get ` (2)`;
  `content_type` from `mime_type`, then `type` when it is a MIME, then the extension;
* `from` = `"<profiles.name>, <profiles.degree_type> via CredentialDOMD"
  <docs@credentialdomd.com>` (degree omitted when empty; `"CredentialDOMD"` when the
  name is empty; the display name is quoted because it contains a comma), the same
  header the acknowledgement used, so both emails come from one name;
* `reply_to` = `profiles.email` (400 when empty), or on the approve path the confirmed
  forwarding address the request came from when that is not the profile email; `cc` =
  `[reply_to]` when `cc_self`;
* `In-Reply-To` / `References` from `original_message_id`, else `message_id` (skipped
  when it is a synthetic `resend:<id>`);
* body = `text` + blank line + footer "Sent from CredentialDOMD on behalf of <name>.
  Reply to this email to reach <name> directly." (name falls back to the email);
* always one `share_log` row `{ user_id, item_name: "Email packet (<n> files)", section:
  "documents", method: "email", recipient: to, sent_at: now(), item_id: null }`.

Deploy:
```
supabase functions deploy send-packet-email --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
```
`RESEND_API_KEY` is reused; no new secret. `INBOUND_AUTHSERV_IDS` on email-inbound is
optional. Apply `supabase/migrations/20260817_document_requests.sql` and
`20260911_request_packet_proposal.sql` before deploying either function: until the
first is applied a docs@ message fails at the ledger insert (route check) and Resend
keeps retrying it; until the second, the proposal update fails and every request
arrives without one.

Test: forward a credentialer email from your profile address to
docs@credentialdomd.com; expect the summary ("<Name> asked for N items: ... Packet ready:
N documents. Open the app and tap Approve and send."), a `document_requests` row with
`from_addr` = the credentialer, `status = 'new'`, `proposal` filled, and, when the
forward authenticated, the credentialer's acknowledgement with `ack_sent_at` set and
"ack sent" in the ledger detail. Then tap Approve and send on Home; expect the
credentialer to receive the packet from "<Name>, <Degree> via CredentialDOMD",
`reply_to` = your address, the row `replied`, a share_log row with `method = 'email'`,
and a second tap (or a second device) to get 409 "Already sent on ...".

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

The function trusts the From address for FILING only after checking the inbound path's `Authentication-Results` header: `dmarc=fail`, or `spf` and `dkim` both failing, drops the message with no upload and no reply (ledger status `failed`, detail starts with "sender authentication failed"). If the header is absent the message is treated as authenticated for that purpose; the residual risk is bounded by the per-sender cap (20 messages/hour per route, 10 files each) and by the fact that dropped files land only in the matched physician's own inbox list, unfiled, where they are obvious. On cme@ and contacts@ the header is read from Resend's collapsed header map; on docs@ it is read from the raw message (top-most occurrence), because that route sends to a third party.

Two things leave our domain on the docs@ route without the physician pressing anything: the acknowledgement to the requester, and nothing else. The packet itself goes only when the physician taps Approve and send. The acknowledgement is mail from docs@ to an address the forwarded text chose, with the physician's name on it, so it is held to a stricter standard than filing: it needs POSITIVE authentication (dmarc=pass, or spf=pass with an aligned dkim=pass) read from the top-most `Authentication-Results` of the raw message, optionally pinned to a trusted authserv-id; the requester must have been found in the forwarded text, must not be our domain, the physician's own addresses or a machine mailbox; `ack_requests` must be on; and it goes at most once per message (stamped before the send), at most 10 per account per day counted on the service-role ledger, and never in answer to an automated sender. A forged forward that clears the positive-authentication bar would still only cause one short "your request was received" note to an address the forger chose, promising nothing, from a named physician's account, capped at ten a day; everything that carries a document waits for the tap.
