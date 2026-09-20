# Public founding-launch copy and mode

Updated September 20, 2026 from `7f0c8147` for the owner-approved first-100 paid founding policy. The checked-in public mode is enabled with `/app/` as its destination; actual checkout availability remains server-owned. This source update is not a deployment receipt. It does not activate the new backend capacity policy, grant membership, start a trial or send email. The original default-off preparation was based on `1d84654b5a4aef2bd5280336943a7a2b7a7ceb32`.

## Implemented contract

`src/content/publicLaunch.mjs` holds the paid copy and `PUBLIC_LAUNCH_MODE`: **enabled: true; signupHref: /app/**. Enabled mode without an explicitly configured same-site signup destination fails validation. Query strings and nonempty fragments are rejected, so an individual invitation bearer token cannot become a public CTA. `/signup/` in automated tests is synthetic; this work does not create that route or assert it is deployed.

`scripts/package-site.mjs` invokes `scripts/public-launch-render.mjs` for home, locums, help, CME, state index, every state guide, watch pages and legal navigation. Only explicit `public-launch:*` marketing slots are replaced. Pages are rendered and checked before the previous package is removed. Missing slot coverage, an unrecognized slot, remaining waitlist CTAs or consent controls, missing whole state pages, stale generated legal/help/CME content, or an invalid destination fail the build. Paid packaging requires the index plus all 51 state guides.

Paid mode is static HTML, so signup links are useful without JavaScript and there is no temporary flash of waitlist copy. Home and locums waitlist forms are replaced entirely with navigation links; they do not submit email addresses to the waitlist RPC. Existing in-page anchors and sign-in/Open the app links remain available.

All **204 requested-guide forms** remain guide forms. Paid mode removes their optional waitlist choices, explains the single-guide purpose, and adds a separate signup link. The actual guide controller forces `p_waitlist: false` when the document is marked `data-public-launch="founding-signup"`, even if a stale selected radio is present. The existing guide delivery flow and anti-spam fields remain. This does not add authorization to send marketing emails.

Off mode keeps the reviewed invitation controller, its timeouts/duplicate guards, and existing waitlist consent behavior. The source fallback now also removes the remaining unqualified “No card required” Security claim, “Free during beta” state app CTA and “Free invite-only beta” CME footer. Those slots explain planned paid access or membership by invitation. Free requested guides still say they are free. Existing legal documents remain unchanged in off mode.

## Customer copy

New copy uses **CredentialDOMD**, with plan names **Credential** and **Practice**. The existing legal operating entity is unchanged.

- Static paid link: **Review membership offers**; compact navigation: **Membership signup**. The destination checks the available offer; the link is not a price or capacity reservation.
- Availability: the first **100 paid founding Credential members** receive the $99 annual offer. The app confirms availability before payment. Creating an account or viewing a quote does not reserve a place; new public paid membership requires a card and explicit consent.
- Early release: “CredentialDOMD is an early release. Some workflows are less polished, and the app will continue to evolve.”
- Participation: “Founding members help shape what comes next. In the app, ask VERA for help and use support tickets to report problems or suggest improvements.” This refers to in-app Vera; the public CME website search remains a website resource search.
- Founding rate: **$99/year**, locked for life while membership remains continuously active. This replaces the previously planned $149 founding price; no previous selling price is claimed. Protected historical $99 offers remain honored within the total 100-place allocation. Reservations are not reported as paid members.
- After 100 paid founding memberships: early-bird Credential is $149/year, also locked while continuously active, followed by standard Credential at $199/year. These are offer phases, not claims about a previously charged standard price.
- Credential + Practice: $245/year total, with **no founding or early-bird discount** on the full package.

The owner approved the 100-paid-member cap on September 20, 2026. The copy does not invent a remaining-place count, offer deadline, unconditional rate after inactive membership, guaranteed implementation of suggestions, or reduced standards for medical/source accuracy. The existing physician-first dark layout, people imagery, resource facts and source dates remain.

## Public offer status

`public/membership-offer.js` progressively updates the main price, headline, signup heading, phase badge, CTA text and status from the public `public-membership-offer` GET endpoint. The packager derives its exact URL from the public `VITE_SUPABASE_URL` build setting and refuses an enabled build without it; no API key, account identity, credentials, request body or local storage is used. Without JavaScript or after a failed check, the page keeps **Check availability in app**, a generic membership link and no claimed current price. Static visible policy, metadata and FAQ structured data explain the $99 first-100 → $149 early-bird → $199 standard progression without claiming that $99 is currently available.

Only schema version 1, the three exact annual phase/amount pairs, and consistent available/temporarily-full/paused states are accepted. Requests use `no-store`, no credentials/referrer/redirect, a six-second fetch-and-body deadline and a 2KB body limit. Visible pages recheck every minute and when returning to the page; older responses cannot overwrite newer status. No remaining count is requested or displayed. The CME page's otherwise closed connection policy permits only this exact endpoint in the packaged paid page; its source facts and search/filter code stay unchanged.

Release requires the matching backend capacity migration and endpoint plus a coordinated activation review. A public status response is informational; authenticated quote and checkout checks still decide eligibility and capacity. The app discards a quote and its consent on `founding_capacity_pending` or `quote_expired`. It never retries or substitutes $149 automatically. Existing lifetime/paid accounts are not asked to repurchase. The Admin legacy-badge count is explicitly separate from paid founding capacity.

### Distinct earlier promises

1. People who signed up under earlier free-beta wording receive **30 days free without a card**. The clock starts at first verified account activation. They can opt into $99/year Credential during those 30 days, with the first charge and paid year at the original beta end. No opt-in means no automatic charge. Protected founding offers remain within the 100-place allocation.
2. Existing eligible registered accounts retain **Credential and Practice free for life**. Waitlist entries alone are not lifetime accounts. This source change does not identify individual eligibility, change grants or introduce setup-related revocation.
3. New paid Credential includes a **separate 30-day Practice trial**, ending without an added charge unless continued Practice is explicitly purchased. Paid Credential continues. Practice records remain readable/exportable under the existing legal policy.

## Surface inventory — implemented

| Surface | Authored source and output | Behavior |
| --- | --- | --- |
| Home | `landing/index.html` | Nav, hero/final/sticky/pricing links; both waitlist forms; offer/availability/exception copy; description metadata. Existing photos/layout retained. |
| Locums | `landing/locums.html` | Nav and both forms; offer section and final action; visible cost FAQ and JSON-LD use one answer. |
| Help | `scripts/build-help.mjs` → `landing/help.html` | Founder notice, signup action and footer. Paid packaging updates first-license access/offer notes, locum-contract membership availability, and Get help refund guidance. All guide steps, source dates and media remain unchanged. Both packaged help JSON paths receive identical text. |
| CME | `scripts/build-cme.mjs` → `landing/cme.html` | Next-step marketing slots/footer only. Search, filters, facts, source register and all review dates remain unchanged. |
| State guides | `landing/state-template.html` → `landing/states/*.html` using `landing/states/generate.js` | Four existing signup CTAs per page, marketing explanation and all four guide consent widgets; all 51 pages regenerated without changing state data. |
| State index | `landing/states/index.html` | Explicit migration because the state generator does not write the index. Search and 51 state destinations retained. |
| Guide widgets | State template and 51 outputs | 204 requested-guide forms preserved; 204 optional waitlist groups removed only in paid output; paid controller forces guide-only. |
| Watch pages | `scripts/watch-pages.mjs`, generated during packaging | Marketing notice/action only, with the compiled help availability. Reviewed videos, captions, transcripts, dates and media bytes retained. |
| Legal navigation and documents | `src/content/legalText.js`, `scripts/generate-legal-pages.mjs`, landing/public terms/privacy, `landing/security.html` | Mode-aware legal document source plus navigation/availability slots. All root, directory and app-relative legal copies match. |

No guide facts, `states-data.json`, authored CME knowledge, provider SDKs, SQL, billing catalogs, grants, or email functions are edited by this work.

## Legal source alignment

`getLegalDocuments(PUBLIC_LAUNCH_MODE)` supplies both the exported `TERMS`/`PRIVACY` used by the app and the importable `renderLegalPages()` generator. Off-mode documents retain their historical text. Paid mode makes only the owner-reviewed changes:

- Terms section 1: early-release paid membership, card/price/renewal disclosure, active-member 99/149 rates, 199 standard, 245 full package, preserved registered-account lifetime promise, earlier 30-day no-card promise and explicit opt-in, paid Credential's separate Practice trial and readable/exportable records.
- Support: “During beta” → “During early release”.
- Liability: removes only “, which during the free beta is zero”; the existing limitation and twelve-month-payment cap remain.
- Privacy introduction: “free beta” → “early release”.

No operating entity, data handling, legal limitation, dispute term, account deletion rule or lifetime exception is otherwise changed. Dates are retained; activation requires owner review of the actual release/legal effective date before publishing. A private packaging parameter can render offline paid fixtures; production must build the app and public site from the same checked-in central mode so app documents and website documents agree.

## Remaining integration gates and manual surfaces

1. **Actual reviewed signup/checkout destination.** The shared policy uses `/app/`. Verify the combined release's new-user, returning-beta and existing-member flows. Do not relabel `/api/waitlist` or a guide request as signup.
2. **Billing and identity readiness.** Root owns Stripe prices/subscription renewals, checkout/webhook verification, Clerk account continuity, trusted founding/lifetime/promised-beta eligibility, trial clock and access enforcement. This public flag enables none of them.
3. **App plan displays.** Root owns `membershipCopy`, PricingModal, Settings/FAQ, cancellation/renewal and payment-result screens. Current app entry and FAQ copy use the canonical offer text. Quotes and eligibility remain server-owned. A temporary capacity hold clears consent and never silently substitutes the $149 offer; a new offer requires a new review. A marketing flag cannot safely infer paid/lifetime status from editable profile fields.
4. **Email approval.** New launch/email content remains subject to the owner's review before sending. The welcome/invitation send holds and Admin behavior remain unchanged; see [Launch email owner review hold](LAUNCH-EMAIL-OWNER-REVIEW-HOLD.md). This public-copy change sends no email and does not authorize replaying earlier reminders. Guide-request delivery remains separate; its footer is a manual email-copy review surface outside this change.
5. **Release review.** Root reviews desktop/phone/keyboarding in both modes, navigation/checkout destination, effective legal date, final combined revision and explicit launch authorization. There is no environment variable, remote dashboard switch, deployment or provider mutation here.

Historical marketing decks, private archived email snapshots and source-provenance records are not live CTAs and are not rewritten. Legal operator names are preserved. Existing app branding/plan display changes are a separate source review, not a global string replacement.

## Validation

Run:

```sh
node --test tests/public-membership-offer.test.mjs tests/public-launch-mode.test.mjs tests/public-launch-render.test.mjs tests/public-launch-copy.test.mjs tests/site-packaging.test.mjs tests/limited-launch/deferred-purchase.test.mjs tests/limited-launch/client-transport.test.mjs tests/limited-launch/read-only-render.test.mjs scripts/help-content.test.mjs scripts/cme-content.test.mjs
# Use the reviewed public VITE_SUPABASE_URL and the release's existing auth/access flags.
npm run build:site
```

The focused suite checks both modes, all 51 guides/204 widgets, actual guide submission behavior with a stale yes selection, matching visible/JSON-LD prices, preserved facts/assets/scripts, deep equality of untouched legal/help fields, complete paid packaging and preservation of an older package on invalid input. All network operations in these tests are synthetic. A passing paid fixture does not prove a deployed signup route, real payment, actual email delivery or a live trial/grant.

Current first-100 source check: **114 tests passed** in the command above, plus changed JavaScript ESLint, generated help/CME checks and `git diff --check`. Browser/keyboard review and combined backend activation remain owned by root. Historical default-off preparation passed 110 public/email checks plus 11 dormant invitation scenarios; those counts are not evidence of this new capacity policy being deployed.
