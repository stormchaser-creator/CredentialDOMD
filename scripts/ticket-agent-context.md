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
Each message page binds the captured customer and ticket in the same database
statement as the message read. An explicit owner envelope distinguishes a genuinely
empty thread from a ticket reassigned or deleted after history selection; the latter
stops collection before any model call. These paginated reads are not one historical
database snapshot: unrelated edits during collection can still require another pass.

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
actionability and the captured approval are rechecked before insertion/stamping.
The approval timestamp is compared separately from `updated_at`: withdrawing and
reapproving a ticket cannot authorize a reply begun under the previous approval.
An originally admin-filed target must still belong to the same, still-admin profile.
New input or changed approval withholds the reply; the saved draft remains available. Related
context is never a publication target. Since 2026-09-28 a reply keeps the ticket's status
(it never reopens a resolved or archived ticket) and is stored only with a
`support_reply_verifications` row written in the same statement: the reply passed the fixed
reply rules in `scripts/ticket-fix/claims.mjs`, and the row carries the body's sha256 and an
HMAC keyed with the vault secret `support_reply_hmac_key`, which the database trigger from
migration 20260928150000 checks. Interactive sessions use the same path through
`scripts/ticket-fix/post-reply.mjs`. A result the host refuses is fed back to the same model
session, at most twice (`--validate`, `--session`), before the run counts as rejected; parked
tickets are left out of the queue; parking and a lock held over 4 h alert the owner.

Review fixes (2026-09-28): every host step (`--schema`, `--load`, `--validate`, `--session`,
`--record-and-reply`, `alert.mjs`, `reconcile.mjs`) runs from a copy of the host code taken
from HEAD before any model runs (`TICKET_REPO` names the real checkout), and a run that changes
the reply checks, the runner, the notifier, the support reply migrations or `send-ticket-reply`
records nothing and holds every later run (`HOLD-host-code-changed`). `--load` and
`--record-and-reply` need the per-run `TICKET_RUN_KEY`; the context file is signed with it, so
the agent path cannot be driven by hand. The model's commits carry a per-run committer identity
and `{{FIX_COMMIT}}` is the one such commit that touches a file cited in `verification.checks`.
The free-text reply may not report a result (`unverified_claim`); its verification records
`claims: "unbound"`. A model that fails or is killed by the alarm counts toward the breaker. The
log carries rule names only; the full refusal stays in the private run directory. Stored
replies are not emailed to members (author is the ticket owner); `--record-and-reply` prints
`"emailed": false`.
`publication: not_confirmed` intentionally prevents treating a saved draft as proof of
successful delivery. Customer publication is not an exactly-once queue; the separate internal continuation
queue below never retries a reply.

