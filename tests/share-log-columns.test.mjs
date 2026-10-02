// SYNC-002: every share-log row the app writes must fit share_log: its keys
// are columns (sent_at, not shared_at), and section, method and item_name are
// NOT NULL. Vera's packet share wrote sharedAt and no section, and the row
// was refused whole and retried on every load. Reads the app's own writers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COLUMNS = new Set(JSON.parse(readFileSync(fileURLToPath(new URL('./member-view/production-columns.json', import.meta.url)), 'utf8')).tables.share_log);
const snake = (k) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const WRITERS = ['App.jsx', 'components/features/AssistantSection.jsx', 'components/features/DocumentsSection.jsx'];

// The keys of an object literal body: split at top-level commas (outside
// brackets and template strings), then take what precedes a top-level colon,
// or the whole part for a shorthand key.
function keysOf(body) {
  const parts = [];
  let depth = 0, tpl = false, quote = null, cur = '';
  for (const ch of body) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (tpl) { if (ch === '`') tpl = false; cur += ch; continue; }
    if (ch === '`') { tpl = true; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => (p.match(/^([A-Za-z_]\w*)\s*(?::|$)/) || [])[1]).filter(Boolean);
}

function literalRows(src) {
  const rows = [];
  // Vera's packet row is built by packetLog() so it can be written at hand-off.
  for (const m of src.matchAll(/(?:addItem\("shareLog", \{|const packetLog = \(\) => \(\{)([^;]*?)\}\)?;/g)) {
    if (m[1].trim().startsWith('...')) continue; // logShare spreads a caller's entry
    rows.push(new Set(keysOf(m[1])));
  }
  return rows;
}

test('SYNC-002: every share-log row is written with real columns and its NOT NULL fields', () => {
  let count = 0;
  for (const file of WRITERS) {
    const src = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
    for (const keys of literalRows(src)) {
      count += 1;
      for (const k of keys) assert.ok(COLUMNS.has(snake(k)), `${file}: ${k} is not a share_log column`);
      for (const k of ['itemName', 'section', 'method', 'sentAt']) assert.ok(keys.has(k), `${file}: missing ${k}`);
    }
  }
  assert.ok(count >= 4, `found ${count} share-log writers`);
});

test('SYNC-002: no writer uses a method the CHECK refuses', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /method = "copy"/);
});
