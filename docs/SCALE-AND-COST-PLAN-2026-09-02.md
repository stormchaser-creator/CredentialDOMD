# CredentialDOMD: scale, storage, safety, and API cost

Date: 2026-09-02. Facts below were measured against the live Supabase project, the repo, and vendor pricing pages fetched today. Every projection is labeled estimated and shows its arithmetic. Price is $199 per physician per year ($16.58 per month). Physicians never bring their own API keys; the shared keys are part of the product.

## 1. The answer in one screen

- **Infrastructure is not the cost problem.** Storage and database for a physician at steady state cost about $0.04 per year. Even the whole-library egress bug below is under $3 per physician per year. The platform floor is $600 per year (Supabase Pro plus Clerk Pro) and is covered by five paying physicians.
- **AI is the cost problem, and it is controllable.** A typical physician on today's Opus defaults costs about $5.81 per month in model calls, a heavy one $30 to $45. The heaviest real user in the last 30 days would have cost about $8.30. Two changes to Vera (cache the record snapshot, lower thinking effort) cut the typical bill by roughly 40 percent, and a per-user dollar budget caps the tail. With those, a typical physician costs about $50 per year all in (AI, card fee, infra) against $199, a gross margin near 75 percent.
- **The one unbounded liability today is blind spend.** The shared Opus key went live on September 2 with a call-count cap only. Nothing records tokens, model, or dollars. The Anthropic Start tier pauses the whole organization at $500 per month with a 429 until the first of the next month, and two physicians saturating the 60-call daily cap with large Vera turns could trip it. Usage logging and dollar budgets ship first.
- **Documents stay on Supabase Storage.** Cloudflare R2 only wins on egress, and the egress is a code bug (the app re-downloads every document on every open), not an architecture limit. Fix the bug; revisit R2 past roughly 2,000 physicians.
- **"Stored safely" is mostly true today and can be said honestly once five gaps close:** the privacy policy misstates the AI vendors, the monthly backup ZIP goes out as a 35-day emailed link, account deletion is partial, there is no access log, and the shared Gemini key's billing tier (which decides whether Google may review or train on scans) has not been confirmed.

## 2. Where everything lives today

| Data | Where | Protection | Size today |
|---|---|---|---|
| Records (licenses, CME, work log, invoices, cases) | Supabase Postgres, us-east-2 (Ohio), 61 tables | RLS on every table, owner = Clerk user; AES-256 at rest (vendor), TLS | 21.4 MB database, 6.2 MB of it user tables |
| Uploaded documents (license cards, DEA, certificates, CVs, contracts) | Private bucket `documents`, one object per file at `user_<clerkId>/<uuid>` | Bucket private; one storage policy ties folder to JWT; app downloads under RLS, no signed URLs | 58 objects, 72.5 MB, one real uploader (avg 1.25 MB, max 6.1 MB) |
| Monthly backup ZIPs | Private bucket `backups`, 3 newest months per user | Service role only; emailed signed link lives 35 days | 6 ZIPs, 126.9 MB |
| Ticket screenshots | `documents` bucket under `tickets/<id>/` | Service role only; 1-hour signed URL for owner or admin | 7 objects, 2.6 MB |
| Hospital portal passwords | In the privileges record | Encrypted in the browser (AES-GCM, PBKDF2 150k) with a lock code the server never sees | |
| Patient-identifying notes | Device only (localStorage vault) | Never uploaded; the server-side note columns exist but hold 0 rows | |
| Offline mirror | localStorage, whole record set minus document bytes | Plaintext on the device; cleared by the delete-account flow | typical under 100 KB, heaviest user 1.5 to 3 MB |

What is plaintext in Postgres: license and DEA numbers, NPI, insurance policy numbers, passport and driver's license numbers in travel documents, contract rates, invoice figures, tax figures, dictation transcripts. No SSN or EIN column exists. Stored API-key columns are empty and are stripped from backups.

## 3. Storage and infrastructure cost

Steady-state model per physician (estimated): 30 documents at the observed 1.25 MB average = 37.5 MB, plus 3 retained monthly backup ZIPs (JPEG and PDF do not compress) = about 115 MB, plus 1 to 3 MB of rows. **About 155 MB with backups on, 41 MB with backups off.** The 2 GB per physician used in an earlier draft is 29 times the heaviest real user and needed 200 files at the 10 MB cap; it is kept only as a stress case.

Storage cost at Supabase's $0.0213 per GB-month: 0.155 GB is $0.0033 per month, **$0.04 per year**. Pro's included 100 GB covers about 645 physicians with backups on.

