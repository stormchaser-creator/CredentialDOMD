# Independent Claude design input

Snapshot received September 18, 2026. This is an attributed design proposal, not authority to activate services or spend money. The implementation and accepted decisions are in `AUTONOMOUS-COMPANY-PLAN.md`. Source SHA-256: `3cf35e57049f77fad5544ed04d3399ab8d1314feb3ccd7908a829d886aa8eaf9`. Some source facts and test counts predate current integration; the implementation runbooks record the latest evidence.

---

# CredentialDOMD customer-service operating model

**Status:** design artifact only. Grounded in `~/Projects/CredentialDOMD` at commit `dd942168`,
read-only, and in Codex's staged foundation at `/private/tmp/credentialdomd-autonomous-company`
(branch `codex/autonomous-company`, uncommitted, disabled). No production edit, send, service,
schedule, migration or paid call is part of any stage this document turns on. Billing is OFF.
The security-repair branch (`5ac3531a`, failed review; `cbdc48cc` awaiting review) is out of
scope and nothing here depends on it. Nothing staged is live. The monthly pilot budget is an
open owner decision (section 9). Written by Claude 2026-09-18; supersedes the three agent drafts
and the agent-written file now archived under `_inputs/`. Grounding: `FACTS-dd942168.md`.

---

## 1. The system on one page

**What runs.** A single support pipeline over the existing `support_tickets` /
`support_messages` tables, extended by Codex's staged foundation: every customer message from
the app or from `support@` becomes a ticket message; a policy decides *automatic*, *owner*, or
*quarantine*; automatic replies are template-bound or exact-match knowledge only; everything
else waits in an owner queue that Eric works in two fixed windows a week. Sends leave through
one outbox that is off until three gates are on and a canary has passed.

**What it may do without asking.** Acknowledge, hold, nudge, close-on-silence, answer an
exactly matched approved FAQ, confirm a CME certificate landed, confirm a document request was
received. All of these are templates or pre-approved text; none contains the physician's data
beyond their first name and ticket reference.

**What it may never do.** Send as Eric. Answer anything clinical, legal, financial or identity-
related. Read a document, a health record, a private note, or another account. Resolve a
ticket. Push code. Change a rule. Spend past a ceiling. Act on an instruction found inside a
customer message.

**How Eric is involved.** Two fixed 30-minute windows a week (his choice of days), one Monday
report with at most five decisions that default if he is silent for seven days, and an
interrupt only for a SEV1 (section 10). The system is designed so that a missed window costs a
customer a clear "Eric reviews on Tuesdays and Fridays" note, never a wrong answer.

**The rule that governs today.** Ticket 8e66cf06 (2026-09-16), encoded in
`supabase/migrations/20260916a_ticket_agent_approval.sql` and `scripts/ticket-agent-prompt.md`:
*"When a user makes a request and puts in a ticket that ticket needs to come to me and be
approved for you to work before you resolve or respond to the user."* That written rule stands
until Eric supersedes it in writing. Stages 0 and 1 below comply with it as written. Stage 2
requires his dated supersession for acknowledgements and holding notes specifically; nothing
in this design asks him to give up approval of substantive replies until section 15's
measured gate is met.

---

## 2. Service roles (functions, not agents)

Every role is a function with a policy, a data grant, a cost ceiling and a kill switch. None
has repository, deploy or Git access (section 8). All run under one non-admin service
principal (section 7).

