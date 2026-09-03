# Public-record import

What a physician would otherwise type by hand already sits in public
registers. The app reads four of them, keyed on the NPI, and turns the answers
into **proposals**. Nothing is written until the physician ticks the row and
presses Save.

The standing rule, which every part of this feature is built around:

> **A claims-derived affiliation is a lead, not a credentialing verification.**
> Medicare knows a physician billed at a hospital. It does not know whether he
> holds privileges there, what kind, or when they are up for reappointment. The
> app never sets a privilege status, never invents an appointment or expiration
> date, and never says a board or a hospital confirmed anything. The same
> applies to a PubMed hit: it is a name match, not proof of authorship.

## The registers

| Register | Dataset / endpoint | What it gives | Refresh |
|---|---|---|---|
| NPPES NPI Registry | `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=<npi>` (via `supabase/functions/_shared/nppes.ts`) | Legal name, credential, every state license number with its taxonomy, practice address and phone | Live. Reflects what the provider or their surrogate last reported to NPPES, so it has no publication lag and no guarantee of currency either |
| Medicare Care Compare, Doctors and Clinicians | `mj5m-pzi6`, property `NPI` | One row per practice location. Read: `cred`, `grd_yr`, `med_sch`, `facility_name` / `org_pac_id`, address (`adr_ln_1`, `adr_ln_2`, `citytown`, `state`, `zip_code`). Present in the row and not read: `pri_spec`, `sec_spec_1..4`, `sec_spec_all`, `num_org_mem`, `telephone_number`, `ind_pac_id`, `ind_enrl_id`, `gndr`, `telehlth` | CMS republishes the provider-data files on a rolling cycle. The metastore item carries the dates: at the time of writing, `modified` 2026-07-31, `released` 2026-08-13. Nothing in the code depends on a cadence |
| Medicare Care Compare, Facility Affiliations | `27ea-46a8`, property `npi` | `facility_type` (e.g. "Hospital") and `facility_affiliations_certification_number`, a CCN. Derived from claims activity | As above: `modified` 2026-07-31, `released` 2026-08-13 |
| Medicare Hospital General Information | `xubh-q36u`, property `facility_id` | Resolves a CCN to a hospital name, city, state and hospital type | `modified` 2026-07-22, `released` 2026-08-13 |
| PubMed | E-utilities `esearch.fcgi` then `esummary.fcgi`, `db=pubmed`, `term=<Last> <Initials>[Author]` | Title, journal, year, author list, PMID, DOI | Live, indexed daily. **Matched on name only** |

Dataset metadata (including the current `modified` date) is readable without a
key at
`https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/<id>`.

A CMS datastore query is one URL shape, built by `cmsQueryUrl` in the function:

```
GET https://data.cms.gov/provider-data/api/1/datastore/query/<dataset>/0
      ?conditions[0][property]=<column>
      &conditions[0][value]=<value>
      &conditions[0][operator]==
      &limit=<n>
```

### Verified live against NPI 1518456078

- `mj5m-pzi6` returns 3 rows: `cred` `DO`, `grd_yr` `2018`, `med_sch` `OTHER`,
  `pri_spec` `NEUROSURGERY`, facilities `EISENHOWER MEDICAL CENTER` (twice) and
  `CAL MED PHYSICIANS AND SURGEONS INC`.
- `27ea-46a8` returns 3 rows, all `facility_type` `Hospital`, CCNs `050573`,
  `050245`, `050292`.
- `xubh-q36u` names those three: Eisenhower Medical Center (Rancho Mirage CA),
  Arrowhead Regional Medical Center (Colton CA), Riverside University Health
  System-Medical Center (Moreno Valley CA).
- PubMed, measured 2026-09-03. The term the code builds is `"Whitney E"[Author]`
  (surname plus first initial). It returns **118 matches**; the 25 most recent
  are shown. Of those 25, roughly 8 are his (three StatPearls chapters, five
  Cureus reviews on deep brain stimulation, arachnoid cysts, cerebral aneurysms
  and two others) and roughly 17 belong to at least four other people: a
  seismologist in Nature Communications, an HPV epidemiologist in MMWR and
  Cancer Epidemiology, a dental educator, and an adolescent addiction group.
  That is the fuzzy-match problem measured rather than asserted, and it is why
  every publication starts unticked and shows its venue, year and co-authors.
