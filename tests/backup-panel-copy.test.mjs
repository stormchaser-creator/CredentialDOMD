// SYNC-019: the Backup panel said the monthly ZIP holds "a JSON file this app
// can import back". Restore from Backup rejects that file (it is the server's
// {format, profile, data} snapshot, not the app's export), and the ZIP's own
// README says loading it back is not a one-tap feature. The panel now says the
// same as the README and points at the export the restore card accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const panel = readFileSync(fileURLToPath(new URL('../src/components/features/BackupPanel.jsx', import.meta.url)), 'utf8');
const readme = readFileSync(fileURLToPath(new URL('../supabase/functions/build-backup/lib.ts', import.meta.url)), 'utf8');

test('SYNC-019: the panel no longer promises the monthly JSON can be imported back', () => {
  assert.doesNotMatch(panel, /this app\s+can import back/);
  assert.match(panel, /not a one-tap feature yet/);
  assert.match(panel, /use Export it yourself below/);
  assert.match(readme, /not a one-tap feature yet/, 'the README the panel agrees with');
  assert.doesNotMatch(panel.slice(panel.indexOf('Once a month'), panel.indexOf('Large accounts')), /—/, 'no em dashes');
});
