# LinkedIn post 2: the lapse nobody sees coming

**The DEA and license lapse pain point, written as recognition.**
Draft for Eric's edit. Post as Eric Whitney, DO. Post body is 218 words.

---

Ask a room of physicians whether they have had a near miss with a renewal. The hands go up slowly. Nobody wants to be first.

It is not a discipline problem. It is a design problem. The credentials that let you practice do not share a clock, or a grace period.

Alabama is the cleanest example. Your medical license and your state controlled substances certificate both expire December 31. The license gets a grace period through January 31 and stays in Active status the whole time. The certificate gets none.

So there is a month where you are fully licensed to practice and not authorized to write a controlled substance. Same physician, same board, same renewal season, two different answers.

That is the shape of most of these stories. Not a forgotten date. A date that was met, for the wrong credential.

One thing worth ten minutes today. The MATE Act requires every DEA-registered prescriber to complete a one-time eight hours of training on treating and managing patients with opioid or other substance use disorders, attested at registration or renewal. General pain management CME is not automatically the same thing. If you are not sure which certificate covers it, this is a cheaper week to find out than renewal week.

I built this. Founder of CredentialDOMD.

#PhysicianLife #Locums

---

## Fact check

| Claim in post | Source | Value |
|---|---|---|
| Alabama license and ACSC both expire December 31 | `states-data.json` -> `states[AL].renewalAnchor` and `states[AL].graceOrLapse` | "all licenses expire annually on December 31, regardless of when issued" / "The ACSC has NO grace period; it expires December 31 and requires reissue if lapsed." |
| License grace period runs January 1 to 31, license stays Active | `states[AL].graceOrLapse` | "Grace period January 1-31 for full MD/DO licenses only, with the $100 late fee; the license remains in Active status (authorized to practice) until midnight January 31." |
| The controlled substances certificate has no grace period | `states[AL].pitfalls[0]` | "The ACSC (state controlled substances certificate) has no grace period: it expires December 31 and you may not prescribe controlled substances after that date even though the medical license itself stays Active through January 31." |
| MATE Act: 8 hours, one-time, DEA registrants | `src/constants/boardRequirements.js` -> `MATE_ACT` | `{ hours: 8, note: "MATE Act: 8 hrs treating/managing opioid & SUD patients (one-time, DEA renewal from June 2023)", oneTime: true }` |
| Attested at registration or renewal | same `MATE_ACT.note`, and `src/components/pages/FAQSection.jsx` | "The MATE Act requires all DEA-registered practitioners to complete a one-time 8-hour training on substance use disorders." |
| General pain management CME is not automatically the same thing | `src/utils/compliance.js` lines 39 to 45 | "Generic pain-management or controlled-substance CME does NOT satisfy it, so only the two specific topics count here." Qualifying topics in code: Opioid Prescribing, Substance Use Disorders. |

Alabama verification date in `states-data.json`: 2026-08, multi-source. Alabama CME and
controlled-substance rules cite `Ala. Admin. Code r. 540-X-14-.02` and `r. 540-X-4-.09(8)`;
the grace and lapse rules cite `Ala. Admin. Code r. 545-X-2-.03`.

## One item Eric must confirm before this posts

The MATE Act paragraph is the only claim in this post whose primary source does not live in
the repo. The repo encodes the rule in three places and the app acts on it, but it carries no
statute or DEA URL. House rule: never state a rule we cannot cite to a primary source.

Confirm against the DEA's own registration page or the Consolidated Appropriations Act, 2023
text, then either add the citation to `boardRequirements.js` or cut the paragraph. If it is
cut, the replacement closing fact with a citation already in hand is Alabama's reinstatement
cost: miss January 31 and the license goes Inactive by rule, with the board's own
reinstatement letter quoting $550 if it expired at the most recent December 31 and $850 if
earlier, plus a $65 background check with two FBI fingerprint cards and 25 Category 1 credits
from the previous 12 months (`states[AL].graceOrLapse`).

## Deliberate omissions

- No DEA three-year renewal cycle. It appears in `marketing/pain-points-analysis.md` but that
  file is an agent-written analysis, not a primary source, and no citation for the cycle
  exists anywhere in the repo.
- No dollar figure for a lapse. Every such number in the old assets was invented.
- No fear framing, no "this could end your career," no pharmacist-calls-you scene. The
  pain-points file recommends recognition over fear and this post follows it.
- No alert or reminder claim.
