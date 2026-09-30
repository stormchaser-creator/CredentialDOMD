// The prompt the agreement analyzer (documentScanner.js analyzeAgreement and
// analyzeAgreementText) sends with a locum agreement. Its own module so the
// tests can read it without the browser-only AI client.
//
// Coverage blocks come back with times when the agreement states them
// (coverageBlocks.js): an agreement can read "October 16, 2026 (4pm) to
// October 19, 2026 (7am)", and without the times the end date read as a
// fourth call day.

export const AGREEMENT_PROMPT = `You are analyzing a physician services agreement — a locum tenens
confirmation letter, a staffing-agency assignment, or a 1099 independent-contractor agreement
with a medical group. Extract the business and billing terms. Return ONLY valid JSON (no
markdown, no backticks).

FIRST decide the PAY MODEL, because it determines which rate fields are meaningful. Getting
this wrong corrupts the physician's invoices, so read the rate schedule carefully — it is
often an appendix or exhibit at the END of the document:
- "stipend"  — a flat amount per on-call DAY that INCLUDES a stated number of worked hours,
               with an hourly rate beyond that. Language: "$1,500 per 24-hour call including
               the first 4 hours worked; $200/hr callback thereafter."
- "hourly"   — paid per hour worked, with no daily flat amount.
- "daily"    — a flat amount per DAY WORKED (per diem / per clinical day / per weekday
               worked), often assembled from components that sum to an all-in day rate, and
               separately a flat amount per accepted on-call period. Language: "per-clinical-day
               fee", "$X / weekday worked", "all-in invoiced day rate".

CRITICAL DISTINCTIONS — these are the mistakes that ruin the data:
1. A DAY RATE IS NOT AN HOURLY RATE. "$1,875.40 / weekday worked" is dayRate, never hourlyRate.
   If a figure is per day, per diem, per shift, or per weekday, it is NOT hourly.
2. stipendHours means HOW MANY WORKED HOURS THE STIPEND COVERS BEFORE OVERAGE STARTS. It is
   NEVER the length of the call period. "$800 per 24-hour on-call period" means callStipend
   800 and stipendHours 0 (or omitted) — NOT stipendHours 24. Only fill stipendHours when the
   contract literally says the payment includes the first N hours of work.
3. If a contract pays per accepted call period with NO included hours and NO callback rate,
   leave stipendHours and overageHourlyRate out entirely rather than writing 0 guesses.
4. An ANNUAL target, envelope, or projection (e.g. "$450,000 total annual") is NOT a rate.
   Never put it in a rate field; mention it in notes.
5. Do not invent a rate by dividing an annual figure yourself. Use only rates the document states.

Fields to extract (omit any not present):
- payModel: "stipend" | "hourly" | "daily" — your determination from above
- facility: hospital or practice the physician works AT. If several hospitals are covered,
  list them comma-separated
- location: facility city and state (e.g. "Loveland, CO")
- agency: the staffing agency OR the contracting medical group. If the agreement's counterparty
  is the physician's OWN professional corporation, that is the CONTRACTOR, not the agency —
  put the group/hospital side here instead
- billTo: billing/AP contact email if listed
- startDate, endDate: assignment period (YYYY-MM-DD; earliest start / latest end)
- coveragePeriods: array of {start, end} (YYYY-MM-DD) — one entry for EVERY separate scheduled
  coverage block. A multi-year term with no specific scheduled blocks is ONE entry spanning it.
  When the agreement states the TIME a block starts or ends, add startTime and endTime as 24-hour
  "HH:MM" strings, and keep end as the date written (not the day before). "October 16, 2026
  (4pm) to October 19, 2026 (7am)" is {"start": "2026-10-16", "startTime": "16:00",
  "end": "2026-10-19", "endTime": "07:00"}; "November 12, 2026 (6am) to November 19, 2026 (6am)"
  is {"start": "2026-11-12", "startTime": "06:00", "end": "2026-11-19", "endTime": "06:00"}.
  Omit startTime and endTime when the agreement states no time for that block; never guess one
- dayRate: flat dollars per DAY worked (daily model). If the document breaks the day into
  components and states an all-in total, use the ALL-IN total and itemize the parts in notes
- hourlyRate: flat hourly dollars for regular non-call work (hourly model only)
- callStipend: flat dollars paid per on-call day/period. If rates differ by hospital, put the
  PRIMARY rate for the main/reference hospital here and put the full grid in callRateGrid
- callRateGrid: array of {hospital, primary, backup} when on-call pay varies by site or by
  primary vs backup role — numbers only
- stipendHours: worked hours INCLUDED in the stipend before overage (see rule 2)
- overageHourlyRate: hourly dollars for time BEYOND stipendHours
- callHourlyRate: per-hour call rate if call is paid hourly rather than as a flat period rate
- orientationFee: one-time orientation/onboarding payment. Often in a rate schedule near the END.
  If orientation pays hourly, use orientationHourlyRate instead
- orientationHourlyRate: hourly dollars for orientation/onboarding time
- incrementMinutes: billing increment in minutes if stated (e.g. 15)
- minCallMinutes: minimum billable time per call if stated, in minutes
- notes: 2-4 sentences on the terms that matter — how the day rate is composed, any conditions
  on a component (e.g. teaching documentation), annual targets or volume commitments,
  malpractice allocation, expense reimbursement, unavailability/PTO weeks, cancellation notice

Return JSON: { "extracted": { ...fields }, "confidence": "high"|"medium"|"low" }
Numbers must be plain numbers without $ signs or commas.`;
