<!-- 46-agent research run 2026-08-16: 5 researchers, 40 competitor claims individually verified against loaded pages, then synthesized. -->

# Beating Mocingbird: product and price

Date 2026-08-16. Sources: Mocingbird pages loaded this week plus a read of the CredentialDOMD working tree (`src/utils/featureMap.js`, `src/constants/*`, `src/components/**`, `supabase/functions/*`, `docs/MULTI-USER-READINESS-2026-08-16.md`).

## 1. What Mocingbird sells

- Individual CME Management "Starting at $199 a year", annual only, 30-day free trial; FAQ states it flatly as "$199 a year" (https://mocingbird.com/company/pricing/, https://mocingbird.com/faqs/).
- Included: CME tracking against state rules, document File Cabinet with email sharing, deadline reminders, Learning Center (318 public courses, 99 free), state-required course finder (https://mocingbird.com/create-an-account/, https://app.mocingbird.com/learning-center).
- Rules engine covers all states for MD/DO/PA/NP/RN and five behavioral roles, maintained by an in-house research team (https://mocingbird.com/solutions/continuing-medical-education-management/state-requirements/).
- Certificate intake is upload, mobile photo, or email to trackcme@; staff sort files "within 72 hours" (Mocingbird Medium post, https://mocingbird.com/solutions/continuing-medical-education-management/real-time-cme-tracking/).
- Licensing support, and both Enterprise tiers, are quote-only; enterprise gets admin dashboard, bulk records, CSM (https://mocingbird.com/company/pricing/).
- Students and residents free on emailed proof of enrollment (https://mocingbird.com/faqs/).
- SOC 2 Type 2 and HIPAA claimed, AWS, TLS 1.2+ (https://mocingbird.com/information-security-overview/).
- Ratings: iOS 7 ratings at 5.0, no written reviews; Play 100+ downloads, no rating shown (https://apps.apple.com/us/app/mocingbird/id1489280926, https://play.google.com/store/apps/details?id=com.mocingbird).

## 2. Head-to-head

| Capability | Mocingbird | CredentialDOMD today |
|---|---|---|
| State CME rules, all jurisdictions | ✓ human research team, all states | ✓ 55 jurisdictions, one entry verified 2026-07 |
| Topic mandates (opioid, ethics, etc.) | ✓ course finder per state | ✓ per-state topic hours in stateRequirements.js |
| Board MOC rules by ABMS board | partial, board certs tracked as expirables | ✓ ABMS/AOA/UCNS/ABPS tables, 2,475 lines |
| License, DEA, CSR trackers | ✓ plus custom trackers | ✓ license, DEA, privileges, malpractice, health |
| Certificate capture | ✓ upload/photo/email, staff sort 72h | ✓ Gemini scan, instant, BYOK key required |
| CME marketplace | ✓ 318 courses, filters, state finder | partial, 37 provider links, no catalog |
| Automated reminders | ✓ email reminders, lead times undocumented | partial, browser push only, no server email cron |
| Sharing with credentialers | ✓ email files, no link portal | partial, native share sheet, share_log, no link |
| Reports/export | partial, zip plus downloadable report | ✓ xlsx/csv/zip export, PDF CV, invoices |
| CV builder | ✗ | ✓ CVGenerator with PDF |
| AI assistant | ✗ conversational AI not offered | ✓ Vera, guarded writes, BYOK |
| Native iOS/Android | ✓ both stores, redesigned Aug 2026 | ✗ PWA only |
| Offline | ✗ not mentioned | ✓ service worker, private vault |
| Locums billing/tax/RVU | ✗ | ✓ 17 locum modules |
| Team/admin dashboard | ✓ enterprise, real-time compliance | partial, TeamSection, untested invite flow |
| Licensing service | ✓ human reps, quote | ✗ |
| Free for residents | ✓ manual proof by email | ✓ tier exists, verification not built |
| Payment can be taken today | ✓ | ✗ Stripe products not created |
| Security attestations | ✓ SOC 2 Type 2 claimed | ✗ none, RLS verified, no BAA |
| Monthly billing | ✗ | ✓ |
| Self-serve cancel and refund | ✗ email cancel, non-refundable | ✓ CancellationPage, 7-day grace |

They win on marketplace, reminders that actually reach an inbox, native apps, human licensing service, attestations, and simply being purchasable. We win on AI, MOC depth, CV, export, offline, locums, and pricing flexibility.

## 3. Gaps to close

**(a) Ship this week**
- Server-side reminder email. Add `supabase/functions/send-reminders` on a daily cron reading expirations plus `notifications.js` compliance gaps, sent via Resend (welcome pipeline already has SPF/DKIM). Done: a test account with a license expiring in 30 days receives an email without opening the app.
- Resident verification. Add ACGME program plus graduation year fields to `AuthPage.jsx`, stamp `resident_free_v1`, auto-convert 90 days post-grad per pricingEngine. Done: a resident signs up free without emailing anyone.
- Share link. Add a signed, expiring Supabase storage URL path in `ShareModal.jsx` and record it in `share_log`. Done: a credentialer opens a packet from a link that dies in 7 days.
- Fix `degreeType` DO default and the phantom $348 deduction (readiness doc items 9). Done: new account shows no degree until chosen.
- Stripe products script plus webhook (CURRENT-STATE.md steps 1 to 7). Done: one live test charge lands in `subscriptions`.

**(b) 30 days**
- Verified rule provenance. Every entry in `stateRequirements.js` carries statute citation, verified date, and a public changelog page. Done: /requirements/{state} shows source and date; that beats Mocingbird's own "may not reflect the latest" disclaimer.
- Managed AI key. Quota-limited Gemini Flash proxy so scanning works without BYOK. Done: new user scans a certificate with zero settings.
- MATE Act attestation tracker tied to the DEA record. Done: 8-hour requirement shows met/unmet with linked certificate.
- Legal surface: remove "We sign BAAs" and "nothing sent to any server" (readiness item 4). Done: FAQ and PricingModal are literally true.
- Course finder v1: map `cmeProviders.js` entries to state topics with free/paid flag. Done: each unmet topic shows two courses.

**(c) Strategic**
- Native app store presence (Capacitor wrap of the PWA) so "download the app" is a real sentence.
- CME auto-import: ACCME PARS learner-completion export and CE Broker transcript import. Nobody in this category has it publicly; first mover owns "zero-upload CME".
- Board portal integration or at least ABIM/ABNS transcript PDF parsing into MOC point buckets.
- SOC 2 Type 1 within 12 months; until then, publish the security page describing RLS, private storage, JWT verification, no AI key in bundle.
- Self-serve team admin priced per seat, live before Mocingbird's admin product ships (their blog targeted Jun 2026 GA, still unshipped in March copy).

## 4. Where we already win, publishable sentences

- "Your certificate is read by AI the moment you scan it, not sorted by staff within 72 hours." (Mocingbird Medium post states 72 hours.)
- "MOC requirements for ABMS, AOA, UCNS and ABPS boards are built in." (`boardRequirements.js`.)
- "Generate a formatted CV as a PDF from the credentials you already track." (`CVGenerator.jsx`, `cvPdf.js`.)
- "Ask Vera, the in-app assistant, and approve every change before it lands." (`assistant.js` guarded writes.)
- "Works offline; patient scratch notes never leave your device." (`sw.js`, `privateVault.js`.)
- "Export everything as spreadsheet, zip and PDF whenever you like; cancel yourself, no email required." (`exportData.js`, `CancellationPage.jsx`; Mocingbird ToS requires emailed cancellation.)
- "Monthly or annual, your choice." (Mocingbird publishes annual only.)
- "Locums billing, RVU log, expenses and tax set-aside in the same app." (`components/features/locum/`.)

## 5. Pricing recommendation

| Tier | Price | Rationale |
|---|---|---|
| Free | $0, 5 credentials, no CME rules engine | Lead magnet; keep, add email reminders so free users still get value. |
| Resident / Fellow | $0, full Core, auto-converts 90 days post-grad | Matches Mocingbird, beats them on zero-friction verification. |
| Founding | $12/mo, $120/yr, locked 24 months, first 100 | Keep; 40% under Mocingbird for the cohort that will give references. |
| Core | $15/mo or $149/yr | Beats $199 by $50 with more product; $149 reads as a category price, not a discount. Rename Solo to Core. |
| Locum add-on | +$10/mo or +$96/yr on Core (Locum total $25/mo, $245/yr) | Premium for the 17 billing modules; still cheaper than Mocingbird's tracker alone plus any invoicing tool. |
| Monthly vs annual | Annual = 2 months free, monthly always offered | Monthly is a feature Mocingbird lacks; make it visible on the pricing page. |
| Practice / Group | Hold current $39 and $29 per seat annual | Do not touch until team invite flow is tested. |

Net: Solo $190 to Core $149, Locum $290 to $245. Founding stays. Change `pricingConstants.js`, `create-stripe-products.sh`, and the 12 marketing docs together, then run the Stripe script once.

## 6. Claims not safe to publish

- "Mocingbird has no patent": application US20230064041A1 shows Pending on Google Patents; say "published application, no grant shown as of 2026-08-16".
- "Mocingbird takes 3 to 5 days" or "email only reminders": say "72 hours per Mocingbird" and "delivery channels not documented".
- "Only 31% of their courses are free": public catalog figure; their pricing page says over 60%.
- "No third-party reviews exist": say "no G2, Capterra or Trustpilot listing found; 7 App Store ratings".
- "We are HIPAA compliant" or "We sign BAAs": false today; no-PHI-by-design is the position.
- "All 55 jurisdictions verified": one entry carries a 2026-07 verification note.
- "Email reminders", "SMS alerts", "resident verification": feature flags exist, delivery does not.
- Any specific Mocingbird course names or prices, "Attest as Exempt", "Active/Past Cycles": unverified UI details.
- "$199 flat": use "starts at $199 a year".
- "Zero-Lapse full year on us": undefined in ToS.