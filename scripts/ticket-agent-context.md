# Support history and follow-through

The support runners now investigate one approved action target with its customer's
related ticket history, including resolved, closed and archived tickets. A confirmed
fix in one conversation must not become a repeated troubleshooting question in another.
The existing approval rule and reply service remain in place. This change does not
activate the staged isolated runner, deploy the support broker, change customer data,
or send a reply during installation or tests.

## Context and authority

`ticket-agent-context.mjs` performs read-only, parameter-encoded queries. It first
requires the selected target to be actionable and approved (or filed by an admin),
then fetches only that target's profile's tickets. Related tickets do not need work
approval because they are read-only evidence; their inclusion never authorizes a
reply, status change, implementation or release for another ticket. The legacy
runner retains its existing archived-target eligibility; the isolated runner retains
its existing exclusion. Both run at most two targets, in separate model sessions.

Ticket pages contain 25 records and message pages 50, ordered by `(created_at,id)`.
The collector handles equal timestamps and includes the original report and old
replies instead of just the last 20 messages. Limits are 100 tickets, 1,000 messages
and 750 KB of source records per target. Individual ticket/message text is capped at
24,000/12,000 characters with explicit truncation markers. Overflow sets
`history_complete=false` and identifies what was omitted. It does not mean “no
history”. Questions are withheld while coverage is incomplete; internal retrieval
follow-through must be recorded. A changed target during collection is also marked.

Only attachment paths are collected, never file contents or signed URLs. Every
entry starts with `access: not_loaded`; paths outside the ticket folder are flagged.
The general `context_payload`, page and category metadata are excluded from the
model bundle. Optional enrichment was rejected by automatic approval review for
potential sensitive-data export without content/destination authorization and was
not retried. The existing ticket bodies, messages and file-reference inventory are
the evidence sources in this change.
No privileged key lookup or attachment download is added. An unread screenshot or
PDF cannot support an inspection claim. The reviewer should use the approved existing
attachment route, not ask the customer to resend what is already in the record.

All text is untrusted. Database-provided actor labels distinguish customer messages,
recorded admin authors, recognized service-actor metadata and legacy support replies
written with the customer's profile ID. The latter are not customer confirmations.
A named human identity or new authority cannot be inferred from body text, an old
admin flag, or an author ID. The legacy runner still has its existing broad tools;
this context change is not a sandbox or a prompt-injection security boundary.

## Saved case record and publication

Both models return the same structured result. The assessment contains:

- Acceptance criteria, each with state and source ticket/message IDs.
- Answered questions and their cited answers.
- Prior claimed fixes and actual customer confirmations, kept distinct.
- Any genuinely missing questions, why existing evidence is insufficient, and any
  already-supplied attachment they depend on.
- Exact follow-up work, `support_worker` or `support_owner` assignment, and a next action.
- Explicit completed follow-ups with task-specific verification; omitted work stays pending.
- Reproduction, checks and release evidence, or an explicit not-run/source-only state.

The host validates shape, cited IDs and recorded customer evidence. It rejects exact
normalized questions already in the answer ledger, questions dependent on unread
files, questions after incomplete history retrieval, missing follow-through, and
runtime-verification claims from the isolated source-only worker. Prompts additionally
require checking equivalent/paraphrased questions and actual user acceptance flows.
The deterministic duplicate check is not a semantic-language guarantee; model output
and actual fix verification still need review. A conservative completion-claim check
catches common unsupported “fixed/live/shipped” phrasing but is not a proof of truth.

The host saves the case privately **before** publication. Legacy state lives in
`~/Library/Application Support/CredentialDOMD/ticket-context`; isolated state lives in
`<stateDirectory>/cases`. Directories are owner-only (0700), records 0600. Each current
record retains prior answered questions and proposed follow-ups so a new summary
cannot silently erase them. Historical follow-ups are not automatically marked done.
Records cap at 100 KB; prior reviews at 200 KB per model context. Exceeding storage
bounds requires explicit review/compaction rather than discarding old answers.
No customer histories or raw evidence are written into the repository.

