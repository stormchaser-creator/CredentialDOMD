// Ticket 53890221: California's one-time 12-hr pain management CME must stay
// met across later renewal cycles, not re-demanded at every renewal. This
// pins that result three renewal cycles after the course was completed.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { computeCompliance } from "../src/utils/compliance.js";

test("a pain management course completed once is not re-demanded three renewal cycles later", () => {
  const entries = [{ title: "Synthetic course", category: "AMA PRA Category 1", hours: 12, date: "2018-05-01", topics: ["Pain Management"] }];
  const comp = computeCompliance(entries, "CA", "MD", { licenseExpiration: "2030-06-30" });
  const pain = comp.topicResults.find((t) => t.topic === "Pain Management");
  assert.equal(pain.earned, 12);
  assert.equal(pain.met, true);
});
