// Checks for src/utils/founding.js: the badge label, the emoji, and the
// read-only mapping of profiles.founding_number / is_founding_member into
// settings. Also pins that the founding keys are never written back to
// profiles (SETTINGS_TO_PROFILE in src/lib/supabase.js, read from the source
// text because that module needs a browser and Vite) and that the delete
// tombstone keeps the number.
// Run: node scripts/founding.test.mjs   (pure node, no test runner)
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FOUNDING_EMOJI, foundingLabel, foundingText, foundingFromProfile } from "../src/utils/founding.js";

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

// Label
eq("label carries the number", foundingLabel(7), "Founding member #7");
eq("label accepts a numeric string", foundingLabel("12"), "Founding member #12");
eq("label without a number", foundingLabel(null), "Founding member");
eq("label ignores zero", foundingLabel(0), "Founding member");
eq("label ignores a fraction", foundingLabel(2.5), "Founding member");
eq("text is emoji, space, label", foundingText(3), `${FOUNDING_EMOJI} Founding member #3`);
ok("one emoji, non-empty", typeof FOUNDING_EMOJI === "string" && FOUNDING_EMOJI.length > 0);
ok("no em dash in the label", !foundingLabel(1).includes("—") && !foundingLabel(null).includes("—"));

// Mapping
eq("numbered profile maps number and flag", foundingFromProfile({ founding_number: 4, is_founding_member: true }),
  { foundingNumber: 4, isFoundingMember: true });
eq("number wins even if the flag lags", foundingFromProfile({ founding_number: 2, is_founding_member: false }),
  { foundingNumber: 2, isFoundingMember: true });
eq("legacy flag without a number keeps the badge, no number", foundingFromProfile({ founding_number: null, is_founding_member: true }),
  { isFoundingMember: true });
eq("plain profile contributes nothing", foundingFromProfile({ founding_number: null, is_founding_member: false }), {});
eq("missing row contributes nothing", foundingFromProfile(null), {});

// Never written back
const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(here, "..", "src", "lib", "supabase.js"), "utf8");
const start = appSource.indexOf("const SETTINGS_TO_PROFILE = {");
const block = appSource.slice(start, appSource.indexOf("\n};", start));
ok("SETTINGS_TO_PROFILE has no foundingNumber", !/foundingNumber/.test(block));
ok("SETTINGS_TO_PROFILE has no isFoundingMember", !/isFoundingMember/.test(block));
ok("SETTINGS_TO_PROFILE has no founding_number column", !/founding_number/.test(block));
ok("supabase.js maps the profile row through foundingFromProfile", /foundingFromProfile\(row\)/.test(appSource));

// The delete tombstone keeps the number (a billing fact, like the flag).
const { PROFILE_KEEP_COLUMNS, PROFILE_TOMBSTONE_PATCH } = await import("../supabase/functions/delete-account/lib.ts");
ok("delete-account keeps founding_number", PROFILE_KEEP_COLUMNS.includes("founding_number"));
ok("delete-account tombstone never nulls founding_number", !("founding_number" in PROFILE_TOMBSTONE_PATCH));

// The migration and the client agree on the cap.
const constants = readFileSync(resolve(here, "..", "src", "utils", "pricingConstants.js"), "utf8");
const cap = Number(/FOUNDING_COHORT_CAP\s*=\s*(\d+)/.exec(constants)?.[1]);
const migration = readFileSync(resolve(here, "..", "supabase", "migrations", "20260902g_founding_members.sql"), "utf8");
eq("migration cap matches FOUNDING_COHORT_CAP", Number(/cap constant integer := (\d+)/.exec(migration)?.[1]), cap);
ok("migration range check matches the cap", migration.includes(`founding_number <= ${cap}`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
