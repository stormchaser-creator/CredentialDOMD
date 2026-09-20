// Which settings survive a round trip through the cloud, and which server-owned
// columns the browser is allowed to read back.
//
// Two defects, one function:
//
//   1. settings.assistantModel was stored nowhere durable. It is not a
//      profiles column, so settingsToProfileRow dropped it without a word;
//      loadFromSupabase rebuilt settings from the profile row; AppContext
//      merged DEFAULT_SETTINGS with that row and then cached the result over
//      the on-device copy. A physician who set "Vera answers with: Claude
//      Opus" got Opus until the next online load, after which every turn ran
//      on Gemini and the dropdown read "Gemini (cheaper, the default)" again.
//      Nothing failed and nothing was shown.
//
//   2. profiles.verified_email is the mailbox the sign-in provider verified,
//      and email-inbound routes forwarded credentialing mail on it. The
//      browser never learned about it, so Settings > Email badged a working
//      address "Not confirmed" and Requests said nothing reached the account.
//      It is read-only here: clerk-webhook writes it with the service role and
//      a trigger freezes it against user tokens, so it must never appear in a
//      profile row this client sends.
//
// Run: node scripts/settings-persistence.test.mjs   (pure node, no runner)

// The module reads localStorage through its device-key helpers. Shim before
// importing, the same way scripts/device-secrets.test.mjs does.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
  clear: () => { store.clear(); },
};
globalThis.window = globalThis.window || {};

import { readFileSync } from "node:fs";
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const {
  LOCAL_ONLY_SETTINGS, withLocalOnlySettings, settingsToProfileRow, profileRowToSettings,
} = await import("../src/lib/supabase.js");
const { DEFAULT_SETTINGS } = await import("../src/constants/defaults.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w ? name : `${name}\n   got  ${g}\n   want ${w}`, g === w);
};

// ── The cause: the cloud has no column for these ────────────────────────────
ok("assistantModel is on the local-only list", LOCAL_ONLY_SETTINGS.includes("assistantModel"));
ok("coderModel is too, for the same reason and before it fails the same way",
  LOCAL_ONLY_SETTINGS.includes("coderModel"));
