// Checks that device secrets never leave the device, in any direction.
//
// Three things went wrong at once and this pins all three:
//   1. loadDeviceKeys returned the WHOLE per-user device slot, and
//      src/utils/secretBox.js keeps the portal-password lock code in that same
//      slot. The code was spread into settings, cached to disk, and written
//      into the downloaded JSON export beside the ciphertext it opens.
//   2. DataExport.jsx and credentialExport.js each stripped apiKey and
//      anthropicApiKey by hand. Two hand-maintained lists, so neither learned
//      about the lock code or the CallSync feed link, and the ZIP's embedded
//      backup carried both.
//   3. A cache written by an older build still holds that material on disk,
//      so the allowlist alone does not clean an existing device.
//
// Run: node scripts/device-secrets.test.mjs   (pure node, no test runner)

// localStorage + window shims must exist before the modules are imported
// (module bodies don't read storage at import time, but every helper does).
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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const {
  DEVICE_KEY_FIELDS, UNLOCK_FIELDS, EXPORT_REDACT_FIELDS,
  redactForExport, loadDeviceKeys,
} = await import("../src/lib/supabase.js");
const { getLockCode, saveLockCode } = await import("../src/utils/secretBox.js");
const { STORAGE_KEY } = await import("../src/constants/defaults.js");
const { DEVICE_KEYS_BASE } = await import("../src/utils/storageScope.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w ? name : `${name}\n   got  ${g}\n   want ${w}`, g === w);
};

const A = "user_2aaaAAAA";
const B = "user_2bbbBBBB";
const slotKey = (uid) => `${DEVICE_KEYS_BASE}:${uid}`;
const cacheKey = (uid) => `${STORAGE_KEY}:${uid}`;
const readSlot = (uid) => JSON.parse(store.get(slotKey(uid)) || "null");
const readCache = (key) => JSON.parse(store.get(key) || "null");

// A cached blob shaped like a real one: the settings a physician actually has,
// plus the collections they read offline.
const realisticCache = (settings) => ({
  settings: {
    name: "Alex Reyes",
    degreeType: "DO",
    primaryState: "NC",
    additionalStates: ["SC", "VA"],
    reminderLeadDays: 90,
    theme: "dark",
    notifyEmail: true,
    cmeVerificationResults: { "lic-1": "verified" },
    ...settings,
  },
  licenses: [{ id: "lic-1", state: "NC", licenseNumber: "2019-1234", expirationDate: "2027-03-01" }],
  cme: [{ id: "cme-1", title: "Stroke update", hours: 2 }],
  documents: [{ id: "doc-1", name: "license.pdf", storagePath: "u/doc-1" }],
  _userId: "profile-1",
});

// ── The lists ───────────────────────────────────────────────────────────────
eq("DEVICE_KEY_FIELDS is the four device-only settings fields",
  DEVICE_KEY_FIELDS, ["apiKey", "anthropicApiKey", "callsyncFeedUrl", "callsyncContractId"]);
ok("UNLOCK_FIELDS names the lock code secretBox writes to the same slot",
  UNLOCK_FIELDS.includes("lockCode"));
for (const f of DEVICE_KEY_FIELDS) {
  ok(`EXPORT_REDACT_FIELDS covers device field ${f}`, EXPORT_REDACT_FIELDS.includes(f));
}
for (const f of UNLOCK_FIELDS) {
  ok(`EXPORT_REDACT_FIELDS covers unlock field ${f}`, EXPORT_REDACT_FIELDS.includes(f));
}

// ── (a) Hydration allowlist ─────────────────────────────────────────────────
store.clear();
store.set(slotKey(A), JSON.stringify({
  apiKey: "gem-key", anthropicApiKey: "ant-key",
  callsyncFeedUrl: "https://callsync.example/feed/abc", callsyncContractId: "c-1",
  lockCode: "8421",
  somethingElseEntirely: "zzz",
}));
const hydrated = loadDeviceKeys(A);
eq("hydration returns exactly the allowlisted fields",
  Object.keys(hydrated).sort(), [...DEVICE_KEY_FIELDS].sort());
