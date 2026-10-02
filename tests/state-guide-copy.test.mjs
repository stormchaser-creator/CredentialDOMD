import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The state renewal guide a lead gets by email (send-guide) and the public
// /states pages read the same data. Research notes had leaked into it as
// reader text ("Processing: null - DPH does not publish ... on any page
// loaded", "(verbatim text loaded)", "returned HTTP 401 when loaded").

const guides = JSON.parse(readFileSync(new URL("../supabase/functions/send-guide/stateGuides.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../supabase/functions/send-guide/index.ts", import.meta.url), "utf8");
const NOTE = /(^|[^a-z-])null(?!(?:[- ]and[- ]| & )void)\b|null-equivalent|\bloaded\b|verbatim|HTTP \d{3}/i;

const strings = (v, path, out) => {
  if (typeof v === "string") out.push([path, v]);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out);
  return out;
};

test("no guide sentence carries a research note", () => {
  const bad = Object.entries(guides).flatMap(([abbr, g]) => strings(g, abbr, [])).filter(([, v]) => NOTE.test(v));
  assert.deepEqual(bad, []);
  // "null and void" is the statute's own phrase and stays.
  assert.ok(!NOTE.test("the license is null and void"));
  assert.ok(NOTE.test("null - DPH does not publish"));
});

test("every guide link is https", () => {
  const links = Object.values(guides).flatMap((g) => strings(g, "", [])).map(([, v]) => v).filter((v) => /^https?:\/\//.test(v));
  assert.ok(links.length > 100);
  assert.deepEqual(links.filter((v) => v.startsWith("http://")), []);
});

test("the email's own wording: American spelling, no hyphenated marketing words, the verified month in words", () => {
  const mate = source.match(/const MATE_NOTE =\s*"([^"]+)"/)[1];
  assert.doesNotMatch(mate, /practise|one-time|-/);
  // The rule is 8 hours in total, done once and cumulative across courses. A
  // hyphen-only rewrite once made it "a single 8 hour training" (one course).
  assert.match(mate, /completed 8 hours of training/);
  assert.match(mate, /spread across more than one course/);
  assert.doesNotMatch(mate, /a single 8 hour|an 8 hour (?:course|training)/i);
  assert.match(source, /verified \$\{esc\(verifiedText\(s\.verified\)\)\}/);
  assert.match(source, /verified \$\{verifiedText\(s\.verified\)\}\./);
  const verifiedText = new Function(`${source.match(/const MONTHS = [^\n]+/)[0]}\nreturn ${source.match(/const verifiedText = (\(v\?: string\) => \{[\s\S]*?\n\};)/)[1].replace("(v?: string)", "(v)").replace(/;$/, "")};`)();
  assert.equal(verifiedText("2026-08"), "August 2026");
  assert.equal(verifiedText("2026-08-19"), "August 2026");
});