Every new legacy-compatible body starts **CredentialDOMD Support · Automated**. It does
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
for the same target, including when it falls outside the first two new-message
queue rows. Each due candidate reports its own awaiting-input state. Input arriving
after queue selection promotes that run to normal reply mode when its context is
loaded, without consuming an internal continuation attempt. No related ticket is
promoted merely by being read.

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
node --test scripts/ticket-agent-context.test.mjs scripts/ticket-agent-context-races.test.mjs scripts/ticket-agent-isolated.test.mjs
node scripts/ticket-approval.test.mjs
python3 scripts/ticket-agent-context.postgres.py
python3 scripts/ticket-agent-hostpath.test.py
python3 scripts/ticket-agent-cli-contract.test.py
zsh -n scripts/ticket-agent.sh
node --check scripts/ticket-agent-context.mjs
node --check scripts/ticket-agent-isolated.mjs
```

The PostgreSQL test requires Homebrew PostgreSQL 17 and creates an isolated synthetic database with TCP disabled and
stops it in `finally`. It exercises the exact SQL against a legacy-shaped schema:
related resolved/archived history, customer isolation, same-time pagination, optional
actor columns, approval withdrawal, stale input, a real after-insert ticket trigger,
one guarded reply, unchanged related tickets and the automated body label. It also
checks transfer between history/message reads, empty owned threads, new-input
state independent of the limited queue, reapproval without a ticket-version bump,
and loss of original admin authority without fallback to a different approval.

The Node regression reproduces an Add-button confirmation in a related resolved
conversation, >20 older messages, pages sharing timestamps, incomplete retrieval,
cross-customer/misbound records, unread attachments, wrong confirmation provenance,
invalid references, repeated questions and durable memory surviving a later summary.
Four new race regressions failed against `6058280` before the repair: related-ticket
reassignment, new input outside the first two queue rows, new input between queue
selection/context loading, and missing approval-epoch binding at publication.
Continuation regressions cover no-new-message work, owner waits, crash reservations,
approval suppression, fair bounded scheduling, no publication, and explicit completion.
Existing approval and isolated worker permission/budget tests remain required.

The full-host test runs a private copy of the legacy shell with only its fixed
repository, log, lock, CLI and case-state paths substituted. Synthetic credential
and model shims replace Keychain/provider access; the actual Node entry points,
schema checks, context collector and generated publication SQL run unchanged.
Every fetch is replaced by an adapter to a temporary PostgreSQL database over an
owner-only Unix socket with TCP disabled. There is no network fallback. Its 28
checks include normal replies, two separate customer sessions, resolved history,
approval withdrawal/reapproval, stale input, changed ownership, invalid model
output, repeated answered questions, database failure, quiet follow-through,
new-input promotion, and owner-decision waits. It does not exercise launchd or
provider authentication. PostgreSQL startup may require local process permissions
that permit shared memory; the database is always stopped in `finally`.

The installed-CLI contract test is separate from the full-host model shim. On
2026-09-19 it exercised Claude Code **2.1.221** at the legacy runner's configured
path, with the real support JSON Schema and one synthetic streaming response from
an ephemeral loopback mock API. The actual CLI produced the expected top-level
`structured_output`, which passed the trusted host assessment validator. The test
uses a fake key, an environment allowlist, `--bare`, empty settings/MCP/tools and
no session persistence. An OS profile denies network access except that specific
loopback port and denies Keychain reads/command execution. A negative socket
probe confirms unlisted destinations are denied. If the OS profile cannot apply,
the test stops before starting a model session; never retry it unrestricted.

These reproducible tests complete the local synthetic host/output-contract checks.
No real provider, customer data, production database, credential lookup, scheduler
or live worker is involved. Real API/OAuth authentication, provider model
availability, normal-mode CLI customizations and actual model answer quality are
not tested. The installed CLI uses additional isolation flags for this test;
its output contract is exercised, not every production CLI behavior. Independently
review release claims: no parser can establish that a model actually performed
the product tests it describes.

## Installation effect

Normal legacy replies remain enabled. Installing these scripts in the existing
scheduled checkout changes the next worker run; there is no separate activation
flag for history collection or internal follow-through. Existing approval gates,
the shared runner lock, two-target bound, one-hour continuation cooldown and
three-attempt limit remain in force. A source-only checkout or commit does not run
the worker. The isolated runner still requires its separate reviewed installation.

### September 19 release compatibility check

The reviewed runtime was integrated onto the current application source without
changing its runtime files. The 26 Node regressions, 43 approval checks, 34
temporary-PostgreSQL checks, 28 full-host checks and installed-CLI mock contract
all passed again on the integrated source.

Read-only production query planning accepted the five exact collector query
forms plus the reply insertion and timestamp update shapes. `EXPLAIN` ran
without `ANALYZE`, inside read-only transactions; it did not select customer
contents, execute a write or send a notification. The existing approval,
ticket-update and reply-notification triggers were present and enabled. This
checks schema compatibility, not delivery or every possible production policy.

One wholly synthetic request to the actual provider using the existing OAuth
authentication and configured model returned structured output accepted by the
trusted host validator. Tools, MCP servers, hooks, browser integration, user
settings and session persistence were disabled; no customer evidence or
communication was involved. The check required normal CLI mode: this installed
CLI's `--bare` mode explicitly excludes OAuth. It used a 60-second timeout and a
$0.50 request budget. This establishes current authentication/model/output
compatibility, not the quality of future customer investigations.

The installed launch agent was inspected read-only and runs hourly at minute 17
against the main checkout. Its schedule was not changed. To activate, acquire the
same worker lock while merging and synchronizing the reviewed source into that
checkout, then release only the lock owned by that release. Do not manually
invoke the worker as a delivery test: doing so may process approved real tickets.
Observe the next scheduled run's exit status and bounded operational summaries.

For rollback, reacquire the shared lock and revert the support release commit in
the scheduled checkout through the normal reviewed source-release path. Preserve
the private case records: the previous worker ignores them, and removing them
would discard follow-through history. Do not replay messages or delete published
replies. The application release and staged isolated runner need no separate
database migration for this support-context change.

## Stage 2: branch-only work, runner-owned gates, held merges (2026-09-28)

`ticket-agent.sh` still owns the lock, the queue, the circuit breaker and the reply
recording. Before any model runs it reads `ticket-work/AUTO_MERGE` once
(`run.mjs auto-merge`), alerts the owner when that value changed since the last run, and
passes it on. For each loaded ticket it runs `scripts/ticket-fix/run.mjs work`:

1. **Worktree.** `git fetch origin main` in the owner's checkout (refs only), then a
   worktree on a new branch `agent/<id8>-<runid>` under
   `~/Library/Application Support/CredentialDOMD/ticket-work/worktrees/`. The owner's
   checkout and branch are never touched. `node_modules` is an APFS clone (`cp -c`) of
   the owner's when the lockfiles match, otherwise of `ticket-work/modules/<lock sha>`,
   installed once with `npm ci --ignore-scripts`. It is never a link into the owner's.
2. **Reproduction.** A separate session (`repro-prompt.md`) sees the ticket and the base
   code and may write only under `tests/`. The host snapshots those tests onto base and
   runs them in a fresh worktree of the snapshot; each must fail with `ERR_ASSERTION`
   (a TypeError, a missing module or a pass is refused; one resume with the verdicts).
   The files are hash-frozen.
3. **Worker.** The fixer runs contained (`worker.mjs`): `--permission-mode dontAsk`,
   `--setting-sources ""`, explicit allow and deny rules, `--strict-mcp-config`, a fresh
   `CLAUDE_CONFIG_DIR` per session, an allowlisted environment (no database or GitHub
   token; git cannot push; hooks off) and the model credential on a pipe
   (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`), not in the environment. It may edit
   `src/`, `tests/` (not `tests/ticket-fix/`, not the frozen files), `public/` and
   `landing/`, and run exactly `npm test`, `node --test tests/<file>` and
   `npm run build:site`; it reads with Read, Grep and Glob, which only the worktree's
   Read rule allows. The reply checks and their two repairs run as before; a
   `verified_change` is refused while nothing the run changed is released.
