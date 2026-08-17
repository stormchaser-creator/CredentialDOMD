# Shared AI key (ai-proxy)

Every AI feature works for a new account with zero setup. The browser sends
Gemini requests to the `ai-proxy` edge function with the user's Clerk JWT;
the function attaches the shared Gemini key (stored only in
`public.app_secrets`), forwards to Google, and logs one `public.ai_usage`
row per call. A user's own key (Settings > AI, device-local) bypasses the
proxy and the quota.

## Pieces

| Piece | Where |
|---|---|
| Tables `app_secrets`, `ai_usage` + RLS | `supabase/migrations/20260817_ai_proxy.sql` |
| Proxy (POST forward, GET status) | `supabase/functions/ai-proxy/index.ts` |
| Admin key management (GET/POST/DELETE) | `supabase/functions/admin-shared-key/index.ts` |
| Admin UI (Admin > AI tab) | `src/components/pages/AdminDashboard.jsx` (`AiPanel`) |
| Client wrapper `geminiCall` / `aiAvailable` | `src/utils/aiClient.js` (separate task) |

## Contract

`POST /functions/v1/ai-proxy` with `Authorization: Bearer <Clerk JWT>` and
body `{ path: "models/<model>:generateContent" | "...:countTokens", body: <Gemini JSON> }`.

| Status | Meaning |
|---|---|
| 401 | not signed in |
| 403 | `profiles.access_status` not `active` (admins always pass) |
| 400 | bad path or JSON |
| 503 `{ error: "shared_key_not_configured" }` | no shared key saved |
| 429 `{ error: "quota", used, limit }` | past the per-user daily cap |
| other | Google's own status and JSON, verbatim |

`GET /functions/v1/ai-proxy` -> `{ shared, used_today, limit, unlimited }`.

## Deploy (owner)

```sh
cd ~/Projects/CredentialDOMD
supabase db push --project-ref hkpnnsjcwprrwobmpqyy            # or run the migration SQL in the dashboard
supabase functions deploy ai-proxy --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
supabase functions deploy admin-shared-key --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
```

Both functions use `_shared/clerkAuth.ts`, so they need the same env as the
other Clerk-aware functions (`CLERK_ISSUER` if not the default,
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform).

Then in the app: Admin > AI > paste a Google AI Studio key > Save shared key
(or "Use my own key from this device").

## Daily cap

Default 200 calls per user per UTC day (`DEFAULT_DAILY_LIMIT` in
`ai-proxy/index.ts`). Override without a redeploy by setting the
`AI_DAILY_LIMIT` function secret. Admins are unlimited.
