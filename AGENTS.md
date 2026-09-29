# CredentialDOMD — Session Orientation

The user-facing product/company name is CredentialDOMD, with this exact capitalization. Use it in website/app labels, emails, documents, generated content, and assistant responses. Preserve existing lowercase email addresses/domains, identifiers, storage keys, and the legal registered entity name.

**What:** Healthcare credential management PWA for physicians. Tracks CME credits, licenses, certifications, and compliance deadlines. Founding-member-only model (no freemium).

**Stack:** React 19 + Vite 7 + Supabase (auth + database + RLS). Deployed on Vercel/Netlify.

**Status:** App built. Marketing materials exist (playbook PPTX, design research). SEO implemented (robots.txt, sitemap, Schema.org). "Add to Home Screen" FAQ done. Signup forms with honeypot anti-spam.

## Key Files
- `DESIGN_RESEARCH.md` — Comprehensive UI/UX design research (color palette, dark mode, typography, component patterns)
- `CME_Compliance_Database.xlsx` — CME compliance data
- `CredentialMD_Marketing_Playbook.pptx` — Marketing deck
- `supabase-schema.sql` — Main database schema
- `supabase-auth-migration.sql` — Auth migration
- `supabase-stripe-migration.sql` — Stripe integration
- `supabase-team-migration.sql` — Team features
- `supabase-rls-fix.sql` — Row-level security fixes

## Architecture Notes
- Supabase handles auth, database, and RLS policies
- Multiple SQL migration files — run in order if rebuilding
- Has Stripe integration for payments
- Landing page in `/landing/`
- Marketing assets in `/marketing/`

## Important Context
- This is the proof-of-concept for AutoAIBiz's "Automate What You Have" product line
- Founding member only — never add freemium

## Membership exceptions approved September 20, 2026

- The owner can give selected verified registered accounts Credential and Practice free for life through Admin → Users → Give free lifetime access. No card, checkout, subscription or automatic email is required. This is a private administrative gift, with an audit reason and server authorization.
- Preserve existing approved lifetime access and the protected historical 30-day no-card beta promise. Public paid plans and their locked annual rates remain in effect.
- A lifetime gift must not leave a renewing subscription charging the recipient. Verify current billing and block unresolved checkout or renewal before granting.

## Trial purchase and refund policy approved September 20, 2026

- Eligible historical no-card beta members may explicitly opt into an annual purchase during their original 30-day beta, using the same account and saved records. Their first annual charge and paid annual period start at the original beta end; opting in must not restart the beta or charge early. Beta activation alone never authorizes a paid subscription.
- The no-hassle 100% money-back guarantee covers the member's most recent annual membership payment, including an annual renewal. It does not refund cumulative payments from previous years. The owner specified no 30-day refund cutoff or prorating.
- Keep website, app checkout, terms, support guidance and reviewed emails consistent with those policies. Distinguish implemented and provider-verified behavior from staged copy. Actual refunds require a verified customer request and the correct latest annual payment; never invent a refund receipt or change production payments as a test.

## Public founding launch correction approved September 20, 2026

- The first 100 paid Credential/Core founding memberships are $99/year. After those 100, early-bird Credential is $149/year; standard Credential is later $199/year. Founding and early-bird annual rates remain locked while membership stays continuously active. Do not advertise $149 as the current founding offer or restrict all $99 offers to the waitlist.
- The four reviewed eligible historical $99 promises reserve places within the 100. Lifetime accounts and the $245/year Credential + Practice package do not consume paid $99 Core places. Legacy profile founding numbers are not a paid-member counter.
- Use authoritative server pricing and capacity for the website, app and checkout. Viewing an offer or creating an account does not reserve a place. Never silently replace $99 consent with a $149 purchase. If all places are held but fewer than 100 are paid, show temporary unavailability. A paid founding place is not replenished after cancellation or refund.
- Show the founding price and terms on the public website before sign-in. A checkout pause changes purchase availability, not the known price. Preserve the stated $99/first-100 policy when live availability cannot be confirmed, and label availability separately; never replace the price with a request to log in to see it.
- Keep the owner's approved pause on new checkout until production identity and real-account acceptance checks pass. Source code, deployed code, enabled policy and verified customer behavior are separate states.
- The owner chose to keep email login for now. Do not purchase Clerk Pro or enable paid SMS without a new owner instruction.

## Sign-in experience approved September 20, 2026