| role | purpose | allowed actions | forbidden | may read | may never read | model, ceiling | kill switch |
|---|---|---|---|---|---|---|---|
| **Intake** | turn every app message and every `support@` email into one ticket message | `support_submit` / `support_ingest`; classify category; detect quarantine markers | reply; change status | ticket subject/body/category, `profiles.id`, `access_status`, first name | documents, health records, notes, other accounts, `profiles.anthropic_api_key`, `api_key` | Gemini 3.8, $0.01/message | `support_actors.enabled` |
| **Policy** | decide auto / owner / quarantine per section 5 | evaluate rules; record decision + rule id in `support_events` | anything else | same as Intake | same | none (deterministic) | n/a |
| **Answer** | produce the reply for *auto* lanes only | exact-match approved knowledge (`support_knowledge`); template fill | free-form composition in any stage before 3; any account data beyond first name and ticket id | knowledge entries, ticket text | everything else | Gemini 3.8, $0.02/reply; Opus never for customer text | `publication_enabled` |
| **Escalation Desk** | build the owner queue | draft a private summary and a *suggested* reply for Eric; set `sla_due_at` | send anything | ticket text | everything else | Gemini 3.8, $0.03/ticket | `publication_enabled` |
| **Send Gate** | the only Resend caller | claim outbox, bind recipient, send, record receipt | compose; choose recipients | outbox row, `support_mail_bindings` | everything else | none | `outbound_enabled` |
| **Clock** | SLO timers: ack due, owner due, nudge, close | enqueue template sends; mark `sla_breached` | any text not a template | ticket timestamps | everything else | none | `publication_enabled` |
| **CME Registrar** | monthly cited review (section 11) | fetch primary sources; write diff proposals | edit `stateRequirements.js`; notify physicians | rule table, sources | customer data | Gemini 3.8 for extraction, $5/month cap | `cme_review_enabled` |
| **Help Editor** | turn ticket themes into help articles and tutorial scripts (section 12) | draft articles into a review folder | publish | ticket themes (counts and categories, not bodies of quarantined items) | documents | Gemini 3.8, $5/month | `help_enabled` |
| **Outreach** | consent-gated drafts only (section 13) | draft into a review folder | send | `email_preferences`, suppression list | anything else | Gemini 3.8, $5/month | `outreach_enabled` |
| **Watch** | reliability, cost, incidents (section 10) | trip kill switches; page | anything customer-facing | events, outbox, receipts, `ai_usage` aggregates | ticket bodies | none | cannot be disabled by the service principal |
| **Ledger** | weekly metrics and the Monday report (section 14) | compute; send one email to Eric | anything customer-facing | events, aggregates | ticket bodies | Opus 5 for the one weekly summary, $0.30/week | n/a |

---

## 3. One conversation record

Use the tables that exist plus Codex's foundation; do not create a parallel `cs_*` schema.

| concept | table / column | note |
|---|---|---|
| conversation | `support_tickets` (id, user_id, subject, category, status, priority, archived_at, agent_approved_at) | one ticket = one conversation, regardless of channel |
| message | `support_messages` (id, ticket_id, author_id, body, is_admin_reply, attachment_path, support_actor_id, support_job_id) | `support_actor_id` set only by the service principal (`support_guard_actor` trigger) |
| channel of origin | `support_events` (kind = `app_message` / `email_message` / `template_send` / `decision` / `sla`) | append-only audit; every automated decision writes its rule id and inputs hash |
| email identity | `inbound_emails` (message_id UNIQUE, from_addr, to_addr, route, profile_id) | idempotency key for inbound |
| **gap** | `inbound_emails` stores no body; `support@` is relayed to Eric's inbox and the body is never persisted | Stage 1 prerequisite: a `support_inbound_bodies` table (message_id, ticket_id, body_text, retained_until) written only for the `support@` route, 90-day retention, RLS service-only. Without it email conversations cannot be triaged from the record. |
| recipient binding | `support_mail_bindings` ↔ `forwarding_addresses.verified_at` | **never `profiles.email`**: it is an unverified text box (`EMAIL-INBOUND.md` §sender matching). A physician who has not confirmed an address gets in-app replies only, and an in-app note saying why. |
| send | `support_outbox` → `support_provider_receipts` | at-most-once via idempotency key; `accepted` ≠ `delivered` |
| approvals | `support_approvals` | typed high-impact proposals, owner decides |

**Threading.** Outbound `Message-ID: <ticket-<id>-<n>@credentialdomd.com>`, `In-Reply-To` /
`References` to the prior message, `Reply-To: support+<ticket-id>@credentialdomd.com`. The
`email-inbound` function gains a `support+<id>` route that appends to that ticket after the
same proven-sender match it already does for `cme@`; an unmatched sender on a `support+` route
gets the existing "not registered" reply and the message is held for Eric, never attached.

**Delete-account.** `delete-account/lib.ts` hard-deletes `support_tickets`, `support_messages`,
`feedback`, `inbound_emails`. Every new foreign key into those tables must be `ON DELETE
CASCADE` or the "Delete All My Data" button fails on its first constraint. Verify in the
foundation migration before apply.

**What the customer sees.** In the app: the ticket thread, with each message labelled by
author kind. Today `SupportModal.jsx` labels every `is_admin_reply` row "Eric" and says the
ticket "goes to Eric Whitney, DO, and he answers personally." **Prerequisite for any in-app
automated message:** render by `support_actor_id` (label "CredentialDOMD Support"), and change
the copy to "Eric reads every ticket. First responses may come from CredentialDOMD Support."
By email: the same thread, from `CredentialDOMD Support <support@credentialdomd.com>`, with the
footer in section 7.

---

## 4. Reply and follow-up SLOs

