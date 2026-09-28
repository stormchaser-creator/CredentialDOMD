// G11: protected paths and the blast radius (design G11, host fixed rules).
//
// protectedReport: a change to any path in protected-paths.json, or to a
// numeric literal in a money module (or on a money line anywhere in the
// product), holds the merge for the owner whatever AUTO_MERGE says.
//
// blastRadius: for every export the diff changes, every string it removes
// and every object key it drops, the sites in the tree the diff did not
// touch (git grep at head), plus the sibling groups (sibling-paths.json) the
// diff touched only in part. The report goes to the independent reviewer,
// which must exclude each untouched sibling with a reason.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../worktree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROTECTED_CONFIG = path.join(HERE, '..', 'protected-paths.json');
export const SIBLING_CONFIG = path.join(HERE, '..', 'sibling-paths.json');
export const loadJSON = file => JSON.parse(readFileSync(file, 'utf8'));

export function globRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') out += '[^/]*';
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
const matchesAny = (file, patterns) => patterns.some(p => globRegExp(p).test(file));

// Numeric literals on a line, outside identifiers (so v2, h1 and 0x ids are
// not money): 1, 1.5, 1,000, .75.
export function numericLiterals(line) {
  return [...String(line).matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?![\w])/g)].map(m => m[1].replace(/,/g, ''));
}
const multiset = values => values.slice().sort().join('|');

// Changed lines per file of base..head.
export function changedLines(dir, base, head, files, { binary = 'git' } = {}) {
  const out = {};
  if (!files.length) return out;
  const diff = git(dir, ['diff', '-U0', '--no-color', '--no-renames', base, head, '--', ...files], { binary, allowFail: true }) || '';
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') file = line.slice(6); continue; }
    if (line.startsWith('--- ')) { if (line !== '--- /dev/null') file = line.slice(6); continue; }
    if (line.startsWith('diff --git ')) { const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line); file = m ? m[2] : null; continue; }
    if (!file) continue;
    out[file] ??= { removed: [], added: [], head_lines: new Set() };
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) { const start = Number(hunk[1]); const count = hunk[2] === undefined ? 1 : Number(hunk[2]); for (let n = 0; n < count; n++) out[file].head_lines.add(start + n); if (count === 0) out[file].head_lines.add(start); continue; }
    if (line.startsWith('-')) out[file].removed.push(line.slice(1));
    else if (line.startsWith('+')) out[file].added.push(line.slice(1));
  }
  return out;
}

export function protectedReport({ dir, base, head, files, config = loadJSON(PROTECTED_CONFIG), binary = 'git' }) {
  const hits = [];
  for (const file of files) {
    const rule = config.paths.find(p => globRegExp(p.pattern).test(file));
    if (rule) hits.push({ path: file, reason: rule.reason, rule: rule.pattern });
  }
  const moneyLine = new RegExp(config.money_line, 'i');
  const lines = changedLines(dir, base, head, files.filter(f => /\.(?:m?js|jsx|html|css|json)$/.test(f)), { binary });
  const literals = [];
  for (const [file, change] of Object.entries(lines)) {
    const moneyFile = matchesAny(file, config.money_literal_paths);
    const pick = list => list.filter(l => moneyFile || moneyLine.test(l)).flatMap(numericLiterals);
    const removed = pick(change.removed), added = pick(change.added);
    if (multiset(removed) !== multiset(added)) literals.push({ path: file, removed: removed.slice(0, 20), added: added.slice(0, 20), money_module: moneyFile });
  }
  for (const l of literals) hits.push({ path: l.path, reason: l.money_module ? 'numeric literal changed in a money module' : 'numeric literal changed on a price, rate, fee or amount line', rule: 'money_literal' });
  return { protected: hits.length > 0, hits, money_literals: literals };
}

const EXPORT = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const STRING = /'((?:[^'\\\n]|\\.){6,120})'|"((?:[^"\\\n]|\\.){6,120})"|`((?:[^`\\$\n]|\\.){6,120})`/g;
const JSX_TEXT = />\s*([A-Za-z][^<>{}\n]{5,119}?)\s*</g;
const KEY = /(?:^|[{,\s])([a-z_][A-Za-z0-9_]{3,40})\s*:(?!:)/g;
export function exportsIn(lines) {
  const names = new Set();
  for (const line of lines) {
    for (const m of line.matchAll(EXPORT)) names.add(m[1]);
    for (const m of line.matchAll(EXPORT_LIST)) for (const part of m[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop(); if (/^[A-Za-z_$][\w$]*$/.test(name || '')) names.add(name); }
  }
  return names;
}
export function stringsIn(lines) {
  const out = new Set();
  for (const line of lines) {
    for (const m of line.matchAll(STRING)) { const s = m[1] ?? m[2] ?? m[3]; if (/^[\x20-\x7e]+$/.test(s) && /[A-Za-z]{3}/.test(s) && !/[\\]/.test(s)) out.add(s); }
    for (const m of line.matchAll(JSX_TEXT)) { const s = m[1].trim(); if (s.length >= 6 && /^[\x20-\x7e]+$/.test(s)) out.add(s); }
  }
  return out;
}
const keysIn = lines => new Set(lines.flatMap(l => [...l.replace(STRING, '""').matchAll(KEY)].map(m => m[1])));

function grepSites(dir, term, { word, binary }) {
  const out = git(dir, ['grep', '-n', '-I', '-F', ...(word ? ['-w'] : []), '-e', term, '--', 'src', 'public', 'landing', 'tests', 'scripts', 'supabase'],
    { binary, allowFail: true }) || '';
  return out.split('\n').filter(Boolean).map(line => { const m = /^([^:]+):(\d+):(.*)$/.exec(line); return m ? { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) } : null; }).filter(Boolean);
}

export function blastRadius({ dir, base, head, files, siblings = loadJSON(SIBLING_CONFIG), binary = 'git', maxTerms = 25, maxSites = 40 }) {
  const product = files.filter(f => /^(?:src|public|landing)\//.test(f));
  const lines = changedLines(dir, base, head, product, { binary });
  const terms = [];
  const push = (term, kind, word) => { if (terms.length < maxTerms && !terms.some(t => t.term === term)) terms.push({ term, kind, word }); };
  for (const change of Object.values(lines)) {
    const before = exportsIn(change.removed), after = exportsIn(change.added);
    for (const name of new Set([...before, ...after])) push(name, before.has(name) && after.has(name) ? 'changed_export' : before.has(name) ? 'removed_export' : 'added_export', true);
  }
  for (const change of Object.values(lines)) {
    const still = stringsIn(change.added);
    for (const s of stringsIn(change.removed)) if (!still.has(s)) push(s, 'removed_string', false);
  }
  for (const change of Object.values(lines)) {
    const still = keysIn(change.added);
    for (const k of keysIn(change.removed)) if (!still.has(k)) push(k, 'removed_key', true);
  }
  const report = [];
  for (const t of terms) {
    const sites = grepSites(dir, t.term, { word: t.word, binary });
    const untouched = sites.filter(s => !(lines[s.file]?.head_lines.has(s.line)));
    report.push({ term: t.term, kind: t.kind, sites: sites.length, untouched: untouched.slice(0, maxSites), untouched_count: untouched.length });
  }
  const groups = siblings.groups.map(g => ({ name: g.name, touched: g.members.filter(m => files.includes(m)), untouched: g.members.filter(m => !files.includes(m)) }))
    .filter(g => g.touched.length && g.untouched.length);
  return { terms: report, sibling_groups: groups };
}