for (const k of LOCAL_ONLY_SETTINGS) {
  const row = settingsToProfileRow({ [k]: "opus", name: "Alex Reyes" });
  ok(`${k} is dropped by settingsToProfileRow, which is why it needs carrying`,
    !Object.keys(row).some((c) => c.includes(k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`))));
  eq(`${k} does not stop the rest of the patch reaching the cloud`, row.name, "Alex Reyes");
}

// A DEFAULT would defeat the carry-forward: the merged value would be defined,
// the "cloud is silent" test below would find nothing missing, and the
// physician's choice would still be lost. The readers treat absent as their
// own default instead (SettingsSection reads `s.assistantModel || "gemini"`).
for (const k of LOCAL_ONLY_SETTINGS) {
  ok(`${k} is deliberately absent from DEFAULT_SETTINGS`, !(k in DEFAULT_SETTINGS));
}

// ── The fix: carry the named keys, and only them ────────────────────────────
const cloud = { name: "Alex Reyes", theme: "dark", primaryState: "NC" };
const local = { name: "Alex Reyes", theme: "light", assistantModel: "opus", coderModel: "gemini" };

eq("the Opus choice survives a cloud load", withLocalOnlySettings(cloud, local).assistantModel, "opus");
eq("so does the coder choice", withLocalOnlySettings(cloud, local).coderModel, "gemini");
eq("a value the cloud DOES hold is not overwritten by the stale local copy",
  withLocalOnlySettings(cloud, local).theme, "dark");
eq("nothing else is carried across",
  Object.keys(withLocalOnlySettings(cloud, local)).sort(),
  ["assistantModel", "coderModel", "name", "primaryState", "theme"]);

// The whole point of merging a NAMED list rather than all of local.settings:
// a value deleted on another device must stay deleted.
const deletedInCloud = { name: "Alex Reyes" };
const staleLocal = { name: "Alex Reyes", npi: "1234567890", phone: "555-0100", assistantModel: "opus" };
eq("a field cleared in the cloud is not resurrected from the device cache",
  withLocalOnlySettings(deletedInCloud, staleLocal).npi, undefined);
eq("nor is any other stale field", withLocalOnlySettings(deletedInCloud, staleLocal).phone, undefined);
eq("while the local-only choice still comes through",
  withLocalOnlySettings(deletedInCloud, staleLocal).assistantModel, "opus");

// A cloud value that is present and explicitly "gemini" wins over a stale
// local "opus": the physician changed it somewhere that could store it.
eq("an explicit cloud value wins",
  withLocalOnlySettings({ assistantModel: "gemini" }, { assistantModel: "opus" }).assistantModel, "gemini");

eq("no local cache at all is not a crash", withLocalOnlySettings(cloud, null), cloud);
eq("no cloud settings at all is not a crash",
  withLocalOnlySettings(null, local), { assistantModel: "opus", coderModel: "gemini" });
eq("both missing", withLocalOnlySettings(null, null), {});
eq("a local cache that is not an object is ignored", withLocalOnlySettings(cloud, "nope"), cloud);
eq("an array for local settings is ignored", withLocalOnlySettings(cloud, []), cloud);
ok("the input objects are not mutated", (() => {
  const c = { ...cloud }, l = { ...local };
  withLocalOnlySettings(c, l);
  return !("assistantModel" in c) && l.assistantModel === "opus";
})());

// ── The whole round trip, the way AppContext runs it ────────────────────────
// Set Opus, save, come back online. Before the carry-forward this ended with
// assistantModel undefined, wantsOpus false, and every turn on Gemini.
const chosen = { ...DEFAULT_SETTINGS, name: "Alex Reyes", email: "doc@hospital.org", assistantModel: "opus" };
const profileRow = { ...settingsToProfileRow(chosen), id: "p1", access_status: "active" };
ok("the cloud row really does not carry the choice", !("assistant_model" in profileRow));
const fromCloud = profileRowToSettings(profileRow);
eq("so a cloud rebuild has no choice in it", fromCloud.assistantModel, undefined);
const merged = withLocalOnlySettings({ ...DEFAULT_SETTINGS, ...fromCloud }, chosen);
eq("and the carry-forward puts it back", merged.assistantModel, "opus");
eq("the name still came from the cloud row", merged.name, "Alex Reyes");
const assistantSrc = read("../src/utils/assistant.js");
ok("this is the exact value assistant.js routes on",
  /s\.assistantModel === "opus"/.test(assistantSrc));

// ── The server-owned verified mailbox, read-only ────────────────────────────
const verifiedRow = {
  id: "p1", name: "Alex Reyes", email: "typed@anything.org",
  verified_email: "doc@hospital.org", verified_email_at: "2026-09-15T00:00:00Z",
  access_status: "active",
};
eq("the verified mailbox reaches settings", profileRowToSettings(verifiedRow).verifiedEmail, "doc@hospital.org");
eq("the editable profiles.email is still its own separate field",
  profileRowToSettings(verifiedRow).email, "typed@anything.org");
eq("a row with no verified mailbox says nothing",
  profileRowToSettings({ id: "p1", name: "Alex Reyes" }).verifiedEmail, undefined);
eq("a null column says nothing either",
  profileRowToSettings({ id: "p1", verified_email: null }).verifiedEmail, undefined);
// Never written back: clerk-webhook owns the column with the service role and
// profiles_lock_verified_email drops anything a user token sends.
const backOut = settingsToProfileRow(profileRowToSettings(verifiedRow));
ok("and it is never written back", !("verified_email" in backOut));
ok("nor is the stamp", !("verified_email_at" in backOut));
eq("the round trip still writes the ordinary columns", backOut.email, "typed@anything.org");

// A real round trip must not lose it either: the browser reads it on every
// load, so it does not need carrying, but it must not be treated as writable.
ok("verifiedEmail is not on the local-only list (the server owns it)",
  !LOCAL_ONLY_SETTINGS.includes("verifiedEmail"));

// ── The wiring, without which the function above is decoration ──────────────
const ctxSrc = read("../src/context/AppContext.jsx");
ok("AppContext actually calls the carry-forward on the cloud merge",
  /merged\.settings = withLocalOnlySettings\(merged\.settings, local\?\.settings\)/.test(ctxSrc));
ok("and it runs after the legacy adoption that can produce `local`",
  ctxSrc.indexOf("adoptLegacyStorage(authUserId") < ctxSrc.indexOf("withLocalOnlySettings(merged.settings"));
ok("and before the merge is handed to setData",
  ctxSrc.indexOf("withLocalOnlySettings(merged.settings") < ctxSrc.indexOf("setData(merged)"));
const settingsSrc = read("../src/components/pages/SettingsSection.jsx");
ok("Settings still reads the choice with its own fallback rather than a stored default",
  settingsSrc.includes('s.assistantModel || "gemini"'));

// ── House rules ─────────────────────────────────────────────────────────────
// Only the lines this change wrote: both files are old and full of em dashes
// in comments written long before the rule, and rewriting those is not this
// batch's job.
const NEW_COMMENTS = [
  "LOCAL_ONLY_SETTINGS", "withLocalOnlySettings", "verified_email",
];
for (const [name, src] of [["lib/supabase.js", read("../src/lib/supabase.js")],
                           ["AppContext.jsx", read("../src/context/AppContext.jsx")]]) {
  const lines = src.split("\n").filter((l) => NEW_COMMENTS.some((k) => l.includes(k)));
  ok(`no em dashes on the lines this change wrote in ${name}`,
    lines.length > 0 && lines.every((l) => !l.includes("\u2014")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
