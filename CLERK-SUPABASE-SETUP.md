# Clerk ↔ Supabase Setup

CredentialDOMD now uses **Clerk** for authentication and **Supabase** for
data + RLS. This doc walks the dashboard configuration that has to be done
once before sign-in works in any environment (dev, gh-pages, custom domain).

The code side (`src/main.jsx`, `src/lib/supabase.js`,
`supabase/functions/clerk-webhook/`) is already wired up — these steps just
hand it the keys it needs.

---

## 1. Create the Clerk app

1. Go to <https://dashboard.clerk.com> → **Create application**.
2. Name: `CredentialDOMD` (separate from the existing ANMG CallSync app).
3. Pick the sign-in methods you want to expose:
   - **Email** (link + code) — recommended default.
   - **Google OAuth** — optional, enable when you're ready.
   - **Password** — optional. Off by default keeps the surface area small.
4. After the app is created, copy the **Publishable Key** (starts with
   `pk_test_…` in dev, `pk_live_…` in prod) into `.env`:

   ```
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxxxxxxxxxx
   ```

   For the gh-pages / Netlify build, set the same key as a build-time
   environment variable. **Never** commit it to git, even though `pk_*` keys
   are technically safe to expose.

---

## 2. Configure the Clerk JWT template for Supabase

Supabase RLS reads the JWT's `sub` claim via `auth.uid()`. We need Clerk to
sign a JWT that Supabase trusts, with the right shape.

We use Clerk's **default RS256 signing key** (not a shared HS256 secret).
Supabase verifies the signature against Clerk's public JWKS. This is the
modern Supabase Third-Party Auth flow — no shared secret to rotate, and
the Supabase JWT secret stays untouched.

The template was created via the Clerk Backend API:

```bash
curl -X POST https://api.clerk.com/v1/jwt_templates \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "supabase",
    "claims": {
      "email": "{{user.primary_email_address}}",
      "aud": "authenticated",
      "role": "authenticated"
    },
    "lifetime": 3600,
    "allowed_clock_skew": 5
  }'
```

Notes:

- The template name `supabase` is hard-coded in `src/lib/supabase.js`.
- `sub` is a **reserved** Clerk claim — do not include it. Clerk auto-injects
  the user id (e.g. `user_2abc…`) into `sub`, so `auth.uid()` resolves to
  the Clerk user id. RLS policies that compare `auth.uid()` to a `text`
  column keep working; policies that expect a UUID need the migration in §4.
- `custom_signing_key` is intentionally `false`. Clerk signs with its
  instance RSA key, exposed at
  `https://<your-frontend-api>/.well-known/jwks.json`.

For this project's dev instance (`dynamic-goshawk-87`):

- Frontend API: `https://dynamic-goshawk-87.clerk.accounts.dev`
- JWKS: `https://dynamic-goshawk-87.clerk.accounts.dev/.well-known/jwks.json`
- Template id: `jtmp_3DECWEvW2YNvstcg2Km3KDp3bzJ`

### 2a. Tell Supabase to trust this Clerk instance

Either via the dashboard (**Authentication → Sign In / Up → Third Party Auth
→ Add provider → Clerk**, set domain to the Clerk Frontend API host) — or
via the Management API, which is what we used since the dashboard SPA
doesn't render reliably in our setup:

```bash
curl -X POST \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth/third-party-auth" \
  -H "Authorization: Bearer $SUPABASE_PAT" \
  -H "Content-Type: application/json" \
  -d '{
    "oidc_issuer_url": "https://dynamic-goshawk-87.clerk.accounts.dev",
    "jwks_url": "https://dynamic-goshawk-87.clerk.accounts.dev/.well-known/jwks.json"
  }'
```

Supabase auto-classifies the provider as `clerk-development` (or
`clerk-production` for `*.clerk.com` issuers) and fetches the JWKS at
registration time — `resolved_at` in the response confirms the keys were
loaded successfully. From then on, Supabase accepts any RS256 JWT whose
`iss` matches the registered domain and whose signature verifies against
the cached JWKS. No shared secret required.

For this project (ref `hkpnnsjcwprrwobmpqyy`):

- Provider id: `311af797-6440-4513-a056-1ffdbf044e87`
- Type: `clerk-development`

To remove or replace the integration, `DELETE` against
`/v1/projects/{ref}/config/auth/third-party-auth/{tpa_id}`.

If you skip this registration entirely, Supabase falls back to its own JWT
secret and rejects the Clerk-issued tokens with `401 invalid JWT`.

---

## 3. Configure the Clerk → profiles webhook

This keeps the `profiles` table in sync with Clerk's user records (created,
email rotated, account deleted).

1. Deploy the function (from the repo root):

   ```bash
   supabase functions deploy clerk-webhook --no-verify-jwt
   ```

   `--no-verify-jwt` is required because Clerk signs the request with Svix,
   not with a Supabase JWT — the function does its own signature
   verification.

2. In the Clerk dashboard: **Webhooks → Add endpoint**.
3. Endpoint URL:

   ```
   https://<your-supabase-ref>.supabase.co/functions/v1/clerk-webhook
   ```

4. Subscribe to:
   - `user.created`
   - `user.updated`
   - `user.deleted`
5. Copy the **Signing secret** (starts with `whsec_…`).
6. Set it as a Supabase Edge Function secret:

   ```bash
   supabase secrets set CLERK_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxx
   ```

7. Hit **Send example** in the Clerk webhook dashboard to confirm the
   endpoint returns `200 ok`.

---

## 4. Existing-data migration (one-time)

The pre-Clerk schema stored `auth_user_id UUID` on `profiles`. Clerk user
ids are strings (`user_2abc…`), not UUIDs. Two paths:

### Option A — change the column type (recommended)

```sql
alter table profiles alter column auth_user_id type text;
-- repeat for any other table that references the auth user directly:
alter table subscriptions alter column auth_user_id type text;
```

Update RLS policies that explicitly cast to UUID.

### Option B — keep UUID, store Clerk id elsewhere

Add `clerk_user_id text` columns alongside the existing `auth_user_id uuid`.
Migrate existing rows by mapping the old Supabase-Auth UUID → the Clerk id
via the email column (one-time script). Note that `sub` is reserved by
Clerk and always carries the Clerk user id, so RLS would have to read the
mapped UUID from a different claim (e.g. `user_metadata.profile_id`) via
`auth.jwt() -> 'user_metadata' ->> 'profile_id'`.

We're going with **Option A** for the dev environment. Production data will
need a coordinated cutover when we have real users.

---

## 5. Smoke-testing locally

```bash
npm run dev
```

Open <http://localhost:5173>. You should see Clerk's sign-in widget inside
the CredentialDOMD shell. Sign up with a test email — Clerk delivers the
verification link.

After sign-in, open the browser devtools network tab and confirm:

- Requests to `*.supabase.co` carry an `Authorization: Bearer eyJ…` header.
- The JWT decodes (jwt.io) to `{ "sub": "user_…", "role": "authenticated" }`.
- Hitting any `profiles` row returns just *your* row — RLS is enforcing.

If you get `401 invalid JWT` from Supabase, the most likely cause is that
the Clerk instance hasn't been registered as a Third-Party Auth provider in
the Supabase dashboard (see §2a). Supabase has no way to fetch the JWKS
until you add the provider. Less likely: the JWT template was renamed away
from `supabase`, or the issuer in the token doesn't match the domain you
registered.
