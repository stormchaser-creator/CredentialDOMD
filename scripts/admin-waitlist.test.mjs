import assert from "node:assert/strict";
import { waitlistView, leadState } from "../src/utils/adminWaitlist.js";
const rows = [
  { id: "home", email: "home@example.com", waitlist: true },
  { id: "both", email: "both@example.com", waitlist: true, note: "guide-email IA" },
  { id: "invited", email: "invited@example.com", waitlist: true },
  { id: "guide", email: "guide@example.com", waitlist: false, status: "invited" },
  { id: "joined", email: "joined@example.com", waitlist: true, status: null },
  { id: "unknown", email: "unknown@example.com", waitlist: null },
];
const users = [{ email: " JOINED@example.com ", access_status: "active" }];
const invites = [{ email: "invited@example.com", invite_sent_at: "2026-09-15", status: "invited" }];
for (const showJoined of [false, true]) for (const showGuideOnly of [false, true]) {
  const v = waitlistView(rows, users, invites, { showJoined, showGuideOnly });
  assert.deepEqual(v.waiting.map(r => r.id), ["home", "both", "invited"]);
  assert.deepEqual(v.contactable.map(r => r.id), ["home", "both", "invited"]);
  assert.equal(v.joined.length, 1);
  assert.equal(v.guideOnly.length, 1);
  assert.equal(v.visible.some(r => r.id === "guide"), showGuideOnly);
  assert.equal(v.visible.some(r => r.id === "joined"), showJoined);
  assert.equal(v.visible.some(r => r.id === "unknown"), false);
  assert.equal(leadState(rows[2], v), "invited");
  assert.equal(leadState(rows[3], v), "guide only");
  assert.equal(leadState(rows[4], v), "account active");
}
assert.equal(waitlistView(rows, [], [{ email: "home@example.com", status: "invited" }]).invitedEmails.size, 0);
assert.equal(waitlistView(rows, [], [{ email: "home@example.com", status: "revoked", invite_sent_at: "2026-09-15" }]).invitedEmails.size, 0);
assert.equal(waitlistView(rows, [{ ...users[0], deleted_at: "2026-09-15" }]).joined.length, 0);
console.log("Waitlist: counts, all display toggles, invitation status, and contact exclusions passed.");