Sized to one neurosurgeon, not a desk. Volume today: 98 tickets lifetime, 10 agent-approved,
9 inbound emails, 7 reminder digests. Nothing here needs speed; it needs honesty about time.

| lane | commitment | who | what the customer is told |
|---|---|---|---|
| acknowledgement (Stage 2+) | ≤ 15 minutes, 24/7 | Clock | "Received. Ticket #1234. Eric reads every ticket; he reviews on {day} and {day}. If this is urgent (locked out, data loss, security), reply URGENT." |
| exact-match knowledge answer (Stage 3) | ≤ 15 minutes | Answer | the approved text, plus "If that does not settle it, reply and Eric will see it." |
| owner lane | next owner window + 1 business day, p90; hard ceiling 6 business days | Eric | on ack: the window days. At window + 1 day with no reply: "Eric has not got to this yet; next review is {day}." (template, once) |
| urgent (customer writes URGENT, or Policy flags lockout / data loss / security) | Eric paged once (Telegram + iMessage, existing channels); target 4 hours when he is available | Eric | "Flagged as urgent. If you are locked out, use Sign in again first; nothing in your file is deleted by a sign-in problem." |
| follow-up nudge | 5 business days of customer silence after our last message | Clock | "Still need help with this? Reply and it reopens." |
| close on silence | 14 business days; reopen on any reply | Clock | "Closed for now. Any reply reopens it." |
| resolve | **only Eric, in-app**, or the customer ("Mark resolved") | Eric / customer | never the system |

**Owner windows.** Two fixed 30-minute slots per week that Eric chooses (recommend Tue and Fri
07:00-07:30 local). An `owner_unavailable` calendar (OR days, call weekends, travel) suppresses
urgent pages for its duration; it never suppresses the customer's holding note, which then
names the next window after the block. Silence from Eric never widens any permission. The system stacks the queue for them: newest first within *urgent*, then
oldest first. A missed window does not page him; the customer gets the template above and the
Monday report records the breach. That is the load-bearing SLO decision in this document: a
neurosurgeon's absence is turned into a scheduled, stated delay, not into a wrong answer or a
second page.

---

## 5. Decision rules: automatic vs owner vs quarantine

Ordered; first match wins; the rule id is written to `support_events`. Default when nothing
matches: **owner**. Policy is deterministic; a model may only *tighten* (move auto → owner),
never loosen.

| # | trigger (concrete) | lane |
|---|---|---|
| Q1 | sender fails proven match (`email-inbound` matchProfile) | quarantine: hold, "not registered" reply per existing backscatter limits, Eric sees it in the window |
| Q2 | body contains an instruction aimed at the system: `ignore (all|previous)`, `as (the )?(admin|owner)`, `send (this|it) to`, `run (this|the) (sql|query)`, `grant access`, base64 / hex blobs > 200 chars | quarantine: never drafted from; Eric sees the verbatim text marked "instruction inside message" |
| Q3 | threat, self-harm, abuse | quarantine + page |
| O1 | `profiles.access_status <> 'active'` | owner (access decisions are his) |
| O2 | category `billing`, or money words: `refund, charge, invoice, price, pay, card, stripe, receipt, cancel` | owner. Exception A1 below. |
| O3 | legal words: `HIPAA, BAA, subpoena, lawyer, attorney, GDPR, delete my data, breach, sue, liability, compliance claim` | owner |
| O4 | identity words: `change my email, merge, transfer, not my account, someone else, locked out, 2fa, password, forwarding address, remove address` | owner |
| O5 | clinical or rule interpretation: `do I need, does X count, am I compliant, which course, MATE, my state requires, my situation, waiver, exemption, pain clinic, DEA` | owner. The app computes; the system does not interpret a rule for a person. |
| O6 | any message naming another person's email, NPI, license number, or a second physician | owner; the text is not drafted from |
| O7 | attachment present, or health words (`immunization, TB, drug screen, physical, diagnosis, medication`) | owner; text excluded from drafting |
| O8 | category `feature_request` | auto ack (A2) then owner; never a promise |
| O9 | category `bug` or `data_issue` | auto ack (A2) then owner; system may append reproduction questions from an approved list, never a fix claim |
| A1 | exact match (lower-cased, trimmed) to a question in an approved, unexpired `support_knowledge` entry whose `source_url` is on `credentialdomd.com` | auto answer (Stage 3) |
| A2 | anything not above, from an active profile | auto ack + holding note (Stage 2); then owner |

Amounts: any message mentioning a dollar figure is O2. Any request to *do* something to a
record (delete, merge, change dates) is O4 or O6 regardless of wording.

