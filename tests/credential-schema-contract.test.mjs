import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { licenseFields, privilegeFields, insuranceFields } from "../src/utils/credentialForms.js";
import { SECTION_FIELDS } from "../src/utils/sectionFields.js";
import { normalizeLifecycle, LIFECYCLE_COLUMNS } from "../src/utils/lifecycle.js";

// Every key a Licenses, Privileges or Insurance form (or Vera) writes must be a
// real column: the sync layer (toSnakeObj, src/lib/supabase.js) sends each key
// as a column, and ONE the table lacks makes PostgREST reject the WHOLE row.
// That is how the licence form's "does not expire" box silently lost every
// save that ticked it: noExpiration had no column (ticket 2c819309).
//
// PRODUCTION is the column list information_schema returned on 2026-09-25 for
// these tables. Columns added later must come from a migration in
// supabase/migrations, which this test reads.

const PRODUCTION = {
  licenses: ["id", "user_id", "type", "name", "license_number", "state", "issued_date", "expiration_date", "notes", "npi_imported", "created_at", "updated_at", "custom_fields", "renewal_cost", "cme_cycle_start", "favorite"],
  insurance: ["id", "user_id", "type", "name", "provider", "policy_number", "coverage_per_claim", "coverage_aggregate", "effective_date", "expiration_date", "notes", "created_at", "updated_at", "custom_fields", "favorite"],
  privileges: ["id", "user_id", "type", "name", "facility", "state", "appointment_date", "expiration_date", "notes", "created_at", "updated_at", "custom_fields", "city", "portal_url", "login_username", "login_secret", "favorite"],
};

// The same conversion the sync layer applies (src/lib/supabase.js camelToSnake).
const snake = (k) => k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());

function migratedColumns() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const added = { licenses: new Set(), insurance: new Set(), privileges: new Set() };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    for (const stmt of readFileSync(new URL(file, dir), "utf8").split(";")) {
      const t = stmt.match(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)/i);
      if (!t || !added[t[1]]) continue;
      for (const m of stmt.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)) added[t[1]].add(m[1]);
    }
  }
  return added;
}
const MIGRATED = migratedColumns();
const columnsOf = (table) => new Set([...PRODUCTION[table], ...MIGRATED[table]]);

const FORMS = {
  licenses: [...licenseFields({ degreeType: "MD" }), ...licenseFields({ degreeType: "DO" })],
  privileges: privilegeFields(),
  insurance: insuranceFields(),
};

for (const [table, fields] of Object.entries(FORMS)) {
  test(`every ${table} form field is a real column`, () => {
    const cols = columnsOf(table);
    const missing = [...new Set(fields.map((f) => f.key))].filter((k) => !cols.has(snake(k)));
    assert.deepEqual(missing, [], `${table} form writes ${missing.join(", ")} with no column: every save would be rejected whole`);
  });

  test(`every ${table} field Vera may write is a real column`, () => {
    const cols = columnsOf(table);
    const missing = SECTION_FIELDS[table].filter((k) => !cols.has(snake(k)));
    assert.deepEqual(missing, []);
  });
}

test("the lifecycle migration supplies exactly the columns the preflight requires", () => {
  for (const [table, cols] of Object.entries(LIFECYCLE_COLUMNS)) {
    for (const c of cols) assert.ok(MIGRATED[table].has(c), `${table}.${c}`);
  }
  assert.ok(MIGRATED.licenses.has("no_expiration"), "the noExpiration checkbox finally has its column");
});

test("normalising a record never introduces a key without a column", () => {
  for (const table of ["licenses", "privileges", "insurance"]) {
    const cols = columnsOf(table);
    const written = normalizeLifecycle(table, {
      id: "x", type: "T", lifecycleStatus: "Superseded ", dateUnknown: "yes", supersededBy: " y ", statusSource: "  a  b ",
      ...(table === "licenses" ? { noExpiration: 1 } : {}),
    });
    const stray = Object.keys(written).filter((k) => !cols.has(snake(k)));
    assert.deepEqual(stray, [], table);
  }
});
