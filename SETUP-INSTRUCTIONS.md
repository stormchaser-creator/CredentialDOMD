# Clerk ↔ Supabase: One-Time Secret Setup

The Clerk secret key and the Supabase JWT secret are the two things that
**cannot** be retrieved programmatically — both providers gate them
behind their dashboards. Once you've copied them, `setup-clerk-supabase.sh`
does the rest (creates the JWT template via the Clerk Backend API, writes
both secrets to `.env.local`).

You only need to do this once per environment.

---

## 1. Get the Clerk secret key

1. Open **https://dashboard.clerk.com**
2. Select the **CredentialDOMD** application.
   - Verify the app id matches: `app_3DDZhRkPX42f5WGQqVp75BKUHT3`
3. Left sidebar → **Configure → API keys**
   - Direct link: `https://dashboard.clerk.com/apps/app_3DDZhRkPX42f5WGQqVp75BKUHT3/instances/ins_3DDZhdSkFminHbCy8SXUSlklwj0/api-keys`
4. Under **Secret keys**, click **Show** next to the active key.
   - It starts with `sk_test_…` (development instance) or `sk_live_…` (production).
5. Copy the full value to your clipboard. You'll paste it into the script in a moment.

> **Treat this like a password.** Anyone with `sk_test_…` can mint
> sessions and read every user in your dev instance. Don't paste it into
> chat, docs, or commits.

---

## 2. Get the Supabase JWT secret

1. Open **https://supabase.com/dashboard/project/hkpnnsjcwprrwobmpqyy/settings/api**
2. Scroll to the **JWT Settings** section.
3. Click **Reveal** under **JWT Secret**.
4. Copy the full value (long opaque string, no `eyJ…` prefix — that prefix
   is for the *signed* tokens, not the signing secret itself).

> This is the symmetric key that signs every Supabase-issued JWT and
> will sign Clerk's `supabase` template tokens too. Same warning — never
> commit it.

---

## 3. Run the setup script

From the project root:

```bash
cd ~/Desktop/CredentialDOMD       # or wherever this repo lives
./setup-clerk-supabase.sh
```

The script will:

1. Prompt for the Clerk secret key (input is hidden).
2. Prompt for the Supabase JWT secret (input is hidden).
3. `POST https://api.clerk.com/v1/jwt_templates` to create a template named
   `supabase`, signing algorithm `HS256`, signing key = the Supabase JWT
   secret, with claims:

   ```json
   {
     "sub":   "{{user.id}}",
     "email": "{{user.primary_email_address}}",
     "aud":   "authenticated",
     "role":  "authenticated"
   }
   ```

4. Write both secrets to `.env.local` (`chmod 600`). `.env.local` is
   already in `.gitignore`, so it will not be committed.
5. Print the new template id and a verification URL.

**Re-running the script is safe** for the secrets file (existing values
are updated in place rather than appended) — but the Clerk API will
reject a second `POST` for the same template name with HTTP 422. If you
need to update an existing template, delete it in the Clerk dashboard
first or use `PATCH /v1/jwt_templates/{id}`.

---

## 4. Verify

After the script reports success:

1. Clerk dashboard → **JWT Templates** → confirm a `supabase` row exists
   with algorithm HS256.
2. In the running app, sign in with Clerk and watch the network panel —
   `POST` to `https://hkpnnsjcwprrwobmpqyy.supabase.co/rest/v1/...` should
   include an `Authorization: Bearer eyJ…` header. Decode the JWT at
   <https://jwt.io>; the payload should show `sub`, `email`,
   `aud: "authenticated"`, `role: "authenticated"`.
3. RLS policies that reference `auth.uid()` will now see the Clerk user
   id (e.g. `user_2abc…`).

---

## What this script does *not* do

- Does **not** set the Clerk webhook signing secret (`whsec_…`) — that's
  step 3 of the original Clerk-Supabase setup; run
  `supabase secrets set CLERK_WEBHOOK_SECRET=…` separately.
- Does **not** push secrets to GitHub Actions or Netlify. Build-time
  variables (the `pk_test_…` publishable key) are already wired up;
  server-side secrets stay local in `.env.local`.
- Does **not** migrate existing RLS policies. If any policies expect a
  UUID `auth.uid()`, they'll need updating to handle Clerk's text user
  ids — see `CLERK-SUPABASE-SETUP.md` §4 in the auth worktree.
