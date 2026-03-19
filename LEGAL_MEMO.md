# Legal Research Memo — CredentialDOMD

**Date:** 2026-03-19
**Agent:** Justice (AutoAIBiz)
**Jurisdictions:** US_FEDERAL, varies by state
**Prepared for:** Eric Whitney, DO

---

## Business Context

- **Owner:** Eric Whitney, DO — neurosurgeon
- **Legal entity:** Eric Whitney DO, A Professional Corporation (S-Corp)
- **Product:** CredentialDOMD — physician credential management SaaS
- **Data stored:** Physician's OWN credentials (licenses, CME, health records, malpractice history) — NOT patient data
- **Infrastructure:** Supabase (PostgreSQL + Auth), Stripe (payments), Vercel (hosting)
- **No new entity needed** — already incorporated as S-Corp P.C.

---

## Question 1: Does CredentialDOMD Qualify as a HIPAA Business Associate?

### Direct Answer

**Likely yes, but with important nuance.** Even though CredentialDOMD stores physician's *own* credentials (not patient data), the platform stores **physician health records** (physical exams, immunization records, drug screening results, disability documentation) as part of the credentialing file. Under HIPAA, individually identifiable health information about *any* individual — including physicians themselves — can constitute Protected Health Information (PHI) when it is created or received by a covered entity or healthcare clearinghouse.

### Key Analysis

**What triggers HIPAA BA status** (per [HHS.gov](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html)):
- A Business Associate is a person or organization that performs functions or activities on behalf of, or provides services to, a covered entity that involve the **use or disclosure of individually identifiable health information**
- Persons whose functions do **not** involve PHI and whose access would be incidental are **not** business associates

**The critical distinction for CredentialDOMD:**
- **Licenses, CME certificates, DEA registrations, malpractice history** — These are *professional credentials*, not health information. Storing these alone would NOT trigger HIPAA BA status.
- **Physician health records (TB tests, physical exams, immunization records, drug screening, fitness-for-duty evaluations)** — These ARE individually identifiable health information. If hospitals or health systems upload or access this data through CredentialDOMD as part of their credentialing workflow, CredentialDOMD likely functions as a BA.

**The "self-management" argument:** If physicians are managing *only their own* data and no covered entity is using CredentialDOMD to process credentialing on their behalf, the BA argument weakens significantly. However, the product's natural use case — sharing credential files with hospitals, insurance companies, and medical staff offices (all covered entities) — means PHI will flow through the platform.

### Risk Assessment: **MEDIUM-HIGH**

The safest path is to treat CredentialDOMD as if it handles PHI and build HIPAA compliance from day one. The cost of compliance is manageable; the cost of a breach or OCR investigation is not.

### Recommended Actions

1. **Assume HIPAA applies** — design the platform as HIPAA-compliant from launch
2. **Segment data types** — separate pure credential data (licenses, CME) from health data (physicals, immunizations, drug screens) at the database level
3. **If you offer a "share with hospital" feature**, you are definitively a BA — prepare BAA templates for institutional customers
4. **Implement minimum necessary standard** — only expose the specific credential data each recipient needs
5. **Consider offering a "HIPAA-lite" tier** that excludes health records storage for price-sensitive users

---

## Question 2: Operating SaaS Under a Professional Corporation — Liability Concerns

### Direct Answer

**Operating CredentialDOMD directly under your DO P.C. is legally permissible but not advisable.** A separate subsidiary LLC provides meaningful liability isolation and cleaner tax treatment. However, given that you're pre-revenue and bootstrapping, launching under the P.C. is acceptable as a temporary measure.

### Key Analysis

