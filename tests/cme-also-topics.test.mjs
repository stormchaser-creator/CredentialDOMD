// Ticket 53890221: a physician ticked Opioid Prescribing and Substance Use
// Disorders on addiction courses, and Pennsylvania's pain management line
// still read short. The rule (49 Pa. Code 16.19, 25.271) lets pain
// management, identification of addiction, or prescribing opioids meet it,
// but the physician engine counted only the "Pain Management" tag. Rule data
// now names the other tags in alsoTopics, as the PA and NP engine already
// reads them. Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { computeCompliance, complianceListFor, topicOutsidePeriod } from "../src/utils/compliance.js";
import { topicTags, topicTagsLabel, outsidePeriodText } from "../src/utils/cmeCore.js";
import { getStateEntry } from "../src/constants/stateRequirements.js";

const course = (topics, date, hours = 1) => ({ title: "Synthetic course", category: "AMA PRA Category 1", hours, date, topics });
const OPTS = { licenseExpiration: "2026-12-31", hasDEA: true };
const pain = (comp) => comp.topicResults.find((t) => t.topic === "Pain Management");

for (const deg of ["MD", "DO"]) {
  test(`${deg} Pennsylvania: courses tagged Opioid Prescribing or Substance Use Disorders count toward pain management`, () => {
    const entries = [
      course(["Substance Use Disorders", "Opioid Prescribing", "Controlled Substances"], "2025-08-09"),
      course(["Substance Use Disorders"], "2026-02-01"),
    ];
    const t = pain(computeCompliance(entries, "PA", deg, OPTS));
    assert.equal(t.earned, 2);
    assert.equal(t.met, true);
  });
}

test("a course carrying the topic and an also-tag counts its hours once", () => {
  const entries = [course(["Pain Management", "Opioid Prescribing", "Substance Use Disorders"], "2025-08-09", 1.5)];
  assert.equal(pain(computeCompliance(entries, "PA", "MD", OPTS)).earned, 1.5);
});

test("the also-tags count only where the rule names them", () => {
  // Michigan's pain management line names no other subject: an opioid course
  // does not meet it, exactly as before.
  const entries = [course(["Opioid Prescribing", "Substance Use Disorders"], "2025-08-09", 3)];
  const mi = computeCompliance(entries, "MI", "MD", { licenseExpiration: "2027-01-31" });
  assert.equal(pain(mi).earned, 0);
  assert.equal(pain(mi).alsoTopics, undefined);
  for (const deg of ["MD", "DO"]) {
    assert.deepEqual(topicTags(getStateEntry("PA", deg).topics.find((t) => t.topic === "Pain Management")),
      ["Pain Management", "Opioid Prescribing", "Substance Use Disorders"]);
  }
});

test("an also-tagged course dated before the cycle is explained under the requirement", () => {
  const entries = [course(["Opioid Prescribing", "Substance Use Disorders"], "2024-08-09")];
  const licenses = [{ state: "PA", type: "State Medical License", expirationDate: "2026-12-31" }];
  const list = complianceListFor({ cme: entries, licenses, settings: { degreeType: "MD", state: "PA", primaryState: "PA", additionalStates: [] } });
  const comp = list.find((c) => c.key === "PA").comp;
  const t = pain(comp);
  assert.equal(t.met, false);
  const out = topicOutsidePeriod(comp, t, entries);
  assert.equal(out.before, 1);
  assert.match(outsidePeriodText(topicTagsLabel(t), out),
    /^1 course you tagged Pain Management, Opioid Prescribing or Substance Use Disorders is dated outside the period/);
});

test("topicTags reads a missing or null alsoTopics as the topic alone", () => {
  assert.deepEqual(topicTags({ topic: "Ethics" }), ["Ethics"]);
  assert.deepEqual(topicTags({ topic: "Ethics", alsoTopics: null }), ["Ethics"]);
  assert.equal(topicTagsLabel({ topic: "Ethics" }), "Ethics");
});
