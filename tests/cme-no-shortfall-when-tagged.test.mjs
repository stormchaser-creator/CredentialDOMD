// Ticket 53890221: the physician tagged every required topic on their CME and
// still saw a deficit in the state requirement summary. This pins the
// aggregate-level result (not just a single topic bar): once the tagged
// hours clear every topic mandate and the category/total minimums, the
// engine reports the state as fully met, with zero hours remaining.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { computeCompliance } from "../src/utils/compliance.js";

const course = (topics, date, hours, category = "AMA PRA Category 1") => ({ title: "Synthetic course", category, hours, date, topics });

test("tagging every required topic clears the state summary, with no residual shortfall", () => {
  // Arkansas: 20 total hrs, 10 cat1min, Opioid Prescribing 1 hr/cycle,
  // Controlled Substances 3 hrs one-time (period: "lifetime").
  const entries = [
    course(["Opioid Prescribing"], "2026-06-01", 1),
    course(["Controlled Substances"], "2026-03-01", 3),
    course([], "2026-06-15", 16),
  ];
  const comp = computeCompliance(entries, "AR", "MD", { licenseExpiration: "2026-12-31" });

  assert.equal(comp.totalMet, true);
  assert.equal(comp.cat1Met, true);
  assert.equal(comp.hoursRemaining, 0);
  assert.equal(comp.allTopicsMet, true);
  assert.equal(comp.knownRequirementsMet, true);
  assert.equal(comp.assessmentStatus, "met");
  assert.equal(comp.fullyCompliant, true);
  for (const t of comp.topicResults) {
    assert.equal(t.met, true, `${t.topic} should read met, not a shortfall`);
  }
});
