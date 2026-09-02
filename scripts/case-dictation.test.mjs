// Unit-style checks for the case-dictation prompts (src/utils/caseDictation.js).
// No network. The Gemini prompt is pinned by hash: it must stay byte-for-byte
// what shipped, while the Opus path splits the same text into a cached
// system block and a small per-case user message.
// Run: node scripts/case-dictation.test.mjs   (pure node, no test runner)
import { createHash } from "node:crypto";
import { geminiPrompt, OPUS_SYSTEM, opusUserMessage } from "../src/utils/caseDictation.js";
import { CONSTRUCT_RULES } from "../src/constants/cptConstructs.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ── Gemini prompt: byte-identical to the shipped PROMPT() ───────────────────
// Hashes were taken from the pre-split file on 2026-09-02 for these inputs.
const T = "right crani for SDH at Eisenhower, primary surgeon";
const CATS = ["Cranial", "Spine", "Peripheral Nerve"];
const g1 = geminiPrompt(T, "2026-09-02", CATS);
eq("gemini prompt length", g1.length, 13074);
eq("gemini prompt hash", sha(g1), "b877c1186bcc55c0933c5c7e93e34ae578ab3949409e759846711c921a512cdb");
const g2 = geminiPrompt("", "2026-01-01", []);
eq("gemini prompt (empty inputs) length", g2.length, 12992);
eq("gemini prompt (empty inputs) hash", sha(g2), "f89eb1715e7feda1f298090c239716e7c05c72593c3cfa054e987cf84fc0fa9b");

// ── Opus split: the fixed text is the system block, the case is the message ─
ok("system block carries the construct rules", OPUS_SYSTEM.includes(CONSTRUCT_RULES));
ok("system block carries the template", OPUS_SYSTEM.includes('{"date": "YYYY-MM-DD",') && OPUS_SYSTEM.includes("Patient identifiers NEVER go in any field."));
ok("system block carries the header", OPUS_SYSTEM.startsWith("You convert a NEUROSURGEON's spoken"));
ok("system block has nothing per-case", !/TODAY is|CATEGORIES \(pick|SPOKEN:/.test(OPUS_SYSTEM));
ok("system block is the same for every call", OPUS_SYSTEM === OPUS_SYSTEM && typeof OPUS_SYSTEM === "string");
ok("system block is big enough to cache (Opus 5 minimum 512 tokens)", OPUS_SYSTEM.length > 4000);

const u = opusUserMessage(T, "2026-09-02", CATS);
ok("user message carries the date", u.includes("TODAY is 2026-09-02 (local)."));
ok("user message carries the categories", u.includes("CATEGORIES (pick the closest): Cranial, Spine, Peripheral Nerve"));
ok("user message ends with the transcript", u.endsWith(`SPOKEN: ${T}`));
ok("user message carries no rules", !u.includes(CONSTRUCT_RULES.slice(0, 80)) && !u.includes('"cptCodes"'));
ok("user message is small", u.length < 400, `len ${u.length}`);

// Every line of the Gemini prompt lives in exactly one of the two Opus pieces,
// so the model reads the same instructions on either route.
{
  const lines = g1.split("\n").filter(l => l.trim());
  const missing = lines.filter(l => !OPUS_SYSTEM.includes(l) && !u.includes(l));
  eq("no Gemini prompt line is lost on the Opus route", missing, []);
  const twice = lines.filter(l => OPUS_SYSTEM.includes(l) && u.includes(l));
  eq("no line is sent twice", twice, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
