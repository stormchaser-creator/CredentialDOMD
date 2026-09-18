# CredentialDoMD customer experience and content system

Prepared September 18, 2026 from source revision `dd942168`. This is a source audit and an implementation design, not a report of live delivery or a new all-state legal review. The changes below are local and reviewable. No mail, social post, paid model call, customer-data change or deployment was performed for this work.

## 1. What is ready now

The smallest useful deliverable is a written help center customers and support can use today:

- Twelve task-based guides in `public/knowledge/credentialdo-help.json`, with audience, source references, review scope and dates. These cover first setup, licenses, CME certificates and transcripts, reviewing calculations, agreements, work, invoices, payments, reminders, tickets and backups.
- A static, mobile-accessible `landing/help.html`, generated from that same content by `scripts/build-help.mjs`. All guides remain available without JavaScript. Search and category filters run locally. There are no invented videos, app deep links or external tracking calls.
- A corrected in-app FAQ. It uses the current navigation: **Add** on a phone, **Documents** on a desktop, **Smart Scan**, **Credentials > CME Credits**, and **Practice** for locum tools. It distinguishes saved records from verification, manual sharing from delivery, email expiration digests from in-app CME alerts, and automated SMS from manual text composition.
- The otherwise gated Practice card now draws the total planned annual Core + Locum price from the billing catalog and links to the real locums page. The old `$10/mo` upsell and ineffective `#pricing` action are removed. Access logic is unchanged: `useSubscription` gives invited beta users the locum tier. Billing remains off.
- Ohio's public and emailed guide now carries the same pain-clinic applicability qualification as the app pilot. Only Ohio's generated state page was rebuilt. No other jurisdiction's rules were reverified.

Build/update: `node scripts/build-help.mjs`. Verify no drift: `node scripts/build-help.mjs --check`. Product support may retrieve the JSON from `/app/knowledge/credentialdo-help.json` after a release. The root site packager must include `/help`; that routing work belongs to the parent implementation.

The twelve video scripts below are ready for recording against synthetic fixtures. **No video has been recorded or published by this change.** Keep written guides as the accessible source for every future video.

## 2. What the audit actually found