4. **G0 and commit.** A change to the runner's own code holds every later run (exit 4);
   anything else outside the editable paths, a `.gitattributes`, `.gitignore` or
   `.gitmodules`, a symbolic link, a nested repository or a NUL byte in a source file
   refuses the run (exit 5). The host makes one commit (hooks off, author "CredentialDOMD
   Ticket Agent", committer the run identity, trailers `Ticket:`, `Ticket-Agent-Run:`,
   and `Gates:` once the gates pass).
5. **G2 and G10.** `gates/tests.mjs` records `gates.json`, running every step in a fresh
   detached worktree of the commit: the reproduction frozen and green, the declared tests
   in the diff and green, every test failing when one product hunk is reverted, no
   product line that reads the test runner or patches a global, `npm test` passing no
   fewer tests than base (less removed, plus added declarations) and no untouched test
   file passing fewer, counted from the gates reporter on the runner's own stdout (a
   test's printed "pass" line counts for nothing), `npm run build:site`, eslint errors
   per changed file not rising and `npm run lint:hooks`, the save-and-reload rule, no
   git-ignored file left behind, and G10 (`gates/personal-data.mjs`: addresses, phone
   numbers, NPI, DEA, SSN, images and base64 in tests, copied ticket text, the runner's
   credential and token shapes; rule and file names only). Every host diff reads
   attributes from base and forces text. Every existing test file the diff modifies or
   deletes is listed for the reviewer. One resume of the worker with the failing check
   names.
