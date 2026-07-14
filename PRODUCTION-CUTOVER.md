# Production Cutover: Switching from Dev Clerk to Production Clerk

## Why this exists

The deployed app at `credentialdomd.com` was loading a **development** Clerk
instance (publishable key `pk_test_…`). Google sign-in went through Clerk's
shared dev OAuth proxy at `clerk.shared.lcl.dev` — that proxy is registered
with a Clerk-owned Google OAuth client and cannot hand off a session to a
non-Clerk-owned origin like `credentialdomd.com`. Result: the OAuth flow
looked like it succeeded on Google's side but the session never landed in
the user's browser.

This document is the manual checklist for putting a real production Clerk
instance behind credentialdomd.com so Google sign-in (and OAuth in general)
actually works. Until that's done, the auth UI hides the Google button and
falls back to email + password / magic link, both of which work on the dev
instance.

The work splits into five phases. Each phase has external prerequisites
(dashboards, DNS, OAuth consoles) that I cannot do for you — but every
piece I *can* automate is called out.

---

## Phase 1 — Create the Clerk production instance

1. Go to https://dashboard.clerk.com → CredentialDOMD application.
2. Top-right environment switcher → **Production**.
   - First time, Clerk shows a "Deploy to production" wizard.
3. Production domain: `credentialdomd.com`.
4. Once created, copy three values:
   - **Publishable key** — `pk_live_…` (goes in the GitHub Action below)
   - **Secret key** — `sk_live_…` (goes in `.env.local` for scripts)
   - **Frontend API host** — usually `clerk.credentialdomd.com`
     (used for DNS in Phase 2)

> The dev instance keeps existing alongside production. They are
> independent — separate users, separate JWT templates, separate
> webhooks. Anything you set up on the dev instance has to be repeated
> on production.

---

## Phase 2 — DNS records

Clerk's production frontend lives on a subdomain you control. The
production instance's "Domains" page lists the exact records you need —
typically four CNAMEs:

| Host                          | Type  | Target                                |
|-------------------------------|-------|---------------------------------------|
| `clerk.credentialdomd.com`    | CNAME | `frontend-api.clerk.services`         |
| `accounts.credentialdomd.com` | CNAME | `accounts.clerk.services`             |
| `clkmail.credentialdomd.com`  | CNAME | `mail.<your-frontend-api>.clerk.services` |
| `clk._domainkey.credentialdomd.com` | CNAME | `dkim1.<...>.clerk.services`    |

(Exact targets vary per instance — copy from the Clerk dashboard, don't
guess.)

**Where to add them:** wherever credentialdomd.com is registered.
`gh-pages` only handles A/AAAA for the apex; the CNAMEs go on your
registrar. Propagation usually takes 5-30 minutes; Clerk re-checks
every minute and flips a green checkmark per record.

---

## Phase 3 — Bring your own Google OAuth client

1. https://console.cloud.google.com/ → pick a project (or create
   "CredentialDOMD-prod").
2. **APIs & Services → OAuth consent screen**.
   - User type: **External**.
   - App name: `CredentialDOMD`.
   - Support email + developer email: yours.
   - Authorized domains: `credentialdomd.com`.
   - Scopes: `openid`, `email`, `profile` (Clerk requires these).
   - Save and (for prod use) submit for verification — verification is
     optional for ≤ 100 test users, required to remove the unverified
     warning at scale.
3. **APIs & Services → Credentials → Create Credentials → OAuth Client ID**.
   - Application type: **Web application**.
   - Name: `CredentialDOMD-prod`.
   - **Authorized JavaScript origins**:
     - `https://credentialdomd.com`
     - `https://clerk.credentialdomd.com`
   - **Authorized redirect URIs**:
     - `https://clerk.credentialdomd.com/v1/oauth_callback`
   - Save. Copy the **Client ID** and **Client secret**.
4. Back in Clerk dashboard (production instance) → **User & authentication
   → Social Connections → Google** → toggle **Use custom credentials** →
   paste the Client ID + Secret → Save.

