# CredentialDO autonomous operations

Status: implementation in progress, 2026-09-18. Billing remains off. No autonomous support sender, recipient portal, marketing campaign, or new production schedule has been activated by this branch.

## Outcome and operating authority

The owner's September 18 directive is to run routine customer service, product improvement, help content and marketing with minimal owner involvement. It supersedes older guidance that every ordinary support reply must wait for Eric or be signed as him. Automation identifies itself as CredentialDO Support; it never impersonates Eric. The owner remains the decision-maker for new spending, charges/refunds outside an approved policy, identity/access changes, irreversible data operations, legal commitments, and physician-specific interpretation of clinical/regulatory requirements.

Routine approved help, acknowledgments, status explanations and follow-up should not require an owner tap after the pilot qualifies. Existing verified facts—including the approved planned $149/$245 annual pricing and billing-off status—may be explained accurately. They may not become invented guarantees or new commercial commitments. Owner silence is never permission to expand authority.

Claude's independent design is preserved in `CLAUDE-OPERATING-MODEL-REVIEWED-INPUT.md`. It provides useful delivery, role and incident controls. His latest revision agrees on reusing `support_*` and separating customer service from source-editing agents. We also adopt truthful service identity, execution-time pauses, verified recipients, explicit unknown delivery, source review, and synthetic staging. His proposed fixed owner review windows, continued approval of ordinary replies, blanket marketing restriction and default $60 budget are not accepted authority: the latest owner directive authorizes bounded routine service, while timing and new spending remain undecided. We will not promise review windows the owner has not chosen. A database role restricted to the required support operations is a deployment prerequisite; the current server adapter still uses the standard service credential and is not yet that boundary.

## Workstreams and current state

| Workstream | Built here | Still required before it runs |
| --- | --- | --- |
| Support intake and replies | Feature-gated ticket UI and protected actor labels; transactional intake; stable retry IDs; protected service identity; owner-scoped jobs; approved FAQ matching; durable email outcomes; privileged operations separated | Real Clerk/Resend staging and receipt configuration; narrow broker database grants; monitoring; pilot |
| Private credential access | One exact recipient; selected synced documents; one-time invitation plus email code; short session; revocation; digest-checked files; access-request history; owner/recipient UI with local PDF preview | Real staging; dedicated secret; provider tracking disabled; private cleanup schedule; enforced live HTTP privacy headers |
| Help and onboarding | Versioned product knowledge; written help center; 12 short video scripts with recording checklists; corrected navigation/reminder claims | Record actual product footage with synthetic data, add captions and publish reviewed videos |
| CME desk | Source-cited review process; Ohio public/email guidance correction and consistency checks | Source registry and scheduled fetch/diff worker; first reviewed source baseline; escalation path for material rule changes |
| Product improvement | Isolated repair workflow and tests; actual Vera failure repaired separately | Wire aggregated support themes/error trends to a prioritized backlog and safe release gates |
| Marketing | Approved factual content rules, proposed cadence and draft templates | Confirm distribution accounts/audiences and existing consent; review first campaign; automate only approved content boundaries |
| Oversight | Authority and release policy in this plan; source-specific implementation runbooks | Live health checks, alerts, cost ledger, weekly operating report and pause control |

## The customer-service loop

1. A request receives a durable ID before any acknowledgment. App messages and, once integrated, authenticated support email enter one conversation with channel/provenance retained.
2. Rules assess account ownership, sensitivity, unsupported actions and urgency. The model may suggest a draft or a stricter escalation; it cannot relax an access check, choose an arbitrary recipient, send arbitrary SQL, invoke git or change permissions.
3. The responder uses versioned, source-backed product knowledge. It uses exact approved answers when appropriate. For an account-specific issue it can state verified workflow status only through narrow authorized readers, without access to credential contents or unrelated accounts.
4. The sender rechecks current conversation state and verified recipient immediately before sending. A response to an older message is superseded. Only the service actor can author an automated reply.
5. The delivery record separates queued, accepted, delivered, failed and unknown. Unknown is investigated or retried with the same provider idempotency key while valid; it is never assumed unsent and resent under a new key.
6. A ticket closes only after evidence of resolution or a clearly disclosed inactivity policy. Opening a share sheet or preparing bytes is never called proof of delivery or reading.
7. An unresolved dependency produces a useful status update and a tracked next action. No invented “I sent it” or silent ticket abandonment.

