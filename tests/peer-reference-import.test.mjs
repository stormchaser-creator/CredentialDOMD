// SYNC-002: peer_references.relationship is NOT NULL. The Peer References page
// had a Contacts banner that called addItem with only name, email and phone,
// so that reference was refused whole and lived on one device. Importing now
// happens only in the Add form, which prefills from the contact and requires
// the Relationship before it saves. No relationship is ever invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const section = app.slice(app.indexOf('if (sub === "peerReferences")'), app.indexOf('if (sub === "malpracticeHistory")'));

test('SYNC-002: no path adds a peer reference without its relationship', () => {
  assert.ok(section.length > 0);
  assert.doesNotMatch(section, /addItem\(\s*['"]peerReferences['"]/, 'nothing adds a reference straight from a contact');
  assert.match(section, /contactImport/, 'the Add form still offers Import from Contacts');
  assert.match(section, /\{ key: "relationship", label: "Relationship", type: "select", options: REFERENCE_RELATIONSHIPS, required: true \}/);
});
