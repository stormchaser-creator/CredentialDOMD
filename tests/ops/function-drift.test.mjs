// QA OPS-013: send-guide was deployed 2026-09-20 16:49 UTC, and two content
// fixes to the stateGuides.json it bundles landed after it, so guide emails
// kept the old fees, the old Arizona portal and the misleading Texas line.
// CI never deploys edge functions, so scripts/function-drift.mjs compares
// each deployed function with the newest commit to anything it bundles.
// These checks run offline: the import graph, the comparison and git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { functionNames, functionFiles, newestCommit, staleFunctions, SAME_CHANGE_MINUTES } from '../../scripts/function-drift.mjs';
import { relativeSpecifiers } from '../../scripts/import-graph.mjs';

test('a function bundles the JSON and shared files it imports, transitively', () => {
  const guide = functionFiles('send-guide');
  for (const f of ['supabase/functions/send-guide/index.ts', 'supabase/functions/send-guide/stateGuides.json', 'supabase/functions/send-reminders/renewalLinks.json', 'supabase/functions/_shared/clerkAuth.ts']) {
    assert.ok(guide.includes(f), `send-guide bundles ${f}`);
  }
  const view = functionFiles('admin-member-view');
  assert.ok(view.includes('supabase/functions/_shared/memberView.mjs'), 'admin-member-view bundles memberView.mjs (through memberViewHandler)');
  assert.ok(functionNames().includes('send-guide'));
  assert.ok(!functionNames().includes('_shared'));
});

test('the send-guide deploy of 2026-09-20 is older than the guide fixes it bundles', () => {
  const latest = newestCommit(functionFiles('send-guide'));
  const deployed = new Map([['send-guide', { version: 15, updated_at: Date.parse('2026-09-20T16:49:36Z'), verify_jwt: false }]]);
  const stale = staleFunctions(['send-guide'], deployed, () => latest);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].name, 'send-guide');
  assert.ok(stale[0].at > new Date('2026-09-22T02:00:00Z'), 'at least d529fb72, the Texas line fix');
  assert.equal(stale[0].probably_same_change, false);
});

test('a function deployed after its newest commit is current; one never deployed is reported without a deploy time', () => {
  const at = new Date('2026-09-28T18:21:31Z');
  const newest = () => ({ at, commit: 'abc1234', subject: 'Synthetic', files: [] });
  const deployed = new Map([['fresh', { version: 4, updated_at: '2026-09-29T18:36:26Z' }]]);
  assert.deepEqual(staleFunctions(['fresh'], deployed, newest), []);
  const missing = staleFunctions(['dormant'], deployed, newest);
  assert.equal(missing[0].deployed_at, null);
  // Deployed from the working tree, committed a few minutes later: flagged, marked.
  const late = staleFunctions(['fresh'], new Map([['fresh', { version: 4, updated_at: at.getTime() - 60_000 }]]), newest);
  assert.equal(late[0].probably_same_change, true);
  const much = staleFunctions(['fresh'], new Map([['fresh', { version: 4, updated_at: at.getTime() - (SAME_CHANGE_MINUTES + 1) * 60_000 }]]), newest);
  assert.equal(much[0].probably_same_change, false);
});

test('only relative imports count, and a commented-out import is not one', () => {
  const text = `import { serve } from "https://deno.land/std/http/server.ts";
import x from "./a.json" with { type: "json" };
export { y } from '../_shared/b.mjs';
import './side-effect.js';
const lazy = await import('./lazy.ts');
// import old from './old.mjs';
/* import older from "./older.mjs"; */
import pkg from 'react';`;
  assert.deepEqual(relativeSpecifiers(text).sort(), ['../_shared/b.mjs', './a.json', './lazy.ts', './side-effect.js']);
});