6. **G11.** `protected-paths.json` (database, scripts, CI, dependencies, legal pages,
   auth, admin and pricing code, and numeric literals in money modules) holds the merge
   for the owner. `gates/owner-rules.mjs` builds the blast radius from `git grep` at the
   commit and `sibling-paths.json`.
7. **G4.** `review.mjs`: a fresh `claude-opus-5-5` session at effort high with Read, Grep
   and Glob only, in a fresh worktree of the commit, given the thread, the diff,
   `gates.json`, the protected report and the blast radius, never the worker's reply or
   summary. Citations are checked against the commit (one fresh rerun for an invented
   one); every met or partial item needs one into the change; any missed path, or a
   member both excluded and missed, is not an approval. Billing, pay, invoice and sync
   diffs get two reviews that must agree. A "revise" or a missed path resumes the worker
   once.
8. **G3.** With every gate passed and the review approving, the change merges only if
   AUTO_MERGE was on when the scheduled run started (off by default). Otherwise the run is
   HELD: `ticket-work/runs/<id8>-<runid>/HELD.txt` (with the commit's tree and the gates
   digest), an owner alert and one command, `node scripts/ticket-fix/merge.mjs <run-id>`,
   which prints the same tree and digest before it pushes. The merge is fast-forward
   only; if main moved it rebases, re-runs the gates, and re-runs the review when
   `git patch-id --stable` changed; it re-runs G10; a conflict, or a changed `.git/hooks`,
   repository git config, `info/attributes` or global git config, holds it. It acts only
   on `ticket-work/worktrees/<run id>` and the configured repository.
9. **G7.** After a merge, `release.mjs` waits for `version.json` to name a build that
   descends from the fix and checks, in the live bundle, the strings the gates found in
   the head build (added, present) and the removed ones the head build no longer has.
   `{{FIX_COMMIT}}` in an agent reply needs that record.

A refused change still records the reply (it claims nothing) but counts toward the
breaker, and the record step (`TICKET_CODE_OUTCOME`) keeps its follow-up pending: a
change that is refused, held, merged but not verified, or failed its release completes
no follow-up and marks no criterion `claimed_fixed`. A continuation for a ticket with a
held change waits without a model run. One code change per scheduled run.

**Containment (stage 2 review, 2026-09-28).** The permission rules bind only the
model's own tool calls; a test file the worker writes runs whenever `npm test` or
`node --test` runs it. So every session and every gate step runs under
`/usr/bin/sandbox-exec` (`scripts/ticket-fix/sandbox.mjs`):

- no read of the keychains, `~/.ssh`, `~/.config` (gh), `~/.gitconfig`, `~/.netrc`,
  `~/.npmrc`, `~/.claude`, `.env` files, iCloud, Mail or Messages, the runner's state
  (case records, ledgers, run records, the base-count cache, the run directory) or the
  AUTO_MERGE flag;
- no exec of `security`, `osascript`, `gh` or any git credential helper, and no lookup
  of the security daemon;
- writes only to the worktree, the session's own directory and its temporary directory
  (so never the owner's checkout, its `.git`, its `node_modules`, `ticket-work` or the
  global git config);
- sessions keep outbound network for the API (not the launchd sockets that serve
  ssh-agent); gates get loopback only and no DNS resolver.