Pilot service targets, to be measured rather than advertised as guarantees: acknowledgment within 2 minutes, routine supported answer within 5 minutes, stalled queued jobs detected within 5 minutes, and an actionable owner escalation for security incidents immediately. Human-dependent matters get an honest status without promising Eric a response deadline during surgery.

## Continuous improvement and release policy

Daily: reconcile unresolved tickets, failed/unknown mail, stale jobs, exceptions and sanitized client-error clusters. Produce a ranked work queue based on user impact, recurrence and evidence. A model-generated ticket is never automatically an unrestricted build command.

For a repair: reproduce with synthetic data; isolate the change; implement; run meaningful regression checks; obtain independent Codex/Claude review; merge current production changes without overwriting them; publish only the reviewed scope; verify the actual deployed version; link the evidence and follow up on the original issue. The Vera reference failure is the first concrete example: a compact snapshot omitted contacts, the prompt falsely claimed completeness, and a separate worker's multi-share text also omitted contacts.

After a successful pilot, standing automatic release scope can include reversible help/copy/accessibility corrections and bounded bug fixes with proven tests. Changes to authentication, recipient binding, database access, clinical rules, billing, deletion, new vendors or spending require the corresponding owner decision and deployment checks. The goal is low owner workload, not unchecked production access.

CME: monitor authoritative board/statute sources, save fetch time/source hash, distinguish broken links from changed requirements, create a source diff with effective date and applicability, and seek qualified review for substantive interpretation. Never silently turn a scraped sentence into a new physician obligation. Release checks compare app, public guide, email guide, assistant context and transcript so one corrected rule cannot remain wrong elsewhere.

Help/videos: prioritize tasks associated with failed attempts and repeated tickets. Publish written steps first; record real product interactions with synthetic accounts; verify labels and completion; add captions and a written alternative. Scripts are not finished videos. Re-record when affected UI changes.

Marketing: use approved planned pricing/beta terms, actual capabilities and real evidence. No fabricated testimonials, clinical outcome claims, guaranteed compliance or invented traction. Begin with owned educational pages and consented onboarding/lifecycle messages. Public posting and campaigns remain bounded to approved accounts, audience and cadence; no mass cold outreach or unrelated account discovery. Privacy/legal inboxes and opt-outs receive stricter handling.

## Owner experience

One weekly digest: active users and task completion, support wait time and resolution, failures/reopens, deployment/rollback outcomes, CME changes awaiting review, help gaps, marketing results and actual cost. Include at most five decisions, each with the exact change, cost, evidence and effect of waiting. Send no repetitive “unchanged” updates. Interrupt immediately for confirmed exposure, failed containment, charging errors or an outage requiring the owner.

Owner controls: pause outbound mail, pause automated changes, revoke recipient access, view the current queue and decision history, and inspect monthly cost. Pauses are enforced at execution time, not merely in a prompt. Automation may contain an incident by pausing itself; it may not independently re-enable privileges after a security incident.

## Costs and activation sequence

No new paid service or higher spending ceiling is authorized by this document. The owner budget question is still pending. Claude now proposes a $60/month pilot ceiling; that is a proposal, not measured usage or approval, and cannot become a default through silence. Reuse existing hosting/database/mail where limits allow, use deterministic routing and approved answers first, and measure per-conversation/model/provider cost before enabling broader AI drafts. Existing model evaluation is task-specific and does not justify an expensive model for every turn.

1. Finish independent review and current schema/security reconciliation. Do not apply an entire legacy migration history to production.
2. Complete browser and real staging exercises using synthetic files and controlled mailboxes: correct/wrong recipient, token expiry/replay, changed documents, delivery uncertainty, deletion, account switch and revocation.
3. Provision only the necessary dedicated credentials and gates; verify provider tracking/retention and actual permission boundaries. Run draft/shadow mode first.
4. Enable a controlled owner canary, then routine approved help for a bounded group. Observe real delivery receipts and no duplicate/cross-account sends before wider rollout.
5. Add email intake, follow-up clocks, health/cost checks and a quiet weekly report. Expand autonomous repair/content publication only as evidence supports the defined scope.
6. Publish truthful documentation and privacy information when behavior actually changes. Keep billing off throughout this work.

Implementation contracts and test evidence: `AUTONOMOUS-SUPPORT-IMPLEMENTATION.md`, `CREDENTIAL-PORTAL-IMPLEMENTATION.md`, `AUTONOMOUS-EXPERIENCE-CONTENT.md`. This plan does not assert those prerequisites are complete.
