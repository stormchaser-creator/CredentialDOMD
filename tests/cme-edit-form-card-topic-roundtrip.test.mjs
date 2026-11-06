// Ticket 53890221: a topic ticked (and saved green) on the Edit CME form did
// not read back as selected on that entry's card. Opening the form, ticking a
// topic, and reading the card all go through the same `item.topics` field and
// the same `topicsOf` reader, with no separate "selected" field to drift out
// of sync. This pins that single source of truth end to end in the source.
// Synthetic records only (the repository is public).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/features/CMESection.jsx", import.meta.url), "utf8");

test("opening Edit CME seeds the ticked-topic state from the same reader the card uses", () => {
  assert.match(src, /setForm\(\{ \.\.\.item, topics: topicsOf\(item\) \}\)/);
});

test("ticking a topic in Edit CME toggles the same item.topics field the card reads", () => {
  assert.match(src, /const sel = \(form\.topics \|\| \[\]\)\.includes\(topic\);/);
  assert.match(src, /return \{ \.\.\.f, topics: tags\.includes\(topic\) \? tags\.filter\(t => t !== topic\) : \[\.\.\.tags, topic\] \};/);
});
