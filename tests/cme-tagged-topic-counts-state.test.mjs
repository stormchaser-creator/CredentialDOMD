// Ticket 53890221: a topic tagged on a CME entry must count toward that
// state's matching requirement line, and an untagged course must not. This
// pins the basic tag-to-requirement link on a state untouched by the
// Pennsylvania also-tags fix, so the two code paths are checked separately.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { computeCompliance } from "../src/utils/compliance.js";

const course = (topics, date, hours, category = "AMA PRA Category 1") => ({ title: "Synthetic course", category, hours, date, topics });

test("a tagged course counts toward its matching Arkansas topic line; an untagged one does not", () => {
  const opts = { licenseExpiration: "2026-12-31" };
  const opioid = (comp) => comp.topicResults.find((t) => t.topic === "Opioid Prescribing");

  const tagged = computeCompliance([course(["Opioid Prescribing"], "2026-06-01", 1)], "AR", "MD", opts);
  assert.equal(opioid(tagged).earned, 1);
  assert.equal(opioid(tagged).met, true);

  const untagged = computeCompliance([course([], "2026-06-01", 1)], "AR", "MD", opts);
  assert.equal(opioid(untagged).earned, 0);
  assert.equal(opioid(untagged).met, false);
});