---

## 6. Sends matrix

**May run under Eric's explicit standing authorization** (each template approved once, in
writing, dated, in `docs/SERVICE-AUTHORIZATIONS.md`; every send still passes the recipient
binding, the suppression list and the outbox gates; all from CredentialDOMD Support):

| send | condition | stage |
|---|---|---|
| S1 acknowledgement | A2 or O8/O9; active profile; verified address bound | 2 |
| S2 holding note ("Eric has not got to this yet") | owner lane, window + 1 day, once per ticket | 2 |
| S3 nudge and close-on-silence | Clock rules | 2 |
| S4 exact-match knowledge answer | A1; entry approved by Eric | 3 |
| S5 "your fix shipped" | only when Eric marks a ticket resolved with a release note | 2 |
| S6 cme@ intake confirmation, docs@ physician summary, requester acknowledgement | existing, live, unchanged | live |
| S7 daily expiration digest (`send-reminders`) | existing, preference-gated, unchanged | live |
| S8 CME rule change notice | after Eric approves a rule diff (section 11); only to physicians tracking that state; via the reminders channel | 3 |

**Must involve Eric, every time** (the system may draft; only he sends or decides):

| class | examples | why |
|---|---|---|
| clinical | whether a course satisfies a mandate; what to do about a lapsed license; anything answering "am I compliant" for a person | a DO's name and licence sit behind the product; a wrong yes is a board problem for the customer |
| legal | HIPAA or BAA questions, data deletion beyond the self-serve button, breach notices, terms, disputes, anything a lawyer would read | LEGAL_MEMO.md: likely a business associate; no compliance claim may be made (marketing plan line 188) |
| money | refunds, credits, price exceptions, invoices, any Stripe action, any "how much" beyond the canonical "billing is off during the beta" sentence | billing is OFF; every dollar decision is his |
| identity | email changes, account merges, access grants or revocations, forwarding-address overrides, "this is not my account" | the 2026-09-03 takeover lesson; identity mistakes are unrecoverable |
| commitments | any promise to build, fix by a date, or change a rule | feature requests become queue items, never promises |
| third parties | anything to a credentialer beyond the existing requester acknowledgement; anything to a reference; anything to a board | not our customer, not our consent |
| Eric's voice | any message signed by or attributed to him | he wrote it or he does not sign it |

---

## 7. Reliability, idempotency, identity isolation

- **Service principal.** A dedicated actor row (`support_actors`, id fixed) executed through
  `service_role` inside the broker; never an `app_admins` email, never Eric's OAuth. The
  broker's capabilities are separate bearer secrets (`supportDependencies.ts authorize()`:
  customer via Clerk, owner via Clerk + admin check, `intake` / `worker` / `delivery` via
  distinct secrets, no cross-reuse).
- **Grants.** All foundation tables and functions: RLS on, `revoke all from public, anon,
  authenticated`, `grant ... to service_role` (migration lines 441-448). Config
  (`support_operations_config`) and knowledge approval are writable only by the owner path;
  the worker capability has no write on them, so the service cannot flip its own kill
  switches or approve its own knowledge.
- **At-most-once sends.** `support_outbox` idempotency key + Resend `Idempotency-Key`;
  provider timeout or malformed success → state `unknown`, never `sent`; receipts Svix-signed.
- **Decision log.** Every automatic decision writes `support_events` with rule id, policy
  version, inputs hash; every send writes outbox id, template id, binding id.
- **Recipient invariant.** To-address = `support_mail_bindings.email` where
  `forwarding_addresses.verified_at` matches, else `suppressed`. Never `profiles.email`.
- **Sender identity.** `From: CredentialDOMD Support <support@credentialdomd.com>` for every
  automated message. Footer, verbatim: *"Sent by CredentialDOMD Support. Eric Whitney, DO reads
  every thread. Reply to reach him."* Eric's own replies keep `From: Eric Whitney, DO`. The
  Resend key used by the outbox is a separate key restricted to `support@`, not the key behind
  `whit@`.
- **Notifier.** `scripts/signup-notify.sh` iMessages Eric for every non-admin
  `support_messages` row. It must exclude rows with `support_actor_id set` before Stage 2, or
  every acknowledgement pages his phone.
- **Least-privilege database role.** The broker should run as a dedicated Postgres role
  (`support_worker`) with grants only on the `support_*` tables and two read views over
  `profiles` (id, name, access_status, notify_email) and `forwarding_addresses` (user_id,
  email, verified_at), instead of `service_role`. Application-layer capability checks stay;
  the role is the floor beneath them. Stage 2 prerequisite (i).
