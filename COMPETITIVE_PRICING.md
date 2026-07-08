# CredentialDOMD — Competitive Pricing Analysis

> **SUPERSEDED (2026-07-08):** Pricing below reflects the legacy cohort model. Current pricing is Architecture D — see src/utils/pricingConstants.js. Strategy rationale retained for history.

**Research agent:** compass.competitive_intel + maven.deep_research
**Date:** 2026-03-19
**Task:** Find all direct competitors targeting individual physicians. Price CredentialDOMD 20% below lowest comparable.

---

## Market Landscape

### Key Distinction: Two Separate Markets

| Market | Who It Serves | Price Range |
|--------|--------------|-------------|
| **Enterprise credentialing** | Hospitals, health systems, large practices | $75–$180/provider/month |
| **Individual physician tools** | Solo MDs/DOs managing their own credentials | $0–$199/year |

CredentialDOMD targets **individual physicians** — the second market. Most enterprise tools don't even compete here.

---

## Direct Competitors (Individual Physician Market)

### 1. Mocingbird
- **URL:** mocingbird.com
- **Price:** $199/year (~$16.58/mo) for individuals | Free for students/residents
- **What it tracks:** Licenses + CME/CE only
- **Missing vs CredentialDOMD:** Hospital privileges, insurance/malpractice, AI document scanner, CV generator, peer references, health records
- **Notes:** SOC 2 + HIPAA compliant, physician-founded, growing fast

### 2. CAQH ProView
- **URL:** proview.caqh.org
- **Price:** Free
- **What it tracks:** Provider profile for payer credentialing (insurance enrollment)
- **Missing vs CredentialDOMD:** CME tracking, license expiration alerts, hospital privileges, AI scanner, CV generator — it's a payer enrollment tool, not a physician management tool
- **Notes:** Not a real competitor for daily credential management

### 3. CredyApp
- **URL:** credyapp.com
- **Price:** Free limited; paid $15–$50/mo
- **What it tracks:** Basic credential verification/outsourcing
- **Missing vs CredentialDOMD:** CME tracking, state-specific requirements, AI scanner, CV generator
- **Notes:** Focused on outsourcing verification, not self-management

### 4. Enterprise Tools (NOT Direct Competitors for Individual Physicians)
These serve hospitals and groups, not individual doctors:
- Medallion: $150+/provider/month (custom)
- Modio Health: $75–$125/provider/month
- QGenda: $100–$180/provider/month
- Symplr Provider: $150+/provider/month
- CredentialStream: $120–$160/provider/month
- CredentialMyDoc: $75–$150/provider/month
- MedTrainer: $70–$120/provider/month

**These are not competitors.** They target hospitals and credentialing offices. CredentialDOMD is the only tool built for the individual physician self-managing their own credentials.

---

## The Real Competitive Set

| Competitor | Individual Price | Features |
|-----------|-----------------|---------|
| **Mocingbird** | $199/year ($16.58/mo) | Licenses + CME only |
| **CredyApp** | $15–$50/mo | Basic verification outsourcing |
| **CAQH ProView** | Free | Payer enrollment only |
| **Spreadsheet/Manual** | $0 | Everything manual |

---

## Pricing Recommendation

**Lowest direct comparable competitor:** Mocingbird at **$199/year ($16.58/month)**

**20% below:** $159.20/year ($13.27/month)

### Recommended CredentialDOMD Standard Pricing (post-founding)
- **Monthly:** **$13/month** (saves physician $3.58/mo vs Mocingbird, and offers 3x more features)
- **Annual:** **$129/year** (saves $70/year vs Mocingbird)

*(Superseded: Architecture D adopted Solo at **$19/month ($190/year)** and Locum at **$29/month ($290/year)**. The $13/$129 figures above are the original research recommendation, retained for history.)*

### Founding Member Pricing
Architecture D replaced the escalating cohort ladder with a flat **Founding Physician** tier:
- **$12/month ($120/year)**, locked for 24 months, first 100 physicians only, then auto-converts to Solo ($19/month) at month 25.

Even at $12/mo, founding pricing is well below Mocingbird ($16.58/mo) with dramatically more features.

*(Legacy note, retained for history: the original research recommended an escalating founding ladder stepping from ~$1.99/mo up to ~$9.99/mo as spots filled. That model is superseded — see the banner at the top.)*

---

## Positioning Statement
> "Mocingbird charges $199/year and only tracks licenses and CME.
> CredentialDOMD Founding Physicians start at $12/month and covers everything —
> hospital privileges, malpractice insurance, AI document scanning, CV generation,
> multi-device sync, and state-specific CME requirements for all 50 states."

---

## Competitive Moat
CredentialDOMD is the **only individual-physician credential management tool** that covers:
1. The full credential stack (not just licenses + CME)
2. Both MD and DO requirements (AMA PRA + AOA categories)
3. Hospital privilege tracking across multiple facilities
4. AI document scanner
5. CV auto-generation
6. At a price point designed for solo physicians, not health systems

No competitor offers this combination at any price.
