<!-- Generated 2026-08-16 from a 46-agent readiness audit (9 dimensions, every P0/P1 adversarially re-verified). Supersedes LAUNCH_PLAYBOOK.md and PRODUCTION-CUTOVER.md where they conflict. -->

# CredentialDOMD: launch-readiness plan for the first invites

## Where we stand

The database layer is genuinely multi-tenant: RLS on all 45 tables, private per-user storage, edge functions verifying Clerk JWTs. A second physician cannot read your rows. Everything wrapped around it still assumes one user: an autonomous agent that builds whatever any ticket says, dev-instance Clerk in production, legal text describing a product that no longer exists, a support loop that swallows replies, a tax engine that assumes you. None of it is a rewrite. P0 is one hour, the P1s are about two focused days of Claude work plus roughly an hour of you in dashboards. No invite goes out until section 2 is clear.

## Blockers before the first invite

(Item 1 was closed on 2026-08-16, commit 468742b: every ticket-agent query now filters on `public.is_admin(t.user_id)`; non-admin tickets are treated as untrusted text.)

1. **P0. Pause and gate the ticket agent.** Any user's ticket text becomes owner-approved instructions to a skip-permissions agent holding the Supabase management token and push-to-main. It fires twice hourly (launchd :17 plus a crontab :47 kickstart) and has already shipped 9 commits from ticket text. Now: `launchctl bootout` plus delete the crontab line. Then: `AND is_admin(t.user_id)` in both queries in `scripts/ticket-agent.sh` (:25, :55) and the prompt query, rewrite `ticket-agent-prompt.md:4-6`, mark ticket bodies untrusted, drop `--dangerously-skip-permissions` for a scoped tool profile. Claude alone. 1 hour.
2. **Clerk production cutover, one change window.** Live bundle ships `pk_test_` (dynamic-goshawk-87). Every account created before cutover must be recreated and re-linked. Cutover as documented would break the app: CSP in `src/main.jsx` blocks `clerk.credentialdomd.com`, Supabase third-party auth and `CLERK_ISSUER` are pinned to dev, `setup-clerk-supabase.sh` builds the wrong (HS256) template. Eric: create prod instance, Google OAuth client, webhook endpoint, hand over keys. Claude: DNS CNAMEs, CSP, issuer registration, secrets, `gh secret set`, re-link your profile and move 43 storage objects, drop 4 test profiles, fix `PRODUCTION-CUTOVER.md`. Both. Half day.
3. **Close public sign-up and build the invite path.** Sign-up mode is Public, allowlist off, no invitation code exists anywhere; "invited" in Admin only flips a chip. Set Restricted mode on the prod instance and send Clerk invitations (dashboard or Backend API) to `/app/#sign-up`; test one end to end. Eric (dashboard) plus Claude (test). 1 hour.
4. **Fix the legal and claims surface.** Live app says "We sign BAAs" (FAQ, PricingModal, enterprise bullet), "Nothing is sent to any server", "document images stored locally only", ToS says "no account required", processors list omits Clerk, Cloudflare, Resend, Anthropic, NLM, no entity named, "Last updated March 2026", footer Privacy/Terms links are `#` and `/privacy` `/terms` 404, no consent at sign-up. Claude rewrites `LegalSection.jsx`, `FAQSection.jsx`, publishes static pages (extend the deploy copy step), links AuthPage, disclose AI processing of tickets and API-key handling. Eric confirms entity name and postal address, sets Clerk terms URLs and consent. Both. Half day.
5. **support@credentialdomd.com bounces.** No MX on the apex. It is the only contact in ToS, Privacy, the pricing modal, and 50 landing pages. Enable Cloudflare Email Routing (support@, hello@, whit@, privacy@) to your inbox, add DMARC. Eric, or Claude once the CF token gets Email Routing permission. 15 minutes.
6. **Support loop is a void.** SupportModal promises an email reply; nothing sends one, users have no thread view, Telegram secrets are unset so no alert reaches you, the agent auto-resolves into the invisible thread. Claude: DB trigger on admin replies sending via Resend, add tickets to `signup-notify.sh`, honest copy in SupportModal. 2 hours.
7. **Clerk webhook wipes app-entered name and email on `user.updated`.** First password reset by an invitee nulls the name on invoices and CV. Claude: fill-blanks-only, never overwrite `profiles.email`, redeploy. 30 minutes.
8. **Tax engine hardcodes CA resident, MFJ, CO/ND.** A Texas locum sees California income tax on everything as a "set aside" number. Claude: add resident state and filing status, show a "modelled for CA/MFJ" notice and hide the headline number otherwise, fix the Contracts hint. 3 hours.
9. **Client defaults that misrepresent the user.** `degreeType` defaults to DO (wrong CME rules, "DO" on CV and every email, gap banner can never fire); phantom $348 subscription deduction in every tax ledger; plan card says "Pro" with a dead Manage Billing button and a Cancel path threatening a 7-day wipe. Claude. 1.5 hours total.
10. **Device cache not scoped to the user.** Any session end other than the Sign out button leaves the whole file for the next account, which renders it and copies your name, NPI, and API keys into a blank profile. Claude: key cache by Clerk sub, purge on SignedOut, gate settings copy. You sign out on every device you used for test accounts. 2 hours.
11. **API keys synced to Postgres in plaintext, undisclosed.** Claude: stop syncing `api_key`/`anthropic_api_key`, null existing rows, update Settings hints. 30 minutes (see decision below).