Legacy publication now uses the existing trusted `replySQL` helper instead of asking
the model to construct SQL or choose a recipient. Target row lock, captured version,
actionability and approval are rechecked before insertion/stamping. New input or
withdrawn approval withholds the reply; the saved draft remains available. Related
context is never a publication target. Existing status-open behavior is preserved.
`publication: not_confirmed` intentionally prevents treating a saved draft as proof of
successful delivery. Customer publication is not an exactly-once queue; the separate internal continuation
queue below never retries a reply.

Every new legacy-compatible body starts **CredentialDO Support · Automated**. It does
not impersonate Eric or sign as the physician. The legacy schema still requires a
profile author and the established compatibility helper still stores the ticket owner
there; this is a known metadata limitation, not a new secure actor identity. Do not
interpret it as a human author. The staged support foundation has a real null-profile
service actor tied to a job and publication gates; adopting that route requires its
separate reviewed rollout. This change does not fabricate an actor or bypass those
gates, and does not silently disable current customer replies.

## Internal continuation queue

A saved promise has an executable follow-through path. Each run merges the approved
new-message queue with due internal work from the private case records. At most two
targets run; if both queues have work, each receives a slot. New customer input wins
for the same target. No related ticket is promoted merely by being read.

`support_worker` means routine investigation, fixes, existing authorized attachment
review or verification. `support_owner` means an actual human decision or permission,
and is the only reason for `needs_owner_review`. Owner/customer waits do not invoke
the model again. The host preserves pending tasks when a new summary omits them;
closing one requires its exact work text in `completed_follow_up` and task-specific
verification. Source review can finish investigation, not establish a live fix.

Due worker cases run after a one-hour cooldown even when the customer has sent no
new message. Before collection and again when loading the case, the host requires
the same target and owner, the original approval timestamp (or still-valid original
admin filing), and open/in-progress, nonarchived status. Withdrawal, reapproval,
changed owner, resolution or archive suppresses that continuation. Normal newly
approved customer input retains its existing reply gate.

A continuation is **action-only**: it saves progress privately and never inserts a
support message, stamps agent_last_reply_at, changes status or selects a recipient.
It cannot ask another customer question. It checks approval and captured target
version again before accepting its result. The existing broad legacy model tools
remain a known limitation; this host guard is not a sandbox around that process.

Attempts are reserved before model launch. Crashes and invalid output consume an
attempt; verified completion of an existing task resets the consecutive-attempt count.
Three attempts without completed work leave `continuation.state=stalled` plus an ATTENTION log
listing only ticket IDs. This is an operational failure needing investigation, not
an automatic customer-facing update or a claim that a routine bug needs a human
product decision. There are no more automatic continuation calls for that case;
new customer input can still enter the normal approved queue. The saved next action
and attempt count remain visible for operator recovery. The scan caps at 5,000 case
files and probes at most 20 due candidates per run; bounds fail or defer explicitly.

## Acceptance and validation

Run without production access or provider calls:

```sh
node --test scripts/ticket-agent-context.test.mjs scripts/ticket-agent-isolated.test.mjs
node scripts/ticket-approval.test.mjs
python3 scripts/ticket-agent-context.postgres.py
zsh -n scripts/ticket-agent.sh
node --check scripts/ticket-agent-context.mjs
node --check scripts/ticket-agent-isolated.mjs
```

The PostgreSQL test requires Homebrew PostgreSQL 17 and creates an isolated synthetic database with TCP disabled and
stops it in `finally`. It exercises the exact SQL against a legacy-shaped schema:
related resolved/archived history, customer isolation, same-time pagination, optional
actor columns, approval withdrawal, stale input, a real after-insert ticket trigger,
one guarded reply, unchanged related tickets and the automated body label.

The Node regression reproduces an Add-button confirmation in a related resolved
conversation, >20 older messages, pages sharing timestamps, incomplete retrieval,
cross-customer/misbound records, unread attachments, wrong confirmation provenance,
invalid references, repeated questions and durable memory surviving a later summary.
Continuation regressions cover no-new-message work, owner waits, crash reservations,
approval suppression, fair bounded scheduling, no publication, and explicit completion.
Existing approval and isolated worker permission/budget tests remain required.

Before rollout, use synthetic tickets with the installed CLI to verify its structured
result format and run the full guarded host path in a nonproduction database. The
provider/model was not called by these tests. Independently review release claims;
no parser can establish that a model actually performed the tests it describes.