- **Model input discipline.** Customer text reaches any model only as a quoted data block
  labelled as untrusted, never as instructions; before any model call the text is redacted of
  other people's email addresses, NPIs, licence numbers and any second physician's name
  (rule O6 text is never sent at all). In Stage 1 the model is the local Ollama instance on the
  Studio under a separate macOS user with no keychain access; no cloud model sees ticket text
  until Eric decides otherwise (decision 9).
- **Never retry an unknown send.** `support_outbox` state `unknown` (provider timeout or
  malformed success) is alerted to the Monday report and to Eric on the urgent lane; it is
  never retried automatically, because the first attempt may have arrived.
- **Template identity lint.** Every template carries a fixed `from_identity`; a release
  check fails any template that names Eric, uses `whit@`, or sets `reply_to` to his personal
  address. Sending under his name is a SEV1 by definition.
- **Dead man's switch.** The Monday line is sent by the Ledger role from the running system.
  No Monday line means the system is down; Eric needs no other health signal.
- **Secrets the service never sees.** `profiles.anthropic_api_key`, `profiles.api_key`,
  `app_secrets.*`, Storage buckets, `documents`, health-record tables. Enforced by column and
  table grants, not by prompt.

---

## 8. Permission separation from source-editing agents

The line: **the support system has no repository, no deploy, no Git, no CLI, no shell.** It
reads tickets and writes tickets, events, outbox rows and draft files under a review folder.

What must change first: today's `ticket-agent.sh` treats an owner-filed ticket as
authorization to "implement, verify, deploy, reply" with `--dangerously-skip-permissions` and
pushes to `main`. That path and this system cannot coexist: **filing a ticket about this
system would trigger a code push.** Before Stage 0's proposals are filed as tickets, either the
hourly runner is paused or its `from_admin` build path is removed (Codex's staged container
does neither merge nor push; that is the right replacement). Until then, proposals live only
as files under this folder.

**Invariant.** The support system never inserts into `support_tickets` as the owner and never
files a ticket of any kind. Under the live runner an owner-filed ticket is a build order
(`scripts/ticket-agent.sh`, `from_admin` path); a support system that files tickets would be
able to cause code changes. Enforced by grant: the worker role has INSERT on
`support_messages` and `support_events` only.

How a feature request travels: customer message → O8 → auto ack → owner queue → Eric tags
`product` → a *ticket for the source-editing worker* is created by Eric, in-app, with
`agent_approved_at` → that worker edits in isolation → independent review → release. The
support system never creates that ticket and never sees its result except "shipped" (S5).

---

## 9. Cost limits

Measured 2026-09-18: Gemini 3.8 Flash $0.004-0.006 per scanner/Vera call, Opus 5 $0.046;
Gemini 3.8 list price doubles 2027-01-01. Recorded ai-proxy usage is $0.0632 lifetime.

