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
- The reply file holds claims, not prose: each claim cites a test that passed in a gates file from `scripts/ticket-fix/run-tests.mjs`, a query recorded with `scripts/ticket-fix/record-query.mjs`, or a `file:line` at HEAD. Anything unproven is shown to the customer as not done yet. Never type a commit or build id; write `{{FIX_COMMIT}}` (with `--fix <commit>`) or `{{BUILD}}`.
- After migration `20260928150000_support_reply_verifications.sql` the database refuses an operator-SQL support reply without a matching verification. Do not disable the trigger to get around it.