**Egress is the real line, and it is a bug.** After every cloud load the app calls `reconcileDocumentFiles()` and downloads every document into memory, because the local mirror deliberately strips document bytes. A physician with 37.5 MB of documents who opens the app 20 to 60 times a month moves 0.75 to 2.25 GB. Supabase bills $0.09 per GB uncached (or $0.03 cached; which rate private-bucket downloads get is not documented). Pro's 250 GB covers 110 to 330 physicians. Caching bytes in IndexedDB, or downloading a document only when viewed, removes about 90 percent of it.

Monthly infrastructure at scale (estimated; realistic 155 MB and 1.5 GB egress per physician; Supabase Pro $25 and Clerk Pro $25 assumed; $0.09 egress):

| Physicians | As coded today | After the egress fix | Documents on R2 instead |
|---|---|---|---|
| 10 | $50 | $50 | $50 |
| 100 | $50 | $50 | $53 |
| 1,000 | about $170 | about $60 | about $75 |
| 10,000 | about $1,520 | about $305 | about $190 |

Arithmetic at 10,000: storage 1,550 GB, 1,450 over the included 100 at $0.0213 = $31; egress 15,000 GB, 14,750 over at $0.09 = $1,328; Large compute about $100 net of the $10 credit; database about 50 GB = $5; edge functions $2; Clerk $25; Workers Paid $5. After the egress fix, egress drops to about 1,500 GB ($113). R2 is $0.015 per GB-month with zero egress and would need a Worker or presigned-URL layer. **Decision: stay on Supabase Storage, fix the egress path now, and revisit R2 past about 2,000 physicians.** Per-physician infrastructure is about $0.15 per month at 10,000 as coded, under $0.03 after the fix.

Tier breakpoints to watch: Supabase Pro storage 100 GB at about 645 physicians; egress 250 GB at 110 to 330 as coded (over 1,000 after the fix); Cloudflare Workers free tier at about 3,300 physicians; GitHub Pages' terms prohibit commercial SaaS hosting and cap bandwidth at a soft 100 GB per month, so the static bundle moves to Cloudflare Pages (free) before launch. Supabase's spend cap is on by default on Pro; with it on, the first physician past an included quota gets failed uploads instead of a bill. It must be off, with alerts set, before the first paying cohort.

Compliance signals buyers may ask about, for reference only: Supabase's SOC 2 report and HIPAA add-on require the Team plan ($599 per month plus about $350 per month for the add-on); Clerk's SOC 2 report requires Business ($300 per month) and a BAA requires Enterprise. That is why no-PHI-by-design matters: the product makes no HIPAA claim and needs none of this.

## 4. AI cost with shared keys

Physicians will not manage API keys. The shared Gemini and Anthropic keys are held server-side and relayed by the ai-proxy edge function with per-user daily caps (200 Gemini calls, 60 Opus calls). Routing since September 1: Opus for the RVU coder, case dictation, and Vera; Gemini 2.5 Flash for document scans, CME import, work dictation, and CPT lookup.

Measured prompt sizes (Anthropic count_tokens, today):

| Surface | Static prompt | Per call | Cached today |
|---|---|---|---|
| RVU coder (Opus) | 17,799 tokens (rules + catalog) | plus the dictation | Yes, 5-minute cache |
| Case dictation (Opus) | about 4,800 tokens | whole prompt in the user message | No |
| Vera (Opus) | 9,637 tokens static | plus a record snapshot of 14,769 (typical) to 34,901 (large) tokens and up to 14 history turns | Static only; snapshot and history re-billed every turn |
| Document scan (Gemini) | about 2,400 tokens | plus 6,192 image tokens for an untouched phone photo | No |

Per-call cost at list prices fetched today (Opus 5: $5 in, $25 out, $6.25 cache write, $0.50 cache read per million; Gemini 2.5 Flash: $0.30 in, $2.50 out):

| Call | Cost |
|---|---|
| RVU coder, Opus, cache miss / hit | $0.121 / $0.019 (Gemini fallback $0.004) |
| Case dictation, Opus | $0.030 (Gemini $0.0015) |
| Vera turn, Opus, typical / large record | $0.134 / $0.234, plus $0.055 on a session's first turn |
| Document scan, Gemini | $0.0033 per photo, $0.0022 per 10-page PDF |
| CME transcript import, Gemini | $0.0066 typical |

Monthly AI cost per physician (estimated):