| ceiling | value | on breach |
|---|---|---|
| per conversation | $0.25 | conversation goes to owner lane with a "cost cap" event; no further model calls |
| per day, all roles | $3.00 | Answer and Escalation Desk stop; acks and Clock continue (templates cost nothing) |
| per month, pilot | **$60 recommended** (the workflow synthesis argued $40; either covers 20-30x today's volume; owner decision pending) | all model roles stop; templates continue; Monday report says so |
| Registrar, Help, Outreach | $5/month each, inside the $60 | that role stops |
| Ledger | $0.30/week | skip the narrative, send the numbers |

Model per task: Stage 1 shadow runs on the local Ollama model (cost $0, no ticket text leaves
the Studio). From Stage 2, Gemini 3.8 Flash for intake, classification, drafts, summaries;
Opus 5 only for the weekly narrative. No fast mode, no Opus on customer-facing text. Degrade mode is
always "templates on, owner lane on, model off," never silence.

What $60 buys at today's volume: roughly 3,000 Gemini calls, or about 30x the current
monthly ticket volume. The pilot's cost is not the constraint; correctness is.

---

## 10. Incident response

| class | definition | detection | containment (automatic) | comms | postmortem |
|---|---|---|---|---|---|
| SEV1 | message to an unbound or wrong address; any cross-account data in a message; any instruction from a message executed | Watch: outbox row without a binding; body containing another profile's identifiers; `support_events` decision citing Q2 text as input | **trip `outbound_enabled=false` and `publication_enabled=false` immediately, by the Watch role, before any human is paged**; page Eric; hold all outbox | Eric approves any customer notice; template prepared, not sent | within 5 days, in this folder |
| SEV2 | > 20 automated sends in an hour; provider `unknown` > 5 in a day; SLA breach on an urgent ticket | Watch counters | trip `outbound_enabled`; page | none to customers | within 7 days |
| SEV3 | CME rule diff applied with a dead source; help article contradicts the app | Registrar link check; help test | revert the article; flag the rule | none | next Monday report |
| provider outage | Resend or Gemini 5xx > 15 min | Watch | queue holds; acks delayed, not lost | ack template adds "delayed" line when > 2 h | none |

Kill switches: `support_operations_config.mode`, `publication_enabled`, `outbound_enabled`,
`support_actors.enabled`, per-role flags. The Watch role may set any of them to false without
asking. Only the owner path may set them true. A human in an operating room is never on the
containment path; he is on the notification path.

---

## 11. Source-cited CME change review

The current method (`docs/CME-RULES-CHANGELOG-2026-08.md`) is right: load the regulator's own
page or codified rule, corroborate with a second official source, apply only confirmed
changes, classify confirmed / changed / unverifiable / needs-a-human-look. Make it a cycle.

1. **Cadence.** Monthly, first Monday. Registrar fetches every `sourceUrl` (72) plus each
   entry's cited rule URL, records HTTP status and a content hash, and diffs against last month.
2. **Dual-source rule.** A *changed* proposal requires two official sources that agree, quoted,
   with fetch timestamps; one source yields *needs a human look*, never a change.
3. **Diff record format.** `cme-review/YYYY-MM/<ST>.json`: `{ state, field, current, proposed,
   sources: [{url, fetched_at, quote}], classification, applies_when }`.
4. **Human gate.** Eric (or a reviewer he names) approves each *changed* record in one sitting;
   approved records go to the source-editing worker as a ticket; the support system never
   edits `stateRequirements.js`.
5. **Applicability gating prerequisite.** Ohio proved the table cannot express a condition:
   `topics[].hours` is applied to everyone (`compliance.js`, `required: t.hours || 0`). Add
   `appliesWhen` (`{ painClinic: true }`, `{ dea: true }`, `{ initialLicensure: true }`)
   and gate in `compliance.js` before encoding any conditional rule. Validate Ohio first
   (done 2026-09-18), then every entry whose `note` says DEA, operator, clinic, or initial.
6. **Link liveness.** Monthly; any 404 on a cited board page is a SEV3 for that state's
   public guide (two of Ohio's three are 404 today).
7. **Physician notice.** A change that alters a physician's tracked state goes out through
   `send-reminders` (preference-gated, S8), naming the rule and the source, never as marketing.
8. **All render targets or none.** `stateRequirements.js`, `landing/states/states-data.json`,
   `send-guide/stateGuides.json` and the state HTML must change together; the release check
   fails otherwise (Codex's help-content check already models this).

---

## 12. Tutorial and video pipeline

Input: ticket categories and help-search misses (`help_search_no_result`), never ticket
bodies from quarantined lanes. Codex's `public/knowledge/credentialdo-help.json` (12 articles
with `sourceRefs`) and the twelve recording-ready scripts in
`docs/AUTONOMOUS-EXPERIENCE-CONTENT.md` are the starting inventory.

1. Help Editor proposes an article or script from a theme with ≥ 3 tickets or ≥ 10 search
   misses in a month, citing the `sourceRefs` it checked at the current commit.
2. Fixture data only: the "Dr. Demo" profile, DEMO DATA label, invalid licence numbers,
   `example.com` addresses; AI results stubbed during recording; no provider spend, no mail.
3. Eric records (or approves a synthetic screencast); captions and transcript match the cut.
4. Publish to in-app help and an unlisted YouTube link; the article is the accessible source.
5. Measure: `help_opened` → ticket filed within 24 h (deflection), search-miss rate, article
   age vs `sourceRevision`. An article older than the commit that changed its `sourceRefs`
   is flagged stale and unpublished by the help test.

---

## 13. Consent-respecting marketing

Nothing exists in code for marketing consent: no preference table, no suppression list, no
unsubscribe link, no postal footer (`grep` across migrations, functions, landing is empty; the
only preference is the transactional `profiles.notify_email`). The standing plan already
forbids autonomous posting (line 201), mass or scraped email (line 202), and compliance
claims (line 188), and names Eric as sender (line 191).

Before any non-transactional send exists:

| required | detail |
|---|---|
| `email_preferences` | `profile_id, transactional (always true), product_updates bool, marketing bool, source, updated_at, unsubscribe_token` |
| suppression list | bounces, complaints, unsubscribes; checked by Send Gate for every send |
| unsubscribe | one-click link in every non-transactional message; honoured within 24 h; `List-Unsubscribe` header |
| CAN-SPAM | accurate From, truthful subject, postal address in the footer |
| opt-in | explicit for `marketing`; beta users are not opted in by being beta users; guide-capture leads receive the guide they asked for and nothing else unless they tick a box |
| cadence | ≤ 2 non-transactional messages per month per address |
| who sends | Outreach drafts; **Eric presses send** on anything not transactional, per his own plan |

Sender identity is the one place this document departs from the plan's line 191: automated
transactional mail is from CredentialDOMD Support; marketing mail Eric sends himself keeps his
name, because he wrote it.

---

## 14. Weekly measurable feedback loop

Metrics from `support_events`, `support_outbox`, `support_provider_receipts`, `ai_usage`
aggregates and `user_events`, never from message bodies:

| metric | definition |
|---|---|
| ack latency p50/p90 | ack send time minus message time (Stage 2+) |
| owner-lane latency p90 | Eric's first reply minus message time, business days |
| SLA breaches | owner-lane items past window + 1 day; urgent past 4 h |
| auto-answer rate | A1 sends / total conversations |
| draft agreement | Stage 1: share of Escalation Desk suggested replies Eric sent unedited, lightly edited, or discarded |
| reopen rate | tickets reopened within 14 days of close |
| quarantine count | Q1-Q3 hits, with rule id |
| cost | per role, vs ceilings; forecast to month end |
| deflection | help_opened without a ticket in 24 h |
| CME review status | states confirmed / changed / unverifiable / dead links |

**Monday report**: one Telegram line on his existing operator channel
(`CS OK|DEGRADED|INCIDENT: n conv, ack p90, owner queue n (oldest d), $spend`) plus a report file
on the Studio with the table and an Opus narrative of at most 200 words. The absence of the
line is itself the alert (dead man's switch, section 7).
**Decision list**: at most five items, each with a default that applies if he is silent for
seven days, e.g. "Approve knowledge entry K-07 (default: not published)", "Raise daily
ceiling to $5 (default: no)". Silence never turns a send on.

---

## 15. First safe stage, and what unlocks the next

**Stage 0, now, zero risk of any send** (nothing sends because nothing can):
- Codex's foundation and portal migrations stay unapplied; their tests run locally
  (81 Postgres checks and 18 portal checks pass on this machine with `LC_ALL=C`).
- This document, `FACTS-dd942168.md`, and the two reviews under `reviews/`.
- Prerequisite list, tracked as files here, **not as tickets** (section 8): (a) in-app author
  labelling by `support_actor_id` and the SupportModal copy change; (b) `signup-notify.sh`
  excludes service rows; (c) `ON DELETE CASCADE` on every new FK into the tables
  `delete-account` purges; (d) `support_inbound_bodies` for the `support@` route; (e) the
  `/credential-access/` page before the portal can ever be enabled; (f) align
  `support_submit` categories with `SupportModal` (`question`, `account` missing;
  `compliance` extra); (g) a separate `support@`-restricted Resend key; (h) Eric's written
  supersession of ticket 8e66cf06 for acknowledgements and holding notes only; (i) the
  `support_worker` least-privilege role in place of `service_role` for the broker.
- Baseline SQL (read-only) for the section 14 metrics on today's 98 tickets.

**Stage 1, shadow** (after the migration is applied with `mode='shadow'`): Intake, Policy and
Escalation Desk run on real tickets using the local Ollama model only; nothing is sent; Eric keeps replying as he does today;
Ledger measures draft agreement. Gate to Stage 2: four weeks, ≥ 30 owner-lane items scored,
zero quarantine misses on a replay of all 98 historical tickets.

**Stage 2, templates** (requires prerequisites a-c, g, h and `canary_verified_at`): S1, S2,
S3, S5 only. Gate to Stage 3: four weeks, zero SEV1/SEV2, reopen rate ≤ 10%, Eric reports
his two windows are sufficient.

**Stage 3, exact-match answers**: S4 with Eric-approved knowledge entries; each entry needs
≥ 5 identical past questions and Eric's approval. Free-form model answers to customers are
not in this document's scope at any stage; that would be a new design with a new gate.

**Stays off throughout:** anything in the "must involve Eric" table; the portal until (e);
marketing until section 13 exists; the current ticket agent's build-and-push path.

---

## 16. Challenges to the directive

Each is a decision Eric must make. Recommendation follows each.

1. **"Email users… involve him only when needed" contradicts his own written rule of
   2026-09-16** (ticket 8e66cf06: every physician ticket comes to him before any response).
   The later, verbal directive does not silently repeal the earlier written one that is
   encoded in a migration and a prompt. *Recommendation:* keep the rule for substantive
   replies; supersede it in writing for acknowledgements and holding notes only; revisit at
   the Stage 3 gate with the agreement numbers.
2. **"Act as Eric" is the single largest risk and is already the status quo.** Every automated
   email today is `From: Eric Whitney, DO`; the in-app thread labels every admin row "Eric";
   the ticket prompt says "write every reply as Eric would." His own plan calls undisclosed
   automation under a real physician identity "a reputational kill shot" (line 201).
   *Recommendation:* a service identity in mail and in the app before any autonomy, with the
   footer in section 7; Eric's name only on what he wrote.
3. **The existing ticket agent's owner-ticket path is a build-and-push loop with
   `--dangerously-skip-permissions`.** A support system that files tickets would trigger it.
   *Recommendation:* pause or replace it (Codex's isolated worker) before Stage 0 files
   anything; keep source editing and customer service permanently separate (section 8).
4. **"Minimal oversight" and "no avoidable errors" meet at the SLO.** Any daily clock on a
   neurosurgeon fails on the first call weekend and then apologises to the customer for him.
   *Recommendation:* two fixed windows a week, stated to customers, defaults-if-silent on the
   Monday list. The design trades speed for zero wrong answers, deliberately.
5. **HIPAA posture is unresolved and tickets are free text.** `LEGAL_MEMO.md` says likely a
   business associate; the standing choice is no-PHI-by-design. Physicians will paste health
   details into tickets. *Recommendation:* rule O7 keeps such text out of every model call and
   every draft; decide the posture before Stage 3, because approved knowledge answers will be
   read as the company's position.
6. **Marketing cannot start.** No consent infrastructure exists; the plan forbids autonomous
   posting and mass email. *Recommendation:* build section 13 first, and rank marketing last
   among the roles; the guides and the help centre are the marketing.
7. **The pilot budget question is the wrong question.** $60/month covers 30x today's volume.
   *Recommendation:* set $60 and spend the attention on the prerequisites in section 15.

---

## 17. Open decisions for Eric

1. Supersede ticket 8e66cf06 in writing for acknowledgements and holding notes (S1, S2)? Default if silent: no; Stage 2 waits.
2. Service identity in mail and app as specified in section 7? Default: yes, since nothing sends without it.
3. Owner windows: which two days and time?
4. Pause the hourly ticket agent's owner-ticket build path, or replace it with Codex's isolated worker? Default: pause before Stage 0 files anything.
5. Monthly pilot ceiling: $60? Default: $60.
6. HIPAA posture before Stage 3: business associate assumed, or no-PHI-by-design with O7 enforced? No default; this one cannot be silent.
7. Who may approve CME rule diffs besides Eric, if anyone?
8. Marketing: build section 13 now, or defer entirely until after first revenue? Default: defer.
9. May a cloud model (Gemini via ai-proxy) see redacted ticket text from Stage 2, or does the
   local model stay the only reader? Default: local only until you decide; this interacts with
   decision 6.

---

## Provenance and why this file is the only design

Inputs: three independent stance drafts, nine adversarial critiques (22 blockers, 67 major,
41 minor), one agent-written draft file, and one workflow synthesis (15,555 words), all
archived under `_inputs/`. This file was written by Claude from those inputs and Codex's
staged implementation; where it differs from the synthesis it does so deliberately:

| synthesis proposed | this file | why |
|---|---|---|
| a parallel `cs_*` schema (`cs_conversations`, `cs_messages`, `cs_settings`, `cs_kb`, `cs_outbound`) and a `cs_service` login role | Codex's staged `support_*` tables plus a `support_worker` role | one implementation exists and passes 81 Postgres checks; a second schema is the "two designs in circulation" failure the critiques named |
| 3-business-day owner lane with a single escalation | two fixed 30-minute owner windows a week, customer told the days | the critiques showed any daily clock fails on the first call weekend and then apologises to the customer for him |
| $40/month | $60/month | immaterial at 20-30x current volume; the prerequisites are the constraint |
| ten roles named R1-R10 | eleven functions in section 2 | same shape; Watch and Ledger split so the containment role cannot be disabled by the service |

Adopted from the synthesis: shadow stage on the local model under a separate macOS user;
dead man's switch; never retry an unknown send; quoted-data-block and redaction rules; template
identity lint; the no-ticket-filing invariant; the owner-unavailable calendar; the
least-privilege database role.
