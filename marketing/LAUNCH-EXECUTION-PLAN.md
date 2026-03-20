# CredentialDOMD — Launch Execution Plan
**Last updated:** 2026-03-20
**Status:** Pre-launch. Waiting on Stripe setup.

---

## The Only Number That Matters Right Now
**333 founding members at $1.99/month**

Everything on this page serves that number.

---

## What Needs to Happen (In Order)

### GATE 1 — Stripe Live (Whit: 20 min)
- [ ] Create product in Stripe: "CredentialDOMD Founding Member" $1.99/month
- [ ] Get Price ID → send to Eli
- [ ] Get Secret Key + Webhook Secret → send to Eli
- **Eli handles:** Vercel env vars, Supabase secrets, webhook config, end-to-end test

### GATE 2 — Cloudflare Deploy (Whit: 5 min)
- [ ] Run `wrangler login` in terminal (browser auth, 30 seconds)
- **Eli handles:** Deploy updated landing page with new pricing + SEO fixes

### GATE 3 — Email Setup (Whit: 10 min)
- [ ] Confirm hello@credentialdomd.com is monitored (or forward to personal email)
- [ ] Set up basic email sequence (see marketing/emails/) — can use ConvertKit free tier

### GATE 4 — First Posts (Whit: 30 min, one time)
- [ ] LinkedIn post (see marketing/outreach/social-posts.md Post 1)
- [ ] Doximity post
- [ ] One Reddit post (r/medicine or r/residency)

---

## Week 1 After Stripe Goes Live

| Day | Action | Who |
|-----|--------|-----|
| Day 1 | Stripe live + end-to-end test | Eli + Whit |
| Day 1 | Cloudflare deploy updated site | Eli + Whit |
| Day 2 | LinkedIn origin story post | Whit |
| Day 2 | Doximity post | Whit |
| Day 3 | Reddit post (beta testers ask) | Whit |
| Day 4 | Reply to every comment/DM | Whit |
| Day 5 | Facebook groups (locum physicians) | Whit |
| Day 7 | Check metrics, iterate | Both |

---

## Target: First 10 Paying Members

**Who they are:**
- Locum tenens physicians (multi-state = highest pain)
- Physicians who recently had a credentialing close call
- DO physicians (underserved by most tools)
- Residents graduating in June 2026 (starting new jobs, need credentials organized)

**Where to find them:**
- Doximity (primary)
- r/medicine (authentic posts only)
- Facebook: "Locum Tenens Physicians" group
- LinkedIn (Whit's network first)

**The ask:** Not "buy my app." Ask for feedback. Offer free 30-day trial to beta testers. Let quality convert them.

---

## Metrics to Track Weekly

| Metric | Target Week 1 | Target Month 1 |
|--------|---------------|----------------|
| Founding members | 5 | 25 |
| Landing page visits | 200 | 1,000 |
| App signups (free) | 20 | 100 |
| Email inquiries | 5 | 20 |
| MRR | $9.95 | $49.75 |

---

## What the Agents Should Be Doing

AutoAIBiz agents are most valuable AFTER you have real user data. Right now:

**COMPASS** — research the 10 highest-traffic physician forums/communities. Build a list of where physicians actually talk. Deliverable: ranked list with post counts, engagement rates, rules.

**SIGNAL** — analyze what language in the existing landing page resonates with physicians. Compare to competitor messaging. Deliverable: 5 specific copy improvements.

**FORGE** — design the onboarding flow improvements. First 2 minutes in the app — what should a new user see? Deliverable: wireframe description + copy.

**MAVEN** — research physician credentialing pain points from public sources (Reddit, Doximity, medical forums). Deliverable: top 10 pain points with real quotes.

**SCOUT** — build a list of 50 locum tenens physicians active on social media. Deliverable: names, platform, specialty, why they're a fit.

---

## What's Already Built (Don't Rebuild)
- ✅ App: all features complete
- ✅ Landing page: live at credentialdomd.com
- ✅ State SEO pages: all 50 states
- ✅ PWA: iOS and Android installable
- ✅ Supabase: schema, auth, RLS
- ✅ Edge Functions: checkout, webhook, portal (need secrets)
- ✅ Email templates: marketing/emails/
- ✅ Social posts: marketing/outreach/social-posts.md
- ✅ Community outreach plan: marketing/outreach/physician-communities.md
