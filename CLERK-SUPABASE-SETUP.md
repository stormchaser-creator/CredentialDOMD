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

1. **Get the Supabase JWT secret.** In the Supabase dashboard:
   *Project Settings → API → JWT Settings → JWT Secret.* Copy it.
2. In the Clerk dashboard: **JWT templates → New template → Blank**.
3. Name: `supabase` (this exact name is hard-coded in
   `src/lib/supabase.js`).
4. **Signing algorithm:** `HS256`.
5. **Signing key:** paste the Supabase JWT secret from step 1.
6. **Claims (JSON):**

   ```json
   {
     "aud": "authenticated",
     "role": "authenticated",
     "email": "{{user.primary_email_address}}",
     "user_metadata": {
       "clerk_user_id": "{{user.id}}",
       "full_name": "{{user.full_name}}"
     }
   }
   ```

   Clerk auto-populates `sub` with the user id, so `auth.uid()` returns the
   Clerk user id (e.g. `user_2abc…`). Existing RLS policies that compare
   `auth.uid()` to a `text` column keep working; policies that expect a
   UUID need a one-time migration (see §4).

7. Save the template.

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
via the email column (one-time script). Update the JWT template to put the
mapped UUID in `sub` instead of the Clerk id.

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

If you get `401 invalid JWT` from Supabase, the JWT template's signing
secret doesn't match the Supabase JWT secret. Re-copy from §2 step 1.
