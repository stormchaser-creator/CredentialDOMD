// The link gate's judgement (no network), and the links the 2026-10-01 audit
// found dead: none of them is shown anywhere again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { judgeLink, urlsIn, isCheckable, collectLinks, ruleContext } from "./check-external-links.mjs";

test("a board page that redirects to its own error page is broken, though it answers 200", () => {
  const v = judgeLink({ status: 200, finalUrl: "https://medboard.nv.gov/error.aspx?aspxerrorpath=/Licensees/Renewals/", body: "<title>Nevada</title>" });
  assert.equal(v.state, "broken");
  assert.match(v.why, /error page/);
});

test("404, a page titled not found, and a host that no longer resolves are broken", () => {
  assert.equal(judgeLink({ status: 404, finalUrl: "https://dsps.wi.gov/Pages/Professions/Physician/CE.aspx" }).state, "broken");
  assert.equal(judgeLink({ status: 200, finalUrl: "https://example.gov/x", body: "<html><title>Page Not Found | Board</title>" }).state, "broken");
  assert.equal(judgeLink({ error: "ENOTFOUND" }).state, "broken");
  assert.equal(judgeLink({ status: 200, finalUrl: "https://example.gov/404", body: "<title>Error 404</title>" }).state, "broken");
});

test("a site's own not found page is broken even when it answers 403", () => {
  const iowa = judgeLink({ status: 403, finalUrl: "https://dial.iowa.gov/about-dial/boards-and-commissions/medicine", body: "<script>x</script>", title: "Please accept our apologies. We can&#039;t find that page | Department of Inspections, Appeals, &amp; Licensing" });
  assert.equal(iowa.state, "broken");
  assert.match(iowa.why, /not found page/);
  const ms = judgeLink({ status: 403, finalUrl: "https://www.msbml.ms.gov/Licensure/Physician_Assistant", body: "<title>Access Denied | Mississippi State Board of Medical Licensure</title><p>You asked for /Licensure/Physician_Assistant. That link no longer exists.</p>" });
  assert.equal(ms.state, "broken");
  assert.equal(judgeLink({ status: 403, finalUrl: "https://azbn.gov/", body: "<title>Just a moment...</title>" }).state, "blocked", "a bot check stays blocked");
  assert.equal(judgeLink({ status: 200, finalUrl: "https://example.gov/a", body: "<p>long script</p>", title: "Page Not Found" }).state, "broken", "a title read past the body excerpt counts");
});

test("a statute whose section number holds 404 is not an error page", () => {
  const v = judgeLink({ status: 200, finalUrl: "https://mca.legmt.gov/bills/mca/title_0370/chapter_0200/part_0040/section_0040/0370-0200-0040-0040.html", body: "<title>\n  37-20-404. Prescribing and dispensing authority, MCA\n</title>" });
  assert.equal(v.state, "ok");
  assert.equal(isCheckable("https://regulations.delaware.gov/api/AdminCode/regulation"), false, "a POST endpoint named in the evidence");
});

