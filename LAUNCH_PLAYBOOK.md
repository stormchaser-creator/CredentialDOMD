# CredentialDOMD — Business Launch Playbook
**Research agent:** compass.market_research + signal.brand_architect
**Date:** 2026-03-19
**Purpose:** Full pre-launch business checklist — what must be done before the first paying customer

---

## The Reality Check

SaaS products that skip pre-launch structure fail validation 60% of the time. Products that beta test first see 60% fewer critical bugs on launch day. This isn't optional overhead — it's the difference between a real launch and an embarrassing one.

---

## PHASE 1 — Business & Legal Foundation
*Must be done before taking money*

### Entity & Banking
- [ ] **LLC or Corp formed** — Is CredentialDOMD under its own legal entity or under an existing company?
- [ ] **Business bank account** — Stripe payouts need somewhere to land
- [ ] **EIN obtained** from IRS (free, takes 5 min online)
- [ ] **Business address** — can be a registered agent (~$50/year)

### Legal Documents (live on site now — verify they're complete)
- [ ] **Terms of Service** — published at credentialdomd.com/terms ✅ (exists)
- [ ] **Privacy Policy** — published ✅ (exists)
- [ ] **Data Rights page** — published ✅ (exists)
- [ ] **Refund policy** — defined? (standard is 30-day money-back for SaaS)
- [ ] **Data Processing Agreement (DPA)** — needed if any enterprise/practice customers

### HIPAA — Critical for Healthcare Data
CredentialDOMD stores physician health records, malpractice history, and medical licenses. This makes it a **Business Associate** under HIPAA.

Required:
- [ ] **BAA with Supabase** — Does Supabase provide a signed BAA? (They do for paid plans — verify)
- [ ] **BAA with Stripe** — Stripe signs BAAs for healthcare companies (verify)
- [ ] **BAA with Vercel/Netlify** — hosting must be covered
- [ ] **Encryption at rest** — Supabase PostgreSQL with RLS ✅ (already built)
- [ ] **Audit logging** — track who accessed what (partially built via Supabase)
- [ ] **Breach notification policy** — document what happens if data is exposed
- [ ] **HIPAA Privacy Policy language** — current privacy policy may need healthcare-specific additions

**Note:** CredentialDOMD may argue it's NOT HIPAA-covered because physicians are managing their OWN credentials (not patient data). This legal determination needs a healthcare attorney. If the answer is "not covered" — great, simpler. If covered, get the BAAs in place first.

---

## PHASE 2 — Product Readiness
*What the code audit found*

### ✅ Already Done
- Core app built and deployed at credentialdomd.com
- Auth flow (Supabase) working
- All credential sections built
- Pro gating logic working
- CME compliance engine for all 50 states (MD + DO)
- NPI registry import
- CV generator
- Data export
- Landing page with founding member pricing
- SEO (sitemap, robots.txt, Schema.org, state pages)
- PWA (installable on iOS/Android)

### ❌ Still Needed
- [ ] **Stripe products created** in Stripe dashboard
- [ ] **Stripe Price IDs** added to Vercel environment variables
- [ ] **Stripe webhook** configured to point at Supabase Edge Function
- [ ] **Supabase secrets** set: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- [ ] **hello@credentialdomd.com** inbox — monitored? Connected to what?
- [ ] **End-to-end payment test** — sign up → checkout → confirm access → webhook fires
- [ ] **Beta test with 5-10 physicians** — get real doctors using it before public launch
- [ ] **Mobile PWA test** — test on iPhone and Android
- [ ] **Onboarding tour** — does a new user know what to do in the first 2 minutes?

---

## PHASE 3 — Payments Setup
*The one blocker between us and revenue*

