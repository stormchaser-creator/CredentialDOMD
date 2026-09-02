# Shared AI keys (ai-proxy)

Every AI feature works for a new account with zero setup. The browser sends
Gemini requests, and Anthropic Messages requests through `@anthropic-ai/sdk`
pointed at the function, to the `ai-proxy` edge function with the user's
Clerk JWT. The function attaches the shared key (stored only in
`public.app_secrets`), forwards the call, and logs one `public.ai_usage` row
per call: provider, model, the vendor's token counts, and the cost at list
price. A user's own key (Settings > AI, device-local) bypasses the proxy, the
daily caps and the monthly budget.

## Pieces

| Piece | Where |
|---|---|
| Tables `app_secrets`, `ai_usage` + RLS | `supabase/migrations/20260817_ai_proxy.sql` |
| Metering columns, spend index, `ai_usage_spend_usd()` | `supabase/migrations/20260902c_ai_usage_metering.sql` |
| Proxy (Gemini POST, Anthropic POST, GET status) | `supabase/functions/ai-proxy/index.ts` |
| Price table and cost arithmetic | `supabase/functions/_shared/aiPricing.ts` (mirrored in `aiPricing.json`) |
| Admin key management (GET/POST/DELETE) | `supabase/functions/admin-shared-key/index.ts` |
| Admin UI (Admin > AI tab) | `src/components/pages/AdminDashboard.jsx` (`AiPanel`) |
| Client wrapper `geminiCall`, `anthropicClientFor`, status and budget copy | `src/utils/aiClient.js` |
| Tests | `scripts/ai-pricing.test.mjs`, `scripts/ai-budget-client.test.mjs` |

## Contract

### Gemini

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

The monthly dollar budget never blocks Gemini: it is cheap, and it is where
the app lands once Opus is over budget. Every call is still costed.

### Anthropic

`POST /functions/v1/ai-proxy/v1/messages` with the same bearer token and the
Anthropic Messages request JSON as the body. The body is forwarded verbatim
with the shared key; only prompt-caching `anthropic-beta` tokens pass through.

| Status | Meaning |
|---|---|
| 401 / 403 | as above |
| 400 `{ error: "Bad JSON" }` | |
| 400 `{ error: "stream_not_supported" }` | `stream: true` (the proxy buffers the reply to meter it) |
| 400 `{ error: "model_not_allowed", allowed }` | only `claude-opus-5` and `claude-sonnet-5` |
| 400 `{ error: "max_tokens_out_of_range", ceiling }` | `max_tokens` over 16000 or missing |
| 400 `{ error: "field_not_allowed", field }` | `speed`, `service_tier`, `tools`, `mcp_servers`, `container`, `betas` |
| 503 `{ error: "shared_key_not_configured", provider: "anthropic" }` | no shared Anthropic key saved |
| 429 `{ error: "quota", used, limit, provider: "anthropic" }` | past the per-user daily cap |
| 429 `{ error: "budget", spent_usd, budget_usd, provider: "anthropic" }` | past this month's hard dollar budget; the app answers on Gemini |
| other | Anthropic's own status and body, verbatim |

Both proxy 429s carry `x-should-retry: false`, which the SDK honors, so a
refusal costs one round trip. `thinking` and `output_config` (effort) are
allowed through: Vera runs conversational turns at effort `low`.

### Status

`GET /functions/v1/ai-proxy` ->
`{ shared, used_today, limit, unlimited, anthropic_shared, anthropic_used_today, anthropic_limit, month_spent_usd, budget_soft_usd, budget_hard_usd, over_soft, over_hard }`.
`shared` and `anthropic_shared` mean the key is configured and this account
may use it. `over_soft` and `over_hard` are always false for admins.

## Metering

Every forwarded call writes one `ai_usage` row. Besides `provider`, `path`,
`ok`, `status` and `prompt_chars`, the row carries:

| Column | Anthropic | Gemini |
|---|---|---|
| `model` | response `model` | response `modelVersion` |
| `input_tokens` | `usage.input_tokens` (uncached) | `promptTokenCount` minus `cachedContentTokenCount` |
| `output_tokens` | `usage.output_tokens` (thinking included) | `candidatesTokenCount` |
| `cache_read_tokens` | `cache_read_input_tokens` | `cachedContentTokenCount` |
| `cache_write_tokens` | `cache_creation_input_tokens` | null |
| `thinking_tokens` | null | `thoughtsTokenCount` (billed as output) |
| `cost_usd` | list price from `aiPricing.ts` | list price from `aiPricing.ts` |

When the vendor names no model (an error reply) the requested model is
recorded. A model that is not in the price table gets its tokens recorded
and a null `cost_usd`: never a guessed price. A countTokens call and a
failed call also leave `cost_usd` null. Prices are the vendor list prices
fetched 2026-09-02 (docs/SCALE-AND-COST-PLAN-2026-09-02.md, section 4);
change `aiPricing.ts` and `aiPricing.json` together, the test fails when
they drift.

`public.ai_usage_spend_usd(p_user, p_since)` sums `cost_usd` for one user
and is executable by `service_role` only; the proxy calls it with the start
of the current UTC month.

## Caps and budgets

Daily call caps, per provider, per user, per UTC day. Override with a
function secret; no redeploy.

| Provider | Secret | Default |
|---|---|---|
| Gemini | `AI_DAILY_LIMIT` | 200 |
| Anthropic | `ANTHROPIC_DAILY_LIMIT` | 60 |

Monthly dollar budget, per user, per UTC calendar month, both providers
summed from `ai_usage.cost_usd`.

| Line | Secret | Default | Effect |
|---|---|---|---|
| Soft | `AI_BUDGET_SOFT_USD` | 8 | Settings > AI shows a warning |
| Hard | `AI_BUDGET_HARD_USD` | 15 | Anthropic path answers 429 `budget`; Vera, the RVU coder and case dictation fall back to Gemini until the 1st |

Admins are unlimited on all four. The daily counts stay as a backstop under
the dollars. If the spend query fails the budget fails open (reads as $0) and
the daily caps still hold.

```sh
supabase secrets set AI_BUDGET_HARD_USD=20 --project-ref hkpnnsjcwprrwobmpqyy
```

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
(or "Use my own key from this device"). The Anthropic key is saved the same
way as `anthropic_shared_key`.
