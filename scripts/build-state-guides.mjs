/**
 * Build supabase/functions/send-guide/stateGuides.json from
 * landing/states/states-data.json.
 *
 * The guide email and the /states/<slug> page must say the same thing, so
 * they read the same source. This script is the only writer of the JSON the
 * edge function imports; re-run it whenever states-data.json changes, the
 * same way landing/states/generate.js rebuilds the pages.
 *
 * Run: node scripts/build-state-guides.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(dir, "..", "landing", "states", "states-data.json");
const OUT = path.join(dir, "..", "supabase", "functions", "send-guide", "stateGuides.json");

const raw = JSON.parse(fs.readFileSync(SRC, "utf-8"));
const states = raw.states || [];
if (states.length !== 51) {
  console.error(`Expected 51 states, found ${states.length}. Refusing to write.`);
  process.exit(1);
}

// Every field the email renders. Anything not listed is deliberately left
// out of the bundle so it does not grow without someone deciding to.
const KEEP = [
  "name", "abbreviation", "slug",
  "boardName", "boardUrl", "portalUrl", "doBoardName", "doBoardUrl",
  "renewalCycle", "renewalAnchor", "renewalMonth",
  "cmeHours", "cmeDetails", "cmeSplit", "cmeSource", "cmeSourceUrl",
  "renewalFee", "lateFee", "graceOrLapse", "processingTime",
  "steps", "pitfalls", "faqs", "sources", "relatedStates", "verified",
];

const out = {};
let missing = 0;
for (const s of states) {
  const abbr = s.abbreviation;
  if (!abbr) { missing += 1; continue; }
  const rec = {};
  for (const k of KEEP) if (s[k] !== undefined && s[k] !== null) rec[k] = s[k];
  rec.guide = `https://credentialdomd.com/states/${s.slug}`;
  out[abbr] = rec;
}
if (missing) { console.error(`${missing} states have no abbreviation. Refusing to write.`); process.exit(1); }

fs.writeFileSync(OUT, JSON.stringify(out, null, 0) + "\n");
const bytes = fs.statSync(OUT).size;
const biggest = Object.entries(out)
  .map(([k, v]) => [k, JSON.stringify(v).length])
  .sort((a, b) => b[1] - a[1])[0];
console.log(`wrote ${Object.keys(out).length} states, ${(bytes / 1024).toFixed(1)} KB`);
console.log(`largest entry: ${biggest[0]} at ${(biggest[1] / 1024).toFixed(1)} KB`);
