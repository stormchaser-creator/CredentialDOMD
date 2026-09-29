#!/usr/bin/env node
// Dry check of one structured reply for one ticket: the same verification and
// rendering post-reply.mjs does, with no database access and nothing stored.
//
//   node scripts/ticket-fix/verify-claims.mjs --ticket <uuid> --reply <file.json|->
//        [--gates <gates.json>] [--fix <commit>] [--json]
//
// Exit: 0 every claim confirmed; 2 refused by a fixed rule or a malformed
// file; 3 some claims would render under "Not done yet"; 1 error.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as postReply } from './post-reply.mjs';
import { isMain } from './is-main.mjs';

export const main = (argv = process.argv.slice(2), deps = {}) => postReply(argv, { ...deps, dryRunOnly: true });

if (isMain(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