## Do in the first two weeks with users

Sign-out purge for vault, Vera chat, timer keys. AI onboarding: BYOK sentence in the invite, "Turn on AI" checklist step, aistudio link. Gate `?preview_tier` and put a beta end date in code. Waitlist emails 2-3: kill or add CAN-SPAM footer and rewrite the "one email" promise. Anon INSERT on `early_access_leads` triggers unlimited Resend sends: move behind the Worker with rate limit. Disable Supabase Auth email sign-up. Single admin source (`app_admins`), fix `profiles_lock_identity` blocking service-role writes. Client error sink and Users tab in Admin. Neurosurgery-only prompts and CASE_CATEGORIES, agency placeholders. Offline edit loss and pending-ops queue. Auto-reload on focus while a form is open. Storage soft-delete. Stripe: async `constructEvent`, port checkout/portal to Clerk auth, add `stripe_customer_id`, run the products script when you are ready to charge.

## Decisions only you can make

- **Cutover before invites?** Yes. Every dev-instance signup is manual re-link work later.
- **Invite batch size:** 3 to 5 named physicians first (Fowler included), then 10 after one week clean.
- **Free during beta vs founding checkout:** free, no card, keep `UNLOCK_ALL_FEATURES` on with a stated end date (recommend 60 days from first invite). Stripe is not wired; do not block invites on it.
- **Founding-offer terms:** first 100 waitlist members in order, $12/mo locked 24 months, honored by stamping `is_founding_member` when invited. Drop the "full year on us" Zero-Lapse promise until it is defined in the ToS.
- **BYOK vs shared AI key:** BYOK at launch, said plainly in the invite. Add a quota-limited Gemini Flash proxy for scanner/dictation in weeks 2-4 if invitees stall on keys. Vera stays BYOK.
- **API keys cross-device:** device-local only (re-enter per device). Simplest honest option.
- **Ticket agent policy:** runs only on tickets you flag approved from Admin; user tickets get a reply, never a build.
- **Legal entity:** confirm "Eric Whitney DO, A Professional Corporation" and a postal address for Privacy, ToS, and email footers.
- **PITR ($100/mo):** not yet.

## Already verified fine

- RLS on all 45 public tables, owner-only policies via `current_profile_id()`, anon gets zero rows.
- Storage bucket private, folder keyed to Clerk sub, no signed or public URLs.
- Edge functions verify Clerk RS256 JWTs; Svix and Stripe signatures checked.
- Client upserts cannot poison another user's rows (PK plus RLS on conflict).
- Admin views and policies gate on `app_admins`, not "any authenticated user".
- No AI key in the bundle; AI costs you $0 regardless of user count.
- Empty-account rendering: 30 sections SSR-clean with default data.
- Deploy pipeline green, SW/version.json update path sound, no secrets in git.
- Welcome email pipeline live with SPF and DKIM.
- Studio jobs have locks, caps, and the Studio never sleeps on AC.

## Refuted claims

None outright refuted; every claim held on re-check. Downgraded from blocker to first-weeks: shared-device cloud merge (PK plus RLS stops row re-homing, exposure is render plus settings copy), missing vault/chat purge (needs two accounts on one browser), UNLOCK/preview_tier (intentional flag, no server-side tier), BYOK-only AI (fails closed with a Settings link), BAA copy (false claim, not a leak), cutover doc errors (latent until cutover), waitlist emails 2-3 (unwired drafts), missing user directory and error reporting (operator tooling).