- “Beta” describes the product's early release stage while bugs are worked out; it is not a separate account type, login, or pricing tier. Access is separately determined by approved lifetime grants, paid membership, or the protected historical waitlist's 30-day free trial honoring earlier advertising. Do not make all early-release users free or charge the protected trial automatically.
- Present one email-first sign-in flow for everyone. Do not ask people to choose beta setup versus regular login or expose internal account-migration details as separate actions.
- Existing users must sign in, never recreate their account. Provision any missing production login identity through the reviewed reserved-email continuity procedure, then require normal mailbox verification before reconnecting the original profile. Keep approved access and saved records behind the single email entry; do not substitute a renamed signup screen.
- Keep the source Clerk development instance and sealed identities intact until every real continuity member is bound. The sealed manifest includes the excluded synthetic identity; a reviewed import subset does not change its digest. Never manually verify imported mailboxes, copy sessions, or use editable profile email as ownership proof.
- This UI requirement does not waive identity verification, change password requirements, enable billing, or authorize paid SMS.

## Membership display approved September 20, 2026

- Keep routine membership status, lifetime access and founding-member badges on Profile & settings. Do not repeat them across dashboards or everyday workspaces.
- Preserve actionable access-error messages and explanations where a feature is read-only. Keep trial dates, renewal terms and membership management available in the profile and intentional purchase flows.

## Dashboard CME guidance

- An unanswered CME applicability question must identify the missing information and provide a direct action to review it. Missing MD/DO selection belongs in Profile & settings; conditional requirements belong with the affected state's CME details.
- Keep the tracked-standing ring's numeric deadline score visible. Explain its meaning and show unanswered questions separately. Do not change compliance calculations, presume an exemption, or treat a deadline score as proof that all CME requirements are complete.

## Support replies (2026-09-28)

- Post every support reply written outside the app with `node scripts/ticket-fix/post-reply.mjs --ticket <uuid> --reply <file.json>`, one ticket per call. Check a draft first with `node scripts/ticket-fix/verify-claims.mjs` (same arguments, nothing is stored). Never insert into `support_messages` with SQL, and never batch replies to several tickets.
- The reply file holds claims, not prose. Opening, context and closing are fixed keys; `ticket_version` is the ticket's `updated_at` exactly as you read it (a ticket that changed since is withheld). Each claim cites a test (post-reply runs the cited test files itself on a clean tree at HEAD, and the live build must contain HEAD), a query recorded with `scripts/ticket-fix/record-query.mjs` with an `expect` (post-reply runs its SQL again; an absence claim needs a positive control on the same table), or quoted UI text at a `file:line` of product source in the live build. Anything unproven is shown to the customer as not done yet. Never type a commit or build id; use context `release` with `--fix <commit>`.
- A reply stored this way on a member's ticket is handed to `send-ticket-reply` to be emailed to that member once (owner decision 2026-09-29, migration `20260929134100`), from CredentialDOMD Support with a link to the ticket and `reply_to` `support+<ticket id>@credentialdomd.com`, which `email-inbound` adds to the ticket when the member answers from a confirmed, authenticated mailbox (anything else is relayed to the owner). Only `support_messages.emailed_at` shows it was sent: a failed send is retried by `retry_ticket_reply_emails` (`20260929150000`), and `reconcile.mjs` alerts the owner about a reply still not emailed an hour after it was stored. A reply on an admin's own ticket is never emailed. post-reply says which in its output. Storing a reply on a member's ticket sends it; there is no unsend, so check it with verify-claims first. Replies are still stored with the ticket owner as author; the verification, not `author_id`, marks them as support replies.
- Never read the vault secret `support_reply_hmac_key`, never write `support_reply_verifications` directly, never write `support_messages` with a service-role key or client, never call `send-ticket-reply` directly, and never run `scripts/ticket-agent-context.mjs --load` or `--record-and-reply` by hand: those are the hourly runner's steps. After migrations `20260928150000` and `20260928161000` the database refuses a support reply that did not come through a checked path, and `scripts/ticket-fix/reconcile.mjs` reports any that got past it to the owner. Do not disable the trigger to get around it.
- Agent changes (stage 2): the hourly agent never commits or pushes. Its work lives on branches `agent/<id8>-<runid>`, one commit each, authored "CredentialDOMD Ticket Agent" with `Ticket:`, `Ticket-Agent-Run:` and `Gates:` trailers. A held change's summary is `~/Library/Application Support/CredentialDOMD/ticket-work/runs/<run-id>/HELD.txt`. Merge it only with `node scripts/ticket-fix/merge.mjs <run-id>` (fast-forward only; if main moved it is rebased, re-gated and, when the diff changed, re-reviewed), or drop it with `node scripts/ticket-fix/merge.mjs --discard <run-id>`. Never merge, cherry-pick or push an `agent/*` branch by hand, and never create `ticket-work/AUTO_MERGE` unless the owner says so.
- Agent replies (stage 3): each ticket's checklist of asks is frozen in `~/Library/Application Support/CredentialDOMD/ticket-context/checklists/<ticket>.json`; never edit or delete it (the runner refuses a changed one). The hourly agent's reply is rendered by the host from verified claims with a "Where each part stands:" footer, one line per item. After you merge a held change, nothing tells the customer it is live: post that update with `post-reply.mjs`.
