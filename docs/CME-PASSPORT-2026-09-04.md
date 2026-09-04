# ACCME CME Passport: what can be connected, and what cannot

Researched 2026-09-04 against ACCME's own documents and the live sites.

## The question

Can CredentialDOMD tie into cmepassport.org so a physician's CME appears here
without them doing anything?

## The answer

Not by an API. There is no interface to call, and building one out of the site
would break ACCME's terms. What can be connected is the two ends the physician
controls, and one of those was missing.

## What was checked

**CME Passport publishes no public API.** The site is a React app. Its own
bundle names three routes that matter: `/activity/search` (public), `/login`,
and `/profile/transcripts`. The transcript route returns a 404 to anyone signed
out, so a transcript is reachable only inside the physician's own session. The
two API paths the bundle calls, `/api/Activities/keywords` and
`/api/Taxonomy/Terms/`, serve the public activity search.

**PARS web services exist, and are not for us.** ACCME publishes
*PARS Provider Web Services Resources* (715_20250610). The endpoints are real:

| Operation | What it does |
|---|---|
| `SaveActivity` / `GetActivity` | the provider's own accredited activities |
| `SaveLearnerActivity` | submit learner credit |
| `GetLearnerMatch` | did this learner match a record |
| `GetLearnerStatusByLearner` / `ByCreditId` | status of credit the provider submitted, keyed by the provider's own `ActivityId` |

Every request carries `ProviderId`, `User` and `Password`, issued by ACCME to an
**accredited CME provider** on request to info@accme.org. CredentialDOMD is not
one. And even with an account, nothing there reads a physician's transcript:
the reads are scoped to activities the calling provider submitted.

**Scraping is out, in writing.** ACCME's terms: "Use of any automated system or
software, whether operated by a third party or otherwise, to extract data from
the Websites (such as screen scraping, crawling, reproducing, duplicating,
copying, selling, trading or reselling) is prohibited." Driving a physician's
own login on their behalf would also mean handling their password, which this
app does not do.

## What actually connects

**Coming back: the transcript file.** Already built. `src/utils/cmeImport.js`
reads a CME Passport transcript PDF directly (source `cmepassport-pdf`), row by
row, and nothing is saved until the physician approves the batch. They can also
email the transcript from CME Passport to `cme@credentialdomd.com`, which files
it in Documents; that reply now points them at Import transcript rather than
File with AI, because a transcript is many activities and File with AI makes one
entry.

**Going out: getting the credit reported in the first place.** This was the gap,
and it is the reason most transcripts are close to empty. A physician's credit
only reaches CME Passport if the accredited provider reports it into PARS, and
ACCME tells providers what they need to do that: the learner's name, state of
licensure, state license number **or** NPI, the **month and day** of their
birth, and their permission to report it.

CredentialDOMD holds all of that except the birth month and day. So:

- `src/utils/cmePassport.js` builds the reporting card from the record on file,
  names any field that is missing, and says how to fill it.
- `settings.birthMonthDay` stores month and day only, as `MM-DD`. The birth
  **year** is not part of what ACCME asks for, so it is not asked for and not
  stored. The Settings field accepts "July 25" or "7/25" and shows how it read
  it back.
- The CME page carries a CME Passport panel: copy the reporting details, open
  CME Passport, import the transcript, search accredited activities.

## If this is ever revisited

The only route to a real integration is becoming, or partnering with, an ACCME
**accredited provider** with PARS web services credentials. That would allow
submitting credit, not reading a physician's transcript, so it would not change
the direction that matters here.

Checked and dated: cmepassport.org bundle `main.a8d99483.js`, ACCME PARS
Provider Web Services Resources 715_20250610, accme.org terms and conditions,
accme.org/learner-credit-data, accme.org/for-physicians/about-cme-passport.
