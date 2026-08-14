# CredentialDOMD competitive brief — August 2026

Thirteen research agents, current primary sources (pricing pages, app stores, vendor docs),
with adversarial verification on every claim that could appear publicly. Corrections from
verification are already applied below.

## The one-paragraph answer

Nobody does what CredentialDOMD does end to end. Every competitor owns one slice:
compliance trackers stop at credentials and CME, agency portals are the agency's ledger,
freelancer tools don't know what a call stipend is, and tax tools top out at two states.
Two capabilities came back as **empty fields across the entire market**: (1) reconciling an
agency's remittance against the physician's own logged time, and (2) automated multistate
allocation of locums income for taxes. Those are the moat. The compliance slice, by
contrast, is contested and cheaper elsewhere — sell the business engine, include compliance.

## Head-to-head threats (individual physician can actually buy)

**Mocingbird — $199/yr** (free for students/residents). The closest true competitor on the
compliance slice: patented, staff-validated CME requirements engine across all states and
specialties, native iOS/Android apps, established brand. Undercuts our Solo tier by $29.
Has none of the business layer: no invoicing, no reconciliation, no tax, no RVU, no AI
scanner. *Implication: Solo-tier buyers comparing pure compliance will find Mocingbird
cheaper and deeper on rules validation. Our Solo pitch must include the vault + sharing +
CV + AI, not just CME.*

**CE Broker (Propelus) — free / $39.99 / $89.99 / $124.99 per yr.** A regulatory moat we
cannot replicate: in mandate states (Florida MD/DO included) it IS the board's reporting
system and course providers push credits in automatically — zero data entry, audit-proof
by construction. Verification correction: paid tiers DO include a credential tracker with
expiration dates, so "they only do CME" is not a claim we can make. Weaknesses: physician
coverage is thin (nurse-heavy), 1.8/5 Trustpilot, standalone iOS app removed from the App
Store as of July 2026, compliance status paywalled. No business layer of any kind.

**Modio Health OneView (CHG/CompHealth) — free provider record; org product quote-only.**
The strategic one. Owned by the largest locums staffing company, lives on the org side
where the credentialers work, and does real automated primary-source verification (pulls
DEA/board/license status from authoritative databases — we import NPPES once, they verify
continuously). Verification correction: profiles DO include a Health Info section
(PPD/immunizations with alerts), so health records are not a differentiator against them.
No billing, no reconciliation, no tax, no RVU, no per-state CME rules engine. *CHG is both
a distribution threat (they could bundle) and a validation of the market.*

**CAQH / DataSpring Provider Data Portal — free.** Rebranded "DataSpring, powered by CAQH"
in June 2026. Payer-facing data entry every credentialed physician already maintains;
payers pull from it directly. Not a personal tool (no alerts UX, no CME engine, no
packets), but every pitch must answer "I already keep this in CAQH."

## Categories with no individual product (the confusion set)

Medallion, Verifiable, CertifyOS, Axuall, MedTrainer, symplr: all sell to hospitals,
payers, and staffing orgs by enterprise quote. None lets a physician sign up. Their edge
is real but different — NCQA-grade primary-source verification and payer enrollment (they
produce regulated verification artifacts; our packets are self-attested documents). Watch
**Axuall**: its org-sponsored Clinician Wallet is the only thing shaped like a physician
wallet, with verified-data network effects. Watch **Credentially** too — verification
flagged that they market AI/OCR document scanning, so "only we have AI scanning" is not
safe as a public claim.

## CME-only competitors

AMA Ed Hub (free, authoritative, auto-reports to some boards but only tracks courses taken
on Ed Hub), AOA portal (authoritative for DOs, AOA-universe only), specialty-board MOC
portals (system of record for MOC only), CMEfy/Learner+ ($50/yr — solves EARNING credits,
complementary rather than competitive; a partnership candidate), CE App (free logging, no
rules depth), one-time $25 app-store loggers with no traction. None computes per-state
cycles + topic mandates + MD/DO + MATE Act the way our engine does — except CE Broker and
Mocingbird above.

## Locums business tools — the empty field

- **Agency portals (MyCompHealth, LocumTenens.com app):** free, convenient, and the
  decisive obstacle to adoption — their timesheet IS the paycheck. But they are the
  counterparty's ledger: single-agency, no independent record, and structurally incapable
  of remittance reconciliation (you cannot audit their numbers with their tool). This is
  our best marketing line, and it is verified true.