| Area | Evidence in this revision | Product consequence |
| --- | --- | --- |
| Guided setup | `SetupPage.jsx`, `setupTasks.js`, `setup/useSetupState.js`: resumable tasks; identity, licenses, dates, DEA, reminders and supporting evidence; every row can be skipped or marked not applicable | Reuse this flow. Avoid a second onboarding wizard or an invented universal “two-minute setup” claim. |
| Smart Scan | `DocumentsSection.jsx`, `ScanReviewCard.jsx`: upload may save a document before extraction succeeds; review and filing are separate | Teach users to check for an existing document after a failed scan. Prevent duplicate retry loops. |
| CME import | `CMEImport.jsx`, `cmeImport.js`: file/paste intake, known/generic layouts, column mapping, review, duplicates unticked, explicit batch save | Make review the key moment, not a claim of automatic course validation. |
| Locum workflow | `locum/Contracts.jsx`, `WorkLog.jsx`, `Invoices.jsx`: agreement drives billing; selecting Copy also records an invoice; payments are manually entered | Explain “billed,” “delivered” and “paid” separately. Teach a partial payment before promoting financial outcomes. |
| In-app help | `FAQSection.jsx` was searchable but had obsolete Scan/Send tab names, SMS promises, broad CME certainty and multiple-per-day email escalation | Corrected here; durable source references and release checks should prevent recurrence. |
| Actual reminder implementation | `send-reminders/index.ts` and `20260816_reminders.sql`: daily expiration-record digest, cadence/fingerprint logic; no CME calculation in this worker. `SettingsSection.jsx` explicitly says texts are not sending | Email reminders exist in source. Their live scheduler and delivery must be monitored separately; do not repeat the older marketing claim that all server reminders are unbuilt. |
| Onboarding email | `send-onboarding-email/index.ts` is explicitly marked **NOT DEPLOYED**, records a missing `onboarding_queue`, and only sets `ready` | The four-email draft sequence is not an operating customer journey. Do not revive that historical function as-is. |
| Support | `SupportModal.jsx` has filing, Your tickets, replies, screenshots and user resolution. Existing worker is approval-gated; isolated replacement is prepared, not activated (`ticket-agent-isolation.md`) | Submission is not a response or resolution. Customer-visible status must reflect actual processing, and model answers must link to reviewed product help. |
| Support identity | `SupportModal.jsx` says Eric answers personally, despite AI tooling in the service design | Support-file owner should reconcile this; new help says support may use AI assistance. Never make a bot impersonate a personal physician reply. |
| Marketing library | `onboarding-sequence.md`, older social/video scripts and concepts contain stale prices, impossible referral paths, security overclaims and invented testimonials. `2026-08-refresh/stale-assets.md` records many defects but its `$199` pricing guidance is now itself superseded | Treat these as an idea archive, excluded from retrieval and publishing. Current catalog is Core $149/year, Core + Locum $245/year; free invite-only beta, no charge or deadline. |
| Video assets | No `.mp4`, `.webm`, `.vtt` or `.srt` deliverables found in `public/` or `landing/`; old TikTok scripts are marketing drafts | Written help is the honest deliverable now. A video link is only added after a real asset passes QA. |
| CME source coverage | Code inventory: 55 jurisdiction entries, 68 MD/DO/combined rule sets; 67 carry a prior verified stamp, VI does not. AZ MD/DO, NH and NJ still use Cornell rule-set mirrors | These counts describe existing metadata, not verification performed in this audit. Preserve unresolved source issues in a review queue. |
| “Provider verification” | `cmeVerification.js` runs a 30-day `HEAD` request in `no-cors` mode and marks a resolved fetch “ok” | Opaque fetch success cannot establish HTTP status, accreditation, course eligibility or current law. Label this only as limited reachability; it is not the rule-monitoring system. |
| Rule drift | `stateRequirements.js` powers the app; `landing/states/states-data.json` separately powers public guides and `send-guide/stateGuides.json`. Ohio public/email text still had an unconditional 20-hour pain claim | Fixed narrowly here. A future change must update all render targets or fail the release check. |
| Restore semantics | `DataExport.jsx` overlays imported collections onto current data; collection arrays supplied by the file replace existing arrays | New help says to export current data before restoring, rather than implying every existing record is preserved by a merge. |

The August changelog already lists unresolved ambiguity, wrong-board history and unverified topics. It is useful review evidence, not authority to automatically restamp every row “verified.” Read `docs/CME-RULES-CHANGELOG-2026-08.md` and `scripts/compliance.test.mjs` before extending rule coverage.

## 3. Top customer journeys and success signals

| Priority | Journey | Successful outcome | Failure the service should detect |
| --- | --- | --- | --- |
| P0 | Invitation → sign-in → About you → first license and date → attached proof | Physician can find a correctly dated record and its document | Sign-in loop, imported wrong person, no expiration date, saved file not filed into a record |
| P0 | CME certificate/transcript → review → save → inspect cycle and source | Intended entries appear once; physician understands included/excluded hours | Unsupported input, assumed category, duplicates, dates outside cycle, unknown condition mislabeled as a deficit |
| P0 | Agreement → time entry → invoice preview → share → record payment | Work bills against reviewed terms; invoice and remaining balance match records | Wrong agreement/rate/increment, Copy treated as delivered, partial payment treated as fully paid |
| P0 | Get help → filed ticket → acknowledgment → useful answer/update → user resolution | Customer always has a visible thread and a truthful next step | Unclaimed ticket, no reply, failed email with no visible thread message, false “fixed” or auto-closed unresolved issue |
| P1 | Reminder settings → due record → digest/alert → updated date | User knows which alert was sent and why | Scheduler silent, mail rejected, missing email, stale record fingerprint, SMS expectation |
| P1 | Export → new-device sign-in → restore private notes → verify | User preserves records and understands local-only notes | Local notes lost at sign-out, export mistaken for a fully downloaded file archive |

