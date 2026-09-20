#!/usr/bin/env node
// List entrypoints that import Clerk verification, including shared adapters.
// Discovery only: no provider access and no deployment.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function listClerkFunctions(root) {
  const base = resolve(root);
  const verifier = resolve(base, '_shared/clerkAuth.ts');
  const dependencies = new Map();
  function imports(file) {
    if (dependencies.has(file)) return dependencies.get(file);
    if (!existsSync(file)) throw new Error(`Missing local import: ${relative(base, file)}`);
    const source = readFileSync(file, 'utf8');
    // These edge entrypoints use static imports/re-exports. Restrict traversal to
    // literal local paths; remote dependencies cannot make a route Clerk-owned.
    const matches = [...source.matchAll(/\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)];
    const files = matches.map((match) => resolve(dirname(file), match[1]));
    for (const local of files) {
      if (!local.startsWith(base + sep)) throw new Error('Local import escapes functions directory');
    }
    dependencies.set(file, files);
    return files;
  }
  function reachesVerifier(file, seen = new Set()) {
    if (file === verifier) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return imports(file).some((child) => reachesVerifier(child, seen));
  }
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && existsSync(resolve(base, entry.name, 'index.ts')))
    .filter((entry) => reachesVerifier(resolve(base, entry.name, 'index.ts')))
    .map((entry) => entry.name).sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/functions');
  const names = listClerkFunctions(root);
  if (!names.length) throw new Error('No Clerk entrypoints found; refusing an empty deployment list');
  process.stdout.write(names.join('\n') + '\n');
}
