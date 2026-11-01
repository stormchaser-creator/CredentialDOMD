// Ticket 53890221: a physician ticked Opioid Prescribing and Substance Use
// Disorders on the Edit CME form (shown checked and filled green there), but
// the course card showed those same chips dim, as if the selection had not
// saved. The card reads its chip list from the same item.topics the Edit CME
// form writes, and fills a chip only when the tag counts toward a tracked
// state or DEA MATE training; this pins that wiring and the engine logic
// behind it together. Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countingTopics, topicTags } from "../src/utils/cmeCore.js";
import { getStateEntry } from "../src/constants/stateRequirements.js";
import { computeCompliance } from "../src/utils/compliance.js";

const course = (topics, date, hours = 1) => ({ title: "Synthetic course", category: "AMA PRA Category 1", hours, date, topics });

test("the card's topic chips are driven by item.topics, the same field the Edit CME form saves", () => {
  const src = readFileSync(new URL("../src/components/features/CMESection.jsx", import.meta.url), "utf8");
  assert.match(src, /const topicsOf = \(item\) => \{/);
  // The mobile card and the desktop table both read topicsOf(item/c), never a
  // separate "selected" field that could drift from what the form saved.
  assert.match(src, /\{topicsOf\(item\)\.length > 0 && \(/);
  assert.match(src, /const list = topicsOf\(c\);/);
  // Every chip keeps an accent outline regardless of whether it counts, so a
  // ticked topic never again reads as dim/unselected.
  assert.match(src, /border: `1px solid \$\{T\.accent\}`,/);
  // The fill (not the outline) is the only thing counting toggles.
  assert.match(src, /backgroundColor: counting\.has\(t\) \? T\.accentGlow : "transparent",/);
  assert.match(src, /const counting = countingTopics\(requiredTopics, hasDea\);/);
});

test("a topic ticked through an also-tag (Opioid Prescribing, Substance Use Disorders for PA Pain Management) is a tracked-state tag once that state is tracked", () => {
  for (const deg of ["MD", "DO"]) {
    const required = [...new Set(
      (getStateEntry("PA", deg)?.topics || []).flatMap(topicTags)
    )];
    assert.ok(required.includes("Opioid Prescribing"), `PA ${deg} requiredTopics should include Opioid Prescribing`);
    assert.ok(required.includes("Substance Use Disorders"), `PA ${deg} requiredTopics should include Substance Use Disorders`);
    const counting = countingTopics(required, false);
    assert.equal(counting.has("Opioid Prescribing"), true);
    assert.equal(counting.has("Substance Use Disorders"), true);
  }
});

test("the same also-tags count for a non-tracked-state DEA registrant too, via MATE training", () => {
  // A physician tracking only a state that does not name these tags (e.g. a
  // single-state CA license) still sees them fill if they hold a DEA
  // registration, exactly as the ticket's screenshot showed.
  const caRequired = [...new Set((getStateEntry("CA", "MD")?.topics || []).flatMap(topicTags))];
  assert.equal(countingTopics(caRequired, false).has("Opioid Prescribing"), false);
  assert.equal(countingTopics(caRequired, true).has("Opioid Prescribing"), true);
  assert.equal(countingTopics(caRequired, true).has("Substance Use Disorders"), true);
});

test("a topic fully covered by tagged courses, including the also-tags, reads met with no residual shortfall", () => {
  // Exactly 2 hours tagged across an also-tag and the named topic for PA
  // Pain Management: the requirement reads met, not partly short.
  const entries = [
    course(["Opioid Prescribing"], "2025-08-09", 1),
    course(["Substance Use Disorders"], "2026-01-10", 1),
  ];
  const comp = computeCompliance(entries, "PA", "MD", { licenseExpiration: "2026-12-31", hasDEA: true });
  const pain = comp.topicResults.find((t) => t.topic === "Pain Management");
  assert.equal(pain.required, 2);
  assert.equal(pain.earned, 2);
  assert.equal(pain.met, true);
});
