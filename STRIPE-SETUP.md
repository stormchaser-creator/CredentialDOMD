# Stripe Setup — CredentialDOMD

## What you need from Stripe

Go to dashboard.stripe.com and get:

### 1. Create Products & Prices (if not already done)

Create 3 products in Stripe:
1. **CredentialDOMD Pro Monthly** — e.g. $29/month
2. **CredentialDOMD Pro Annual** — e.g. $290/year
3. **CredentialDOMD Practice** — e.g. $99/month (multi-physician)

Each product will give you a **Price ID** that looks like `price_1ABC...`

### 2. Get your keys

- **Publishable key** (starts with `pk_live_`) — for the frontend
- **Secret key** (starts with `sk_live_`) — for Edge Functions only
- **Webhook secret** (`whsec_...`) — from Stripe Webhooks dashboard

### 3. Set up webhook endpoint

In Stripe Dashboard → Developers → Webhooks:
- Add endpoint: `https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/stripe-webhook`
- Events to listen for:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

---

## Where to set the values

### `.env` (local dev only — DO NOT commit)

```
VITE_SUPABASE_URL=https://hkpnnsjcwprrwobmpqyy.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_STRIPE_PRICE_PRO_MONTHLY=price_...
VITE_STRIPE_PRICE_PRO_ANNUAL=price_...
VITE_STRIPE_PRICE_PRACTICE=price_...
```

### Vercel Environment Variables (production)

Go to vercel.com → CredentialDOMD project → Settings → Environment Variables.
Add all `VITE_*` variables above.

### Supabase Secrets (for Edge Functions)

```bash
cd /Users/whit/Projects/CredentialDOMD
npx supabase login
npx supabase link --project-ref hkpnnsjcwprrwobmpqyy
npx supabase secrets set STRIPE_SECRET_KEY=sk_live_...
npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
npx supabase secrets set STRIPE_PRICE_ID_PRO_ANNUAL=price_...
npx supabase secrets set STRIPE_PRICE_ID_PRACTICE=price_...
```

### Deploy Edge Functions

```bash
./scripts/deploy-functions.sh
```

---

## Checklist

- [ ] Products created in Stripe
- [ ] Price IDs added to `.env`
- [ ] Price IDs added to Vercel environment variables
- [ ] Stripe secret key added to Supabase secrets
- [ ] Webhook endpoint created in Stripe dashboard
- [ ] Webhook secret added to Supabase secrets
- [ ] Edge Functions deployed (`./scripts/deploy-functions.sh`)
- [ ] Test checkout with Stripe test card: `4242 4242 4242 4242`