The button text should now read "Continue with Google" → on click,
Google's consent screen says "to continue to **CredentialDOMD**" instead
of "to continue to Clerk".

---

## Phase 4 — Switch the deployed app to the production key

Once Phase 1-3 are done and Clerk's production dashboard shows all
checkmarks green:

```bash
# Replace the dev publishable key with the live one.
gh secret set VITE_CLERK_PUBLISHABLE_KEY --body 'pk_live_…' \
  --repo stormchaser-creator/CredentialDOMD

# Trigger a redeploy (the workflow path filter doesn't include this doc,
# so you have to dispatch manually).
gh workflow run deploy-gh-pages.yml --ref main

# Watch it.
gh run watch --exit-status
```

Once the run is green, hard-reload `credentialdomd.com/app/` and confirm:

- DevTools → Console: no "loaded with development keys" warning.
- DevTools → Network → first Clerk request: hostname is
  `clerk.credentialdomd.com`, not `dynamic-goshawk-87.clerk.accounts.dev`.

The Google button un-hides itself: as of 2026-07-08 the overrides in
`src/components/pages/AuthPage.jsx` are gated on the publishable key
type (`pk_test_` hides, `pk_live_` shows). No code change needed at
cutover — the button appears automatically with the new key.

---

## Phase 5 — Re-create the Clerk side of the Supabase JWT template

The `supabase` JWT template you created earlier lives on the *dev*
Clerk instance. Production needs its own. Run the existing setup script
again, but paste the **production** Clerk secret key when prompted:

```bash
./setup-clerk-supabase.sh
# Clerk secret key  → paste sk_live_…
# Supabase JWT secret → paste the same value as before (Supabase didn't
#                       change; only the Clerk side did)
```

The script writes both keys into `.env.local`, replacing whatever was
there from the dev run. Verify in Clerk dashboard (production) → JWT
Templates that a `supabase` template now exists with HS256 algorithm.

If you also have the Clerk webhook for the `profiles` table wired up:
the webhook is configured on a per-instance basis in the Clerk
dashboard. Re-create it under the production instance (same URL —
`https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/clerk-webhook`),
copy the new `whsec_…` signing secret, then:

```bash
supabase secrets set CLERK_WEBHOOK_SECRET=whsec_… \
  --project-ref hkpnnsjcwprrwobmpqyy
```

---

## What's already done

- ✅ CSP allows Cloudflare Turnstile in `script-src`, `frame-src`, and
  `connect-src` (commit `3457f11`, deployed). This unblocks Clerk's
  Smart CAPTCHA on email/password sign-up if it ever fires.
- ✅ `setup-clerk-supabase.sh` exists at the repo root and works against
  whichever instance you point it at (paste the matching `sk_*` key).
- ✅ Google sign-in button auto-hides while the app runs on a `pk_test_`
  key and auto-shows on `pk_live_` (2026-07-08). Email + password + magic
  link work on the dev instance meanwhile.
- ✅ Supabase already trusts the DEV Clerk issuer via Third-Party Auth
  (see CLERK-SUPABASE-SETUP.md §2a). In Phase 5 you must ALSO register the
  production issuer (`https://clerk.credentialdomd.com`) the same way —
  dashboard: Authentication → Sign In / Up → Third Party Auth → Add
  provider → Clerk, or the Management API call in that doc with the prod
  issuer/JWKS URLs.
- ✅ `VITE_CLERK_PUBLISHABLE_KEY` GitHub repo secret already exists
  (currently the dev `pk_test_…`); just overwrite with `pk_live_…` in
  Phase 4.

## What still needs you, in order

- ⚠ Phase 1 — create production instance in Clerk dashboard.
- ⚠ Phase 2 — add CNAMEs at your DNS registrar.
- ⚠ Phase 3 — create a Google OAuth client; paste it into Clerk.
- ⚠ Phase 4 — `gh secret set` + workflow dispatch (one command each).
- ⚠ Phase 5 — re-run `setup-clerk-supabase.sh` against the prod instance.

Each phase is gated on the previous one; don't try to do them out of
order or Clerk's dashboard will refuse to mark the instance "live".