Measure steps using small event names and state transitions, not uploaded text or filenames. Proposed events: `help_opened`, `help_search_no_result`, `guide_opened`, `setup_step_complete`, `scan_review_saved`, `import_batch_saved`, `invoice_recorded`, `payment_recorded`, `ticket_acknowledged`, `ticket_reply_visible`, `ticket_resolved_by_user`. Record content version and feature version with events. Avoid patient details, document contents, payment references, email addresses and search-query text in analytics.

## 4. Twelve recording-ready tutorials

All durations are **planned**, at most 90 seconds. Every tutorial has the corresponding guide ID in the JSON. Use an isolated test profile named “Dr. Demo” with a visible **DEMO DATA** label, fictitious non-valid license numbers, `example.com` addresses, a synthetic PDF certificate, and an invented Sample Clinic agreement. Do not record the owner's or any customer's account. Seed or stub AI results and network actions during recording; do not incur provider spend or send real mail. Captions and transcript must match the final recording.

### 1. First license — `first-license` — P0, 60 seconds

**Shots:** 0–8s show More > Setup; 8–22s open About you and check name/degree/state; 22–40s open Your licenses and use a synthetic license; 40–52s show Expiration dates; 52–60s show the saved record in Credentials > Licenses.

**Narration:** “Start in Setup under More. Check your name, degree and primary state. Add a license, then use the expiration date on your current document. If you use an NPI match, review it before importing. Your saved record and its supporting document are separate steps. You can return to Setup later.”

**Recording check:** Do not show a real NPI result or imply the license is validated by the board. Finish with the correct date visibly saved.

### 2. Scan a license — `scan-license` — P0, 75 seconds

**Shots:** 0–10s show phone Add and desktop Documents side by side; 10–22s Smart Scan > Upload; 22–48s review fixture with one deliberately wrong expiration date and correct it; 48–60s Save to License; 60–75s show record/document and point to File with AI recovery.

**Narration:** “Add on your phone and Documents on your desktop open Smart Scan. Upload the license and wait for its review card. Check the type, number, state and dates against the original; fix anything that is wrong before saving. If analysis fails, check Documents first. The file may already be saved, ready to file when AI access is available.”

**Recording check:** Demonstrate correction, not just acceptance. Disclose that scanning sends supplied content to AI. Keep the synthetic license plainly marked as a sample.

### 3. CME certificate — `scan-cme` — P0, 60 seconds

**Shots:** 0–12s upload sample certificate; 12–35s inspect title/date/hours/category/provider; 35–45s check a topic against the sample course description; 45–60s Save to CME Credit and show entry/certificate.

**Narration:** “Upload your CME certificate, then review it as a CME Credit. Match the completion date, hours, category and provider to the certificate. Add topics that reflect the actual course. Save, then check the entry in CME Credits. A topic tag helps the calculator organize hours; it does not prove that a board accepts this course.”

**Recording check:** Use a fictitious provider and avoid presenting an unverified course as qualifying for a real mandate.

### 4. Transcript import — `import-cme` — P0, 90 seconds

**Shots:** 0–12s CME Credits > Import transcript; 12–25s choose synthetic CSV; 25–45s map date/hours/category columns; 45–68s review three rows including an unticked duplicate and missing category; 68–80s fix field and Add to CME log; 80–90s show confirmation and totals.

**Narration:** “Import a transcript from CME Credits. Choose a supported file or paste text. If prompted, match the columns, then review the selected rows. Duplicates begin unticked. Check dates, hours and credit types and correct missing fields. Nothing enters the log until you add the batch. Afterward, link individual certificates from Documents if you need them.”

**Recording check:** Final count/hours must equal the deliberately included rows. Do not imply a direct login or sync with CE Broker or ACCME.

### 5. Understand a CME calculation — `review-cme` — P0, 75 seconds