test("a server failure (509, 503, 500) is listed as unreachable, not as a dead link", () => {
  const nd = judgeLink({ status: 509, finalUrl: "https://www.ndbon.org/", body: "<title>Temporarily Unavailable</title>" });
  assert.equal(nd.state, "unreachable");
  assert.match(nd.why, /509/);
  assert.equal(judgeLink({ status: 503, finalUrl: "https://ndbon.org/licensing/renewal/ce/", body: "<title>503 Service Unavailable</title>" }).state, "unreachable");
  assert.equal(judgeLink({ status: 500, finalUrl: "https://example.gov/a", body: "<title>Server Error</title>" }).state, "unreachable");
  assert.equal(judgeLink({ status: 500, finalUrl: "https://example.gov/b", body: "<title>Page Not Found</title>" }).state, "broken", "a not found page served with 500 is still gone");
  assert.equal(judgeLink({ status: 410, finalUrl: "https://example.gov/c" }).state, "broken", "a 4xx stays broken");
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

// Every source of outside links the physician sees: the app's screens and
// email templates are TypeScript and JSX, the PA and NP rule data lives in
// data/app-rules, and the reminder and guide emails read their own files.
test("the extraction reads TypeScript and JSX, and skips code imports, data endpoints and placeholders", () => {
  const links = collectLinks(["scripts/fixtures/link-extraction"]);
  assert.deepEqual([...links.keys()].sort(), ["https://renew.board-fixture.gov/apply", "https://rules.board-fixture.gov/ce?rule=12"]);
  assert.deepEqual(links.get("https://renew.board-fixture.gov/apply"), ["scripts/fixtures/link-extraction/template.ts"]);
  assert.equal(isCheckable("https://esm.sh/jose@5"), false);
  assert.equal(isCheckable("https://clinicaltables.nlm.nih.gov/api/npi_idv/v3/search"), false);
  assert.equal(isCheckable("https://data.cms.gov/provider-data/api/1/datastore/query"), false);
  // A legislature whose rule pages sit under /api/ is still a page; so is the registry's API documentation.
  assert.equal(isCheckable("https://sdlegislature.gov/api/Statutes/36-4A.html?all=true"), true);
  assert.equal(isCheckable("https://npiregistry.cms.hhs.gov/api-page"), true);
});

function urlsInJson(node, out = new Set()) {
  // A note can follow the link ("https://... (built-in browser)").
  if (typeof node === "string") { if (/^https?:\/\//.test(node)) out.add(new URL(node.split(/\s/)[0]).href); }
  else if (node && typeof node === "object") for (const v of Object.values(node)) urlsInJson(v, out);
  return out;
}

test("every PA and NP rule link, board link and source link is checked, from the data and from what the app ships", () => {
  const links = collectLinks();
  const dir = new URL("../data/app-rules/", import.meta.url);
  const jsonFiles = ["national.json", "ledger/national.json",
    ...readdirSync(new URL("states/", dir)).map(f => `states/${f}`),
    ...readdirSync(new URL("ledger/", dir)).filter(f => f.endsWith(".json")).map(f => `ledger/${f}`),
    ...readdirSync(new URL("ledger/additions/", dir)).map(f => `ledger/additions/${f}`)];
  const shipped = ["../supabase/functions/send-reminders/appBoardLinks.json", "../supabase/functions/send-reminders/renewalLinks.json", "../supabase/functions/send-guide/stateGuides.json"];
  let n = 0;
  for (const file of [...jsonFiles.map(f => new URL(f, dir)), ...shipped.map(f => new URL(f, import.meta.url))]) {
    for (const url of urlsInJson(JSON.parse(readFileSync(file, "utf8")))) {
      if (!isCheckable(url)) continue;
      n++;
      assert.ok(links.has(url), `${url} (${file.pathname.split("/").slice(-2).join("/")}) is not checked`);
    }
  }
  assert.ok(n > 1000, `read the rule data (${n})`);
  for (const mod of ["paStateRules.js", "npStateRules.js", "certificationRules.js", "renewalInfo.js", "assistantSources.js"]) {
    const text = readFileSync(new URL(`../src/constants/${mod}`, import.meta.url), "utf8");
    const own = urlsIn(text).filter(isCheckable);
    assert.ok(own.length > 0, `${mod} has links`);
    for (const url of own) assert.ok(links.has(url), `${url} (${mod}) is not checked`);
  }
});

test("each PA and NP link says which jurisdiction and which rule it stands behind", () => {
  const rules = ruleContext();
  const boards = JSON.parse(readFileSync(new URL("../supabase/functions/send-reminders/appBoardLinks.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(boards).length, 51);
  for (const [st, kinds] of Object.entries(boards)) for (const [kind, b] of Object.entries(kinds)) {
    if (!b?.url) continue;
    assert.ok((rules.get(new URL(b.url).href) || []).some(l => l.startsWith(`${st}`)), `${st} ${kind} board ${b.url} has no ${st} label`);
  }
  const nccpa = rules.get("https://www.nccpa.net/maintain-certification/continuing-medical-education/");
  assert.ok(nccpa.includes("national: bodies.NCCPA link (fact pa.nccpa.cme_per_cycle)"));
  assert.ok(nccpa.some(l => /^national: pa\.nccpa\.cme_per_cycle \(/.test(l)), "a ledger fact names its rule and citation");
  assert.ok([...rules.values()].flat().some(l => /^[A-Z]{2}: np\./.test(l)), "a state ledger fact names its profession");
});