| Profile | Volume | Opus defaults today | After the two Vera fixes | Everything on Gemini Flash |
|---|---|---|---|---|
| Light | 2 dictations, 5 Vera turns, 2 scans | $1.03 | about $0.70 | $0.05 |
| Typical | 10 dictations, 30 Vera turns, 8 scans, 1 CME import | $5.81 | about $3.50 | $0.24 |
| Heavy | 60 dictations, 150 Vera turns, 20 scans | $30 to $45 | about $18 to $27 | $1.20 |
| Heaviest real user, last 30 days | 43 case dictations, 34 Vera turns, 19 scans, 15 coded cases | about $8.30 | about $5.50 | |

Where the money goes and the levers, in order of dollars per hour of work:

1. **Log usage and enforce dollar budgets (2 hours).** The proxy already buffers the full upstream JSON (streaming is refused), so recording `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, the model, and a computed cost is a schema change plus a parse. Then the cap becomes money, not counts: a soft monthly budget that warns, a hard budget that routes the rest of the month to Gemini. Recommended defaults: $8 soft, $15 hard per physician per month; admins unlimited. Note that ai_usage has never held a surviving production row: the only active AI user runs on device-local keys and bypasses the proxy, so the caps, the 403 gate, and the insert path get their first real test with the first shared-key physician.
2. **Cache Vera's record snapshot (1 hour).** The snapshot is 55 to 75 percent of every Vera turn and only changes when a record changes. A second `cache_control` breakpoint on it turns a $5 per million read into $0.50 after the first turn of a session. Saves $1.14 per month on the typical profile, $13.50 on heavy. Moving the 37,745-character renewal-rules block (46 percent of a large snapshot) into the cached static prompt shrinks a large snapshot from 34,901 to about 19,000 tokens.
3. **Lower Vera's thinking effort (15 minutes).** Vera omits the thinking parameter, so Opus 5 thinks adaptively on every chat turn at $25 per million output tokens; about 28 percent of a typical turn. Effort low on conversational turns saves about $1.13 per month typical.
4. **Cache the case-dictation rules (30 minutes).** Move the 4,000-token construct rules into a cached system block. Saves $0.02 per case.
5. **Retire the dead CPT lookup model (1 line).** `cptAILookup.js` still calls gemini-2.0-flash, shut down June 1, 2026; every lookup fails and still burns a cap unit.
6. **Keep the coder on Opus.** Its rulebook and catalog are already cached and it decides money; the exposure is the 5-minute cache TTL on a lone dictation ($0.11), about $1 per month at 10 dictations.

Vendor limits that bite before volume does: the Anthropic Start tier caps organization spend at $500 per month and pauses with a 429 until the next month; a hundred typical physicians on today's defaults is about $580 per month, so the account must be on Build ($1,000) before 100 physicians and Scale before 1,000. Gemini rate limits are per Google Cloud project, not per key, and Google no longer publishes the numbers; the shared key's project must be on a billed tier (Tier 1 or higher) and its live quota read in AI Studio.

## 5. Margin per physician

Per typical physician per year, estimated: AI $70 today ($42 after the Vera fixes), Stripe $6.07 (2.9 percent plus 30 cents), infrastructure $1.59 as coded ($0.40 after the egress fix). **About $78 today, about $50 after the fixes, against $199.** A heavy physician on today's defaults costs $362 to $542 per year, which is why the dollar budget exists: with a $15 hard monthly budget the worst case is $180 of AI plus $8, still under $199. The fixed floor of $600 per year needs five paying physicians. Today's revenue is $0 (8 free beta accounts, 5 active).

## 6. What "stored safely" can truthfully mean, and what closes the gaps

True today and safe to say: no patient data by design and no HIPAA claim; records live in a Supabase Postgres database and private storage bucket in the US (Ohio), encrypted at rest by Supabase with AES-256 and in transit with TLS, with row-level security tying every row and file to the account; hospital-portal passwords are encrypted in the browser with a lock code the operator never sees; patient-identifying notes stay on the device; the operator can access the database and storage for support and there is no automated access log yet.

Not safe to say until fixed: "permanently wiped after 7 days", "delete all of your data at any time", "Anthropic only under your own key", and never "bank-level", "military-grade", "HIPAA compliant", "SOC 2" (Supabase's certifications are not CredentialDOMD's), "end-to-end encrypted", or "we cannot read your documents".

Ranked gaps with fixes (effort estimated):

| # | Gap | Likelihood x impact | Fix | Effort |
|---|---|---|---|---|
| 1 | Privacy policy and landing FAQ say Vera runs on Gemini and Anthropic is used only under the physician's own key; the shared Anthropic key is live. Deletion promise ("wiped after 7 days") has no implementation. | certain x medium | Correct the factual description of vendors and retention now; the deletion wording becomes true when item 3 ships | 2 h |
| 2 | Monthly backup ZIP of every scan (passport, DL, DEA) is emailed as a 35-day signed link; a read or forwarded inbox exposes the archive | medium x high | Email a pointer to the app's Data and Backup page; mint 15-minute links on click | 2 h |
| 3 | Account deletion leaves the profile row, Vera question log, tickets and screenshots, feedback, and the last three backup ZIPs (never pruned for a departed user); nothing honors data_deletion_date | certain x medium-high | Service-role delete-account function covering everything, called by the button and by a daily cron over data_deletion_date | 1 day |
| 4 | Shared Gemini key's billing tier unknown; on an unpaid project Google's terms allow human review and product training on ID scans | unknown x high | Confirm billing on the Google Cloud project (Eric, 15 minutes), then state "Paid Services" in the policy | 15 min |
| 5 | Vera sends full license and DEA numbers and NPI to Anthropic every turn (30-day retention, no training) | medium x medium | Send last-4 in the snapshot unless the physician asks for a number | 1 h |
| 6 | No admin or data access log | grows with scale | access_log table written by every service-role read path plus a dashboard-access rule; export to the physician under Data Rights | 1.5 days |
| 7 | No per-user storage quota; any account can upload unlimited 50 MB objects | at scale | Bucket file_size_limit 15 MB (client cap is 10) and a per-folder 2 GB check | 0.5 day |
| 8 | Storage objects are not in Supabase's daily backups; only the monthly app ZIP covers files | low-medium x medium | Weekly backup schedule or nightly copy to a second bucket; PITR ($100 per month) covers rows only | 0.5 day |
| 9 | No retention on ai_usage, page_visits, assistant_log, support_messages | low x medium | Cron prunes: ai_usage 90 days, page_visits 13 months, assistant_log 12 months; state the numbers in the policy | 2 h |
| 10 | Hook secret embedded as a literal in live SECURITY DEFINER function bodies | low x medium | Read from vault or a GUC, rotate | 2 h |
| 11 | Whole record set cached in plaintext localStorage; a shared hospital workstation exposes numbers without sign-in | low-medium | Clear on sign-out, or encrypt the cache with a session key | 1 day |
| 12 | Client-side encryption of scans | design decision | Would break server-built backups, packet emails, inbound-email filing, CME downloads, and needs key-recovery UX; 2 to 4 weeks. Cheaper middle step: move identifier columns behind the existing lock code (2 to 3 days) at the cost of Vera, reminders, and CV export losing the numbers unless unlocked. Not recommended now. | |

## 7. Build order

**Now (this week, no decision needed):** usage logging with model and tokens, dollar budgets with Gemini fallback, Vera snapshot caching and low effort, case-dictation caching, CPT lookup model, documents bucket file limit, backup link hardening, retention prunes, orphan-object cleanup (4 objects, 3.8 MB), the delete-account function and daily cron, and the factual corrections to the privacy policy and FAQ.

**Next (1 to 2 weeks):** IndexedDB document cache or download-on-view (the egress fix), access log, per-folder storage quota, weekly file backups, static bundle to Cloudflare Pages, Clerk production cutover.

**Later (past about 1,000 physicians):** Anthropic Scale tier, Supabase compute upgrade, R2 for documents if the egress bill still matters after the cache, secretBox for identifier columns if the market asks.

## 8. Decisions that are Eric's

1. Confirm the shared Gemini key's Google Cloud project has billing enabled (console, 15 minutes). This is the difference between Google training on ID scans and not.
2. Check the Anthropic organization tier and spend cap for the shared key, and request Build before the first 100 physicians.
3. Turn off the Supabase spend cap and set usage alerts before the first paying cohort (Organization > Billing).
4. Approve the AI budget defaults: $8 soft and $15 hard per physician per month, Gemini for the rest of the month past the hard line, admins unlimited.
5. Decide whether Vera may show last-4 of license and DEA numbers instead of full numbers.
6. Decide whether monthly ZIP backups stay on by default (they triple storage and are the emailed-archive exposure) or become on-demand from the Data and Backup page.

## Sources

Supabase pricing, backups, compute-and-disk, egress, SOC 2 and HIPAA pages; Cloudflare R2 and Workers pricing; Clerk pricing; Google Gemini API pricing, tokens, rate limits, terms, deprecations; Anthropic pricing, prompt caching, rate limits, privacy article 7996866, commercial terms; GitHub Pages limits; Stripe pricing. All fetched 2026-09-02. Repository facts cite file and line in the research notes kept with this session.
