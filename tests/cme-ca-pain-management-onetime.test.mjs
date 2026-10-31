// Ticket 53890221: a California physician asked whether the 12-hr pain
// management CME (Bus. & Prof. Code 2190.5) is a one-time requirement or is
// re-demanded every renewal. Rule data already carries period: "lifetime" for
// this topic; this pins that a single completion keeps the requirement met
// across later renewal cycles, instead of aging out of each cycle's window.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { computeCompliance } from "../src/utils/compliance.js";

const course = (topics, date, hours = 1) => ({ title: "Synthetic course", category: "AMA PRA Category 1", hours, date, topics });
const painOf = (comp) => comp.topicResults.find((t) => t.topic === "Pain Management");

test("California pain management CME, completed once, stays met across later renewal cycles", () => {
  const entries = [course(["Pain Management"], "2019-03-01", 12)];

  const firstCycle = painOf(computeCompliance(entries, "CA", "MD", { licenseExpiration: "2022-01-31" }));
  assert.equal(firstCycle.earned, 12);
  assert.equal(firstCycle.met, true);
  assert.equal(firstCycle.period, "lifetime");
  assert.equal(firstCycle.periodLabel, "One time, not every cycle");

  const laterCycle = painOf(computeCompliance(entries, "CA", "MD", { licenseExpiration: "2028-01-31" }));
  assert.equal(laterCycle.earned, 12);
  assert.equal(laterCycle.met, true);
});