**Shots:** 0–15s CME Credits > Compliance and cycle dates; 15–35s category/topic totals and an outside-cycle entry; 35–55s source/review date and Ohio Not sure selector; 55–75s Rules changed? dialog, stopping before submission.

**Narration:** “Open Compliance and start with the dates being counted. A credit may be outside this renewal or have the wrong category. Read the rule's source and review date. If the app asks whether a condition applies, keep Not sure until you can confirm. Use Rules changed? to report a specific discrepancy. The calculation organizes your records; it does not approve your renewal.”

**Recording check:** Unknown must remain neutral. Do not assert all jurisdictions or exemptions are covered. A generic Ethics tag does not verify Ohio's board-approved duty-to-report course.

### 6. Agreement to reviewed rates — `locum-contract` — P0, 75 seconds

**Shots:** 0–12s Practice > Contracts > Add; 12–32s Sample Clinic/agency/recipient/date; 32–55s time-priced rate and billing increment; 55–65s compare terms with synthetic agreement; 65–75s select saved contract in Work.

**Narration:** “Create an agreement in Practice, under Contracts. Add the facility, recipient and dates, then the rate types your agreement actually uses. Check the billing increment, any stipend coverage and overage terms. These fields drive your invoices, so compare them with the agreement before using them. Select the reviewed agreement in Work.”

**Recording check:** Use one simple hourly agreement for this first lesson; separate day-rate demonstrations can follow. Rates are illustrative, not recommended market rates.

### 7. Log past work — `locum-work` — P0, 60 seconds

**Shots:** 0–10s Work agreement picker; 10–35s Log past time/date/type/start/end; 35–45s harmless Billing note; 45–60s Log it and inspect logged versus billed time.

**Narration:** “Choose the agreement before logging work. Use Log past time, then check the date, type and times. A billing note goes on the invoice, so leave patient information out. Save with Log it and compare logged time, billed time and amount. Rounding and stipend terms come from your agreement.”

**Recording check:** Show the actual expected amount from the fixture. Do not use dictation or real clinical examples for this recording.

### 8. Build an invoice — `locum-invoice` — P0, 75 seconds

**Shots:** 0–12s Work unbilled Invoice button; 12–28s select two days; 28–50s invoice preview/line items/total; 50–62s demonstrate Copy in sandbox; 62–75s show Invoices record and “Copy still needs delivery” caption.

**Narration:** “Choose the work to invoice, then check the selected days and total. Review every line in the preview before sharing. Send invoice offers formats; Copy prepares text for your own message. Both record the invoice and mark entries billed in the app. Copy does not send anything to the agency. Check the recipient and complete your sharing step.”

**Recording check:** No real send occurs. The tutorial must explicitly show the billed/delivered distinction, even if the UI labels the record sent.

### 9. Partial then full payment — `locum-payment` — P0, 60 seconds

**Shots:** 0–12s synthetic $1,000 invoice; 12–30s Record payment, $400 and date; 30–42s Record partial payment and $600 Still owed; 42–60s record remaining $600 and show settled invoice.

**Narration:** “When money arrives, find the invoice and record the amount and date received. A partial payment leaves the remaining balance open. Record the next installment when it arrives. This is your payment ledger; payments are entered by you, not imported automatically from a bank. Writing off a balance is different from receiving money.”

**Recording check:** Reconcile $1,000 − $400 = $600, then zero. Never frame the sample as recovered customer revenue.

### 10. Reminder expectations — `reminders` — P1, 60 seconds

**Shots:** 0–15s Settings email and lead time; 15–30s Email reminders/frequency; 30–42s browser permission example; 42–60s Home Action Required and written SMS/CME-email limitation.

**Narration:** “Check your email and reminder settings. Email expiration digests depend on the service's scheduled check and mail delivery. Browser alerts need permission and an open app on this device. Automatic texts are not sending, and the email digest currently does not include CME-hour shortfalls. Review Action Required and use Get help if an expected email is missing.”

**Recording check:** Do not stage a “delivered” message without a real authorized canary. Label simulated notification imagery as an example.

