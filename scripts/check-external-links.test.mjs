// The link gate's judgement (no network), and the links the 2026-10-01 audit
// found dead: none of them is shown anywhere again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { judgeLink, urlsIn, isCheckable, collectLinks } from "./check-external-links.mjs";

test("a board page that redirects to its own error page is broken, though it answers 200", () => {
  const v = judgeLink({ status: 200, finalUrl: "https://medboard.nv.gov/error.aspx?aspxerrorpath=/Licensees/Renewals/", body: "<title>Nevada</title>" });
  assert.equal(v.state, "broken");
  assert.match(v.why, /error page/);
});

test("404, a page titled not found, and a host that no longer resolves are broken", () => {
  assert.equal(judgeLink({ status: 404, finalUrl: "https://dsps.wi.gov/Pages/Professions/Physician/CE.aspx" }).state, "broken");
  assert.equal(judgeLink({ status: 200, finalUrl: "https://example.gov/x", body: "<html><title>Page Not Found | Board</title>" }).state, "broken");
  assert.equal(judgeLink({ error: "ENOTFOUND" }).state, "broken");
});

test("a refusal of an automated client is listed as blocked, never as a pass or a failure", () => {
  assert.equal(judgeLink({ status: 403, finalUrl: "https://azmd.gov/" }).state, "blocked");
  assert.equal(judgeLink({ status: 200, finalUrl: "https://validate.perfdrive.com/x" }).state, "blocked");
  assert.equal(judgeLink({ error: "ECONNREFUSED" }).state, "unreachable");
  assert.equal(judgeLink({ status: 200, finalUrl: "https://dsps.wi.gov/a-z-boards-and-councils-list/meb/", body: "<title>Medical Examining Board - DSPS</title>" }).state, "ok");
});

test("a statute link keeps its own parentheses; prose around a link does not", () => {
  assert.deepEqual(urlsIn('see (https://docs.legis.wisconsin.gov/document/statutes/440.08(3)).'), ["https://docs.legis.wisconsin.gov/document/statutes/440.08(3)"]);
  assert.deepEqual(urlsIn('"https://a.gov/x?y=1&amp;z=2",'), ["https://a.gov/x?y=1&z=2"]);
  assert.equal(isCheckable("https://credentialdomd.com/states/ohio"), false);
  assert.equal(isCheckable("https://fonts.googleapis.com/css2"), false);
  assert.equal(isCheckable("https://med.ohio.gov/"), true);
});

// Found dead on 2026-10-01 (curl and Python, browser user agent). Each was
// replaced by the board's current page, or an archived copy of the page the
// claim came from.
const DEAD = [
  "https://dsps.wi.gov/Credentialing/Renewal/RenewalDatesFees.pdf",
  "https://dsps.wi.gov/Documents/NewsMedia/20250808FeeAdjustmentNewsRelease.pdf",
  "https://dsps.wi.gov/Pages/Professions/Physician/CE.aspx",
  "https://dsps.wi.gov/Pages/Professions/Physician/Default.aspx",
  "https://medboard.nv.gov/Licensees/Renewals/",
  "https://www.tmb.texas.gov/apply-renew/other-permits-and-licenses/pain-management-clinics/continuing-education-pain-management-clinics",
];
// Working only through a redirect: linked directly instead.
const REDIRECT_ONLY = ["https://dsps.wi.gov/Pages/BoardsCouncils/MEB/Default.aspx"];

test("no page, email, app screen or source list links a page the audit found dead", () => {
  const links = collectLinks();
  assert.ok(links.size > 300, `the gate reads every link (${links.size})`);
  for (const url of [...DEAD, ...REDIRECT_ONLY]) {
    const where = [...links].filter(([u]) => u === url).flatMap(([, files]) => files);
    assert.deepEqual(where, [], `${url} is still linked from ${where.join(", ")}`);
  }
});

test("Wisconsin links the board directly, and its CME rule at the rule itself", () => {
  const { states } = JSON.parse(readFileSync(new URL("../landing/states/states-data.json", import.meta.url), "utf8"));
  const wi = states.find(s => s.abbreviation === "WI");
  assert.equal(wi.boardUrl, "https://dsps.wi.gov/a-z-boards-and-councils-list/meb/");
  assert.equal(wi.cmeSourceUrl, "https://docs.legis.wisconsin.gov/code/admin_code/med/13/02");
  const guides = JSON.parse(readFileSync(new URL("../supabase/functions/send-guide/stateGuides.json", import.meta.url), "utf8"));
  assert.equal(guides.WI.boardUrl, wi.boardUrl, "the guide email says what the page says");
  assert.deepEqual(guides.WI.sources.map(s => s.url), wi.sources.map(s => s.url));
  const page = readFileSync(new URL("../landing/states/wisconsin.html", import.meta.url), "utf8");
  for (const s of wi.sources) assert.ok(page.includes(`href="${s.url}"`), `wisconsin.html links ${s.url}`);
});