After every session and gate run the host also checks the shared git hooks and config,
the worktree's `.git` link and origin main: a change, or an agent commit on main, holds
every later run (exit 6, `HOLD-host-code-changed`); main moving for another reason alerts
the owner. `tests/ticket-fix/containment-live.test.mjs` (`LIVE_CLI=1`) runs the installed
CLI through the runner's own launcher, with no outer sandbox, and includes the two-step
escape (write a test, run it with `node --test`).

**What this still does not contain:** the macOS sandbox is the whole boundary. A session
can still send what it can read (the worktree, the public code, anything the profile does
not name) to any host, since it needs the network for the API; a test that forges the
Node test runner's serialized events from inside a test file is not detected; and
`sandbox-exec` is deprecated by Apple, though present on macOS 26. The container runner
(`scripts/ticket-agent-isolated.mjs`) remains the stronger option and the owner's
decision.

## Stage 3: every ask tracked, and screenshots actually seen (2026-09-28)

Design G1 and G6 with the critique's amendments (A3 for the reply, the G1 owner-decision and
non-ask amendments). The runner keeps its lock, queue, breaker and reply recording; stage 3
adds three host steps and changes what the worker returns.

1. **Attachments (G6).** After `--load`, `ticket-agent.sh` runs
   `scripts/ticket-fix/attachments.mjs fetch` with the management token, before any session.
   It lists the project's API keys through the management API, keeps the service key in that
   process's memory only, and downloads every attachment on the target ticket and its
   messages, plus the newest six on related tickets, from the private `documents` bucket. A
   path outside `tickets/<ticket>/` (or `tickets/<ticket>/replies/`) is never fetched. The
   bytes decide the type (PNG, JPEG, GIF, WebP, HEIC/HEIF, PDF; anything else is refused),
   HEIC becomes PNG and images over 2000 px are shrunk with `/usr/bin/sips`, files over 10 MB
   are refused, and each file is written `att-<n>.<ext>` (0600) into
   `$TMPDIR/credentialdomd-attachments.XXXXXX/<ticket>/`, next to the run directory and
   removed with it (and after each ticket's run). The host's manifest goes to
   `<run dir>/<ticket>-attachments.json`. The log carries the ticket id and storage path
   only. A failed download is `unavailable` with a reason, internal work for the next run,
   never a request to the customer.
   - The attachment root is not inside the run directory because every session is denied
     the run directory, and a deny rule beats an allow rule. Sessions of this ticket may Read
     its folder (permission rule and a read-only `readable` entry in the macOS sandbox
     profile) and are denied every folder next to it; the root is denied to the gates.
   - "reviewed" is set only when the worker's own tool events show a successful Read of that
     exact path. Every session now reports on `--output-format stream-json`; the host reads
     the Read calls and their results from the CLI's stdout, which nothing the session runs
     can write to (the on-disk transcript is in a directory the session can write, so it is
     not used). Until every delivered attachment on the ticket is read, the worker's result is
     refused and it is resumed with the paths. It gives one observation per attachment it
     read (`attachment_observations`), and an item whose message carried a screenshot must be
     in that observation's `supports`. The reviewer (or, with no change to review, a
     read-only `confirm` session) opens the same files and agrees or disputes each
     observation; a disputed or unjudged one is not an approval of a change, and the items it
     supports are not shown as done.
2. **Checklist (G1).** `run.mjs` runs an extraction session (`claude-opus-5-5`, no tools,
   `--input-format stream-json` with the screenshots inline) over every customer message no
   extraction has read. Each item is `{id AC-n, requirement, kind, source_id, quote,
   surface}`; the host checks each quote word for word against that message (customer
   sources on the target ticket only), the requirement against the fixed reply rules (it is
   shown to the customer), and, on the owner's own ticket, that an `owner_decision` is about
   price or money constants, legal copy or clinical coding (CPT, wRVU, modifiers,
   bundling). A keyword for those topics makes the extractor confirm once; it never
   reclassifies. Problems go back to the session once; a second refusal is exit 7, and the
   shell parks the ticket and alerts the owner, with no reproduction or worker run. The
   checklist is frozen in `ticket-context/checklists/<ticket>.json` (0600, digest-checked):
   later runs only add items for new messages, and a rewrite or deletion is refused.
   Sentences the extractor judged not to be asks go to the reviewer or the confirmer for a
   verdict; one judged an ask, and any missed ask whose quote checks out, becomes a new item.
   Sentences no item quotes are shown to them as hints.
