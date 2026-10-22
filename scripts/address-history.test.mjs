// Checks for src/utils/addressHistory.js: the gap detection that is the real
// feature. A credentialing application asks where you have lived for the last
// five years and what it VERIFIES is that the list has no holes, so a list
// without this check is half a feature.
//
// Run: node scripts/address-history.test.mjs

import { readFileSync } from "node:fs";
const m = await import("../src/utils/addressHistory.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };
const eq = (n, g, w) => { const s = JSON.stringify(g) === JSON.stringify(w); ok(s ? n : `${n}  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`, s); };

const asOf = new Date("2026-09-18T00:00:00Z");
const opt = { asOf };
const kinds = (rows, o = opt) => m.addressProblems(rows, o).map((p) => p.kind).sort();

const A = { id: "a", street: "9 Old St", city: "Boulder", state: "CO", startDate: "2019-01-01", endDate: "2021-06-30" };
const B = { id: "b", street: "5 Mid Ave", city: "Aurora", state: "CO", startDate: "2021-06-30", endDate: "2024-03-01" };
const NOW = { id: "c", street: "1 Now Rd", city: "Denver", state: "CO", postalCode: "80202", startDate: "2024-03-01", current: "Yes" };

// ── A complete history is complete ────────────────────────────────────────
{
  const p = m.addressProblems([A, B, NOW], opt);
  eq("an unbroken five years has nothing wrong with it", p, []);
  ok("and says so plainly", m.historySummary([A, B, NOW], opt).ok);
  ok("naming the lookback it satisfied", /5 years/.test(m.historySummary([A, B, NOW], opt).text));
}

// ── The gap, which is the whole point ─────────────────────────────────────
{
  const gapped = [A, { ...B, startDate: "2021-11-01" }, NOW];
  const p = m.addressProblems(gapped, opt);
  eq("a four-month hole is found", p.filter((x) => x.kind === "gap").length, 1);
  const g = p.find((x) => x.kind === "gap");
  eq("and measured", g.days, 124);
  ok("the message names both dates, so it can be acted on",
     g.text.includes("2021-06-30") && g.text.includes("2021-11-01"));
  ok("and says what to do about it", /add the address you lived at in between/.test(g.text));
  ok("the summary leads with it", /1 gap/.test(m.historySummary(gapped, opt).text));
  ok("and says what it costs", /returned/.test(m.historySummary(gapped, opt).text));
}
{
  // A day either side is a move, not a hole.
  eq("one day between addresses is not a gap", kinds([A, { ...B, startDate: "2021-07-01" }, NOW]), []);
  ok("two days is", kinds([A, { ...B, startDate: "2021-07-02" }, NOW]).includes("gap"));
}

// ── Overlaps are flagged but not condemned ────────────────────────────────
{
  const p = m.addressProblems([A, { ...B, startDate: "2021-05-01" }, NOW], opt);
  const o = p.find((x) => x.kind === "overlap");
  ok("an overlap is reported", !!o);
  eq("and measured", o.days, 60);
  ok("without calling it an error, because two homes happen", /fine if you genuinely held both/.test(o.text));
}

// ── Reaching back far enough ──────────────────────────────────────────────
{
  const short = [{ ...B, startDate: "2023-01-01" }, NOW];
  ok("a history that does not reach five years says so", kinds(short).includes("too_short"));
  ok("and says by how much", /short of the 5 years/.test(m.addressProblems(short, opt).find((x) => x.kind === "too_short").text));
  ok("ten years can be asked for instead",
     kinds([A, B, NOW], { asOf, years: 10 }).includes("too_short"));
  ok("and five is the default", m.DEFAULT_LOOKBACK_YEARS === 5);
  eq("nothing at all is its own message", kinds([]), ["no_history"]);
}

// ── The current address is part of the history ────────────────────────────
{
  ok("no current address leaves the history short of today",
     kinds([A, { ...B, endDate: "2024-03-01" }]).includes("no_current"));
  ok("two current addresses is a mistake",
     kinds([{ ...A, current: "Yes" }, NOW]).includes("many_current"));
  ok("current is read from the select's Yes", m.isCurrent({ current: "Yes" }));
  ok("and from a real boolean", m.isCurrent({ current: true }));
  ok("but not from No", !m.isCurrent({ current: "No" }));
  ok("nor from nothing", !m.isCurrent({}));
}

// ── Rows that cannot be placed ────────────────────────────────────────────
{
  ok("an address with no move-in date is named", kinds([{ id: "x", street: "?", endDate: "2020-01-01" }, NOW]).includes("missing_start"));
  ok("a past address with no move-out date is named", kinds([{ id: "x", street: "?", startDate: "2020-01-01" }, NOW]).includes("missing_end"));
  ok("and is told where Current lives", /tick Current/.test(m.addressProblems([{ id: "x", street: "?", startDate: "2020-01-01" }, NOW], opt).find((p) => p.kind === "missing_end").text));
  ok("an address that ends before it starts is named",
     kinds([{ id: "x", street: "?", startDate: "2021-01-01", endDate: "2020-01-01" }, NOW]).includes("reversed"));
  ok("an address starting in the future is named",
     kinds([{ id: "x", street: "?", startDate: "2030-01-01", endDate: "2031-01-01" }, NOW]).includes("future"));
  eq("a row with no dates at all is ignored rather than crashing", m.periods([{ id: "x", street: "?" }]).length, 0);
}

// ── Dates and formatting ──────────────────────────────────────────────────
{
  eq("a junk date is not a date", m.asDate("soon"), null);
  eq("nor is an empty one", m.asDate(""), null);
  eq("nor undefined", m.asDate(undefined), null);
  ok("an ISO date parses as UTC, so a test at midnight does not move",
     m.asDate("2020-05-06").toISOString().startsWith("2020-05-06T00:00:00"));
  eq("an address reads the way a form wants it",
     m.formatAddress({ street: "1 Now Rd", unit: "Apt 2", city: "Denver", state: "CO", postalCode: "80202" }),
     "1 Now Rd Apt 2, Denver, CO 80202");
  eq("missing parts are skipped, not padded", m.formatAddress({ city: "Denver", state: "CO" }), "Denver, CO");
  eq("USA is left off, because a US form assumes it", m.formatAddress({ city: "Denver", country: "USA" }), "Denver");
  eq("anywhere else is kept", m.formatAddress({ city: "Toronto", country: "Canada" }), "Toronto, Canada");
  eq("nothing in, nothing out", m.formatAddress({}), "");
  eq("null in, nothing out", m.formatAddress(null), "");
}
{
  // Oldest first, which is the order the form asks for.
  const order = m.periods([NOW, A, B]).map((p) => p.id);
  eq("periods come back oldest first", order, ["a", "b", "c"]);
}

// ── Home and Work: only where you LIVED is checked for gaps ───────────────
{
  const W1 = { id: "w1", kind: "work", placeName: "Synthetic General Hospital", street: "100 Clinic Way", city: "Aurora", state: "CO", startDate: "2020-02-01", endDate: "2020-03-01" };
  const W2 = { id: "w2", kind: "work", placeName: "Example Spine Practice", city: "Denver", state: "CO", startDate: "2025-01-01", isCurrent: true };
  ok("kind work reads as work", m.isWorkAddress(W1));
  ok("blank kind reads as home", m.addressKind({}) === "home" && m.addressKind({ kind: "" }) === "home" && m.addressKind({ kind: null }) === "home");
  ok("an unknown kind reads as home", m.addressKind({ kind: "vacation" }) === "home");
  ok("and Work in any case is work", m.addressKind({ kind: " WORK " }) === "work");

  eq("work rows alone are never checked for gaps, only that no home is listed",
     kinds([W1, W2]), ["no_history"]);
  eq("work rows do not change a complete home history", m.addressProblems([A, W1, B, W2, NOW], opt), []);
  ok("so the summary still says it is ready", m.historySummary([A, W1, B, W2, NOW], opt).ok);
  ok("and says it is about where you lived", /where you lived/i.test(m.historySummary([A, W1, B, W2, NOW], opt).text));
  {
    // A work row that spans the hole does not fill it: a gap is about homes.
    const gapped = [A, { ...B, startDate: "2021-11-01" }, NOW, { ...W1, startDate: "2021-06-01", endDate: "2021-12-01" }];
    const p = m.addressProblems(gapped, opt);
    eq("a work address does not paper over a gap in where you lived", p.filter((x) => x.kind === "gap").length, 1);
    ok("the gap summary names where you lived", /gap in where you lived/.test(m.historySummary(gapped, opt).text));
  }
  eq("a work row with no dates, no end or a second Current raises nothing",
     kinds([A, B, NOW, { id: "w3", kind: "work", startDate: "2022-01-01" }, { id: "w4", kind: "work", isCurrent: true }, { id: "w5", kind: "work" }]), []);
  ok("two current homes is still a mistake with work rows about",
     kinds([{ ...A, current: "Yes" }, NOW, W2]).includes("many_current"));
  ok("no current home is still named when only a job is current",
     kinds([A, { ...B, endDate: "2026-01-01" }, W2]).includes("no_current"));

  ok("isCurrent is read from the isCurrent column key", m.isCurrent({ isCurrent: true }));
  ok("and is false when isCurrent says so even with an old current key", !m.isCurrent({ isCurrent: false, current: "Yes" }));

  eq("a work line leads with the place", m.addressLine(W1), "Synthetic General Hospital, 100 Clinic Way, Aurora, CO");
  eq("a home line has no place, even if one was typed before switching to Home", m.addressLine({ ...NOW, placeName: "Leftover" }), "1 Now Rd, Denver, CO 80202");
  eq("dates read From to To", m.addressDates(A), "2019-01-01 to 2021-06-30");
  eq("and Present for a current one", m.addressDates(NOW), "2024-03-01 to Present");

  const g = m.addressGroups([W2, NOW, W1, A, B]);
  eq("the export groups Home then Work", g.map((x) => x.kind), ["home", "work"]);
  eq("each oldest first", g.map((x) => x.rows.map((r) => r.row.id)), [["a", "b", "c"], ["w1", "w2"]]);
  eq("with Present for the current ones", g[1].rows[1].dates, "2025-01-01 to Present");
  eq("an empty group is left out", m.addressGroups([W1]).map((x) => x.kind), ["work"]);
  eq("and nothing in is nothing out", m.addressGroups(undefined), []);
}

// ── The write shape: every key must be a real address_history column ──────
{
  const { prepareRecord } = await import("../src/utils/recordWrite.js");
  const out = prepareRecord("addressHistory", { id: "x", street: "1 Now Rd", current: "Yes", kind: "Work" }, "");
  ok("an old `current` key is moved to isCurrent (there is no current column)", !("current" in out) && out.isCurrent === true);
  eq("kind is stored lower case", out.kind, "work");
  eq("an unknown kind is stored blank, which reads as home", prepareRecord("addressHistory", { id: "x", kind: "Vacation" }, "").kind, null);
  eq("a ticked Current stays a boolean", prepareRecord("addressHistory", { id: "x", isCurrent: true }, "").isCurrent, true);
  eq("a cleared one is false, not a string", prepareRecord("addressHistory", { id: "x", isCurrent: "" }, "").isCurrent, false);
  ok("work history keeps its own current column", "current" in prepareRecord("workHistory", { id: "y", type: "Other", current: true }, ""));
}

// ── Wired into the app ────────────────────────────────────────────────────
{
  const read = (r) => readFileSync(new URL(r, import.meta.url), "utf8");
  const app = read("../src/App.jsx");
  ok("the section exists", /sub === "addressHistory"/.test(app));
  ok("it is in the Credentials nav as Addresses", /id: "addressHistory", label: "Addresses"/.test(app));
  ok("next to Work History", /id: "workHistory", label: "Work History"[^\n]*\n\s*\{ id: "addressHistory"/.test(app));
  ok("each address has a Type, Home or Work", /\{ key: "kind", label: "Type", type: "choice", options: ADDRESS_KIND_OPTIONS/.test(app));
  ok("a Place for a work address only", /\{ key: "placeName", label: "Place"[^}]*show: f => isWorkAddress\(f\)/.test(app));
  ok("From, To and Current", /label: "From", type: "date"/.test(app) && /label: "To", type: "date"/.test(app) && /\{ key: "isCurrent", label: "Current", type: "checkbox"/.test(app));
  ok("the form never writes a `current` key, which address_history has no column for",
     !/sub === "addressHistory"[\s\S]{0,4000}key: "current"/.test(app));
  ok("the empty state says to add where you lived and worked, with dates",
     /emptySub="Add every place you have lived and every place you have worked, with dates\. Applications ask for both/.test(app));
  ok("the warning is rendered by the page, not passed to a prop CrudSection ignores",
     /summary\.ok \? T\.success : T\.warning/.test(app) && !/header=\{/.test(app));
  ok("and uses theme keys that exist in both light and dark",
     /summary\.ok \? T\.successDim : T\.warningDim/.test(app));
  ok("every problem is shown, not just the first", /summary\.problems \|\| \[\]\)\.map/.test(app));
  ok("and nothing is shown before there is anything to judge", /rows\.length > 0 && \(/.test(app));

  const defaults = read("../src/constants/defaults.js");
  ok("the collection exists", /addressHistory: \[\]/.test(defaults));
  const sb = read("../src/lib/supabase.js");
  ok("it syncs to its own table", /addressHistory: "address_history"/.test(sb));
  const del = read("../supabase/functions/delete-account/lib.ts");
  ok("and is deleted with the account", /"address_history"/.test(del));
  const sql = read("../supabase/migrations/20260918b_address_history.sql");
  ok("the table is owner-scoped", /using \(user_id = public\.current_profile_id\(\)\)/.test(sql));
  ok("on both sides", /with check \(user_id = public\.current_profile_id\(\)\)/.test(sql));
  ok("RLS is enabled", /enable row level security/.test(sql));
  ok("and it cascades from the profile", /references public\.profiles\(id\) on delete cascade/.test(sql));

  const ce = read("../src/utils/credentialExport.js");
  ok("it reaches the credential export, grouped Home then Work", /for \(const g of addressGroups\(data\.addressHistory\)\)/.test(ce)
     && /g\.kind === "work" \? "Work Address" : "Home Address"/.test(ce));
  ok("with Present for a current one", /current \? "Present"/.test(ce));
  const de = read("../src/components/features/DataExport.jsx");
  ok("and the plain-text export, grouped Home then Work", /for \(const g of addressGroups\(data\.addressHistory\)\)/.test(de));
  const h = read("../src/utils/helpers.js");
  ok("a record renders its own fields", /section === "addressHistory"/.test(h));
  ok("and has a name on a card", /case "addressHistory":/.test(h));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