ok("hydration drops the lock code", !("lockCode" in hydrated));
ok("hydration drops an unknown field from the slot", !("somethingElseEntirely" in hydrated));
eq("hydration keeps the Gemini key", hydrated.apiKey, "gem-key");
eq("hydration keeps the Anthropic key", hydrated.anthropicApiKey, "ant-key");
eq("hydration keeps the CallSync feed link", hydrated.callsyncFeedUrl, "https://callsync.example/feed/abc");
eq("hydration keeps the CallSync contract id", hydrated.callsyncContractId, "c-1");

// (a) the lock code keeps working: secretBox reads the slot directly, never settings.
eq("secretBox.getLockCode still reads the code out of the slot", getLockCode(A), "8421");
ok("the slot still holds the lock code after a hydration", readSlot(A).lockCode === "8421");
eq("no lock code leaks into another account's hydration", loadDeviceKeys(B), {});
eq("loadDeviceKeys with no user is empty", loadDeviceKeys(null), {});
eq("loadDeviceKeys with undefined user is empty", loadDeviceKeys(undefined), {});

store.clear();
store.set(slotKey(A), "{not json");
eq("a malformed slot does not throw", loadDeviceKeys(A), {});

store.clear();
saveLockCode("1234", A);
eq("a slot holding only the lock code hydrates nothing", loadDeviceKeys(A), {});
eq("and the lock code survives that load", getLockCode(A), "1234");

// Adoption out of an old cached blob must MERGE into the slot: overwriting it
// with the adopted keys alone would take the lock code, and with it every
// encrypted portal password, off the device.
store.clear();
saveLockCode("1234", A);
store.set(cacheKey(A), JSON.stringify(realisticCache({ apiKey: "cached-key" })));
const adopted = loadDeviceKeys(A);
eq("an old cached key is adopted into the slot", adopted.apiKey, "cached-key");
eq("adoption leaves the lock code in the slot", readSlot(A).lockCode, "1234");
ok("adoption strips the key back out of the cached blob",
  !("apiKey" in readCache(cacheKey(A)).settings));

// ── (b) One redaction, used by both export paths ────────────────────────────
const fullSettings = {
  name: "Alex Reyes", degreeType: "DO", primaryState: "NC", reminderLeadDays: 90,
  apiKey: "gem-key", anthropicApiKey: "ant-key",
  callsyncFeedUrl: "https://callsync.example/feed/abc", callsyncContractId: "c-1",
  lockCode: "8421",
};
const redacted = redactForExport(fullSettings);
for (const f of EXPORT_REDACT_FIELDS) {
  ok(`redactForExport removes ${f}`, !(f in redacted));
}
eq("redactForExport keeps the name", redacted.name, "Alex Reyes");
eq("redactForExport keeps the degree", redacted.degreeType, "DO");
eq("redactForExport keeps the primary state", redacted.primaryState, "NC");
eq("redactForExport keeps the reminder lead days", redacted.reminderLeadDays, 90);
ok("redactForExport does not mutate the settings it was handed",
  fullSettings.lockCode === "8421" && fullSettings.apiKey === "gem-key");
eq("redactForExport of null settings is an empty object", redactForExport(null), {});
eq("redactForExport of undefined settings is an empty object", redactForExport(undefined), {});
eq("redactForExport of already-clean settings is unchanged",
  redactForExport({ name: "A", theme: "dark" }), { name: "A", theme: "dark" });

