// Ticket 53890221: confirms the California pain management topic result
// carries the statute citation behind its one-time determination (Bus. &
// Prof. Code 2190.5), so the "One time, not every cycle" label shown to the
// member is backed by a traceable source, not just an unlabeled flag.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { computeCompliance } from "../src/utils/compliance.js";

test("CA pain management's one-time period carries its statute citation", () => {
  const entries = [{ title: "Synthetic course", category: "AMA PRA Category 1", hours: 12, date: "2019-03-01", topics: ["Pain Management"] }];
  const comp = computeCompliance(entries, "CA", "MD", { licenseExpiration: "2026-12-31" });
  const pain = comp.topicResults.find((t) => t.topic === "Pain Management");
  assert.equal(pain.period, "lifetime");
  assert.equal(pain.periodLabel, "One time, not every cycle");
  assert.match(pain.cite, /2190\.5/);
});
