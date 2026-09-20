# Public founding-launch copy and mode

Prepared from `1d84654b5a4aef2bd5280336943a7a2b7a7ceb32`. **Sales remain off. Nothing is published.** All public marketing surfaces are wired to a single packaging-time mode. This change does not enable checkout, grant membership, remove an invitation gate, start a trial or send email.

## Implemented contract

`src/content/publicLaunch.mjs` holds the proposed paid copy and `PUBLIC_LAUNCH_MODE`: **enabled: false; signupHref: null**. Turning on the flag without an explicitly configured same-site signup destination fails validation. Query strings and nonempty fragments are rejected, so an individual invitation bearer token cannot become a public CTA. `/signup/` in automated tests is synthetic; this work does not create that route or assert it is deployed.

`scripts/package-site.mjs` invokes `scripts/public-launch-render.mjs` for home, locums, help, CME, state index, every state guide, watch pages and legal navigation. Only explicit `public-launch:*` marketing slots are replaced. Pages are rendered and checked before the previous package is removed. Missing slot coverage, an unrecognized slot, remaining waitlist CTAs or consent controls, missing whole state pages, stale generated legal/help/CME content, or an invalid destination fail the build. Paid packaging requires the index plus all 51 state guides.

Paid mode is static HTML, so signup links are useful without JavaScript and there is no temporary flash of waitlist copy. Home and locums waitlist forms are replaced entirely with navigation links; they do not submit email addresses to the waitlist RPC. Existing in-page anchors and sign-in/Open the app links remain available.

All **204 requested-guide forms** remain guide forms. Paid mode removes their optional waitlist choices, explains the single-guide purpose, and adds a separate signup link. The actual guide controller forces `p_waitlist: false` when the document is marked `data-public-launch="founding-signup"`, even if a stale selected radio is present. The existing guide delivery flow and anti-spam fields remain. This does not add authorization to send marketing emails.

Off mode keeps the reviewed invitation controller, its timeouts/duplicate guards, and existing waitlist consent behavior. The source fallback now also removes the remaining unqualified “No card required” Security claim, “Free during beta” state app CTA and “Free invite-only beta” CME footer. Those slots explain planned paid access or membership by invitation. Free requested guides still say they are free. Existing legal documents remain unchanged in off mode.

## Customer copy

New copy uses **credentialdomd**, with plan names **Credential** and **Practice**. The existing legal operating entity is unchanged.

- Main paid link: **Sign up as a founding member**; compact navigation: **Founding signup**.
- Availability: “Founding signup is open. Paid membership requires a card at checkout. Review your offer before choosing to pay.”
- Early release: “credentialdomd is an early release. Some workflows are less polished, and the app will continue to evolve.”
- Participation: “Founding members help shape what comes next. Use Vera to get help with the app and share feedback, and use in-app support tickets to report problems or request improvements. Review a ticket before sending it.” This refers to in-app Vera; the public CME website search remains a website resource search.
- Founding rate: “Eligible founding members get Credential for $99/year, a discounted annual rate locked for life while their membership remains active.”
- Early-bird Credential: $149/year, also locked while active. Standard Credential: $199/year. These are offer phases, not claims about a previously charged standard price.
- Credential + Practice: $245/year total, with **no founding or early-bird discount** on the full package.

The copy does not invent a founder cap, offer expiry date, unconditional rate after inactive membership, guaranteed implementation of suggestions, or reduced standards for medical/source accuracy. The existing physician-first dark layout, people imagery, resource facts and source dates remain.

### Distinct earlier promises

1. People who signed up under earlier free-beta wording receive **30 days free without a card**. Their invitation confirms eligibility and when the clock starts. Continuing requires an explicit $99/year Credential purchase; no automatic charge.
2. Existing eligible registered accounts retain **Credential and Practice free for life**. Waitlist entries alone are not lifetime accounts. This source change does not identify individual eligibility, change grants or introduce setup-related revocation.
3. New paid Credential includes a **separate 30-day Practice trial**, ending without an added charge unless continued Practice is explicitly purchased. Paid Credential continues. Practice records remain readable/exportable under the existing legal policy.

## Surface inventory — implemented

