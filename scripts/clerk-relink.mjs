#!/usr/bin/env node
/** Retired: the old report joined an editable email and read a credential store.
 * No credentials, network, file moves, identity writes, or activation here.
 */
console.error('The legacy Clerk relink report is retired. Use scripts/clerk-continuity-plan.mjs with reviewed authenticated-provider snapshots, then the protected initialization runbook. This command changes nothing.');
process.exitCode = 1;