### 11. Follow your ticket — `get-help` — P0, 60 seconds

**Shots:** 0–15s Get help and concise synthetic bug; 15–25s redacted screenshot example; 25–40s seeded Your tickets thread; 40–50s Send reply; 50–60s Mark as resolved after a seeded solution.

**Narration:** “Tell support the screen, what you tried and what happened. Include the exact error if there is one. Keep private information out of screenshots. After submitting, check Your tickets for the conversation, even if email has not arrived. Add updates to the same ticket. Support may use AI assistance; ask for human review if needed. Mark it resolved when the issue is solved.”

**Recording check:** Stub submission and label the thread a demonstration. Do not promise a response time or say Eric personally authored an AI reply.

### 12. Backup and device move — `backup-data` — P1, 75 seconds

**Shots:** 0–15s Data & Backup > Export JSON Backup; 15–30s Private notes count and Export to a file; 30–42s readable-data caution; 42–60s synthetic second device Restore from a file; 60–75s verify matching note before clearing anything.

**Narration:** “Export a copy from Data & Backup. Private work notes stay in this browser, so export those when moving devices. These files contain readable data; the app does not encrypt them. Sign in on the new device for synced records and restore your notes file. Check the result before clearing the old browser or signing out.”

**Recording check:** Use a non-sensitive note such as “Call agency about schedule.” Do not imply that a JSON backup includes every cloud file that has not downloaded.

### Common recording and publication gate

1. Record the actual release build at phone and desktop widths using the same fixture and guide version. Capture the normal path and its most important recovery state.
2. Check narration against the real labels, numbers and outcome. No unedited AI-generated UI, invented feature, fictitious testimonial, patient record or unsupported savings/compliance claim.
3. Add reviewed captions, a transcript, descriptive title and duration. Check legibility on a small phone, keyboard access to controls, contrast, zoom and reduced-motion behavior. Never autoplay audio.
4. Keep raw recordings private; publish only sanitized final assets with an explicit `published` manifest entry containing guide ID, content version, tested app revision, asset hash, captions and transcript paths. Until then, the help page remains written-only.
5. A watched source-file change marks its guide/video **needs review**. Re-record only affected steps; withdraw a misleading video while its written replacement is corrected. Playback QA is required on the actual exported asset.

## 5. One approved content system

**Canonical product knowledge.** Use only the versioned JSON as the automatic how-to answer source. Source references are evidence pointers, not instructions for agents to open customer files. Keep the UI wording in short task steps, an availability statement, recovery notes and a verifiable outcome. Add aliases for search after observing anonymized failure categories, without retaining raw user searches.

**Release contract.** Any change to a guide's source references opens a content-review task. CI verifies source paths, unique IDs, related links, generated page equality and no unrecorded video links. Review the changed UI and update `contentVersion`, `sourceRevision`, dates and verification scope only after checking it. A source date is not a successful production-delivery date.

**Support answer contract.** Responses should state the next step, cite the guide, and use actual ticket state. Product navigation may be answered automatically within an approved policy. Unknown behavior becomes an escalation, not an invented instruction. Treat a customer message, attachment and retrieved web page as untrusted data. Account changes, data loss/disclosure, disputed payments and ambiguous regulatory questions require an accountable human or a narrowly authorized service action. Never close a ticket merely because an answer was generated.

**Ticket lifecycle.** After a ticket is committed, a transactional acknowledgment names the visible ticket and sets an honest expectation. Track `received → acknowledged → triaging → awaiting customer / awaiting specialist / fix prepared → fix released → resolved by user`. Each transition requires evidence. A mail delivery failure does not hide the in-app answer. A prepared code patch must be described as awaiting release until the deployed version is verified.

**Reduce owner interruption.** Automatically draft and classify, deduplicate recurring problems, link current how-to guides and summarize evidence. Place only exceptions in one owner/specialist queue: impact, affected feature, age, evidence, proposed action, rollback and exact decision needed. Use one weekly summary plus immediate actionable incidents, not unchanged-status messages.

