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

## Support replies (2026-09-28)

- Post every support reply written outside the app with `node scripts/ticket-fix/post-reply.mjs --ticket <uuid> --reply <file.json>`, one ticket per call. Check a draft first with `node scripts/ticket-fix/verify-claims.mjs` (same arguments, nothing is stored). Never insert into `support_messages` with SQL, and never batch replies to several tickets.
- The reply file holds claims, not prose. Opening, context and closing are fixed keys; `ticket_version` is the ticket's `updated_at` exactly as you read it (a ticket that changed since is withheld). Each claim cites a test (post-reply runs the cited test files itself on a clean tree at HEAD, and the live build must contain HEAD), a query recorded with `scripts/ticket-fix/record-query.mjs` with an `expect` (post-reply runs its SQL again; an absence claim needs a positive control on the same table), or quoted UI text at a `file:line` of product source in the live build. Anything unproven is shown to the customer as not done yet. Never type a commit or build id; use context `release` with `--fix <commit>`.
- Replies stored this way are not emailed to members yet (they are stored with the ticket owner as author); post-reply says so in its output. How member replies are emailed is the owner's decision.
- Never read the vault secret `support_reply_hmac_key`, never write `support_reply_verifications` directly, never write `support_messages` with a service-role key or client, never call `send-ticket-reply` directly, and never run `scripts/ticket-agent-context.mjs --load` or `--record-and-reply` by hand: those are the hourly runner's steps. After migrations `20260928150000` and `20260928160000` the database refuses a support reply that did not come through a checked path, and `scripts/ticket-fix/reconcile.mjs` reports any that got past it to the owner. Do not disable the trigger to get around it.
- Agent changes (stage 2): the hourly agent never commits or pushes. Its work lives on branches `agent/<id8>-<runid>`, one commit each, authored "CredentialDOMD Ticket Agent" with `Ticket:`, `Ticket-Agent-Run:` and `Gates:` trailers. A held change's summary is `~/Library/Application Support/CredentialDOMD/ticket-work/runs/<run-id>/HELD.txt`. Merge it only with `node scripts/ticket-fix/merge.mjs <run-id>` (fast-forward only; if main moved it is rebased, re-gated and, when the diff changed, re-reviewed), or drop it with `node scripts/ticket-fix/merge.mjs --discard <run-id>`. Never merge, cherry-pick or push an `agent/*` branch by hand, and never create `ticket-work/AUTO_MERGE` unless the owner says so.
- Agent replies (stage 3): each ticket's checklist of asks is frozen in `~/Library/Application Support/CredentialDOMD/ticket-context/checklists/<ticket>.json`; never edit or delete it (the runner refuses a changed one). The hourly agent's reply is rendered by the host from verified claims with a "Where each part stands:" footer, one line per item. After you merge a held change, nothing tells the customer it is live: post that update with `post-reply.mjs`.