- Do not "improve" the term to `"Whitney EE"[Author]`. That returns **0**. The
  first initial alone is the only form that finds his papers at all, and
  carrying the false positives is the price of not silently finding nothing.

### `med_sch` is not a medical school

Medicare files most schools as the literal string `OTHER`. The normalizer
treats it as blank, and the education proposal carries the degree type and the
graduation year with **no institution**. An absent value stays absent; the form
is never filled to look complete.

## Why an edge function

`data.cms.gov` sends no `access-control-allow-origin`, and PubMed rejects the
preflight, so the browser cannot call either. Both go through
`supabase/functions/public-record`, following the existing `npi-proxy` pattern.

The function is authenticated (any signed-in user), **writes nothing**, and
fans out to the four registers concurrently with a per-call timeout and its own
try/catch. One dead register becomes an entry in `errors` and a source marked
`error`; the request still returns 200 with whatever the others gave, and the
screen offers to ask the dead one again on its own.

The function is never given the physician's records and must not be. Matching a
proposal against what is already on file happens in the browser, in
`src/utils/publicRecord.js`, next to the only data that can answer it.

Deploy:

```
SUPABASE_ACCESS_TOKEN=$(security find-generic-password -l "Supabase CLI" -w) \
  npx --yes supabase@latest functions deploy public-record \
  --project-ref hkpnnsjcwprrwobmpqyy --no-verify-jwt --use-api
```

## Where the physician meets it

- **Settings > NPI > "Pull from public records"**, once an NPI is on file. Opens
  the whole review in a modal.
- **Setup**, on the rows these registers can fill: Medical school and
  postgraduate training, Your current position, and Hospital privileges. The
  drawer swaps to the review pointed at that section, the way it already swaps
  to the capture run. Everything else the same search found sits behind one
  button rather than being dropped.
- Publications has no Setup row of its own, so it is reached from Settings.

## The rules the review screen keeps

1. **Nothing is saved without a tick.** There is no import-all button. Saving
   goes through the same `updateSettings` and `addItem` a hand-typed record
   uses, so an accepted row syncs identically.
2. **Every row names its register** and links to it where a link exists.
3. **A lead never starts ticked**, and carries the sentence that says why it is
   a lead. Facility affiliations and publications are always leads.
4. **A record already on file is greyed and labelled**, not proposed a second
   time. Matching is by `dedupeKey`: state plus license number, facility,
   employer, PMID or DOI, organization, institution or degree type.
5. **A profile row that would overwrite an answer already given starts
   unticked**, carries a "replaces what you have" chip, and names the values it
   would take away. `primaryState` in particular drives the renewal reminders
   and the CME state.
6. **A row whose section this plan cannot open is shown, named and unpickable.**
   Privileges is Pro-gated in `App.jsx`; accepting a hospital on a free plan
   would file a record into a page the physician cannot reach.
   `buildSavePlan` drops it even if its id is in the selection.
7. **No field is invented to fill a form.**

## Pieces

| Piece | Where |
|---|---|
| Edge function (fan-out, auth, errors) | `supabase/functions/public-record/index.ts` |
| Normalizing registers to findings | `supabase/functions/public-record/normalize.ts` |
| The one client call | `src/utils/publicRecordApi.js` |
| Matching, grouping, selection rules, save plan | `src/utils/publicRecord.js` |
| The review screen | `src/components/features/PublicRecordReview.jsx` |
| Settings entry | `src/components/pages/SettingsSection.jsx` (NPI field) |
| Setup entry | `src/components/features/SetupPage.jsx` (`PacketDrawer`) |
| Tests | `scripts/public-record.test.mjs`, `scripts/public-record-review.test.mjs` |
| Live register captures the tests run on | `scripts/fixtures/public-record/` |

## Not in scope

**CMS Open Payments** (`openpaymentsdata.cms.gov`) is deliberately not read. It
is about money from industry, it is sensitive, and no one asked for it in a
credentialing record.
