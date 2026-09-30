// HOME-018: a backslash-u escape (backslash, "u00b7" for the middle dot,
// "u2014" for the em dash) written in JSX text is not an escape. JSX text is
// taken as written, so the Home board card printed "AMA PRA Cat 1/year",
// a backslash and "u00b7 2026", and the subspecialty note printed the em
// dash's code before "CME follows the primary board above". Only a JS string
// (in braces) turns an escape into its character. This reads every JSX file
// in src/ and fails on an escape sequence in JSX text or in a quoted JSX
// attribute value (which is also taken as written).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ESCAPE = /\\(u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2})/;

function files(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(jsx|js)$/.test(f)) out.push(p);
  }
  return out;
}

/** Escape sequences written where JSX takes text as written. */
function rawEscapes(source) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true });
  const hits = [];
  const visit = (n, parent) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'JSXText' && ESCAPE.test(n.value)) hits.push({ line: n.loc.start.line, text: n.value.trim() });
    if (n.type === 'Literal' && parent?.type === 'JSXAttribute' && ESCAPE.test(n.raw)) hits.push({ line: n.loc.start.line, text: n.raw });
    for (const [k, v] of Object.entries(n)) {
      if (k === 'loc' || k === 'range') continue;
      if (Array.isArray(v)) v.forEach(c => visit(c, n));
      else if (v && typeof v.type === 'string') visit(v, n);
    }
  };
  visit(ast, null);
  return hits;
}

test('the check sees an escape in JSX text and in a quoted attribute, not in a JS string', () => {
  assert.equal(rawEscapes('const a = <div>{b.unit} \\u00b7 {b.window}</div>;').length, 1);
  assert.equal(rawEscapes('const a = <div title="x \\u2014 y" />;').length, 1);
  assert.equal(rawEscapes('const a = <div>{`${b.unit} \\u00b7 ${b.window}`}{" \\u2014 "}</div>;').length, 0);
});

/** A .js file holds JSX when it only parses with JSX on. */
const holdsJsx = (source) => {
  try { espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); return false; } catch { return true; }
};

test('no JSX in src/ prints a raw escape sequence', () => {
  const all = files(path.join(root, 'src'));
  const jsx = all.filter(f => f.endsWith('.jsx') || holdsJsx(readFileSync(f, 'utf8')));
  assert.ok(jsx.some(f => f.endsWith(`${path.sep}App.jsx`)), 'App.jsx is read');
  assert.ok(jsx.length > 50, `${jsx.length} JSX files read`);
  const found = [];
  for (const f of jsx) {
    // A file that does not parse fails here rather than being skipped.
    for (const h of rawEscapes(readFileSync(f, 'utf8'))) found.push(`${path.relative(root, f)}:${h.line} ${h.text}`);
  }
  assert.deepEqual(found, []);
});

test('the Home board cards read as sentences, with no em dash', () => {
  const app = readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(app, /\{`\$\{b\.unit\} \\u00b7 \$\{b\.windowLabel\}`\}/);
  assert.match(app, /\{b\.label\}: CME follows the primary board above/);
});
