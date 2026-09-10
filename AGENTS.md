# CredentialDOMD — Session Orientation

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