3. **The host's decision and the reply (A3).** The worker returns `reply: {opening, claims,
   closing}` (claims `{ac_id, text, evidence: test | file}`), one `checklist` entry per
   frozen item and its observations; it writes no free prose for the customer and no ids.
   After the gates, the review and the merge decision, `run.mjs` verifies each claim itself
   (`scripts/ticket-fix/stage3.mjs`: a test passing in this run's gates once the change is
   released and verified, or run by the host at a base the live build contains; quoted text
   at a cited line in the live build), and decides each item's state from its own artifacts
   (`checklist.mjs finalStates`): an owner decision waits on the owner; a bug or change is
   done only on a verified claim on a test bound to that item (a reproduction or declared
   test, this run's or a released run's the reviewer found met); a change held for release
   is "in progress"; a refused change is "not done"; any other unproven "done" is "partly
   done, not confirmed yet". It writes `<run dir>/<ticket>-stage3.json`, which the shell
   passes to `--record-and-reply` (`TICKET_STAGE3_FILE`). The reply is rendered from it: a
   fixed opening, "What we confirmed:" with the verified claims only, the questions, "Where
   each part stands:" with one line per item, and a fixed closing. The record step refuses a
   free-text result and a result without a stage 3 record for that ticket. The case record
   keeps the host's state per item and the host's own follow-ups (an attachment it could not
   download, a change waiting for release, an item added after the worker ran).

The staged isolated runner keeps its free-text result (`LEGACY_RESULT_SCHEMA`).

Tests: `tests/ticket-fix/checklist.test.mjs`, `attachments.test.mjs`, `stage3-run.test.mjs`,
`stage3-reply.test.mjs`, `stage3-runner.test.mjs`, the full-host shell test (an `attachment`
scenario: download, inline image, a refused answer with no Read, the resume that reads it,
the confirmer, the verification recording it as reviewed, the files gone), and
`containment-live.test.mjs` (`LIVE_CLI=1`: the installed CLI reads this ticket's attachment
and is refused the neighbour's and any write; the extractor gets no tool and its image inline).

**Not done in this stage:** after the owner merges a held change, nothing tells the customer
it is live; the continuation that confirms it is action-only and never publishes (the case
record keeps it as pending work). The attachment download needs the service key from the
management API's key listing; the endpoint's shape was not called against production while
building this (only its documented forms, with a local stub).

## Session context and failure records (2026-09-29)

The reproduction session of 2026-09-29 16:35Z stopped at its $3 budget
(`error_max_budget_usd`, $3.0096) before it wrote a test, and the log said only "exited 1":
its stderr went to the shell's run directory, which is deleted on exit. Every turn re-reads
the prompt, and the prompt carried the full history of the owner's account (99 tickets, 308
messages and 78 KB of saved reviews, 418 KB of JSON, a first turn near 196K tokens).

- **Trimmed context** (`scripts/ticket-fix/session-context.mjs`). The reproduction and the
  worker get at most 40 KB of evidence: the target ticket and its thread (a thread too long
  for its 20 KB share keeps its first message and the newest that fit, with the count and
  dates of the rest), this ticket's saved review (pending follow-up with its exact work
  text, remembered answers, the host's last item states), answers saved on the customer's
  other tickets, and those tickets newest first: 25 in detail (subject, status, dates, the
  opening, the newest customer message) and the rest as an index. The owner's account comes
  to 30 KB. The whole first prompt stays under 96 KB (`PROMPT_LIMIT`; the runner logs one
  that does not). The extractor (one turn), the reviewer and the confirmer read what they
  read before. The run record carries `session_context` (bytes shown of the full size,
  messages and tickets shown, `history_bytes`) and `prompt_bytes`.
- **The whole history, on demand** (review of 2026-09-29). The host checks cited ids and
  completed follow-up against the full history, but its question check only compares a
  question's wording with answers saved in case reviews; it never reads the messages. With
  only the trimmed view, an answer in a related ticket's middle message (the owner's
  account: 284 customer messages, 22 shown as excerpts, 1 answer saved on another ticket)
  was invisible to the worker and would pass the host. The file for that account is 432 KB
  in 432 lines. So the runner writes the whole history to
  `case-history.jsonl` in this ticket's own attachment folder (or a fresh folder of the same
  shape when the download step made none): one JSON record per line, `kind` first (case,
  ticket, message, saved_answer, pending_follow_up, saved_review, attachment), so a Grep
  hit carries its ids. The reproduction and the worker may Grep and Read it (the folder's
  permission rule and sandbox opening, nothing else); the host facts name it and the
  prompts say to search it before any question and to read only the lines needed. It is
  removed when the run ends. A view that cannot fit its limit now fails at once (the hard
  bound looped forever once it had replaced the saved review) and is recorded as
  `host_failed` before any session starts.
- **Failure records.** `runSession` reads the CLI's result event even when it exits
  non-zero, so a failed session's reason reads
  `exited 1 (error_max_budget_usd, 57 turns, $3.0096): Reached maximum budget ($3)`.
  Every session goes on the run record's `sessions` list (role, whether it resumed, the
  result subtype, cost, turns, and for a failure the reason and the last error line) with
  a `cost_usd` total, and on one `SESSION` log line. Each session's stderr is kept under
  `ticket-work/runs/<run>/sessions/NN-<role>.stderr.log` (the newest 64 KB, owner-only in an
  owner-only directory no session can read), after `scripts/ticket-fix/redact.mjs` removes
  the runner's own credential, token shapes, values after a key or token name and any long
  opaque string. The merge command's re-reviews keep theirs there too, and go on the
  `sessions` list (`phase: merge`) and the cost total, with a `SESSION` line in the merge
  output.
- **A stopped runner** (the shell's 3-hour alarm, launchd). The stop handler kills every
  process group, writes the stderr of the session in flight (redacted, with a last line
  saying the runner was stopped), puts that session on the run record as
  `killed by SIGALRM` (or the signal it was) and marks a run still working `killed`, with
  `stopped: { signal, at }`, before it exits. Once a merge has begun the merge's own record
  is kept and only the sessions and `stopped` are added.
- **Budgets are unchanged** (worker $6, reproduction $3, reviewer $5, confirmer $3,
  extractor $2). The successful 27-turn reproduction of 17:01Z (same account) read 5.8M
  cached tokens, about $1.93 at Sonnet 5 list prices, most of it the history re-read each
  turn. With the trimmed evidence the first turn is estimated near 35K tokens instead of
  196K, and the same session near $0.70, so $3 leaves room for more than twice the turns. If a reproduction still records `error_max_budget_usd`, its `sessions` entry has
  the turns and cost to decide a new budget from.

Tests: `tests/ticket-fix/session-context.test.mjs` (the bound on a large synthetic history,
a very long target thread, multibyte text; the prompt size through `run.mjs`; an answer in
a related ticket's middle message found in the case history file the sessions may read; a
view that cannot fit fails instead of looping, and is a recorded host failure),
`tests/ticket-fix/session-failure.test.mjs` (a stand-in CLI that stops at its budget: the
reason, the run record, the log, the kept and redacted stderr after the run directory is
gone), `tests/ticket-fix/session-signal.test.mjs` (SIGALRM to `run.mjs work` during a
hanging stand-in session: its stderr and the run record) and the merge re-review record in
`tests/ticket-fix/merge.test.mjs`.
