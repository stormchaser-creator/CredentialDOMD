# LinkedIn post 1: founder arc

**Why a neurosurgeon built his own license renewal tracker.**
Draft for Eric's edit. Post as Eric Whitney, DO. Post body is 219 words.

---

I opened the spreadsheet to answer what should have been a five-second question: which of my licenses renews next?

I could not answer it.

Not because the dates were hard to find. Because the states do not agree on what a date is. One anchors to the month my license was issued. One expires every physician in the state on one fixed day in odd-numbered years. One uses my birthday. One uses whether I was born in an even year or an odd one. Four licenses, four unrelated clocks, and a spreadsheet that only knew what I typed into it.

So I made the thing I wanted. It holds the licenses, the DEA record, the board requirements and the per-state CME rules in one place, and I use it on my own credentials daily.

I built this. Founder of CredentialDOMD. It is in a small invite-only beta.

The part worth keeping even if you never click anything:

If you hold a Maine license, your renewal year follows your birth year. Born in an even year, you renew in even years. Born odd, odd. And Maine DOs do not renew with the MD board at all: different board, different portal, 100 CME hours per cycle instead of 40.

I am a DO. I found that out by looking.

#PhysicianLife #LocumTenens

---

## Fact check

Source for every claim. File is `landing/states/states-data.json` unless noted.

| Claim in post | Field | Value |
|---|---|---|
| "One anchors to the month my license was issued" (California) | `states[CA].renewalAnchor` | "MD: license expires at 11:59 p.m. on the last day of the month in which the license was originally issued, every two years (not birth month)." |
| "One expires every physician in the state on one fixed day in odd-numbered years" (Colorado) | `states[CO].renewalAnchor` | "All Physician and Pro Bono Physician licenses expire on April 30 of odd-numbered years, regardless of when the license was issued." |
| "One uses my birthday" (North Dakota) | `states[ND].renewalAnchor` | "Licenses expire on the physician's birthday every other year (effective August 1, 2023)." |
| "One uses whether I was born in an even year or an odd one" (Maine) | `states[ME].renewalAnchor` | "physicians born in an even-numbered year expire on the last day of their birth month in an even-numbered year, those born in an odd-numbered year in an odd-numbered year (MD board FAQ)." |
| Maine birth-year parity, stated plainly | `states[ME].pitfalls[0]` | "Your expiration follows your birth-year parity, not your license anniversary." |
| Maine DOs: different board, different portal | `states[ME].pitfalls[3]` | "DOs renew with a different board on different numbers: Maine Board of Osteopathic Licensure, $525 fee, separate portal (board_number=383)." |
| Maine DO 100 hours vs MD 40 | `states[ME].cmeDetails` and `states[ME].pitfalls[3]` | "MD: 40 hours per 2-year cycle... DO: 100 hours per 2-year cycle" / "100 CME hours per cycle with at least 40% osteopathic medical education." |
| Maine CME rule citation | `states[ME].cmeSource` | "ME BLM Rules ch. 1 s. 11 (amended eff. Feb 3, 2026); ME BLM CME Information" |
| Product holds licenses, DEA, board requirements, per-state CME rules | `docs/BEATING-MOCINGBIRD-2026-08-16.md` section 2 | Head-to-head table, CredentialDOMD column |

Verification dates from `states-data.json`: CA 2026-08, CO 2026-08, ME 2026-08, ND 2026-08
(single-source). Maine, the only state named in the post, is multi-source verified.

## Deliberate omissions

- No alert, reminder or notification claim. Email and SMS reminders are feature flags with no
  delivery today, per `BEATING-MOCINGBIRD-2026-08-16.md` section 6.
- No price. The post does not need one and a price line changes the register from founder to
  seller. If Eric wants it, the only correct line is "$199 a year."
- No signup count, no testimonial, no dollar figure of any kind.
- The four-clock line names no states, so nothing rests on North Dakota's single-source entry.

## Before posting

Confirm the count. The post says four licenses. If Eric holds five, change the number and
add the fifth anchor type, or cut the number and write "my licenses."