| Surface | Authored source and output | Behavior |
| --- | --- | --- |
| Home | `landing/index.html` | Nav, hero/final/sticky/pricing links; both waitlist forms; offer/availability/exception copy; description metadata. Existing photos/layout retained. |
| Locums | `landing/locums.html` | Nav and both forms; offer section and final action; visible cost FAQ and JSON-LD use one answer. |
| Help | `scripts/build-help.mjs` → `landing/help.html` | Founder notice, signup action and footer. In paid packaging `publicLaunchHelp()` changes only the `locum-contract` availability field; all 14 authored guides otherwise remain identical. Packaged help JSON receives the same availability text. |
| CME | `scripts/build-cme.mjs` → `landing/cme.html` | Next-step marketing slots/footer only. Search, filters, facts, source register and all review dates remain unchanged. |
| State guides | `landing/state-template.html` → `landing/states/*.html` using `landing/states/generate.js` | Four existing signup CTAs per page, marketing explanation and all four guide consent widgets; all 51 pages regenerated without changing state data. |
| State index | `landing/states/index.html` | Explicit migration because the state generator does not write the index. Search and 51 state destinations retained. |
| Guide widgets | State template and 51 outputs | 204 requested-guide forms preserved; 204 optional waitlist groups removed only in paid output; paid controller forces guide-only. |
| Watch pages | `scripts/watch-pages.mjs`, generated during packaging | Marketing notice/action only, with the compiled help availability. Reviewed videos, captions, transcripts, dates and media bytes retained. |
| Legal navigation and documents | `src/content/legalText.js`, `scripts/generate-legal-pages.mjs`, landing/public terms/privacy, `landing/security.html` | Mode-aware legal document source plus navigation/availability slots. All root, directory and app-relative legal copies match. |

No guide facts, `states-data.json`, authored CME knowledge, provider SDKs, SQL, billing catalogs, grants, or email functions are edited by this work.

## Legal source alignment

`getLegalDocuments(PUBLIC_LAUNCH_MODE)` supplies both the exported `TERMS`/`PRIVACY` used by the app and the importable `renderLegalPages()` generator. Default documents retain their exact existing text. Paid mode makes only the owner-reviewed changes:

- Terms section 1: early-release paid membership, card/price/renewal disclosure, active-member 99/149 rates, 199 standard, 245 full package, preserved registered-account lifetime promise, earlier 30-day no-card promise and explicit opt-in, paid Credential's separate Practice trial and readable/exportable records.
- Support: “During beta” → “During early release”.
- Liability: removes only “, which during the free beta is zero”; the existing limitation and twelve-month-payment cap remain.
- Privacy introduction: “free beta” → “early release”.

No operating entity, data handling, legal limitation, dispute term, account deletion rule or lifetime exception is otherwise changed. Dates are retained; activation requires owner review of the actual release/legal effective date before publishing. A private packaging parameter can render offline paid fixtures; production must build the app and public site from the same checked-in central mode so app documents and website documents agree.

## Remaining integration gates and manual surfaces

1. **Actual reviewed signup/checkout destination.** No production route is configured. Verify real new-user, existing-user and invitation flows, then set the URL in the shared policy. Do not relabel `/api/waitlist` or a guide request as signup.
2. **Billing and identity readiness.** Root owns Stripe prices/subscription renewals, checkout/webhook verification, Clerk account continuity, trusted founding/lifetime/promised-beta eligibility, trial clock and access enforcement. This public flag enables none of them.
3. **App plan displays.** Root owns `membershipCopy`, PricingModal, Settings/FAQ, cancellation/renewal and payment-result screens. Their billing/entitlement flags currently remain off; align them with the commercial launch before enabling this mode. A marketing flag cannot safely infer paid/lifetime status from editable profile fields.
4. **Email approval.** Welcome/invitation send holds remain independent. New or changed campaign/template content requires the owner's review before sending. Recipient selection follows the owner's approved eligibility and exclusions; this does not create a new approval requirement for each eligible recipient list. The selected second setup reminder currently requires exact-rendered approval because an actual automatic approval review rejected the send. Dan remains excluded. Guide-request delivery remains its existing explicit user action. These email workflows are outside this public-copy change.
5. **Release review.** Root reviews desktop/phone/keyboarding in both modes, navigation/checkout destination, effective legal date, final combined revision and explicit launch authorization. There is no environment variable, remote dashboard switch, deployment or provider mutation here.

Historical marketing decks, private archived email snapshots and source-provenance records are not live CTAs and are not rewritten. Legal operator names are preserved. Existing app branding/plan display changes are a separate source review, not a global string replacement.

## Validation

Run:

```sh
node --test tests/public-launch-mode.test.mjs tests/public-launch-render.test.mjs tests/public-launch-copy.test.mjs tests/waitlist-signup.test.mjs tests/site-packaging.test.mjs scripts/help-content.test.mjs scripts/cme-content.test.mjs scripts/watch-pages.test.mjs scripts/help-videos.test.mjs
npm run build:site
```

The focused suite checks both modes, all 51 guides/204 widgets, actual guide submission behavior with a stale yes selection, matching visible/JSON-LD prices, preserved facts/assets/scripts, deep equality of untouched legal/help fields, complete paid packaging and preservation of an older package on invalid input. All network operations in these tests are synthetic. A passing paid fixture does not prove a deployed signup route, real payment, actual email delivery or a live trial/grant.

Latest local result: **95 tests passed**, the default-off site build passed, changed core modules passed explicit ESLint checks, and `git diff --check` passed. The build retains existing SDK browser-externalization and bundle-size warnings. Browser/keyboard review is still owned by root.
