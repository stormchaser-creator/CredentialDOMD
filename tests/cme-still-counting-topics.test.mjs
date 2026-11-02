// Ticket 53890221: the CME math panel listed a one-time California pain
// management course dated before the cycle under "Not counting toward this
// renewal" with no word that it still meets the one-time mandate. The panel
// now names the topics such an entry still counts toward.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { complianceListFor, splitByCycle } from "../src/utils/compliance.js";
import { stillCountingTopics } from "../src/utils/cmeCore.js";

const course = (topics, date, hours = 12, category = "AMA PRA Category 1") => ({ id: `c-${date}-${topics}`, title: "Synthetic course", category, hours, date, topics });
const caCard = (cme) => complianceListFor({ cme, licenses: [{ state: "CA", type: "State Medical License", expirationDate: "2027-06-30" }], settings: { degreeType: "MD", state: "CA", primaryState: "CA", additionalStates: [] } }).find((c) => c.key === "CA").comp;

test("a pre-cycle one-time pain management course is named as still counting", () => {
  const old = course(["Pain Management"], "2019-03-01");
  const comp = caCard([old]);
  const { outWin } = splitByCycle([old], comp.windowStart, comp.windowEnd);
  assert.equal(outWin.length, 1);
  assert.equal(comp.topicResults.find((t) => t.topic === "Pain Management").met, true);
  assert.deepEqual(stillCountingTopics(outWin[0], comp.topicResults, comp.windowEnd), ["Pain Management"]);
});

test("a cycle-only topic or an untagged entry outside the window is not named", () => {
  const geri = course(["Geriatric Medicine"], "2019-03-01", 10);
  const plain = course([], "2019-03-01", 5);
  const comp = caCard([geri, plain]);
  assert.deepEqual(stillCountingTopics(geri, comp.topicResults, comp.windowEnd), []);
  assert.deepEqual(stillCountingTopics(plain, comp.topicResults, comp.windowEnd), []);
});

test("the CME math panel shows the still-counting line for outside entries", () => {
  const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(src, /const stillCounts = stillCountingTopics\(c, comp\.topicResults, comp\.windowEnd\);/);
  assert.match(src, /but still counts toward \{stillCounts\.join\(", "\)\}/);
});
