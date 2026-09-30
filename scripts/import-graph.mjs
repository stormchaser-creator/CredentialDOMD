// The local files a module pulls in, followed transitively: every relative
// import, export-from, side-effect import and dynamic import('...') with a
// literal specifier, JSON imports included. Remote specifiers (https:, npm:,
// jsr:, bare package names) are not followed.
//
// Used by scripts/function-drift.mjs (which files an edge function bundles,
// so a change to any of them is caught before the deploy goes stale) and by
// tests/ops/deploy-paths.test.mjs (which files outside src/ the app bundle
// imports, so the deploy workflow's path filter cannot miss one).
import fs from 'node:fs';
import path from 'node:path';

const SPECIFIERS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const EXTENSIONS = ['', '.js', '.jsx', '.mjs', '.ts', '.tsx', '.json', '/index.js', '/index.jsx', '/index.mjs', '/index.ts'];

/** Relative specifiers written in one source text. */
export function relativeSpecifiers(text) {
  const out = new Set();
  // Line and block comments often quote an import; they are not imports.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const re of SPECIFIERS) for (const m of code.matchAll(re)) if (m[1].startsWith('./') || m[1].startsWith('../')) out.add(m[1]);
  return [...out];
}

/** The file a relative specifier points at, or null when none exists. */
export function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec.split('?')[0]);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every local file reachable from the entries (entries included), absolute paths. */
export function importClosure(entries) {
  const seen = new Set();
  const stack = entries.map((e) => path.resolve(e));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const spec of relativeSpecifiers(text)) {
      const target = resolveSpecifier(file, spec);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return [...seen].sort();
}
