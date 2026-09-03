# Stale-asset sweep, marketing tree

Run 2026-08-28 against `/Users/ew/Projects/CredentialDOMD/marketing/` (all 39 files, every
subdirectory). Nothing in the originals was edited. This file is the map only.

**Note on em dashes in this file.** Every em dash below sits inside a backtick-quoted
string that is being *reported as a defect*. That is the point of the document. There are
zero em dashes in this file's own prose, and zero in the five assets shipped alongside it.

**Totals.** 35 text files scanned. 33 carry at least one dead fact. 296 em dashes across
the tree. 1 binary (`lead-magnets/CME_Compliance_Checklist_2026.pdf`) not machine-scannable.

---

## 1. Dead-fact classes and the standing replacement

| # | Class | What it looks like | Standing replacement |
|---|---|---|---|
| D1 | Any individual price that is not $199/yr | `$4.99`, `$7.99`, `$8/mo`, `$12/month`, `$14.99`, `$15`, `$19/month`, `$190/year`, `$29/month`, `$290/year`, `$39/provider/month`, `$149`, `$228`, `$245`, `$348` | `$199 a year` |
| D2 | Monthly individual billing | `/mo`, `per month`, `a month`, `$X/month` for an individual plan | Delete. The individual price is annual and flat. |
| D3 | Wrong founder identity | `Whit Whitney`, `Whit Whitney DO`, `Whit Whitney, DO`, `— Whit`, `whit@credentialdomd.com`, `Whit's hook` | `Eric Whitney, DO`. Sender address is an open decision (marketing plan decision 4). |
| D4 | Wrong brand | `CredentialMD`, `credentialmd.com`, `ambassadors@credentialmd.com`, `credentialmd.com/refer`, `twitter.com/credentialmd`, `instagram.com/credentialmd` | `CredentialDOMD`, `credentialdomd.com`. The refer/ambassador URLs have no live counterpart, so delete rather than remap. |
| D5 | Compliance or security claim | `HIPAA compliant` as an assertion, `bank-level encryption`, `military-grade`, blockchain verification copy | Only literal design facts: no patient data enters the product, keys stay on the device. Never a compliance claim. |
| D6 | Undercut framing | `cheaper`, `$5 under competitors forever`, `competitors charge $20+/mo`, `stay $5 under every competitor` | Exact price parity with Mocingbird at $199. The argument is more product for the same price, never cheaper. |
| D7 | The $47,000 anecdote | `$47,000`, `$47K`, and the six-weeks-of-lost-privileges story it sits in | Delete the whole anecdote. Marketing plan decision 1, default killed as unverifiable. |
| D8 | Fabricated testimonials and named fake users | `Dr. Sarah K.`, `Dr. James P.`, `Dr. Maria R.`, `— Dr. K., Internal Medicine`, and the entire testimonial section markup | Delete. No testimonial exists. 2 beta users. |
| D9 | Money-back guarantee | `30-day money-back guarantee`, `money back`, `full refund, no questions` | Delete. No published refund term exists. |
| D10 | Price lock / founding cohort | `price locked forever`, `locked for 24 months`, `Price Lock Guarantee`, `first 100 physicians`, `Founding Physician`, `Founding Member`, `100 founding spots`, `limited to first 50 physicians` | Delete. Replaced by: free invite-only beta, $199 a year after. |
| D11 | Em dash | `—` anywhere in prose | Rewrite the sentence. Do not swap in a hyphen, a comma, or a colon by reflex; the sentence usually wants splitting. |
| D12 | Unshipped-feature claim (added, not in the brief's list) | `texts you 90 days before`, `Sends alerts 90/60/30 days`, `notifies you at 90, 60, and 30 days`, `sends alerts before anything expires`, `Automated alerts` | Per `docs/BEATING-MOCINGBIRD-2026-08-16.md` section 6, email and SMS reminders are feature flags with no delivery. Browser push only. Delete or rewrite to what ships. |
| D13 | Free tier and trial (added) | `free plan ($0, up to 5 credentials, free forever)`, `14-day trial`, `Start free today`, `Free for 5 credentials` | Undefined under $199 flat. Marketing plan decision 3. Unpublishable until Eric decides. |
| D14 | Coverage imprecision (added) | `all 50 states` | The renewal guides cover 51 jurisdictions (50 states plus DC). The CME engine covers 55. Pick the number that matches the claim being made. |

D12, D13 and D14 are additions to the brief's list. They are included because they fail the
same test: a physician acting on them gets a wrong answer.

---

## 2. Per-file map

Files are grouped by disposition. Retirement-tier files get a class-level map plus exact
strings for the highest-risk items, because every line in them is built on a dead price and
a dead brand; string-by-string repair costs more than a rewrite and leaves residue.

### 2A. Reuse tier: worth refreshing string by string

#### `outreach/social-posts.md` (13 em dashes, 9 dead facts)
This is the source for LinkedIn post 1. The origin story survives; the numbers do not.

- L2 `**CredentialDOMD — Ready-to-Post Content**` -> `**CredentialDOMD post bank**`
- L8 `### Post 1 — Origin Story` -> `### Post 1. Origin story`
- L14 `Last year I watched a colleague — brilliant physician, 20 years of practice — lose hospital privileges for 6 weeks because a DEA registration lapsed.` -> Delete the sentence and the two that follow it. D7. Unverifiable third-party story with three invented numbers (20 years, 6 weeks, $47,000).
- L16 `$47,000 in lost billing. Six weeks of administrative hell. All from one missed renewal date.` -> Delete. D7.
- L20 `So I built CredentialDOMD — a credential tracking app that monitors every license, certification, DEA registration, CME requirement, and hospital privilege across all 50 states. Automated alerts. Document vault. CV generator. Works offline.` -> `So I built CredentialDOMD. It holds every license, certification, DEA registration, CME requirement and hospital privilege in one place, with the per-state CME rules built in. Document vault. CV generator. Works offline.` (D11, D12, D14)
- L24 `First 100 physicians who sign up get $12/month — locked for 24 months. After that it's the standard Solo rate of $19.` -> `It is in a small invite-only beta right now. After that it is $199 a year.` (D1, D2, D10, D11)
- L32 `### Post 2 — The Math` -> `### Post 2. The math`. The post body itself is dead: `8-12 active credentials`, `2-4 hours`, `$300/hr`, `$7,200/year`, `$15,000-$90,000` are all invented. Delete the post.
- L39 `- One lapsed credential = 30-90 days of lost billing = $15,000-$90,000` -> Delete. Invented.
- L41 `CredentialDOMD costs $12/month for Founding Physicians.` -> `CredentialDOMD is $199 a year.` (D1, D10)
- L51 `### Post 3 — The DO Angle` -> `### Post 3. The DO angle`. Body is salvageable; it is the post-4 candidate in the marketing plan.
- L70 `**Title:** I built a credential tracker after a colleague lost hospital privileges over a missed renewal — looking for beta testers` -> Rewrite without the colleague story. D7, D11.
- L93 `"One missed medical license renewal = 30-90 days without hospital privileges = $15K-$90K in lost billing. I built a $12/mo fix. 100 founding spots. credentialdomd.com"` -> Delete. D1, D10, invented numbers.
- L95 `...the hardest part wasn't the code — it was learning...` -> `The hardest part was not the code. It was learning that "credentialing" means completely different things to MDs, DOs, the hospital and the insurance panel.` (D11)
- L97 `"Physicians have 8-12 active credentials..."` -> Delete or resource the count. Invented.
- L99 `"The DEA registration expires every 3 years. So does your NPI address if you move..."` -> Hold. The DEA three-year cycle is not cited to a primary source anywhere in this repo. Either cite 21 CFR 1301.13 directly or drop the claim. House rule.
- L106 `Fellow physicians — I built something and I want honest feedback before I push it publicly.` -> `Fellow physicians. I built something and I want honest feedback before I push it publicly.` (D11)
- L110 `First 100 physicians get $12/month locked for 24 months. Looking for early feedback from colleagues.` -> `It is a small invite-only beta. Looking for early feedback from colleagues.` (D1, D10)
- L112 `credentialdomd.com — DMs open.` -> `credentialdomd.com. DMs open.` (D11)
- L114 `— Whit Whitney DO, Neurosurgery` -> `Eric Whitney, DO, Neurosurgery` (D3, D11)

#### `outreach-emails.md` (0 em dashes, 7 dead facts)
Structure is good and the "no features in email 1" logic is the right instinct. Every offer
line is dead.

- L23 `I'm opening it to the first 100 physicians at **$12/month, locked for 24 months** (Solo pricing is $19/month once founding closes). There's a 14-day trial, no pitch calls -- just a link.` -> `It is a small invite-only beta right now, free while it runs, $199 a year after. No pitch calls, just a link.` (D1, D2, D10, D13)
- L42 `One thing I didn't mention: CredentialDOMD texts you **90 days before your Texas medical license expires**` -> Delete. D12. There is no SMS delivery. Substitute a real capability: the per-state renewal and CME rules are built in, so Texas and your other states are computed separately rather than tracked as one date.
- L48 `Still **$12/month Founding Physician rate**, still only 100 spots. If you want in:` -> `Still open, still a small beta. If you want in:` (D1, D10)
- L60 `Founding Physician pricing is capped at the first 100 physicians.` -> Delete. D10.
- L67 `If credential tracking is on your radar at all, now's the time -- **$12/month, locked for 24 months**, vs. $19/month once founding closes.` -> `If credential tracking is on your radar at all, the beta is open and free while it runs.` (D1, D2, D10)
- L23, L67 `--` double hyphen used as an em dash substitute throughout. Rewrite the sentences; do not leave `--`.
- Sign-off `-- Eric` -> `Eric`. Correct name already; fix the punctuation.

#### `emails/waitlist-sequence.md` (5 em dashes, 2 dead facts)
The best-written asset in the tree and the one the marketing plan promotes to the nurture
sequence. Two defects only.

- L3 `From: Whit Whitney, DO <whit@credentialdomd.com>` -> `From: Eric Whitney, DO <address pending decision 4>` (D3)
- L1 `# Waitlist email sequence — drafts for Eric's approval` -> `# Waitlist email sequence. Drafts for Eric's approval.` (D11)
- L9 `## Email 1 — Welcome (sends instantly on signup)` -> `## Email 1. Welcome (sends instantly on signup)` (D11)
- L34 `## Email 2 — Proof note (about 1 week later)` -> `## Email 2. Proof note (about 1 week later)` (D11)
- L58 `## Email 3 — The 30-second import (about 2 weeks later)` -> `## Email 3. The 30-second import (about 2 weeks later)` (D11)
- L82 `## Email 4 — The invite (sent in batches of ~10 when production opens)` -> `## Email 4. The invite (sent in batches of about 10 when production opens)` (D11)
- L86 `Founding terms, only for this list: {{founding_offer}}. Annual, and if it's not earning its keep inside 30 days, full refund, no questions.` -> Delete the refund sentence. **D9.** No refund term is published anywhere. `{{founding_offer}}` is also still unfilled (marketing plan decision 2). This email cannot send as written.
- Also reframe: the sequence addresses a pre-launch waitlist. It now needs to address a guide downloader entering a free invite-only beta.

#### `physician-faq.md` (7 em dashes, 9 dead facts)
Mixed. The security answers are the honest ones the marketing plan wants reused. The
pricing answers are entirely dead.

- L28 **DO NOT CHANGE.** `**CredentialDOMD is not HIPAA compliant and does not sign business associate agreements.**` This is the correct line and the reason the file is worth keeping. See section 4.
- L43 `Founding Physician pricing is available to the first 100 physicians only. You lock in **$12/month (or $120/year)** for 24 months; at month 25 your plan converts to the standard Solo rate ($19/month).` -> Delete the whole Q&A. (D1, D2, D10)
- L48 `**Practice** is $39/provider/month for 2–25 seats, **Group** is $29/provider/month for 26–100 seats` -> Hold, unpublished. Team pricing is untouched per BEATING-MOCINGBIRD section 5, but the team invite flow is untested, so no team price should be public.
- L53 `There's a **free plan** ($0, up to 5 credentials, free forever). Paid individual plans are **Solo at $19/month ($190/year)** and **Locum at $29/month ($290/year)** — both include a 14-day trial...The first 100 physicians can claim **Founding Physician pricing at $12/month ($120/year)**, locked for 24 months.` -> `CredentialDOMD is $199 a year. It is currently in a free invite-only beta.` (D1, D2, D10, D13)
- L8 `...No more spreadsheets or missed renewal dates — everything is visible on a single dashboard with expiration alerts.` -> Split the sentence, and check the alert claim against D12 before publishing.
- L17 `**Q: I hold licenses in multiple states — can you track different CME requirements for each?**` -> `**Q: I hold licenses in multiple states. Can you track different CME requirements for each?**` (D11)
- L33 `You can export your full credential history at any time — your data is yours, full stop.` -> `You can export your full credential history at any time. Your data is yours, full stop.` (D11)
- L38 `CAQH ProView is built for hospitals and payers to pull your credentials — you maintain it for their benefit.` -> `CAQH ProView is built for hospitals and payers to pull your credentials. You maintain it for their benefit.` (D11)
- L1 `# CredentialDOMD — Physician FAQ` -> `# CredentialDOMD physician FAQ` (D11)
- L23 references `encryption at rest and TLS encryption in transit` with named limits. This is factual and stays; it is not a D5 violation because it describes the implementation without claiming a standard.

#### `competitive-one-pager.md` (7 em dashes, 5 dead facts)
Named in the marketing plan as the base for the state-society press kit.

- L28 `| **Cost** | Free (but costs you time) | $19/month (Solo; Founding Physician $12/mo) | $500–$5,000/year (billed to employer) |` -> `| **Cost** | Free (but costs you time) | $199 a year | $500 to $5,000 a year (billed to employer) |` (D1, D2, D10)
- L49 `> **$12/month — locked for 24 months.**` -> `> **$199 a year. Free invite-only beta now.**` (D1, D10, D11)
- L50 `> Available to the first 100 physicians. At month 25 your plan converts to the standard Solo rate ($19/month).` -> Delete. (D1, D10)
- L59 `*100 Founding Physician spots. First come, first locked.*` -> Delete. (D10)
- L7 `### Why individual physicians need their own credential management tool — not a spreadsheet, not a hospital system` -> `### Why individual physicians need their own credential management tool, not a spreadsheet and not a hospital system` (D11)
- L13 `None of them work for *you* — they work for the institutions that employ you.` -> `None of them work for you. They work for the institutions that employ you.` (D11)
- L37 `...a personal record that travels with your career — across employers, states, and specialties.` -> `...a personal record that travels with your career, across employers, states and specialties.` (D11)
- L40 `CredentialDOMD tracks them all in one place — hours earned, categories required, deadlines by state — so you're never caught off-guard at renewal time.` -> `CredentialDOMD tracks them all in one place: hours earned, categories required, deadlines by state. You are not caught off guard at renewal.` (D11)
- L43 `License expirations, DEA renewals, board certifications, hospital privileges — CredentialDOMD monitors every expiration date and notifies you at 90, 60, and 30 days.` -> **D12.** The 90/60/30 notification claim is not deliverable today. Rewrite to what ships or hold the line until the reminder cron is live.
- L27 `| **Portability** | Nothing moves with you | Your record moves with you | Locked to the employer |` -> Keep. `Locked` here is descriptive of the competitor, not a price lock.

#### `outreach/physician-communities.md` (12 em dashes, 4 dead facts)
Superseded in strategy by `docs/MARKETING-PLAN-2026-08-28.md` section 1, which has verified
venue rules this file does not. Keep it only as a venue list.

- L3 `**Goal:** 100 Founding Physicians at $12/mo` -> `**Goal:** first real users into the invite-only beta` (D1, D2, D10)
- L21 `- "I spent 3 hours renewing my Texas medical license last month when a $2 app could have done it. So I built the app."` -> Delete. Invented time and invented price.
- L22 `- "Built a credential tracker after watching a colleague lose hospital privileges over a missed renewal — want beta testers"` -> Delete. D7 source story.
- L38 `- **Whit's hook:** Neurosurgeon who built a tech product — that's interesting to physicians` -> `- **Eric's hook:** a neurosurgeon who built the tool he needed` (D3, D11)
- L82 `1. **Whit posts, not a brand.** Physicians trust physicians. Every post should come from Whit Whitney DO, not "CredentialDOMD."` -> `1. **Eric posts, not a brand.** Every post comes from Eric Whitney, DO.` (D3)
- L83 `2. **Lead with the pain, not the product.** "One missed renewal cost a physician $47,000" before any product mention.` -> Delete the quoted example. D7.
- L84 `3. **100 Founding Physicians is a real constraint.** The scarcity is genuine — use it.` -> Delete. D10. The constraint no longer exists, so the scarcity claim would now be false.
- Remaining 8 em dashes are section headers (`## Tier 1 — Highest ROI`, `### 3. Facebook Groups — Locum Physicians`, etc). Replace the dash with a period or a colon.

#### `emails/01-founding-member-welcome.md` through `05-cold-outreach-residency-program.md` (22 em dashes, 14 dead facts)
All five are addressed to a founding cohort that no longer exists. Emails 1 through 3 should
be rebuilt against beta terms; 4 and 5 are salvageable in structure.

- 01 L3 `**From:** Whit Whitney DO <whit@credentialdomd.com>` -> `**From:** Eric Whitney, DO` (D3)
- 01 L4 `**Subject:** You're in — Founding Member #[X] 🏛️` -> `**Subject:** You're in` (D10, D11)
- 01 L10 `You just locked in $12/month for 24 months.` -> Delete. (D1, D10)
- 01 L12 `That's your Founding Physician rate — one of only 100 founding spots. When founding closes, new members pay the standard Solo rate of $19/month. At month 25 your plan converts to that Solo rate too...` -> Delete. (D1, D2, D10, D11)
- 01 L34 `You're not just a customer. You're Founding Member #[X] — the people who believed before there was proof.` -> Rewrite without the cohort framing. (D10, D11)
- 01 L38 `— Whit Whitney DO` -> `Eric Whitney, DO` (D3, D11)
- 02 L3 same From line. (D3)
- 02 L12 `...I get it — you're a physician, not a software setup person.` -> `I get it. You are a physician, not a software setup person.` (D11)
- 02 L16 `**Scan your DEA certificate** (or medical license, or board cert — whatever's on your desk). Open the app → Add → Camera. The AI reads it and fills everything in. That's it.` -> Keep the capability, add the BYOK condition. Per BEATING-MOCINGBIRD section 2 the scanner requires the user's own key until the managed proxy ships. (D11 on the dash.)
- 02 L20 `— Whit` -> `Eric` (D3, D11)
- 02 L22 `P.S. — If you just haven't had time...Your $12/month Founding Physician rate is locked in for 24 months regardless.` -> Delete. (D1, D10, D11)
- 03 L3 same From line. (D3)
- 03 L16 `Every physician who joins at this stage gets the $12/month rate — locked for 24 months. After the 100 founding spots fill, new members pay the standard Solo rate of $19/month.` -> Delete. (D1, D2, D10, D11)
- 03 L18 `If you refer someone who signs up, I'll extend your $12 rate for an extra year beyond the 24-month founding lock.` -> Delete the whole referral offer. There is no referral program and no rate to extend. (D1, D10)
- 03 L10 `Two weeks in — thanks for being here.` -> `Two weeks in. Thanks for being here.` (D11)
- 03 L14 `Not a mass referral thing. Just — if you have a colleague...` -> `Not a mass referral thing. If you have a colleague...` (D11)
- 04 L3 `**From:** Whit Whitney DO` -> `**From:** Eric Whitney, DO` (D3)
- 04 L4 `**Subject:** Built this for locums docs — want to try it free?` -> `**Subject:** Built this for locums docs. Want to try it?` (D11)
- 04 L10 `I'm Whit — board-certified neurosurgeon...` -> `I'm Eric Whitney, a neurosurgeon...` (D3, D11)
- 04 L12 `...malpractice records — all in one place, with alerts before anything expires.` -> **D12** on the alerts clause, D11 on the dash.
- 04 L20 `— Whit Whitney DO` -> `Eric Whitney, DO` (D3, D11)
- 05 L10 `I'm Whit Whitney, a board-certified neurosurgeon. I built a credential tracking tool after watching too many physicians — including residents finishing training — get tripped up...` -> `I'm Eric Whitney, a neurosurgeon. I built a credential tracking tool after watching physicians, residents finishing training included, get tripped up...` (D3, D11)
- 05 L16 `Just a tool that might save one of them from a $47,000 billing gap when a license lapses.` -> Delete. **D7.**
- 05 L20 `— Whit Whitney DO` / L21 `whit@credentialdomd.com | credentialdomd.com` -> `Eric Whitney, DO` and the decided sender address. (D3)

#### `LAUNCH-EXECUTION-PLAN.md` (12 em dashes, 2 dead facts)
- L8 `**100 Founding Physicians at $12/month**` -> `$199 a year, free invite-only beta first` (D1, D10)
- L17 `- [ ] Create product in Stripe: "CredentialDOMD Founding Physician" $12/month ($120/year)` -> `- [ ] Create product in Stripe: "CredentialDOMD" $199/year` (D1, D10). Cross-check against `STRIPE-SETUP.md` before running anything; Stripe products are still uncreated per `CURRENT-STATE.md`.
- 12 em dashes, all in headers and asides. D11.

#### `competitive-analysis.md` (26 em dashes, 1 dead fact)
Internal strategy doc. The `$15,000–$100,000+/year` figure on L62 is a competitor estimate,
not our price, so it is not a D1 violation, but it is labelled `Estimated` and should not
appear in anything public. The thesis on L108 (`the incumbent to beat...is the Google Sheet
on the physician's desktop`) is the reusable line and the marketing plan cites it for the
KevinMD essay. 26 em dashes to clear before any of it is quoted publicly.

#### `onboarding-sequence.md` (17 em dashes, 0 other dead facts)
Clean on prices and identity. Em dashes only.

#### `agent-plans/*.md` (34 em dashes across 8 files)
Internal agent scratch. `ledger-plan.md` is entirely built on $12/$19 LTV math (L22 to L62,
12 price hits) and is now arithmetic about a price that does not exist. Recommend archiving
the whole directory rather than refreshing. `justice-plan.md` L6 asks about HIPAA obligations
and predates the no-PHI-by-design decision recorded in `project_credentialdomd_hipaa`.

---

### 2B. Reference tier: internal only, do not publish, fix the superseded prices

#### `research/competitive-brief-2026-08.md` (31 em dashes)
Competitor prices in this file are correct and verified. Do not touch them. Two of our own
prices are superseded:

- L128 `Pricing check: Solo $228 sits $29 above Mocingbird` -> superseded by $199 flat. Add a header note; the analysis that follows it was written against a price we no longer charge.
- L129 `Locum $348 is unchallenged` -> superseded.
- L15 `The compliance slice, by contrast, is contested and cheaper elsewhere` and L24 `will find Mocingbird cheaper and deeper on rules validation` -> these are true internal findings, not D6 violations, because they are not claims we make publicly. Flag the file `INTERNAL, NOT FOR PUBLICATION` at the top so no line gets lifted verbatim.
- 31 em dashes. If any sentence is lifted for public use, it must be rewritten anyway.

---

### 2C. Retirement tier: rewrite, do not repair

These seven files are Gen-1 assets built on `$4.99/mo`, the `CredentialMD` brand, price-lock
guarantees, refund guarantees and, in two cases, fabricated evidence. Every line carries at
least one dead fact. Repairing them string by string produces copy that still has Gen-1 bones.
The marketing plan already routes their formats and hooks into new drafts.

| File | Dead facts | Fatal item |
|---|---|---|
| `social-posts/twitter-posts.md` | 18 brand, 6 price, 4 guarantee, 4 lock, 18 em dashes | L25 `Founding Member Price: $4.99/mo. Price locked forever. 30-day money-back guarantee.` (D1, D9, D10) |
| `social-posts/facebook-posts.md` | 15 brand, 7 price, 4 guarantee, 5 lock, 8 em dashes | L91 to L93 fabricated testimonial signed `— Dr. K., Internal Medicine` (**D8**), plus L16 which scripts posing as a customer |
| `social-posts/linkedin-posts.md` | 10 brand, 4 price, 3 guarantee, 3 lock, 11 em dashes | L112 `We stay $5 under every competitor. 30-day money-back guarantee. Price Lock Guarantee — your rate never increases.` (**D6**, D9, D10) |
| `social-posts/instagram-captions.md` | 17 brand, 4 price, 1 guarantee, 5 em dashes | L47 `$4.99/mo for Founding Members. Price locked forever. 30-day money-back guarantee.` |
| `social-posts/tiktok-scripts.md` | 13 brand, 3 price, 2 em dashes | L23 `$4.99/mo Founding Member Price, capped at $14.99/mo (competitors charge $20+/mo)` (**D6**) |
| `social-posts/reddit-playbook.md` | 9 brand, 2 price, 20 em dashes | L31, L34, L37, L40, L43, L65: six scripted comments in which the founder poses as an ordinary satisfied user. **Astroturfing.** Banned outright by marketing plan section 6. Delete, do not rewrite. |
| `influencer-outreach/ambassador-program.md` | 10 brand, 5 price, 16 em dashes | L41 `We're priced at $4.99/mo for Founding Members and stay $5 under competitors forever` (**D6**). The whole 25% revenue-share program is undefined and unbuilt. |
| `email-templates/launch-newsletter-1.html` | 11 brand, 1 price, 2 lock, 1 guarantee, 6 em dashes | L43 `Lock In $4.99/mo →` and L45 `30-day money-back guarantee.` |
| `landing-pages/concept-1-dark-premium.html` | 7 brand, 7 em dashes | L444 to L464: three fabricated testimonials with invented physician names and specialties (`Dr. Sarah K.`, `Dr. James P.`, `Dr. Maria R.`). **D8.** Also L434 `$79.99/yr Pro`, `$39.99/yr Resident`, `$5.99/user/mo`. |
| `landing-pages/concept-2-clean-medical.html` | 5 brand, 7 em dashes | L350 `Join physicians across all 50 states who trust CredentialMD` implies a user base that does not exist |
| `landing-pages/concept-3-bold-energy.html` | 4 brand, 4 em dashes | L244 comparison row prices us at `$7.99/mo` against `$199+/yr`. Both halves now wrong; we are at parity, not below. **D6.** |
| `landing-pages/referral-page.html` | 9 brand, 7 price | Entire page is a referral program that does not exist, with an earnings calculator built on `$7.99/mo` |
| `feature-roadmap/killer-features.md` | 6 brand, 4 em dashes | L42 to L45 blockchain credential passport. **D5** adjacent: an unbuildable verification claim. |
| `lead-magnets/CME_Compliance_Checklist_2026.pdf` | binary, not scannable | Marketing plan decision 6 recommends dropping it. Stale `CredentialMD` branding, redundant with the 51 live guides. |

---

## 3. Files with zero dead facts

None. Every text file in the tree carries at least one class from section 1. The closest to
clean is `emails/waitlist-sequence.md`: two defects, both trivial to fix, and it is the only
sequence written to the current voice rules.

---

## 4. Strings that look like hits but must NOT be changed

A find-and-replace run without these exclusions will make the tree worse.

- `physician-faq.md` L27 to L28: `**Q: Is CredentialDOMD HIPAA compliant?**` / `**CredentialDOMD is not HIPAA compliant and does not sign business associate agreements.**` This is the correct answer and the standing position. The phrase `HIPAA compliant` here is a denial. Keep it exactly.
- `research/competitive-brief-2026-08.md`: every competitor price (`$199`, `$39.99`, `$89.99`, `$124.99`, `£14/mo`, `$20/mo`, `$23-65/mo`, `$99-525/mo`, `$3,550/yr`, `$22/user/mo`). These are verified external facts.
- `docs/BEATING-MOCINGBIRD-2026-08-16.md`: `Starting at $199 a year` describing Mocingbird. Verified from their pricing page. Note the claims-not-safe list in that same file forbids rendering it as `$199 flat` when describing *them*, even though $199 flat is exactly what *we* charge.
- `competitive-analysis.md` L93 and L106, `competitive-one-pager.md` L27: `Locked to one employer`, `locked inside an employer's HR system`, `Locked to the employer`. Descriptive of competitors, not a price lock.
- All CSS in the landing-page concepts: `display:block`, `display:inline-block`, `margin-bottom:1px`. The `lock`/`block` pattern matches produce dozens of false positives in those files.
- `emails/waitlist-sequence.md` L45: `One week was $600 short: a two-hour orientation block they never paid.` Eric's own verified experience, cited by the marketing plan as the first Facebook-group contribution. Real. Keep.
- Numeric en dashes in ranges (`2–25 seats`, `$300 to $485`) are not em dashes. Only `—` is in scope for D11.

---

## 5. Out of scope, reported not touched

Found while scanning. These live in `landing/`, `index.html` and the repo root, which the
brief puts off limits. They are listed because they are public today and they contradict the
$199 flat standing fact.

- `landing/index.html` L2676, comparison table: `$149 a year (Core), $245 with the Locum add-on`. Live public page, wrong price, two dead figures.
- `index.html` L14, meta description: `Free for 5 credentials. $19/month for unlimited.` This is the description Google shows in search results. Wrong price and a free tier that is undefined under the current model (D13).
- `landing/locums.html` L109 and L3500: FAQ headed `Is my patient data safe? Is this HIPAA compliant?`. Read the answer body before deciding; the question phrasing is fine if the answer is the physician-faq denial, and fatal if it is not.
- `CredentialMD_Marketing_Playbook.pptx` (repo root): dead brand in the filename and presumably throughout.
- `docs/BEATING-MOCINGBIRD-2026-08-16.md` section 5 recommends Core $149 and Locum add-on $245. Superseded by $199 flat. The doc's win sentences and claims-not-safe list are still authoritative; only its section 5 pricing table is stale.

---

## 6. Decisions this sweep cannot make

1. **Sender address.** `whit@credentialdomd.com` appears in six files. Replacing the display
   name is mechanical; choosing `eric@` versus keeping the mailbox with a corrected display
   name is not. Marketing plan decision 4.
2. **Beta terms.** `{{founding_offer}}` in the waitlist sequence and every "what happens when
   the beta ends" line depend on terms that do not exist yet. Marketing plan decision 2.
3. **Free tier, trial, resident pricing.** D13. Three FAQ answers stay unpublished until this
   is decided. Marketing plan decision 3.
4. **Monthly billing.** BEATING-MOCINGBIRD section 5 treats monthly as a differentiator
   Mocingbird lacks. The standing fact is $199/yr flat. Until Eric reconciles these, every
   `/mo` string for an individual plan is dead, including the ones that would otherwise be a
   real competitive advantage.
5. **The reminder claim.** D12 blocks roughly a dozen strings across the tree. The fix is a
   product fix, not a copy fix: ship `supabase/functions/send-reminders` and the claim
   becomes true.
