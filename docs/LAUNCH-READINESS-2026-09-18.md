# CredentialDoMD launch readiness — September 18, 2026

The owner selected **Core $149/year** and **Core + Locum $245/year**, then directed:
**Keep billing off; prepare the launch first.** The beta remains active, with no
end date. There is no scheduled charge or paid presale.

This work follows the recommendations in Claude's “YouTube scraper for Tom Bilyeu
investment recommendations” conversation. They are Claude's applications of the
interview research to this project, not direct recommendations Tom made about
CredentialDoMD. Codex owns implementation and review; Claude supplied independent
usage/evaluation evidence and primary-source Ohio verification.

## What is implemented or prepared

| Recommendation | Result |
| --- | --- |
| One price source | Two annual bundles in the shared billing catalog; app pricing/FAQ and public pages agree. Historical pricing instructions are visibly superseded. |
| Production Clerk cutover | Remains disabled pending verified identity mapping and a durable storage recovery journal. Existing sign-ins and document ownership are preserved. The old email-only relink procedure must not be used. |
| Beta deadline | Deferred by the owner. `FREE_BETA.active` remains true, `endsOn` null. |
| Revenue-based AI budgets | Corrected planning targets in the price decision. Not enabled: production is not yet a total, atomic spending cap across providers; security reservation work requires separate review. |
| Ticket-worker isolation | Replacement container runner, narrow source access, one-ticket broker, bounded budget configuration and tests prepared. Existing working schedule remains active. Dedicated API credentials, pinned image and a runtime canary are required before cutover. |
| Accurate security page | New public security/data-handling page; privacy/terms/FAQ reconciled with cloud storage, local plaintext notes, AI routing and server email sharing. No blanket no-PHI/HIPAA assertion. |
| Stripe readiness | Two-price offline/test bootstrap, Clerk/profile ownership, durable checkout reservation and serialized webhook reconciliation implemented. Catalog remains disabled. New migration is unapplied; no real Stripe checkout has been performed. |
| Paid presale | Deferred by the owner. No sales email sent, card collected or customer charged. |
| Locums positioning | Contract → work → invoice → payment tracking on home and locums pages. Manual payment recording is described accurately; no automatic remittance audit is promised. Static packager includes these routes. |
| Value interviews | Draft below is ready for six participating physicians. No invented answers or savings estimates; no unsolicited outreach sent. |
| Real usage and heavy week | Aggregate query measured 24 proxy calls, two users, $0.0632. No customer prompts/documents collected. A seven-day synthetic protocol is prepared; a week of results is not claimed. |
| Model comparison | Claude ran seven synthetic text cases, repeated three times per Gemini model and once on Opus, with actual token counts. Cost calculations independently reviewed. Keep current model routing; this small text test does not establish a universal best model or OCR quality. |
| CME grounding pilot | Ohio's pain-clinic condition is explicit, with a per-license Yes/No/Not-sure answer and deterministic cited facts for Vera. Unknown is not treated as noncompliance or exemption. Other jurisdictions are not newly certified. |
| Hosting and business setup | Complete static package and manual Cloudflare preview workflow prepared. Existing credential lacks Pages access; GitHub login lacks workflow scope. No DNS move or spend-cap increase. Email formation records and the signed-in EWAI Stripe business settings now identify Eric Whitney, DO, A Professional Corporation and directly bind the merchant account to credentialdomd.com. Stripe shows payments/payouts active, no outstanding verification tasks, and an empty live product catalog. App billing secrets are absent; test integration is still being prepared. |

## Review and verification

- Public pages: responsive checks at phone, tablet and desktop widths; scripts,
  anchors, structured data, policy mirrors and route package reviewed.
- Pricing: two-price invariants, mobile/desktop rendering and modal keyboard/close behavior.
- Billing: 26 offline behavior tests, 43 checks against the actual migration in an
  isolated PostgreSQL instance, and seven additional independent handler tests.
- Ticket worker: six isolation/configuration suites and existing approval checks.
- Ohio: conditional rule, cycle/category counts, assistant context and transcript
  tests, plus existing CME/Gemini regressions. Normal Vite production build required.

No production billing tables, payment configuration, auth issuer, customer account
mapping or ticket-worker schedule is changed by this release. The new billing
hook does not query the unapplied tables while the catalog is disabled.

## Six-physician value interview draft

Use this with a consenting beta participant after they try a real workflow:

1. How do you currently move from contract terms to work log, invoice and payment?
2. Which step took the most time in your last assignment? Approximately how much?
3. Did this app help identify an actual missing payment, incorrect rate or expense?
   If yes, record the verified amount; otherwise record zero, not an estimate.
4. Which part needed correction or was too difficult to complete?
5. Which bundle would you choose at $149/year Core or $245/year Core + Locum,
   and what would stop you from paying after the beta?
6. What is the one thing that must work reliably before you recommend it?

Capture six independent responses before revisiting price/value claims. Do not
include patient identifiers, contracts or bank details in the interview notes.

## Related implementation records

- [Price decision and cost targets](PRICE-DECISION-2026-09-18.md)
- [Billing implementation and activation prerequisites](../tests/billing/README.md)
- [Ticket-worker preparation and runtime canary](../scripts/ticket-agent-isolation.md)
- [Hosting preparation](HOSTING-READINESS-2026-09-18.md)

Before a paid launch: finish protected membership/security review, safe Clerk
cutover, actual Stripe test checkout and signed-webhook
verification, then obtain the owner's explicit billing enablement decision.