// Both export paths use the shared helper, and neither keeps its own list.
const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(resolve(here, "..", "src", ...p), "utf8");
const dataExportSrc = src("components", "features", "DataExport.jsx");
const credentialExportSrc = src("utils", "credentialExport.js");
const INLINE_STRIP = /const\s*\{\s*apiKey\s*,\s*anthropicApiKey\s*,\s*\.\.\./;

ok("DataExport.jsx imports the shared redaction", /redactForExport/.test(dataExportSrc));
ok("DataExport.jsx calls it on the settings it downloads",
  /redactForExport\(data\.settings\)/.test(dataExportSrc));
ok("DataExport.jsx no longer strips two fields by hand", !INLINE_STRIP.test(dataExportSrc));
ok("credentialExport.js imports the shared redaction from lib/supabase",
  /import\s*\{\s*redactForExport\s*\}\s*from\s*"\.\.\/lib\/supabase\.js"/.test(credentialExportSrc));
ok("the ZIP's embedded JSON export goes through it",
  /settings:\s*redactForExport\(data\.settings\)/.test(credentialExportSrc));
ok("the ZIP path no longer contains its own inline redaction",
  !INLINE_STRIP.test(credentialExportSrc));

// And the real failing case, end to end: build the account export a
// physician downloads before cancelling and read the embedded backup back out
// of the archive. The packet sent to a credentialing office carries no JSON
// backup at all (ticket d49088c7), so it has nothing to redact.
const { generateCredentialZip } = await import("../src/utils/credentialExport.js");
const JSZip = (await import("jszip")).default;
const zipInput = {
  settings: fullSettings,
  licenses: [{ id: "lic-1", state: "NC", licenseNumber: "2019-1234", type: "License" }],
  privileges: [{
    id: "priv-1", hospital: "County General",
    portalUsername: "areyes", portalPassword: "enc1:AAAABBBBCCCC",
  }],
  documents: [],
};
const packet = await generateCredentialZip(zipInput, { scope: "account" });
const backupEntry = await JSZip.loadAsync(await packet.arrayBuffer());
const backupPath = Object.keys(backupEntry.files).find((n) => n.endsWith("credentialdomd_backup.json"));
ok("the account export carries the embedded JSON backup", !!backupPath, backupPath || "");
{
  const sent = await JSZip.loadAsync(await (await generateCredentialZip(zipInput)).arrayBuffer());
  ok("the packet for a credentialing office carries no JSON backup",
    !Object.keys(sent.files).some((n) => n.endsWith(".json")));
}
const backupText = await backupEntry.file(backupPath).async("string");
const backup = JSON.parse(backupText);
for (const f of EXPORT_REDACT_FIELDS) {
  ok(`the ZIP's embedded backup carries no ${f}`, !(f in backup.settings));
}
ok("the ZIP's embedded backup carries no lock code anywhere in its text",
  !backupText.includes("8421"));
ok("the encrypted portal password still rides along, with nothing to open it",
  backupText.includes("enc1:AAAABBBBCCCC"));
eq("the ZIP's embedded backup keeps the physician's name", backup.settings.name, "Alex Reyes");
eq("the ZIP's embedded backup keeps the records", backup.licenses[0].licenseNumber, "2019-1234");

// ── (c) Legacy scrub of a cache written by an older build ───────────────────
store.clear();
const dirty = realisticCache({
  apiKey: "gem-key",
  callsyncFeedUrl: "https://callsync.example/feed/abc",
  lockCode: "8421",
});
store.set(cacheKey(A), JSON.stringify(dirty));
saveLockCode("8421", A); // the slot is where the code really lives
loadDeviceKeys(A);
const scrubbed = readCache(cacheKey(A));
ok("the scrub removes the lock code from the cached blob", !("lockCode" in scrubbed.settings));
ok("the scrub removes the CallSync feed link from the cached blob",
  !("callsyncFeedUrl" in scrubbed.settings));
ok("the scrub removes a cached AI key too", !("apiKey" in scrubbed.settings));
eq("the scrub keeps the name", scrubbed.settings.name, "Alex Reyes");
eq("the scrub keeps the degree", scrubbed.settings.degreeType, "DO");
eq("the scrub keeps the primary state", scrubbed.settings.primaryState, "NC");
eq("the scrub keeps an array setting", scrubbed.settings.additionalStates, ["SC", "VA"]);
eq("the scrub keeps an object setting", scrubbed.settings.cmeVerificationResults, { "lic-1": "verified" });
eq("the scrub keeps the reminder lead days", scrubbed.settings.reminderLeadDays, 90);
eq("the scrub keeps every other settings key",
  Object.keys(scrubbed.settings).sort(),
  ["additionalStates", "cmeVerificationResults", "degreeType", "name", "notifyEmail", "primaryState", "reminderLeadDays", "theme"]);
// A physician offline still has to see their records.
eq("the scrub keeps the licenses", scrubbed.licenses.length, 1);
eq("the scrub keeps the license number", scrubbed.licenses[0].licenseNumber, "2019-1234");
eq("the scrub keeps the CME", scrubbed.cme.length, 1);
eq("the scrub keeps the documents", scrubbed.documents[0].name, "license.pdf");
eq("the scrub keeps the profile id", scrubbed._userId, "profile-1");
eq("the lock code is still readable after the scrub", getLockCode(A), "8421");

// The scrub is also the last line: if the slot lost the code, recover it from
// THIS account's own cache before deleting it.
store.clear();
store.set(cacheKey(A), JSON.stringify(realisticCache({ lockCode: "9999" })));
loadDeviceKeys(A);
eq("a lock code found only in this account's cache is recovered into the slot", getLockCode(A), "9999");
ok("and is gone from the cached blob", !("lockCode" in readCache(cacheKey(A)).settings));

// The un-namespaced pre-namespace blob can belong to another account on a
// shared device, so its lock code is scrubbed but never adopted.
store.clear();
store.set(STORAGE_KEY, JSON.stringify(realisticCache({ lockCode: "7777" })));
loadDeviceKeys(A);
eq("another account's cached lock code is never adopted", getLockCode(A), null);
ok("but it is still scrubbed off the disk",
  !("lockCode" in readCache(STORAGE_KEY).settings));

// The same file, the same rule, for everything else in it. The adoption loop
// used to read the un-namespaced blob FIRST and take whatever device fields it
// held, which is the opposite of the decision the lock code gets twenty lines
// earlier in the same function. On a shared workstation that billed physician
// A's Anthropic key to physician B and pointed B's app at A's CallSync
// calendar feed, and the scrub that runs straight afterwards deleted the
// evidence from the blob.
store.clear();
store.set(STORAGE_KEY, JSON.stringify(realisticCache({
  apiKey: "A-gemini-key", anthropicApiKey: "A-anthropic-key",
  callsyncFeedUrl: "https://callsync.example/feed/A-token", callsyncContractId: "A-contract",
})));
const strangersBlob = loadDeviceKeys(B);
eq("another account's cached AI keys are never adopted", strangersBlob, {});
eq("and nothing was written into this account's slot", readSlot(B), null);
ok("but the un-namespaced blob is still scrubbed",
  !["apiKey", "anthropicApiKey", "callsyncFeedUrl", "callsyncContractId"]
    .some((f) => f in readCache(STORAGE_KEY).settings));

// This account's OWN namespaced cache is still adopted: that file is this
// account's by construction, and it is where adoptLegacyStorage puts a legacy
// blob once the cloud profile proves it belongs here.
store.clear();
store.set(cacheKey(A), JSON.stringify(realisticCache({ apiKey: "mine", callsyncFeedUrl: "https://callsync.example/feed/mine" })));
const ownBlob = loadDeviceKeys(A);
eq("this account's own cached key is still adopted", ownBlob.apiKey, "mine");
eq("and so is its CallSync link", ownBlob.callsyncFeedUrl, "https://callsync.example/feed/mine");

// Both files present: the namespaced one is this account's, and it is the only
// one read. A stranger's key must not win by being in the older file.
store.clear();
store.set(STORAGE_KEY, JSON.stringify(realisticCache({ apiKey: "strangers" })));
store.set(cacheKey(A), JSON.stringify(realisticCache({ apiKey: "mine" })));
eq("the namespaced cache wins over the un-namespaced one", loadDeviceKeys(A).apiKey, "mine");

// And an empty namespaced cache does not fall through to the other file.
store.clear();
store.set(STORAGE_KEY, JSON.stringify(realisticCache({ apiKey: "strangers" })));
store.set(cacheKey(A), JSON.stringify(realisticCache({})));
eq("an empty namespaced cache adopts nothing rather than falling back", loadDeviceKeys(A), {});

// A clean cache is left byte-for-byte alone (no pointless rewrite of a big blob).
store.clear();
const cleanBlob = JSON.stringify(realisticCache({}));
store.set(cacheKey(A), cleanBlob);
loadDeviceKeys(A);
eq("a cache with nothing to scrub is returned unchanged", store.get(cacheKey(A)), cleanBlob);

// Nothing here may throw on the shapes a real device produces.
store.clear();
store.set(cacheKey(A), "{not json at all");
eq("malformed cached JSON does not throw", loadDeviceKeys(A), {});
eq("and the malformed blob is left alone", store.get(cacheKey(A)), "{not json at all");
store.clear();
store.set(cacheKey(A), "null");
eq("a null cached blob does not throw", loadDeviceKeys(A), {});
store.clear();
store.set(cacheKey(A), JSON.stringify({ settings: null, licenses: [] }));
eq("a cached blob with null settings does not throw", loadDeviceKeys(A), {});
store.clear();
store.set(cacheKey(A), JSON.stringify({ settings: ["not", "an", "object"] }));
eq("a cached blob with an array for settings does not throw", loadDeviceKeys(A), {});
store.clear();
eq("no cached blob at all does not throw", loadDeviceKeys(A), {});

// ── (d) The error sink cannot see any of this ───────────────────────────────
const errorReportSrc = src("lib", "errorReport.js");
// No settings object can reach the sink because the module never names one:
// reportError builds a fixed payload and its own two callers pass only a
// filename, a line, a column and a React component stack.
ok("errorReport.js never mentions settings", !/settings/i.test(errorReportSrc));
ok("errorReport.js never names the lock code", !/lockCode/i.test(errorReportSrc));
ok("errorReport.js never names the CallSync link", !/callsync/i.test(errorReportSrc));
ok("errorReport.js scrubs credential-shaped text out of what it does send",
  /const SECRET_RE\s*=/.test(errorReportSrc) && /scrub\(clip\(rawMessage/.test(errorReportSrc));
ok("the reported payload is built from a fixed set of fields",
  /const payload = \{[\s\S]*?\bkind,[\s\S]*?\bmessage,[\s\S]*?\bstack:[\s\S]*?\burl:[\s\S]*?\buser_agent:[\s\S]*?\bbuild:[\s\S]*?\bauth_user_id:[\s\S]*?\bextra:/.test(errorReportSrc));
ok("the identity it attaches is coerced to a string id, never an object",
  /currentUserId = typeof id === "string" && id \? id : null/.test(errorReportSrc));

// Walk src/ once: nobody reads the lock code out of settings, and nobody hands
// an app object to the error sink.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(p);
  }
  return out;
}
const srcFiles = walk(resolve(here, "..", "src"));
ok("src/ has files to scan", srcFiles.length > 50, String(srcFiles.length));

// supabase.js is the one exception, and only inside the scrub: it reads the
// lock code out of a CACHED blob's settings to move it into the slot before
// deleting it. Every other file must get the code from secretBox.
const supabaseSrc = src("lib", "supabase.js");
const readsLockCodeFromSettings = srcFiles
  .filter((p) => !p.endsWith("/lib/supabase.js"))
  .filter((p) => /settings[?.]*\.lockCode|settings\[["']lockCode["']\]/.test(readFileSync(p, "utf8")))
  .map((p) => p.split("/src/")[1]);
eq("nothing hydrates or reads the lock code out of settings", readsLockCodeFromSettings, []);
eq("every settings.lockCode line in supabase.js is part of the recovery",
  supabaseSrc.split("\n")
    .filter((l) => l.includes("settings.lockCode"))
    .filter((l) => !/getLockCode|saveLockCode/.test(l)),
  []);
ok("and that one touch is the recovery before the delete",
  /settings\.lockCode && !getLockCode\(authUserId\)\) \{\s*saveLockCode\(settings\.lockCode, authUserId\);/.test(supabaseSrc));

// Relative to the scanned root, not split on "/src/": CI checks this repo out
// into a directory that is itself named src, so the absolute path contains
// "/src/src/" and the split returned "src/main.jsx" instead of "main.jsx".
const srcRoot = resolve(here, "..", "src");
const importsErrorReport = srcFiles.filter((p) => /from\s+"\.[^"]*errorReport"/.test(readFileSync(p, "utf8")))
  .map((p) => relative(srcRoot, p).split(sep).join("/"));
ok("main.jsx is where the sink is installed", importsErrorReport.includes("main.jsx"),
  importsErrorReport.join(", "));
const reportErrorCalls = srcFiles.flatMap((p) =>
  [...readFileSync(p, "utf8").matchAll(/reportError\([^)]*\)/g)].map((m) => m[0]))
  .filter((c) => /settings|apiKey|lockCode|callsync/i.test(c));
eq("no reportError call passes app settings", reportErrorCalls, []);

// ══ The cache, on the way OUT as well as on disk ═══════════════════════════
//
// The scrub above rewrites what is stored. That is half the job: a caller that
// reads the cache gets an object back, and if THAT object still carries the
// lock code then the app renders, saves and exports from a poisoned copy no
// matter how clean the disk is. These drive the real storage.js.
//
// storage.js reads import.meta.env at module scope, which Vite fills and node
// leaves undefined, so it is loaded from a copy with that one expression
// replaced and its three relative imports pinned to absolute URLs. Nothing
// else about it is changed.
{
  const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const cache = resolve(here, "../node_modules/.cache/credentialdomd-storage-test");
  mkdirSync(cache, { recursive: true });
  const abs = (rel) => JSON.stringify(pathToFileURL(resolve(here, "../src/utils", rel)).href);
  let patched = readFileSync(resolve(here, "../src/utils/storage.js"), "utf8")
    .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
    .replace('from "../constants/defaults"', `from ${abs("../constants/defaults.js")}`)
    .replace('from "./storageScope"', `from ${abs("./storageScope.js")}`)
    .replace('from "../lib/supabase"', `from ${abs("../lib/supabase.js")}`);
  ok("the storage.js copy really did get its env expression replaced", !patched.includes("import.meta.env"));
  ok("and all three of its imports were pinned", (patched.match(/from "file:\/\//g) || []).length === 3);
  const file = join(cache, "storage.mjs");
  writeFileSync(file, patched);
  const storage = await import(pathToFileURL(file).href);
  try {

  const LOCK = "lock-code-for-A";
  const legacy = (extra) => realisticCache({ apiKey: "AIza-legacy", lockCode: LOCK, callsyncFeedUrl: "https://feed/A.ics", ...extra });

  // ── readCachedData returns clean, and cleans the disk ──────────────────
  store.clear();
  store.set(cacheKey(A), JSON.stringify(legacy()));
  const out = storage.readCachedData(A);
  // "Carries no value", not "has no key": withDefaults merges DEFAULT_DATA's
  // settings underneath, and that shape declares apiKey as an empty string.
  // An empty string is not a secret; a stale one is.
  for (const f of EXPORT_REDACT_FIELDS) {
    ok(`readCachedData hands back no ${f}`, !(out?.settings || {})[f]);
  }
  ok("readCachedData keeps the physician's real settings", out.settings.name === "Alex Reyes");
  ok("readCachedData keeps their collections", Array.isArray(out.licenses) || out.licenses === undefined);
  for (const f of EXPORT_REDACT_FIELDS) {
    ok(`and the disk copy no longer holds ${f}`, !(f in readCache(cacheKey(A)).settings));
  }
  eq("the lock code was recovered into the device slot, so the vault still opens",
    getLockCode(A), LOCK);

  // A blob with nothing to strip is not rewritten at all.
  store.clear();
  const cleanBlob = JSON.stringify(realisticCache({}));
  store.set(cacheKey(A), cleanBlob);
  storage.readCachedData(A);
  eq("a clean cache is left byte-identical", store.get(cacheKey(A)), cleanBlob);

  // No user, no read.
  eq("readCachedData with no user reads nothing", storage.readCachedData(null), null);
  eq("readCachedData with no cache is null", (store.clear(), storage.readCachedData(A)), null);

  // ── the hydrate CLEANS, it does not merge over ────────────────────────
  store.clear();
  store.set(cacheKey(A), JSON.stringify(legacy()));
  store.set(slotKey(A), JSON.stringify({ apiKey: "AIza-current" }));
  const loaded = await storage.loadData(A);
  eq("the CURRENT device key beats the stale one in the cache", loaded.settings.apiKey, "AIza-current");
  ok("the lock code still never reaches settings", !loaded.settings.lockCode);
  ok("the physician's own settings are untouched", loaded.settings.name === "Alex Reyes");
  // The CallSync token is a legitimate device field, so it is MIGRATED out of
  // the trusted cache rather than dropped. See the migrate-before-scrub block.
  eq("a legitimate field the slot lacked is migrated, not lost", loaded.settings.callsyncFeedUrl, "https://feed/A.ics");

  // The slot has SOME fields and the trusted cache has others. Each field is
  // decided on its own: the slot wins where it has a value, the cache donates
  // where it does not. This is the case that lost four fields for a day.
  store.clear();
  store.set(cacheKey(A), JSON.stringify(legacy()));
  store.set(slotKey(A), JSON.stringify({ anthropicApiKey: "sk-ant-current" }));
  const loaded2 = await storage.loadData(A);
  eq("the field the slot does have arrives from the slot", loaded2.settings.anthropicApiKey, "sk-ant-current");
  eq("the field it does not is migrated from the trusted cache", loaded2.settings.apiKey, "AIza-legacy");
  ok("and the lock code is still not in settings", !loaded2.settings.lockCode);

  // ── saveData caches none of it ────────────────────────────────────────
  store.clear();
  await storage.saveData({
    settings: { name: "Alex Reyes", apiKey: "AIza-x", anthropicApiKey: "sk-ant-x", lockCode: LOCK, callsyncFeedUrl: "https://feed/A.ics", callsyncContractId: "c-1" },
    documents: [],
  }, A);
  const cached = readCache(cacheKey(A));
  for (const f of EXPORT_REDACT_FIELDS) {
    ok(`saveData never writes ${f} to the cache`, !(f in cached.settings));
  }
  ok("saveData keeps everything else", cached.settings.name === "Alex Reyes");

  // ── the Capacitor store gets the same treatment ───────────────────────
  // The native copy is the one that survives a browser-storage clear, so a
  // scrub that only rewrote localStorage put the lock code back every launch.
  store.clear();
  const native = new Map([[cacheKey(A), JSON.stringify(legacy())]]);
  globalThis.window.storage = {
    get: async (k) => ({ value: native.get(k) ?? null }),
    set: async (k, v) => { native.set(k, String(v)); },
  };
  const fromNative = await storage.loadData(A);
  // The STORES must end up clean of every device-only field, in both places.
  for (const f of EXPORT_REDACT_FIELDS) {
    ok(`the Capacitor STORE no longer holds ${f}`, !(f in JSON.parse(native.get(cacheKey(A))).settings));
    ok(`and the localStorage copy it wrote is clean of ${f}`, !(f in readCache(cacheKey(A)).settings));
  }
  // What comes BACK differs by field, and the difference is the point: the
  // four device keys are the physician's own and are migrated into the slot,
  // then rehydrated; the lock code is not hydrated into settings at all.
  // Only the fields this blob actually carried; legacy() sets three of the four.
  const carried = DEVICE_KEY_FIELDS.filter((f) => legacy().settings[f]);
  ok("the fixture carries more than one device field, or this proves little", carried.length >= 2);
  for (const f of carried) {
    ok(`the Capacitor read still yields ${f}, migrated through the slot`, !!fromNative.settings[f]);
  }
  for (const f of UNLOCK_FIELDS) {
    ok(`the Capacitor read never yields ${f}`, !fromNative.settings[f]);
  }
  eq("the lock code from the native copy was recovered before deletion", getLockCode(A), LOCK);
  ok("the physician's records came through the native path", fromNative.settings.name === "Alex Reyes");
  delete globalThis.window.storage;

  // ── The three cases an independent review reproduced ──────────────────
  // All three are the same mistake: the scrub was made to run before the
  // adoption that needed the material, and it only reached one of the two
  // stores. Each is named here for the case it came from.
  const DEVICE_ONLY = { apiKey: "AIza-legit", anthropicApiKey: "sk-ant-legit", callsyncFeedUrl: "https://feed/A.ics", callsyncContractId: "contract-1" };
  const legacyFull = () => realisticCache({ ...DEVICE_ONLY, lockCode: LOCK });

  // (1) trusted namespaced cache, NO device slot, localStorage only.
  store.clear();
  store.set(cacheKey(A), JSON.stringify(legacyFull()));
  delete globalThis.window.storage;
  const r1 = await storage.loadData(A);
  for (const [f, v] of Object.entries(DEVICE_ONLY)) {
    eq(`localStorage-only legacy cache: ${f} is migrated, not lost`, r1.settings[f], v);
  }
  eq("localStorage-only: the slot now holds all four", DEVICE_KEY_FIELDS.filter((f) => readSlot(A)?.[f]).length, 4);
  eq("localStorage-only: the vault key is recovered", getLockCode(A), LOCK);
  ok("localStorage-only: the lock code is not in settings", !r1.settings.lockCode);
  for (const f of EXPORT_REDACT_FIELDS) {
    ok(`localStorage-only: the stored blob is clean of ${f}`, !(f in readCache(cacheKey(A)).settings));
  }

  // (2) the same, Capacitor only. On a native build this is the copy that
  // survives a browser-storage clear, so it has to be swept too.
  store.clear();
  {
    const native2 = new Map([[cacheKey(A), JSON.stringify(legacyFull())]]);
    globalThis.window.storage = {
      get: async (k) => ({ value: native2.get(k) ?? null }),
      set: async (k, v) => { native2.set(k, String(v)); },
    };
    const r2 = await storage.loadData(A);
    for (const [f, v] of Object.entries(DEVICE_ONLY)) {
      eq(`Capacitor-only legacy cache: ${f} is migrated, not lost`, r2.settings[f], v);
    }
    eq("Capacitor-only: the vault key is recovered", getLockCode(A), LOCK);
    for (const f of EXPORT_REDACT_FIELDS) {
      ok(`Capacitor-only: the native store is clean of ${f}`, !(f in JSON.parse(native2.get(cacheKey(A))).settings));
    }
  }

  // (3) both stores hold a copy and localStorage answers first. The native one
  // used to be left untouched until some later save happened to overwrite it.
  store.clear();
  {
    const blob3 = JSON.stringify(legacyFull());
    store.set(cacheKey(A), blob3);
    const native3 = new Map([[cacheKey(A), blob3]]);
    globalThis.window.storage = {
      get: async (k) => ({ value: native3.get(k) ?? null }),
      set: async (k, v) => { native3.set(k, String(v)); },
    };
    await storage.loadData(A);
    for (const f of EXPORT_REDACT_FIELDS) {
      ok(`parallel stores: localStorage is clean of ${f}`, !(f in readCache(cacheKey(A)).settings));
      ok(`parallel stores: the Capacitor copy is clean of ${f} too`, !(f in JSON.parse(native3.get(cacheKey(A))).settings));
    }
  }
  delete globalThis.window.storage;

  // Must-not-break, checked alongside: a value already in the slot is current
  // and a value in an old cache is at best equally old, so the slot wins.
  store.clear();
  store.set(cacheKey(A), JSON.stringify(realisticCache({ apiKey: "AIza-STALE" })));
  store.set(slotKey(A), JSON.stringify({ apiKey: "AIza-CURRENT" }));
  eq("the slot's value beats a stale cache value", (await storage.loadData(A)).settings.apiKey, "AIza-CURRENT");

  store.clear();
  store.set(slotKey(A), JSON.stringify({ lockCode: "lock-CURRENT" }));
  store.set(cacheKey(A), JSON.stringify(realisticCache({ lockCode: "lock-STALE" })));
  await storage.loadData(A);
  eq("a lock code already in the slot is never overwritten by a cache copy", getLockCode(A), "lock-CURRENT");

  // ── cross-account adoption is still refused ───────────────────────────
  // B signs in on a device where A left an un-namespaced blob. Nothing of A's
  // may reach B: not the AI key, not the calendar feed token, not the lock
  // code. Dropping a key costs a minute of retyping; adopting one bills a
  // colleague's account and pulls the wrong call schedule.
  store.clear();
  store.set(STORAGE_KEY, JSON.stringify(legacy({ anthropicApiKey: "sk-ant-A" })));
  const forB = storage.readCachedData(B);
  eq("B reads nothing from A's un-namespaced blob", forB, null);
  const keysForB = loadDeviceKeys(B);
  eq("B adopts none of A's device keys", keysForB, {});
  // And the blob is cleaned by the LOAD itself, not only as a side effect of
  // something later calling loadDeviceKeys. loadData returns early when this
  // account has no cache of its own, so a colleague's old keys used to sit
  // there untouched through every load.
  store.clear();
  store.set(STORAGE_KEY, JSON.stringify(legacy({ anthropicApiKey: "sk-ant-A" })));
  await storage.loadData(B);
  for (const f of EXPORT_REDACT_FIELDS) {
    ok(`a load by another account scrubs ${f} from the un-namespaced blob`,
      !(f in (readCache(STORAGE_KEY)?.settings || {})));
  }
  eq("and still adopts none of it", loadDeviceKeys(B), {});
  eq("and still does not take A's lock code", getLockCode(B), null);
  eq("B does not inherit A's lock code", getLockCode(B), null);
  for (const f of EXPORT_REDACT_FIELDS) {
    ok(`A's un-namespaced blob is scrubbed of ${f} rather than adopted`,
      !(f in (readCache(STORAGE_KEY)?.settings || {})));
  }

  } finally {
    try { rmSync(cache, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
