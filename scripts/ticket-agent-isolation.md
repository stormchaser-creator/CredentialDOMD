# Staged ticket-worker isolation

## Current status

This is a replacement runner prepared for review. **It is not activated by merging
these files.** The existing `ticket-agent.sh`, prompt, launchd `:17` run and cron
`:47` run are untouched. Do not interrupt replies while provisioning the replacement.
There is no automatic fallback from this runner into the unrestricted old runner.

The current runner explicitly tries **Claude subscription OAuth first** and only
falls back to the Keychain item named `Anthropic API` if OAuth is unavailable. This
inspection did not retrieve either credential. It does not establish that the
worker uses the app's API key, and a separate API identity changes its billing from
the usual subscription path. No key was created, rotated, or copied for this change.

## What is implemented

- One approved ticket and its last 20 messages per model session. Different reporters
  never share a model context. At most two tickets per scheduled invocation.
- The September 16 rule is enforced in trusted SQL: owner tickets or tickets with
  `agent_approved_at`. Archived tickets are excluded. A failed query raises an error;
  it cannot become an empty queue.
- A disposable, non-root container gets client-source files only. It gets no home
  mount, `.git`, SSH agent, Docker socket, production environment, database token,
  Supabase credentials, Git credentials, or deployment credentials.
- Only Read, Glob, Grep and Edit are available. Edits are scoped to existing `src/`
  files. Shell commands, new-file Write, web tools, agents, skills, hooks, browser
  integration and MCP are disabled. The CLI uses `dontAsk`, never permission bypass.
- The model cannot send a reply directly. The host broker validates its JSON and
  can post only to the captured ticket, after rechecking approval and `updated_at`.
  SQL text is encoded, never interpolated as executable model output. It leaves
  the ticket open; Eric resolves it.
- Original and modified source snapshots plus a private review summary are retained
  outside the checkout. The runner never executes model-edited code, installs its
  dependencies, merges it, or pushes it. A person or independent reviewer verifies
  and ships a prepared change. A reply must say when a change is awaiting review.
- Each call reserves its full configured allowance in an owner-only persistent
  ledger before launch, including calls that crash or produce unusable output.
  The example allows $2 per ticket, at most $12 of reservations per UTC day and a
  ten-minute timeout. Corrupt accounting stops with an error, not a fresh balance.
- It shares the existing worker lock to prevent overlapping old/new runs. Container
  cleanup runs even on failure. Logs exclude ticket bodies and subprocess output.

## Prerequisites and activation

1. Create a dedicated Anthropic API workspace/project for this worker. Configure a
   provider-enforced spending limit appropriate to the owner and store its key in
   a new Keychain item with service `CredentialDOMD Ticket Worker API`. The generic
   `Anthropic API` item and subscription OAuth are not accepted fallbacks. Do not
   put the key in a JSON file, source file, command argument or image.
2. Review the Dockerfile and its dependencies. Build using a reviewed digest-pinned
   Node 24 Debian base and a reviewed pinned Claude Code version. The default
   2.1.221 matches the locally inspected CLI; pinning is not a claim that it has no
   vulnerabilities. Record the resulting immutable image digest in the private
   configuration. The runner uses `--pull=never` and will not download an image.
3. Copy the example configuration to a private location outside this repository,
   set its paths/image, keep `sendReplies: false`, and confirm the provider budget
   only after actually configuring it. The example intentionally fails validation.
4. Run `node scripts/ticket-agent-isolated.mjs --check /absolute/private-config.json`.
   This checks local configuration/image presence without retrieving credentials or
   invoking a model. It is not an end-to-end verification.
5. Before processing real tickets, run a synthetic canary in the exact pinned
   container. Prove the installed CLI starts with these flags and can read/edit
   `/work/src/`, but cannot read a host marker, `/proc/self/environ`, a hidden file,
   `/work/package.json` through Edit, or anything outside the workspace; cannot run
   shell, web, agents or MCP; and cannot inherit local hooks/settings. Verify a
   tool refusal, valid structured output, timeout cleanup and reported cost. Use
   only synthetic data for this canary. The unit tests do not prove these runtime
   properties, and this change did not make a paid provider call.
6. Run against an owner-approved test ticket with sending still disabled. Review
   the proposed reply and source files. Test the broker's SQL in a rolled-back
   synthetic database fixture, including withdrawal and a committed newer reply
   while the model is running. Confirm the post/stamp transaction and existing
   support-message trigger coexist. No live SQL was executed for this change.
7. After those checks, enable replies and update the one scheduled entry point to
   invoke the new runner. Preserve both existing schedule times and shared lock.
   Observe an approved test reply landing with status open. Only then retire the
   old entry point. Do not leave the old runner active as a failure fallback.

A failed canary means the old working service is still in place and the replacement
is not activated. During cutover, surface runner failures rather than reporting
idle. No maintenance lock should be left behind across a review session.

## Limits and remaining work

The CLI budget is a spending control, not a guarantee that a final in-flight call
cannot exceed the allowance. The local ledger reserves configured maxima, not an
invoice; provider project limits are the independent boundary. The API key is a
credential inside the container process, so exact-version tool isolation must pass
the canary. The container has outbound networking for Anthropic; no network tool is
available to the model. If arbitrary execution is enabled later, add an outbound
allowlist and a separate test sandbox before granting that tool.

The host broker still holds a broadly privileged Supabase management credential;
it never exposes it to the model or accepts SQL from the model. A future dedicated
server-side ticket API with narrowly scoped authentication would reduce the
broker's own privilege further. Source allowlisting excludes environment/Git/server
files; it cannot prove someone never hardcoded a secret in client source.

Freshness is checked against a committed ticket row. The existing system's
`agent_last_reply_at` timestamp protocol is retained. It is not a durable message
queue and does not establish strict ordering against a message transaction that
started earlier and commits after the broker. A future ticket broker API should
acknowledge exact message IDs if strict delivery ordering is required.

Automatic deployment is deliberately absent from the isolated process. Restoring
it requires a separate trusted review/publish step; adding Git tokens or production
SQL to the model would undo the isolation. This affects how quickly a source fix
ships and must be included in the cutover decision.

## Verification performed

`node --test scripts/ticket-agent-isolated.test.mjs`: six synthetic suites pass.
`node --check scripts/ticket-agent-isolated.mjs`: passes.
The existing approval suite remains applicable because its runner/prompt are unchanged.

References checked against the installed CLI help and primary documentation:
[Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference),
[permissions and their limits](https://code.claude.com/docs/en/permissions).