- **MyLocumManager (£14/mo):** proof physicians pay for exactly this workflow — UK-only,
  NHS-pension-centric, no US concepts.
- **Lucens ($195/yr):** a community, not a tool — but it owns the audience we want.
  Channel candidate, not competitor.
- **Wanderly (free):** pay transparency pre-contract; nothing post-signature. Their rate
  benchmark data is something we can never see — a real edge of theirs.
- **QuickBooks Solopreneur ($20/mo) / FreshBooks ($23-65/mo) / Wave (free-$19/mo) /
  Bonsai ($9-59/mo):** the DIY stack physicians actually use. Their edges are real:
  bank feeds and background mileage capture beat our manual imports; FreshBooks/Found
  collect the money (payment rails + dunning) where our invoices are documents. None has
  call-stipend/overage math, contract extraction, or reconciliation.

## Tax tools — the second empty field

- **Keeper ($199-399/yr):** files returns, continuous bank-feed deduction scanning, 4.8
  stars — but caps at TWO state returns and has no per-state allocation and no S-corp.
- **Collective (~$3,550/yr + $199 onboarding):** humans do everything including filing —
  but their own ToS limits tax service to federal + primary state; multistate is form-prep
  without advice. Single-member LLCs only.
- **Lettuce ($99-525/mo):** automates payroll and estimated payments for S-corps ($28M
  Series A, Oct 2025) — but multistate is a $525/mo human-advisory tier, not software.
- **Everlance/MileIQ ($60-100/yr):** background GPS mileage — a genuine feature gap for us.
- **Found (free-$720/yr):** real banking + federal quarterly payments in-app; federal-only.
- **Cerebral Tax Advisors ($10-30k plans) / Physician Tax Solutions (quote):** the "just
  hire humans" alternative; no software. Cerebral's White Coat Investor channel presence
  is exactly where our buyers read.

**Verified market fact: no software product automates multistate nonresident allocation of
locums income.** We are alone on this.

## What they do better than us (roadmap candidates, honestly)

1. **Continuous primary-source verification** (Modio, Axuall, Verifiable) — we import once.
2. **Automatic CME ingestion** (CE Broker in mandate states, board portals via PARS) — our
   engine needs the user to feed it. A CE Broker import, or PARS/board-transcript upload
   parsing, would blunt their moat.
3. **Bank feeds + background mileage** (QuickBooks, Everlance, MileIQ) — continuous capture
   beats batch statement import; locums drive constantly.
4. **Payment rails** (FreshBooks, Found) — collecting the invoice, not just generating it.
5. **Actually filing** (Keeper, Collective, Lettuce, CPAs) — a "hand your CPA this package"
   export is our realistic answer, or a filing-partner integration later.
6. **Native app-store presence** (Mocingbird) — PWA install friction is real.

## Positioning that survives the evidence

"The only app where your credentials, your contracts, your invoices, and your taxes are
one system — built and used daily by a locums neurosurgeon." Every word verified: the
business engine has zero head-to-head competition; the compliance slice alone does not
justify us against Mocingbird/CE Broker, so never lead with it. The agency-portal line —
"their portal is their ledger; this one is yours" — is both true and the sharpest knife.

Pricing check: Solo $228 sits $29 above Mocingbird and 2.5-5x above CE Broker for the
overlapping slice; Locum $348 is unchallenged (nearest analog: UK's MyLocumManager at
~$215/yr equivalent with a fraction of the features; the DIY stack runs $320-900/yr across
2-3 subscriptions without solving reconciliation or multistate tax). Consider making the
business engine the headline of the Locum tier and repositioning Solo as the vault+CME+CV
tier priced against Mocingbird.

## Claims cleared for public use (verification-checked)

Safe: "No other product reconciles agency remittances against your own log." · "No
software automates multistate locums tax allocation." · "Agency portals are the agency's
ledger." · Keeper's 2-state cap · Collective's primary-state ToS limit · CE Broker/
Mocingbird/MedRenewal/Everlance/Found/Wave/Bonsai/FreshBooks/QuickBooks prices as listed.

NOT safe: "CE Broker is CME-only" (paid tiers track credentials) · "Modio has no health
records" (it does) · "only we have AI document scanning" (Credentially markets it) ·
unqualified "cheapest" claims · anything about CredyApp being free (its Basic tier is
$22/user/mo per Capterra).
