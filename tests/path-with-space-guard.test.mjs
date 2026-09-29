import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// new URL(..., import.meta.url).pathname percent-encodes a space, so a checkout
// under a folder with a space ("Application Support", "Mobile Documents")
// resolves to ".../Application%20Support/..." and the file is not found. The
// ticket runner tests every fix in a worktree under Application Support; 18
// suite failures there refused every change on 2026-09-29. Use fileURLToPath.
// (Reads files directly: git is not available inside the runner's sandbox.)
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PATTERN = /new URL\([^)]*import\.meta\.url\)\.pathname/;
function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.(mjs|js|jsx|ts)$/.test(name)) yield full;
  }
}
test('no test or script builds a file path from import.meta.url with .pathname', () => {
  const hits = [];
  for (const top of ['tests', 'scripts', 'src', 'supabase/functions']) {
    for (const file of sources(path.join(ROOT, top))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (PATTERN.test(line) && !file.endsWith('path-with-space-guard.test.mjs')) hits.push(`${path.relative(ROOT, file)}:${i + 1}`); });
    }
  }
  assert.deepEqual(hits, [], `use fileURLToPath(new URL(...)) instead:\n${hits.join('\n')}`);
});
