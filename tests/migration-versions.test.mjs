// Every timestamped migration has its own version.
//
// The Supabase CLI keys supabase_migrations.schema_migrations by the digits
// before the first underscore. Two files with one version either fail
// `supabase db push` / `db reset` on the duplicate key or leave the second
// file's tables unapplied, in an order nobody chose. Branches cut the same day
// reach for the same round number (20260925130000 was taken by both the
// member support view and the server invoice email), so the merged tree is
// checked here.
//
// The early date-only names (20260816_*.sql) predate the 14-digit convention
// and were applied by hand; only the 14-digit versions are held to this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const DIR = new URL('../supabase/migrations/', import.meta.url);

export function duplicateVersions(names) {
  const byVersion = new Map();
  for (const name of names) {
    const match = /^(\d{14})_.+\.sql$/.exec(name);
    if (!match) continue;
    byVersion.set(match[1], [...(byVersion.get(match[1]) || []), name]);
  }
  return [...byVersion.values()].filter(files => files.length > 1);
}

test('no two timestamped migrations share a version', () => {
  assert.deepEqual(duplicateVersions(readdirSync(DIR)), []);
});

test('the check catches two branches that picked the same timestamp', () => {
  assert.deepEqual(duplicateVersions(['20260925130000_member_support_view.sql', '20260925130000_invoice_email_sends.sql', '20260816_tax.sql', '20260816_errors.sql']),
    [['20260925130000_member_support_view.sql', '20260925130000_invoice_email_sends.sql']]);
});

test('the member support view migration is not on the invoice email branch\'s version', () => {
  const names = readdirSync(DIR);
  assert.ok(names.includes('20260925131000_member_support_view.sql'));
  assert.ok(!names.some(name => name.startsWith('20260925130000_member_support_view')));
});
