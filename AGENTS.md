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
