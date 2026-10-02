# PA and NP rule data

The physician assistant and nurse practitioner rules the app uses. Physician
(MD and DO) rules live in `src/constants/stateRequirements.js` and are not
touched by anything here.

## Files

- `ledger/<ST>.json`, `ledger/national.json`: the research evidence, one fact
  per entry with `field`, `value`, `cite`, `url`, `quote` (25 words or fewer),
  `loaded` and `verified`. Copied from the October 2026 research; quotes longer
  than 25 words were cut to the 25-word stretch that states the value
  (`quoteTrimmed: true`). Never edited by hand after copying.
- `ledger/additions/<ST>.json` (optional): facts verified later, same fields,
  `verifiedBy` naming who loaded the primary source. `data-implementer-2026-10`
  facts re-host a ledger fact over https (same field and quote);
  `review-fix-2026-10` facts are new fields the October review loaded from the
  primary source (quotes 25 words or fewer, `...` marking elisions; a `note`
  says when only a real browser could load the page).
- `states/<ST>.json`: the canonical state file. Every number is
  `{ "value": ..., "fact": "<field>" }` or `{ "value": ..., "facts": [...], "reason": "..." }`;
  `reason` is required when the number is a reading of the fact rather than its
  literal text, and is reviewed by a person. All 51 jurisdictions are curated
  for the PA license and the NP's RN and APRN licenses (October 2026); what the
  evidence does not settle is listed in each section's `unverified` and shows
  as "not yet verified" with the board link.
- `national.json`: the canonical national certification rules (NCCPA, AANPCB,
  ANCC, PNCB, NCC, AACN) and the DEA MATE values.
- `coverage.json` (generated): per state and kind, what is verified and what is not.

## Generating

    node scripts/generate-app-rules.mjs          # validate, then write
    node scripts/generate-app-rules.mjs --check  # exit 1 if a generated file is stale

Outputs: `src/constants/paStateRules.js`, `npStateRules.js`,
`certificationRules.js`, `supabase/functions/send-reminders/appBoardLinks.json`
and `coverage.json`. `tests/profession/app-rules-provenance.test.mjs` runs the
check and the provenance rules on every `npm test`.

## The rules the generator enforces

- A number reaches the app only through a fact that is `verified: true`,
  loaded, has an https URL and a quote, and whose value or quote states the
  number (or the canonical entry gives a `reason`). Anything else becomes an
  unverified item with the board link and no figure.
- A board URL is used only when its host (ignoring `www.`) appears among that
  state's verified fact URLs; otherwise the link is null until an addition
  verifies it.
- `total: 0` only in a `none` mode backed by a fact; `certification`,
  `options` and `unverified` modes carry `total: null`, never 0.
- A canonical state section's `ce.mode` is one of `hours`, `certification`,
  `none`, `options`, `unverified`; `windowRule` is `license` (default) or
  `calendarYears` (needs its own fact and a `reason`).

## Curating a state file

Each section (`pa`, `np.rn`, `np.aprn`) has:

- `license.cycleYears`: how often the license itself renews (the renewal box
  shows it). `license.title` is an optional plain label ("Physician associate
  license").
- `ce.mode`: `hours` (needs `cycleYears` and `total`), `certification` (needs
  `certificationRequired` true), `none` (needs `none: { value: true, fact }`),
  `options` (each option has `text` and a `fact` or `facts`), or `unverified`.
  A mode's `reason` explains a reading of the rule, for the reviewer.
- `ce.windowRule`: `license` (default: the cycle before expiration),
  `calendarYears` (needs `window` with a fact and a reason; `window.preceding:
  true` counts the calendar years before the renewal year, Oklahoma and Wyoming
  PAs), `fixed` (fixed periods from `window.anchor`, a YYYY-MM-DD date whose
  year a fact states; Alabama PA from January 1, 2025, Mississippi PA from
  July 1, 2022), `memberStart` (the period starts on a date only the member's
  record shows, North Carolina and Tennessee: the member sets CME Cycle Start),
  or `unverified` when the counting dates are not settled (Rhode Island PA).
  An `unverified` mode with a curated `cycleYears` still frames the license
  window for verified topics (New York).
- `ce.exemption` (`field`, `question`, `text`, `fact` or `facts`, `topics`:
  `"all"` or a list): a renewal the hours are not due for, answered on the
  license for that renewal (a first renewal, a new licensee). `whenAnswer:
  "No"` reads the question the other way and `perRenewal: false` keeps a
  standing answer (Hawaii APRN: the hours are for APRNs renewing prescriptive
  authority). Unanswered, the hours stand.
- `ce.categoryMin` (`value`, `fact`, `label`, `accepted`, `unverifiedAccepted`),
  `ce.totalAccepted` (`{ value: [...], fact }`), `ce.totalUnverifiedAccepted`,
  `ce.certificationInLieu` (`bodies`, `covers`, `bodiesVerified: false` when the
  fact does not name the certifying bodies, or `bodiesFact` naming the fact
  that does), `ce.satisfiesRn` (on the APRN set), `ce.notes`.
- `certificationRequired` (optional `condition`: Colorado and Hawaii require it
  of prescribers), `practiceHours` (`hours`, `years`, optional `label` for
  states with alternatives, `facts` when the label cites more than one), `nlc`
  (optional `effectiveThrough`).
- `topics`: `topic` (a name from `getCmeTopics`), `hours` (0 means a course
  with no stated hours), `fact` or `facts`, `label`, optional `period`
  (`"lifetime"` for one time, `{ "years": N }`; absent means every renewal),
  `periodReason`, `condition` (`field`, `question`, `description`: a question
  the member answers on the license), `measure: "pharmacology"` or `"total"`
  (every hour of the `acceptedCategories`, tagged or not), `additional`,
  `expiringOnOrAfter`, `expiringBefore`, `alsoTopics` (a second tag that meets
  it), `separate` (a separate course on a tag another topic uses: only the
  hours left after the other topics take theirs count), `period.anchor` (fixed
  due dates, New York's July 1 every three years), `period.fromToday` (counted
  back from today: North Carolina NP before prescribing),
  `unverifiedUnderCertification` (the item shown when certification covers the
  hours), or `status: "unverified"` with an `unverifiedItem` (with `fact` or
  `facts`, any figure in the item must be stated by them).
- `practice.agreement` (`kind`, `text`, `facts`, `conditional` when the facts
  tie the agreement to hours, years, setting or prescribing),
  `prescribing.stateCsRegistration`, `unverified`, and `dated` items for the
  coverage report.

A fact id names the ledger field; `"field#2"` names the second fact recorded
under a field the research reused. Every figure in a label, note, option or
agreement text must appear in its facts, and a one-time or N-year period must
be stated by its fact or carry a `periodReason`; the generator stops with an
error otherwise. Facts whose ledger copy cites plain http were reloaded over
https and recorded in `ledger/additions/` with the same field and quote.

`node scripts/app-rules/draft-from-ledger.mjs ST` prints a draft from the
ledger for a person to curate (every drafted topic is not yet verified).
