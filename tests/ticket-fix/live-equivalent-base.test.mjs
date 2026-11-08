// A run starts from main; a push that touched only the runner (scripts/,
// tests/) never redeploys the web app, so main's head is not in the live
// build although the live app is the same. The claims check treats such a
// base as live (16ba1758, 2026-11-07: every claim failed "not live yet").
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deployPaths, sameAppAsLive } from '../../scripts/ticket-fix/stage3.mjs';

const YAML = `on:
  push:
    branches: [main]
    paths:
      # Don't trigger on doc-only changes.
      - 'src/**'
      - 'public/**'
      - 'index.html'
      - 'scripts/package-site.mjs'
  workflow_dispatch: {}
`;
const LIVE = 'a'.repeat(40), BASE = 'b'.repeat(40);
const fakeGit = ({ ancestor = true, changed = [], yaml = YAML } = {}) => ({
  isAncestor: (a, b) => (a === LIVE && b === BASE ? ancestor : false),
  fileAt: (commit, file) => (commit === BASE && file === '.github/workflows/deploy-gh-pages.yml' ? yaml : null),
  diffNames: (a, b) => (a === LIVE && b === BASE ? changed : null),
});

test('the deploy paths are read from the workflow', () => {
  assert.deepEqual(deployPaths(YAML), ['src/**', 'public/**', 'index.html', 'scripts/package-site.mjs']);
  assert.equal(deployPaths('name: x'), null);
});
test('a base after the live build that changed only runner files is the live app', () => {
  assert.equal(sameAppAsLive(fakeGit({ changed: ['scripts/ticket-agent-context.mjs', 'tests/ticket-fix/reply-hold.test.mjs'] }), BASE, LIVE), true);
});
test('a base that changed a published file is not the live app', () => {
  assert.equal(sameAppAsLive(fakeGit({ changed: ['scripts/ticket-agent-context.mjs', 'src/utils/billing.js'] }), BASE, LIVE), false);
  assert.equal(sameAppAsLive(fakeGit({ changed: ['scripts/package-site.mjs'] }), BASE, LIVE), false);
});
test('not after the live build, or nothing known: not the live app', () => {
  assert.equal(sameAppAsLive(fakeGit({ ancestor: false, changed: [] }), BASE, LIVE), false);
  assert.equal(sameAppAsLive(fakeGit({ changed: null }), BASE, LIVE), false);
  assert.equal(sameAppAsLive(fakeGit({ yaml: 'name: x' }), BASE, LIVE), false);
  assert.equal(sameAppAsLive(fakeGit(), BASE, null), false);
});
