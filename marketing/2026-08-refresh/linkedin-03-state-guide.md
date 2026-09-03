# LinkedIn post 3: Colorado renewal guide, as a native post

**A state guide written to stand on its own in the feed.**
Draft for Eric's edit. Post as Eric Whitney, DO. Colorado chosen because Eric holds it and
because it is one of the multi-source-verified entries in the state data.

---

If you hold a Colorado medical license, 2027 is the first renewal in the state's history where CME is mandatory.

HB 24-1153 did it. For renewals on or after January 1, 2026, Colorado physicians owe 30 hours per two-year cycle, including 2 hours on substance use disorders, with board audits of up to 5 percent of physicians. The first physician renewal it touches is April 30, 2027.

The rest of the Colorado calendar, since most of it surprises people:

Every physician license in the state expires April 30 of odd-numbered years. Not your birthday, not your license anniversary. If yours was issued mid-cycle, your first renewal period is shorter than two years.

The renewal link does not appear in the state portal until roughly four to six weeks before expiration, so starting early is not an option.

There is a 60-day grace period after expiration under CRS 12-20-202(1)(e). Miss it and this stops being a late renewal: reinstatement wants a certified NPDB self-query, an FSMB disciplinary action report sent to DORA, out-of-state license verifications and a practice history. Those reports take weeks to arrive.

Full guide with sources: credentialdomd.com/states/colorado

I built this. Founder of CredentialDOMD.

---

<!--
FACT CHECK, COLORADO POST
Source file: /Users/ew/Projects/CredentialDOMD/landing/states/states-data.json
Record: states[] entry where name == "Colorado"
Record-level verification: states[CO].verified == "2026-08"  (multi-source; not flagged
single-source, unlike ND and TX)
File-level: meta.verified == "2026-08-19", meta.cmeReviewed == "2026-08"

1. "2027 is the first renewal in the state's history where CME is mandatory"
   FIELD: states[CO].pitfalls[5]
   TEXT: "Renewals on or after January 1, 2026 carry Colorado's first physician CME
   mandate ... The first physician renewal it hits is the April 30, 2027 cycle; the board's
   own Medical Licensing Guide confirms the 30-hour requirement for the 2027 renewal"
   NOTE: "first ... mandate" in the field supports "first renewal ... where CME is
   mandatory". If Eric wants a softer claim, drop "in the state's history".

2. "HB 24-1153 did it"
   FIELD: states[CO].cmeSource
   TEXT: "HB 24-1153 (effective 2026-01-01)"
   URL FIELD: states[CO].cmeSourceUrl == "https://dpo.colorado.gov/Medical/CME"

3. "30 hours per two-year cycle, including 2 hours on substance use disorders"
   FIELDS: states[CO].cmeHours == 30; states[CO].cmeDetails
   TEXT: "30 hours per 2-year cycle. at least 30 Category 1, 2 hrs substance use disorders."
   CORROBORATED BY: states[CO].pitfalls[5] "30 hours of accepted CME per cycle including
   2 hours of substance use disorder training"

4. "board audits of up to 5 percent of physicians"
   FIELD: states[CO].pitfalls[5]
   TEXT: "with board audits of up to 5% of physicians"

5. "expires April 30 of odd-numbered years ... not your birthday, not your license
   anniversary"
   FIELDS: states[CO].renewalAnchor; states[CO].pitfalls[0]
   TEXT: "All Physician and Pro Bono Physician licenses expire on April 30 of odd-numbered
   years, regardless of when the license was issued (next expiration: April 30, 2027)."
   / "The April 30 odd-year expiration is statewide and fixed, not tied to your issuance
   date or birthday."

6. "If yours was issued mid-cycle, your first renewal period is shorter than two years"
   FIELD: states[CO].pitfalls[0]
   TEXT: "A license issued mid-cycle still expires April 30 of the next odd-numbered year,
   so your first renewal period can be much shorter than 2 years."
   NOTE: the field says "can be much shorter". The post says "is shorter", which is true for
   any mid-cycle issuance. Safe.

7. "renewal link does not appear ... until roughly four to six weeks before expiration"
   FIELD: states[CO].renewalAnchor
   TEXT: "Renewal opens in the DPO Online Services portal approximately 4 to 6 weeks before
   the expiration date (the Applications page says renewals open about 4-5 weeks prior; the
   DPO FAQ says the renewal link appears when the license is within 6 weeks of expiration)."
   NOTE: the post says "state portal" rather than naming DPO Online Services, to keep the
   sentence readable. The guide page names it.

8. "60-day grace period after expiration under CRS 12-20-202(1)(e)"
   FIELD: states[CO].graceOrLapse
   TEXT: "Colorado law (CRS 12-20-202(1)(e), loaded from the official 2024 CRS Title 12
   printout) gives a 60-day grace period after expiration: you may renew without
   disciplinary sanction for practicing on the expired license during those 60 days, but you
   must satisfy all renewal requirements and pay a delinquency fee."

9. "reinstatement wants a certified NPDB self-query, an FSMB disciplinary action report sent
   to DORA, out-of-state license verifications and a practice history"
   FIELD: states[CO].graceOrLapse
   TEXT: "Reinstatement ... requires the reinstatement application and fee, a current
   certified NPDB self-query report, an FSMB Disciplinary Action Report sent to DORA,
   out-of-state license verifications, a chronological practice history for the last year,
   liability insurance attestation..."

10. "Those reports take weeks to arrive"
    FIELD: states[CO].pitfalls[1]
    TEXT: "The NPDB and FSMB reports can take weeks to arrive (CRS 12-20-202; Medical
    Licensing Guide PDF)."

11. Guide URL
    FIELD: derived from states[CO].slug == "colorado"; live page pattern confirmed in
    src/constants/renewalInfo.js as "https://credentialdomd.com/states/{slug}"

BOARD PAGES BEHIND THE RECORD: states[CO].sources[] lists four loaded pages:
dpo.colorado.gov/Medical, /Medical/Applications, /Medical/DRLicenseRequirements, and
dpo.colorado.gov/FAQ.

DELIBERATELY NOT USED, though present in the record:
- states[CO].renewalFee is null and states[CO].pitfalls[4] notes third-party sites quote
  "$300 to $485" with no board-published figure. No fee number appears in the post. Quoting
  an unpublished fee range in a feed post is exactly the kind of number that gets repeated
  without its caveat.
- The Rule 1.8 continued-competency and CPEP re-entry detail (pitfalls[2]) is real but too
  deep for a feed post. It is on the guide page.
- No price, no alert claim, no signup count.
-->
