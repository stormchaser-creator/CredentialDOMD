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
