// On the owner's iPhone a link from Mail opens Safari, not the app on his home
// screen, and Safari is signed out (link audit, 2026-10-01). Every email that
// links into the app says where to go in the installed app instead.
import test from "node:test";
import assert from "node:assert/strict";
import { ticketReplyEmail } from "../../supabase/functions/_shared/ticketReplyEmail.ts";
import { renderEmailText, BACKUP_PAGE_PATH } from "../../supabase/functions/build-backup/lib.ts";
import { physicianSummaryText } from "../../supabase/functions/_shared/requestFlow.ts";
import { readFileSync } from "node:fs";

const HINT = /On an iPhone with CredentialDOMD on your home screen, open it from there and go to (.+?)\. A link from Mail opens Safari, where you are not signed in\./;

test("a ticket reply email says where the ticket is in the installed app", () => {
  const { text } = ticketReplyEmail("Fixed in the current build.", false, { support: true, ticketId: "0b7f3c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" });
  assert.equal(text.match(HINT)?.[1], "More > Get help > Your tickets");
  assert.ok(text.indexOf("Open this ticket in the app") < text.search(HINT), "after the link it explains");
});

test("the monthly backup email says where Data & Backup is in the installed app", () => {
  const text = renderEmailText({ greetingName: "Rowan", period: "2026-09", recordCount: 3, sectionCount: 2, documentCount: 0, documentBytes: 0, builtParts: 1, archiveBytes: 2048, skippedCount: 0 });
  assert.equal(text.match(HINT)?.[1], BACKUP_PAGE_PATH);
});

test("a request summary says where Requests is in the installed app", () => {
  const proposal = { v: 1, method: "rules", items: [{ ask: "board certificate", kind: "board_cert", status: "found", docIds: ["d9"], labels: ["Board Certification (AOA)"] }], docIds: ["d9"], missing: [], coverNote: "x" };
  const text = physicianSummaryText({ requesterName: "Casey Example", requesterAddr: "c@osterly-health.example", requesterFound: true, proposal, appUrl: "https://credentialdomd.com/app/", oneTap: true });
  assert.equal(text.match(HINT)?.[1], "More > Requests");
  const unclear = physicianSummaryText({ requesterName: "Casey Example", requesterAddr: "c@osterly-health.example", requesterFound: true, proposal, appUrl: "https://credentialdomd.com/app/", unclear: { about: "a form" } });
  assert.equal(unclear.match(HINT)?.[1], "More > Requests");
});

test("the staged contact card reply says it too", () => {
  const src = readFileSync(new URL("../../supabase/functions/email-inbound/index.ts", import.meta.url), "utf8");
  assert.match(src, /Open the app: \$\{APP_URL\}#requests\\n\$\{homeScreenHint\("More > Requests"\)\}/);
});