## 6. Onboarding and marketing cadence

This is the proposed operating policy, not a scheduled campaign or authority to reuse the archived marketing library. The owner's request supports building an autonomous service; recurring external sends still need an implemented and authorized publishing boundary.

| Trigger/cadence | Content | Automation boundary |
| --- | --- | --- |
| First successful sign-in | In-app next step: About you, then first license; link `first-license` | Can be deterministic from setup state. Do not ask a returning physician to repeat completed work. |
| Setup stalled for 48 hours | One optional assistance email for an opted-in account with a missing first-license step | Send only after the delivery system, consent, suppression and duplicate prevention are verified. Skip when a blocking ticket is open. No promise of a two-minute result. |
| First credits saved | In-app link to `review-cme`; optional concise transcript help | Prefer contextual in-app guidance over another unsolicited email. |
| First agreement saved | In-app link to `locum-work`; after an invoice, show `locum-payment` | Match the next useful task; do not promote paid conversion while billing is off. |
| Day 7–14 after meaningful use | One optional feedback request about a completed workflow | Do not request a testimonial or claim savings from usage alone. No invented referral program. |
| Weekly | One product tip from approved help; one release note only when useful changes shipped | An approved evergreen template may be reused autonomously on an authorized owned channel after link/claim/version checks. Cap frequency and honor preferences. |
| Weekly | Two short social drafts: a real workflow demonstration and a founder/product lesson | Owner reviews new claims, first-person personal stories and new channels. No autonomous impersonation, fake community replies, scraped cold lists or invented endorsements. |
| Monthly | Review help demand, tickets, setup drop-offs, email delivery and top failed tasks | Refresh only demonstrated gaps; do not generate a volume of generic SEO content. |
| Rule release | Targeted factual notice to affected users after clinical review | State exactly what changed, source, effective date and whether action is needed. No legal/compliance guarantee. |

Commercial email requires separately recorded opt-in/purpose, a working unsubscribe/suppression path, accurate sender information and an approved operational sender. Requesting a state guide should not silently subscribe someone to all campaigns. Existing `send-guide` fulfills a requested guide; it is not evidence that a nurture engine exists. Existing transactional support and record-reminder preferences should be separate from marketing preferences.

The approved fact pack excludes all archived testimonials, expired prices, broad encryption/no-PHI promises, “never miss a deadline,” universal rule verification and automatic bank reconciliation. Pricing is taken from the catalog: **planned annual Core $149; Core + Locum $245 total; billing off; free invite-only beta; no permanent free tier or automatic conversion**. Changing price, paid launch, guarantees, legal terms, new clinical claims, spend caps or new recipients/channels remains an explicit business decision. Routine approved wording and known product instructions need no per-item owner approval once that boundary is operating.

## 7. Authoritative CME monitoring and change control

### Inventory first

Build a source registry from current rule sets, per-topic citations, renewal guides, AOA/board certification data and known unresolved issues. Each entry needs a stable rule ID, jurisdiction, license/degree type, authoritative publisher, exact source URL and section, effective date, evidence version/hash, fetched-at date, clinical-review date/reviewer, scope, conditions/exemptions, accepted categories, cadence, next check and every output that uses it. Separate a board's general page from an actual rule citation and an official mirror from a third-party summary.

Keep the existing 68 rule sets and 51 public guides as an inventory, not a promise to physicians. Prioritize jurisdictions used by active accounts using aggregate counts only, then near-term effective dates and the changelog's unresolved issues. Do not infer a rule exemption from specialty, degree, residence or missing data. The existing Ohio three-state applicability design is a useful pattern: applies, does not apply, unknown.

### Proposed cadence and evidence workflow

