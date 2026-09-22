import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRO_GATED, STARRABLE_SECTIONS, isStarrable, isFavorite, selectFavorites, countFavorites,
} from "../src/utils/favorites.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(here, "..", ...p), "utf8");

test("a star is an explicit boolean true, never a truthy value", () => {
  assert.equal(isFavorite({ favorite: true }), true);
  for (const v of [false, null, undefined, 0, "", "false", "true", 1, {}]) {
    assert.equal(isFavorite({ favorite: v }), false, `favorite: ${JSON.stringify(v)} must not read as starred`);
  }
  assert.equal(isFavorite(undefined), false);
  // The column is nullable and a wrongly typed legacy value must not render a
  // record starred forever: the string "false" is truthy in JS.
  assert.equal(isFavorite({ favorite: "false" }), false);
});

test("Pro gated sections are omitted entirely for a non-Pro account", () => {
  const data = {
    licenses: [{ id: "L1", favorite: true }, { id: "L2" }],
    privileges: [{ id: "P1", favorite: true }],
    insurance: [{ id: "I1", favorite: true }],
    caseLogs: [{ id: "C1", favorite: true }],
    peerReferences: [{ id: "R1", favorite: true }],
    malpracticeHistory: [{ id: "M1", favorite: true }],
    cme: [{ id: "E1", favorite: true }],
  };
  const pro = selectFavorites(data, { isPro: true }).map(f => f.record.id);
  assert.deepEqual(pro.sort(), ["C1", "E1", "I1", "L1", "M1", "P1", "R1"]);

  const free = selectFavorites(data, { isPro: false }).map(f => f.record.id);
  assert.deepEqual(free.sort(), ["E1", "L1"], "no Pro gated record may reach a non-Pro list");
  for (const section of PRO_GATED) {
    assert.ok(!selectFavorites(data, { isPro: false }).some(f => f.section === section),
      `${section} leaked to a non-Pro account`);
  }
  assert.equal(countFavorites(data, { isPro: false }), 2);
});

test("selection is total and tolerates a missing or malformed collection", () => {
  assert.deepEqual(selectFavorites({}, { isPro: true }), []);
  assert.deepEqual(selectFavorites(undefined, { isPro: true }), []);
  assert.deepEqual(selectFavorites({ licenses: null, cme: "nope" }, { isPro: true }), []);
  // Absent options must not silently behave as Pro.
  const gated = { privileges: [{ id: "P1", favorite: true }] };
  assert.deepEqual(selectFavorites(gated).map(f => f.record.id), []);
});

test("newest activity first, and a record with no timestamp still appears", () => {
  const data = { licenses: [
    { id: "old", favorite: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "new", favorite: true, updatedAt: "2026-09-01T00:00:00.000Z" },
    { id: "none", favorite: true },
  ]};
  assert.deepEqual(selectFavorites(data, { isPro: true }).map(f => f.record.id), ["new", "old", "none"]);
});

// ── Registry tripwires ──────────────────────────────────────────────────────
// The failure this project has been bitten by twice is a section that works
// locally and never persists. These fail loudly instead.

const supabaseSrc = read("src", "lib", "supabase.js");
function tableMap() {
  const start = supabaseSrc.indexOf("const TABLE_MAP = {");
  const block = supabaseSrc.slice(start, supabaseSrc.indexOf("\n};", start));
  return Object.fromEntries([...block.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)].map(m => [m[1], m[2]]));
}

test("every starrable section is a real synced collection", () => {
  const map = tableMap();
  for (const key of STARRABLE_SECTIONS) {
    assert.ok(key in map,
      `${key} is starrable but missing from TABLE_MAP: its rows would be written to a table that does not exist, the write would fail quietly, and every star would vanish on the next load`);
  }
});

test("the migration adds the column to every table in TABLE_MAP", () => {
  const sql = read("supabase", "migrations", "20260924010000_record_favorites.sql");
  const covered = new Set([...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  for (const table of Object.values(tableMap())) {
    assert.ok(covered.has(table),
      `${table} is in TABLE_MAP but not in the favorites migration: any record carrying the favorite key would have its WHOLE row rejected on save, not just the star`);
  }
});

test("every starrable CrudSection call site actually passes favoritable", () => {
  const app = read("src", "App.jsx");
  for (const m of app.matchAll(/sectionKey="(\w+)"([^>]*?)(?:\/>|>)/g)) {
    const [, key, rest] = m;
    if (!isStarrable(key)) continue;
    assert.ok(/\bfavoritable\b/.test(rest),
      `CrudSection for "${key}" is starrable but has no favoritable prop, so its star never renders`);
  }
});

test("the three sections that render their own rows still have a star", () => {
  for (const [file, key] of [
    ["CMESection.jsx", "cme"],
    ["ScreeningsSection.jsx", "screenings"],
    ["HealthRecordsSection.jsx", "healthRecords"],
  ]) {
    const src = read("src", "components", "features", file);
    assert.ok(isStarrable(key), `${key} must be starrable`);
    assert.ok(src.includes(`toggleFavorite("${key}"`),
      `${file} contains zero CrudSection references, so a star added there cannot reach it; it needs its own toggleFavorite call`);
    assert.ok(src.includes("StarIcon"), `${file} must render a StarIcon`);
  }
});

test("paused and non-collection categories are never starrable", () => {
  for (const key of ["answerBank", "identityVault", "matrix", "findCme"]) {
    assert.equal(isStarrable(key), false, `${key} must not be starrable`);
  }
});