**Professional Corporation restrictions:**
- PCs are designed for licensed professional services. Most states restrict PCs to activities within the scope of the professional license ([California Lawyers Association](https://calawyers.org/business-law/professional-services-as-an-llc-yes-or-no/))
- A SaaS product is NOT a professional medical service — running it under a DO P.C. creates a **scope mismatch**
- Some states' medical practice acts may restrict the types of business activities a medical PC can engage in

**Liability exposure:**
- If CredentialDOMD has a data breach or contract dispute, claims could reach your P.C.'s assets — including medical practice assets
- Per [Proskauer Rose LLP](https://www.proskauer.com/blog/two-sides-of-a-different-coin-separating-businesses-and-subsidiaries-for-liability-protection): subsidiary structures protect parent entities, but only if operational separation is maintained
- A single-member LLC owned by your P.C. (or by you personally) creates a liability firewall between medical practice and SaaS operations

**Insurance considerations:**
- Your medical malpractice policy likely does NOT cover SaaS-related claims (data breach, IP infringement, contract disputes)
- Running both under one entity could create coverage gaps

### Risk Assessment: **MEDIUM**

Not an emergency, but should be addressed before significant revenue or user growth.

### Recommended Actions

1. **Short-term (acceptable for launch):** Operate under the P.C. while pre-revenue
2. **Before first paying customer:** Form a single-member LLC (e.g., "CredentialDOMD LLC") owned by you personally (not the P.C.)
3. **Maintain strict separation:** Separate bank account, separate contracts, no commingling of P.C. and LLC funds
4. **Get SaaS-specific insurance:** Technology E&O (errors & omissions) and cyber liability insurance for the LLC
5. **Estimated cost:** LLC formation ~$70-150 (state filing) + ~$800/year (registered agent + annual report). Very cheap liability protection.

---

## Question 3: BAA Requirements with Supabase, Stripe, and Vercel

### Direct Answer

**Yes — you need BAAs with Supabase and likely Vercel. Stripe is lower priority but worth evaluating.** All three vendors offer HIPAA support, but at specific plan tiers.

### Vendor-Specific Analysis

**Supabase** ([docs](https://supabase.com/docs/guides/security/hipaa-compliance)):
- BAA is available with the **HIPAA add-on** (requires Pro plan or higher)
- Supabase provides a fully managed, HIPAA-compliant Postgres platform with PHI protection
- You MUST enable the HIPAA add-on and sign the BAA before storing any health data
- Supabase is SOC 2 Type II certified
- **Action required: YES — this is your primary data store**

**Vercel** ([docs](https://vercel.com/kb/guide/hipaa-compliance-guide-vercel)):
- BAA available for **Enterprise** customers (signed agreement) and **Pro** customers (click-through BAA)
- Pro customers can purchase the HIPAA add-on via Settings > Billing
- Important: Using Vercel with a BAA doesn't automatically ensure compliance — it's a shared responsibility
- **Action required: YES if PHI passes through the frontend** (e.g., displaying physician health records in the browser). If Vercel only serves static assets and API calls go directly to Supabase, the risk is lower.

**Stripe:**
- Stripe processes payments only — it should NOT receive PHI
- Stripe is PCI DSS compliant (payment card security)
- If you're only passing payment amounts, plan IDs, and customer emails to Stripe, **no BAA needed**
- **Action required: NO**, unless you're embedding health data in payment metadata (don't do this)

### Risk Assessment: **HIGH** (for Supabase), **MEDIUM** (for Vercel), **LOW** (for Stripe)

### Recommended Actions

1. **Immediately:** Enable Supabase HIPAA add-on and sign BAA before storing any physician health records
2. **Before launch:** Evaluate whether PHI transits Vercel (likely yes if rendering credential dashboards) — if so, get Vercel Pro + HIPAA add-on
3. **Stripe:** Keep PHI out of Stripe entirely. No health data in metadata, descriptions, or custom fields
4. **Document your data flow:** Create a data flow diagram showing where PHI lives and transits — this is required for HIPAA risk assessment anyway
5. **Estimated cost:** Supabase Pro (~$25/mo) + HIPAA add-on pricing (contact Supabase); Vercel Pro ($20/mo) + HIPAA add-on

---

## Question 4: Minimum Legal Documents Before Taking Payment

### Direct Answer

You need **at minimum 5 documents** before accepting payment for a healthcare-adjacent SaaS:

### Required Documents

1. **Terms of Service (ToS)**
   - Service description, acceptable use, account terms
   - Limitation of liability, warranty disclaimers
   - Dispute resolution (arbitration clause recommended)
   - Termination and data portability provisions
   - HIPAA-specific terms: obligations regarding PHI, breach notification procedures
   - ([TermsFeed](https://www.termsfeed.com/blog/legal-requirements-saas/))

2. **Privacy Policy**
   - Legally required if you collect ANY personal data (including email addresses)
   - Must comply with CCPA (California), state privacy laws, and potentially GDPR
   - Describe what data you collect, how it's used, who it's shared with, retention periods
   - Special section for health information handling
   - ([ContractsCounsel](https://www.contractscounsel.com/t/us/saas-agreement))

3. **Business Associate Agreement (BAA) Template**
   - Required before any covered entity (hospital, health system) uses the platform
   - Must include: permitted uses/disclosures, safeguards, breach notification, termination
   - Use the [HHS sample BAA provisions](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html) as a starting template

4. **HIPAA Notice of Privacy Practices**
   - If you're a BA, you need to inform users how their health information is handled
   - Can be incorporated into your Privacy Policy with a dedicated section

5. **Subscription/Payment Agreement**
   - Billing terms, refund policy, auto-renewal terms
   - Must comply with state auto-renewal laws (particularly California SB-313)

### Strongly Recommended (Before Scaling)

6. **Data Processing Agreement (DPA)** — for enterprise customers and GDPR compliance
7. **Acceptable Use Policy** — what users can/cannot do on the platform
8. **Security Policy / Trust Page** — encryption standards, SOC 2 status, incident response

### Risk Assessment: **HIGH** (operating without these creates significant legal exposure)

### Recommended Actions

1. **Priority 1 (before launch):** ToS + Privacy Policy + BAA template — these are non-negotiable
2. **Priority 2 (before first payment):** Subscription agreement with clear billing terms
3. **Priority 3 (before enterprise sales):** DPA + Security documentation
4. **Budget option:** Use a reputable legal template service (e.g., Termly, Iubenda) for ToS/Privacy Policy (~$100-200/year), then have an attorney customize the BAA template (~$1,000-2,500)
5. **Do NOT copy-paste** from other SaaS companies — template services generate compliant documents; copying creates liability

---

## Question 5: S-Corp Tax Implications of Mixed Medical + SaaS Revenue

### Direct Answer

**Mixing SaaS revenue with medical practice income in a single P.C. S-Corp creates tax complexity but is not illegal.** The primary concerns are reasonable compensation calculations, QBI deduction optimization, and state-specific PC rules.

### Key Tax Considerations

**Reasonable Compensation** ([IRS guidance](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues)):
- The IRS requires S-Corp shareholder-employees to pay themselves a "reasonable salary" before taking distributions
- Reasonable compensation is determined by looking at the **source of the S-Corp's gross receipts**
- For a physician, medical practice income requires a substantial W-2 salary (typically 60-70% of medical revenue)
- SaaS revenue generated primarily by software (not personal services) may support a lower reasonable compensation allocation
- **With mixed income:** The IRS could argue all revenue requires high reasonable compensation since you're the sole shareholder doing everything

**QBI Deduction (Section 199A):**
- Medical practice income is a Specified Service Trade or Business (SSTB) — QBI deduction phases out above $191,950 (single) / $383,900 (MFJ) in 2026
- SaaS revenue is generally NOT an SSTB — it qualifies for the full 20% QBI deduction regardless of income
- **Mixing them in one entity means the entire entity may be treated as an SSTB**, losing the QBI deduction on the SaaS revenue
- Per [Revonary](https://www.revonary.com/blog/entity-structure-for-physicians): separating income sources into different entities preserves QBI deduction eligibility for the non-SSTB income

**Self-Employment Tax Savings:**
- S-Corp distributions (beyond reasonable salary) avoid FICA taxes (15.3% up to SS cap, 2.9% + 0.9% Medicare above)
- SaaS revenue flowing through a separate LLC with S-Corp election maximizes this benefit by allowing an independent reasonable salary calculation

**State PC Rules:**
- Some states restrict P.C. income to professional service revenue only
- Non-professional income (SaaS subscriptions) in a medical P.C. could trigger regulatory scrutiny
- Per [San Diego Corporate Law](https://sdcorporatelaw.com/business-newsletter/can-a-california-professional-medical-corporation-be-an-s-corp/): California has particularly strict rules about medical corporation activities

### Risk Assessment: **MEDIUM-HIGH** (tax inefficiency, not illegality)

### Recommended Actions

1. **Separate the SaaS into its own entity** — single-member LLC with S-Corp election, owned by you personally
2. **This preserves:**
   - QBI deduction on SaaS revenue (20% deduction — potentially thousands in tax savings)
   - Independent reasonable compensation calculation
   - Clean liability separation
3. **Timing:** Do this before SaaS revenue exceeds ~$10,000/year (below that, the complexity isn't worth it)
4. **Consult your CPA** specifically about:
   - Your state's PC rules on non-professional income
   - Optimal salary/distribution split for each entity
   - Whether the SaaS LLC should elect S-Corp (only beneficial above ~$40K net income)
5. **Estimated CPA cost for this analysis:** $500-1,500 one-time; worth every dollar

---

## Summary of Priority Actions

| Priority | Action | Estimated Cost | Timeline |
|----------|--------|---------------|----------|
| 1 | Enable Supabase HIPAA add-on + sign BAA | ~$25/mo + add-on | Before storing health data |
| 2 | Draft ToS + Privacy Policy | $100-200/yr (template) or $1,500-3,000 (attorney) | Before launch |
| 3 | Create BAA template for institutional customers | $1,000-2,500 (attorney) | Before first hospital customer |
| 4 | Form CredentialDOMD LLC | $70-150 (state filing) | Before first paying customer |
| 5 | Evaluate Vercel HIPAA add-on | $20/mo + add-on | Before launch if PHI transits frontend |
| 6 | Consult CPA on entity structure | $500-1,500 | Before SaaS revenue exceeds $10K |
| 7 | Get Tech E&O + Cyber insurance | $500-2,000/yr | Before launch |

---

## Sources Consulted

- **[regulatory_guidance]** [Business Associates | HHS.gov](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html) (Authority: 85/100)
- **[regulatory_guidance]** [Covered Entities and Business Associates | HHS.gov](https://www.hhs.gov/hipaa/for-professionals/covered-entities/index.html) (Authority: 85/100)
- **[regulatory_guidance]** [Business Associate Contracts | HHS.gov](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html) (Authority: 85/100)
- **[regulatory_guidance]** [S-Corp Compensation and Medical Insurance | IRS.gov](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues) (Authority: 85/100)
- **[bar_opinion]** [HIPAA Regulations: Business Associate Definition | Bricker Graydon](https://www.brickergraydon.com/insights/resources/key/HIPAA-Regulations-General-Provisions-Definitions-Business-Associate-160-103) (Authority: 75/100)
- **[secondary_source]** [HIPAA Compliance and Supabase](https://supabase.com/docs/guides/security/hipaa-compliance) (Authority: 40/100)
- **[secondary_source]** [Supabase for Healthcare](https://supabase.com/solutions/healthcare) (Authority: 40/100)
- **[secondary_source]** [HIPAA Projects | Supabase Docs](https://supabase.com/docs/guides/platform/hipaa-projects) (Authority: 40/100)
- **[secondary_source]** [HIPAA Compliance on Vercel](https://vercel.com/kb/guide/hipaa-compliance-guide-vercel) (Authority: 40/100)
- **[secondary_source]** [Vercel supports HIPAA compliance](https://vercel.com/blog/vercel-supports-hipaa-compliance) (Authority: 40/100)
- **[secondary_source]** [Separating Businesses for Liability Protection | Proskauer](https://www.proskauer.com/blog/two-sides-of-a-different-coin-separating-businesses-and-subsidiaries-for-liability-protection) (Authority: 40/100)
- **[secondary_source]** [Professional Services as LLC | California Lawyers Association](https://calawyers.org/business-law/professional-services-as-an-llc-yes-or-no/) (Authority: 40/100)
- **[secondary_source]** [Entity Structure for Physicians | Revonary](https://www.revonary.com/blog/entity-structure-for-physicians) (Authority: 40/100)
- **[secondary_source]** [Can a Professional Corporation be an S Corp | UpCounsel](https://www.upcounsel.com/can-a-professional-corporation-be-an-s-corp) (Authority: 40/100)
- **[secondary_source]** [S-Corp Tax Strategies for Physicians | SLP Wealth](https://slpwealth.com/physicians/physician-s-corp-tax-strategies/) (Authority: 40/100)
- **[secondary_source]** [HIPAA Compliance for SaaS | HIPAA Journal](https://www.hipaajournal.com/hipaa-compliance-for-saas/) (Authority: 40/100)
- **[secondary_source]** [Legal Requirements for SaaS | TermsFeed](https://www.termsfeed.com/blog/legal-requirements-saas/) (Authority: 40/100)
- **[secondary_source]** [SaaS Agreement: Key Terms | ContractsCounsel](https://www.contractscounsel.com/t/us/saas-agreement) (Authority: 40/100)
- **[secondary_source]** [Business Associates' Use of Information | Holland & Hart](https://www.hollandhart.com/business-associates-use-of-information-for-their-own-purposes) (Authority: 40/100)
- **[ai_synthesis]** Justice agent synthesis of web research findings (Authority: 20/100)

---

**LEGAL RESEARCH DISCLAIMER: This is legal research, not legal advice. The information provided is for informational and educational purposes only and does not constitute legal advice or create an attorney-client relationship. Laws vary by jurisdiction and change over time. Always consult a licensed attorney before making legal decisions or taking legal action.**