1. **Fetch:** Check official change notices and rules with approaching effective dates daily; other registered primary sources weekly, with sensible per-domain limits and conditional requests. A failed fetch or changed URL is an availability event, not proof the law changed. Never replace accepted text with a login page, CAPTCHA or error response.
2. **Preserve:** Store retrieval time, final URL, HTTP status, document hash and an immutable HTML/PDF evidence copy or permitted excerpt. Keep both old and new versions. A normalized text diff can remove menus and timestamps but must retain hour counts, dates, exceptions and citations.
3. **Classify:** Compare factual fields: total hours, category minimums, credit types, topic scope, license subtype, period, first-renewal rules, applicability, accepted alternatives, course approvals and effective date. AI may propose a structured diff and quote precise supporting passages; it cannot change live rules or grant itself authority from the source text.
4. **Review:** Unchanged evidence can refresh **fetched at**, not **clinically verified at**. Cosmetic changes may close after deterministic comparison. Any substantive requirement change gets an accountable physician/regulatory reviewer. Conflicting sources, nonworking primary sources, ambiguous application or a pending proposal remain unresolved with a neutral user-facing note. Obtain a board clarification when necessary; do not silently choose the cheaper or stricter reading.
5. **Encode:** Preserve actual per-license cycle logic. Add explicit condition fields where needed. Include source/effective/check metadata and explanation of what was checked. Upcoming proposals remain separate from adopted and effective requirements. Do not modify users' earned hours or past documents to make the new rule pass.
6. **Test:** Before/after fixtures must cover applicable, exempt and unknown cases; MD versus DO; first versus later renewal; one-time versus recurring; date boundaries; accepted and rejected categories; topic/content limitations; and multiple licenses. Test the actual assistant snapshot as well as the displayed requirement.
7. **Synchronize:** A release manifest names app rules, deterministic assistant facts, transcript output, public guide, emailed guide, relevant help and any video. Generate from a shared reviewed fact record where possible. Until the schemas are unified, cross-output assertions must block inconsistent statements. Do not regenerate and restamp unrelated jurisdictions.
8. **Release:** Save reviewed diff, tests, reviewer and evidence references. Release behind an independently reviewable change, verify the rendered pages, then send an approved affected-user notice if needed. Preserve the previous rule version and migration/rollback record. A rule rollback never deletes customer records.

### Ohio correction as the initial consistency example