### Stripe Setup Steps (in order)
1. Log into dashboard.stripe.com
2. Create product: **"CredentialDOMD Founding Member"**
3. Add price: **$1.99/month** recurring (this is Spot 1-19 price)
4. Get the Price ID (looks like `price_1ABC...`)
5. Add to Vercel: Settings → Environment Variables → `VITE_STRIPE_PRICE_FOUNDING`
6. Set Supabase secrets via CLI
7. Add webhook endpoint in Stripe → point to Supabase function
8. Test with Stripe test card `4242 4242 4242 4242`
9. Confirm subscription status updates in DB
10. Switch to live mode

### Founding Member Price Escalation Logic
The site already shows the tiered pricing. Need to decide:
- Is the escalation manual (you update the price as spots fill)?
- Or automatic (app tracks spot count and charges accordingly)?

**Recommendation:** Manual for now. Start at $1.99, update when 19 spots claimed.

---

## PHASE 4 — Marketing Readiness
*Build before you open the doors*

### Email
- [ ] **hello@credentialdomd.com** working inbox — who manages it?
- [ ] **Transactional email** — Supabase sends auth emails, but what about welcome emails, payment receipts, expiration alerts? (Resend.com integrates easily, $0 for first 3k/month)
- [ ] **Waitlist email sequence** — people who join waitlist need a follow-up when live

### Channels to Build Now (4-6 weeks pre-launch is ideal, but we start now)
- [ ] **Reddit presence** — r/medicine, r/Residency, r/medicalschool — organic posts, not ads
- [ ] **Doximity** — physician-only network, best organic channel for this audience
- [ ] **Twitter/X** — physician Twitter community is large and active
- [ ] **Product Hunt** — prepare listing (screenshots, description, video walkthrough)
- [ ] **Kevin MD** — submit a physician admin burden article with soft mention

### Content Needed
- [ ] **Product demo video** (60-90 seconds, screen recording of the app)
- [ ] **3-5 physician pain point posts** — "The $47,000 missed renewal" (already on landing page) is the hook
- [ ] **State-specific CME pages** — already built at /states/{state} ✅

---

## PHASE 5 — Support Infrastructure
*Before the first customer, not after*

- [ ] **Support inbox** monitored (hello@credentialdomd.com)
- [ ] **FAQ page** built ✅ (exists in app)
- [ ] **Onboarding email** sent after signup
- [ ] **Response time commitment** — what's the SLA? 24 hours is fine for founding members
- [ ] **Cancellation flow** built ✅ (exists in app)

---

## PHASE 6 — Analytics
*You can't improve what you can't see*

- [ ] **Signup tracking** — how many people visit → sign up → pay?
- [ ] **Conversion funnel** — landing page → app → pro upgrade
- [ ] **Posthog or Mixpanel** — free tier covers early stage needs
- [ ] **Stripe dashboard** — revenue, churn, MRR (this comes for free with Stripe)

---

## Launch Sequence (Recommended Order)

**Week 1 — Business & Legal**
1. Confirm entity/banking
2. Verify HIPAA question with attorney
3. Get Supabase BAA if needed
4. Set up hello@ inbox properly

**Week 2 — Payments**
5. Create Stripe products + prices
6. Wire all keys (Vercel + Supabase)
7. End-to-end payment test

**Week 3 — Beta**
8. Give app to 5-10 physicians (colleagues, residents, attendings)
9. Fix anything that breaks
10. Collect first testimonials

**Week 4 — Marketing**
11. Record demo video
12. Post in r/medicine, r/Residency
13. Reach out to physician Twitter accounts
14. Submit to Product Hunt

**Week 5 — Open Doors**
15. Announce founding member spots
16. Email the waitlist
17. Watch first payment come in

---

## What Agents Are Assigned

| Task | Agent |
|------|-------|
| Competitive pricing research | compass.competitive_intel ✅ Done |
| Launch checklist | compass.market_research ✅ Done |
| Marketing copy + outreach strategy | signal.brand_architect + signal.content_strategist |
| Physician community outreach | scout.sdr_outbound |
| Legal/HIPAA review | justice.vera + justice.lex |
| Payment flow testing | forge.backend_engineer |
| Analytics setup | forge.data_engineer |
