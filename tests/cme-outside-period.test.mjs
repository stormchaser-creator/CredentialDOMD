// Ticket 53890221: a physician tagged courses with a state topic, the edit form
// showed the tags, and the requirement still read short because the courses
// are dated outside the period the rule counts. The engines now report those
// tagged courses (outsidePeriod) and the card says why they do not count; a
// period that has not started yet says so instead of reading as a shortfall.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { complianceListFor, windowNotes, cardWindowNotes, topicOutsidePeriod } from "../src/utils/compliance.js";
import { taggedOutsidePeriod, outsidePeriodText } from "../src/utils/cmeCore.js";
import { loadAppRules } from "../src/utils/appRules.js";

const course = (topics, date, hours = 1) => ({ title: "Synthetic course", category: "AMA PRA Category 1", hours, date, topics });
const md = (licenses, cme) => complianceListFor({ cme, licenses, settings: { degreeType: "MD", state: licenses[0].state, primaryState: licenses[0].state, additionalStates: [] } });
const cardOf = (list, key) => list.find((c) => c.key === key).comp;
// What the card shows: the engine's topic row plus topicOutsidePeriod.
const topicOf = (list, key, topic, entries) => { const comp = cardOf(list, key); const t = comp.topicResults.find((x) => x.topic === topic); return { ...t, outsidePeriod: topicOutsidePeriod(comp, t, entries) }; };

test("a tagged course dated before the cycle is reported, a counted one is not", () => {
  const ohio = [{ state: "OH", type: "State Medical License", expirationDate: "2028-06-17" }];
  const oldEntries = [course(["Ethics"], "2024-08-09")];
  const t = topicOf(md(ohio, oldEntries), "OH", "Ethics", oldEntries);
  assert.equal(t.earned, 0);
  assert.equal(t.met, false);
  assert.deepEqual({ hours: t.outsidePeriod.hours, before: t.outsidePeriod.before, after: t.outsidePeriod.after, undated: t.outsidePeriod.undated },
    { hours: 1, before: 1, after: 0, undated: 0 });
  assert.equal(t.outsidePeriod.from, "2026-06-17");
  assert.equal(t.outsidePeriod.through, "2028-06-17");
  assert.match(outsidePeriodText("Ethics", t.outsidePeriod), /^1 course you tagged Ethics is dated outside the period this requirement counts \(Jun 17, 2026 to Jun 17, 2028\), so it does not count here\.$/);

  const inside = [course(["Ethics"], "2027-01-10")];
  const counted = topicOf(md(ohio, inside), "OH", "Ethics", inside);
  assert.equal(counted.met, true);
  assert.equal(counted.outsidePeriod, null);
});

test("a longer-period topic reports against its own period, not the cycle", () => {
  // Alabama: an annual license; controlled substances counts two years back.
  const alabama = [{ state: "AL", type: "State Medical License", expirationDate: "2026-12-31" }];
  const al = [course(["Controlled Substances"], "2024-08-08", 1.25), course(["Controlled Substances"], "2024-08-09")];
  const t = topicOf(md(alabama, al), "AL", "Controlled Substances", al);
  assert.equal(t.earned, 0);
  assert.equal(t.outsidePeriod.hours, 2.25);
  assert.equal(t.outsidePeriod.before, 2);
  assert.equal(t.outsidePeriod.from, "2024-12-31");
  assert.match(outsidePeriodText("Controlled Substances", t.outsidePeriod), /^2 courses you tagged Controlled Substances are dated outside .* so they do not count here\.$/);
});

test("a one-time topic counts any date, so nothing is reported outside it", () => {
  const california = [{ state: "CA", type: "State Medical License (MD)", expirationDate: "2028-01-31" }];
  const ca = [course(["Pain Management"], "2019-03-01", 3)];
  const t = topicOf(md(california, ca), "CA", "Pain Management", ca);
  assert.equal(t.earned, 3);
  assert.equal(t.outsidePeriod, null);
});

test("undated tagged courses are reported and the text asks for a date", () => {
  const entries = [course(["Ethics"], ""), course(["Ethics"], "2027-05-01")];
  const out = taggedOutsidePeriod(entries, [entries[1]], ["Ethics"], null, new Date(2026, 5, 17), new Date(2028, 5, 17));
  assert.equal(out.undated, 1);
  assert.equal(out.before + out.after, 0);
  assert.equal(outsidePeriodText("Ethics", out), "1 course tagged Ethics has no completion date. Add the date to count it.");
  assert.equal(taggedOutsidePeriod(entries, entries, ["Ethics"], null, null, null), null);
  assert.equal(outsidePeriodText("Ethics", null), "");
});

test("a course in an accepted category only is reported when its category counts", () => {
  const entries = [{ ...course(["Ethics"], "2020-01-01"), category: "Other" }];
  assert.equal(taggedOutsidePeriod(entries, [], ["Ethics"], ["AMA PRA Category 1"], new Date(2026, 0, 1), new Date(2028, 0, 1)), null);
});

test("a period that has not started says so", () => {
  const pa = [{ state: "PA", type: "State Medical License", expirationDate: "2028-12-31" }];
  const comp = md(pa, []).find((c) => c.key === "PA").comp;
  const notes = cardWindowNotes(comp, new Date(2026, 9, 30));
  assert.ok(notes.some((n) => /^This period has not started yet\. It begins Dec 31, 2026; CME you complete from then counts toward it\.$/.test(n)), notes.join(" | "));
  assert.ok(!cardWindowNotes(comp, new Date(2027, 2, 1)).some((n) => /not started/.test(n)));
  // The engine's own notes (pinned by the MD/DO goldens) are unchanged.
  assert.ok(!windowNotes(comp).some((n) => /not started/.test(n)));
});

test("the PA and NP engine reports tagged courses outside its period too", async () => {
  await loadAppRules();
  const illinois = [{ state: "IL", type: "State Physician Assistant License", expirationDate: "2028-03-31" }];
  const list = complianceListFor({ cme: [{ ...course(["Implicit Bias"], "2020-01-15", 3), category: "AAPA Category 1" }], licenses: illinois, settings: { degreeType: "PA", state: "IL", primaryState: "IL", additionalStates: [] } });
  const t = list.flatMap((c) => c.comp.topicResults || []).find((x) => x.topic === "Implicit Bias");
  assert.equal(t.met, false);
  assert.equal(t.outsidePeriod.before, 1);
  assert.equal(t.outsidePeriod.hours, 3);
});