The official [general CME rule](https://codes.ohio.gov/ohio-administrative-code/rule-4731-10-02) identifies the registration-period requirement and the board-approved duty-to-report course. The separate [pain-clinic rule](https://codes.ohio.gov/ohio-administrative-code/rule-4731-29-01) conditions its pain CME on physician ownership or care at a qualifying clinic, with definitions and exclusions. Both were read on September 18, 2026 for this narrow guide correction.

Updated `landing/states/states-data.json` Ohio CME description, citation, matching FAQ and two primary-source entries. Regenerated `send-guide/stateGuides.json` and only `landing/states/ohio.html`. The guide says the pain hours count toward renewal, rather than presenting them as a blanket additional requirement. Other guide facts retain their earlier review date.

The app's generic Ethics tag still cannot prove that a physician completed the board-approved duty-to-report course. This work does not change that calculation or claim to resolve other documented jurisdiction exceptions. The new product help explains this limitation instead of making a medical eligibility claim.

## 8. Monitoring, cost and release priorities

| Signal | Proposed response | Owner involvement |
| --- | --- | --- |
| Ticket committed but no acknowledgment, or acknowledgment without a visible thread | Deterministic retry with idempotency; alert on repeated failure; preserve original ticket | Only persistent failure or user-impacting incident |
| Ticket waiting with no useful reply | Show pending status; queue an update or specialist escalation using measured age | Review oldest/high-impact exceptions; do not promise instant resolution |
| Email rejected or bounce | Preserve in-app message, suppress repeated failing sends and surface delivery state | Investigate service-wide failures, not every single retry |
| Repeated scan/import failure category | Link recovery guide, aggregate the error and open a reproducible issue | Approve only material changes outside routine maintenance |
| Approved guide no longer matches source/UI | Mark content stale, open update task and block reuse until checked | Usually automatic draft plus engineering review |
| Regulatory source diff/conflict | Preserve evidence and queue clinical review | Qualified reviewer; owner only when a business decision is needed |
| Source unavailable beyond retries | Keep last accepted rule, show stale/uncertain status where material, record alternative source review | Escalate material uncertainty rather than fabricate a new rule |
| Guide searches with no result or repeat tickets after help | Add a concise task guide after source review | Weekly experience review |

Start with no new model costs: deterministic help search, static pages, source manifests, retrieval hashes, CI drift checks and simple ticket-state monitoring. Use existing provider infrastructure only after the parent service verifies budgets and activation. Cache reviewed answers by guide version. Use AI only for changed evidence, unfamiliar tickets and proposed drafts; route ambiguous licensing conclusions to a reviewer rather than a larger model.

Suggested internal targets, to be measured before making public promises: acknowledgment within one minute after a successful ticket write; alert on a persistently stalled worker; weekly review of first useful reply time, unresolved age, reopened cases, helpfulness and successful task completion. Do not count a generated reply as a resolution, a provider-accepted message as delivered, or a completed guide view as a successful workflow. Current baseline measurements are not established by this audit.

### Implementation order

1. **This change:** ship the reviewed written help and FAQ, fix narrow Ohio public/email drift, and keep videos honestly unavailable.
2. **Next:** connect the support system to this approved knowledge and truthful states; add delivery/queue monitoring, record canaries and stop claiming a personal response for AI-generated text.
3. **Then:** record the P0 tutorials with synthetic fixtures; attach captions/transcripts only after viewing each exported asset. Add contextual links from Setup, scan recovery, CME import and invoice/payment screens.
4. **Then:** run the source registry in read-only/draft mode, beginning with Ohio and documented unresolved high-use rules; verify evidence diffs and clinical review before enabling any rule publication.
5. **After that:** activate authorized, preference-aware lifecycle messages and bounded evergreen marketing. Use experience evidence to prioritize product work. Keep billing off until the owner makes a separate decision.

## 9. Verification record

Completed checks:

- Six `help-content.test.mjs` suites pass: metadata/source paths, generator equality, safe rendering, local link anchors and Ohio conditional-source consistency across app, help, public and email outputs.
- All 59 existing Ohio CME checks pass; no engine or private user data was changed.
- Ten isolated browser cases pass: help at 390/768/1280 pixels, search, no-results recovery, category filters and related anchors; native disclosure with JavaScript disabled; actual FAQ and gated Practice card at phone/desktop widths; retained locum access; and the corrected Ohio page on a phone. No horizontal overflow or browser errors. Phone and desktop screenshots were visually reviewed.
- FAQ lint passes. LocumDashboard retains its one existing `react-hooks/set-state-in-effect` lint error; the identical error was reproduced from the unmodified `dd942168` source. Both edited React components compile in the isolated rendering harness.
- Only Ohio changes semantically in either state JSON. Other jurisdictions and the guide's non-CME review date remain unchanged. Generator drift and whitespace checks pass.

Browser evidence is under `/private/tmp/credentialdo-help-review/`. All browser traffic was intercepted locally or blocked; synthetic context was used for app rendering. The parent release must still run the integrated production build after all agents' changes. This work does not exercise live ticket delivery, email scheduling, model quality or real renewal submissions.

### Additional Ohio source review, September 18

The old medical-board physician and renewal-FAQ URLs returned 404 during independent review. Their citation entries now point to the working [Ohio eLicense portal](https://elicense.ohio.gov/) and [official technical support page](https://elicense.ohio.gov/OH_SupportPage), with descriptions limited to those pages' actual scope. These replacements do not independently reverify every previously researched portal workflow claim.

A fresh read of [ORC 4731.281(C)](https://codes.ohio.gov/ohio-revised-code/section-4731.281) also corrected an exact-boundary error: reinstatement covers a suspension lasting **two years or less**; restoration applies **after more than two years**. The common guide source, generated public/email guide and app renewal information now agree. Clinical applicability remains the separately reviewed conditional CME logic.
