#!/usr/bin/env node
// Refuse to deploy a client that writes a column production does not have.
//
// Every key the client puts on a record is sent as a column (toSnakeObj in
// src/lib/supabase.js), and one unknown column makes Postgres reject the WHOLE
// row: the edit that carried it, and everything else in that save, never
// reaches the cloud. check-tables-exist.mjs only proves the tables are there,
// so a migration that adds a column needs this too, applied BEFORE the client
// that writes the new key ships.
//
// It asks PostgREST, the same API the browser uses, to select each column
// with no rows (limit=0) using the public key. A column that exists answers
// 200, or 401/403 "permission denied" (42501); only a column Postgres does not
// know answers 400 with 42703. It fails closed: if production cannot be
// reached, or answers anything else, the deploy stops.
//
// Add a column here in the same change as the migration that creates it.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { LIFECYCLE_COLUMNS } from "../src/utils/lifecycle.js";

export const REQUIRED_COLUMNS = {
  // 20260925030000_credential_lifecycle.sql (ticket 2c819309)
  ...LIFECYCLE_COLUMNS,
  // 20260925120000_call_day_split.sql (ticket 73202ae8)
  locum_contracts: ["split_at_day_start", "day_start_hour"],
  work_log: ["split_group_id"],
};

/** Classify one PostgREST answer. Only a definite "no such column" is missing. */
export function classify(status, body) {
  if (status === 400 && body && body.code === "42703") return "missing";
  if (status === 200 || status === 206) return "present";
  if ((status === 401 || status === 403) && body && body.code === "42501") return "present";
  return "unknown";
}

async function probe(url, key, table, column, fetchImpl = fetch) {
  let last = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(`${url}/rest/v1/${table}?select=${column}&limit=0`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      last = classify(res.status, body);
      if (last !== "unknown") return last;
    } catch { last = "unreachable"; }
    await new Promise(r => setTimeout(r, 750 * attempt));
  }
  return last;
}

export async function checkColumns({ url, key, required = REQUIRED_COLUMNS, fetchImpl }) {
  const pairs = Object.entries(required).flatMap(([table, cols]) => cols.map(col => [table, col]));
  const results = await Promise.all(pairs.map(async ([t, c]) => [`${t}.${c}`, await probe(url, key, t, c, fetchImpl)]));
  const missing = results.filter(([, s]) => s === "missing").map(([n]) => n);
  const unsure = results.filter(([, s]) => s !== "missing" && s !== "present").map(([n, s]) => `${n} (${s})`);
  return { columns: pairs.map(([t, c]) => `${t}.${c}`), missing, unsure };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("check-columns-exist: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required.");
    process.exit(1);
  }
  const { columns, missing, unsure } = await checkColumns({ url, key });
  if (missing.length) {
    console.error(`check-columns-exist: the client writes ${missing.length} column(s) production does not have: ${missing.join(", ")}`);
    console.error("Apply the migration and verify it BEFORE deploying this client, or every save that carries these keys is rejected whole.");
    process.exit(1);
  }
  if (unsure.length) {
    console.error(`check-columns-exist: could not confirm ${unsure.join(", ")}. Refusing to deploy blind.`);
    process.exit(1);
  }
  console.log(`check-columns-exist: all ${columns.length} required columns exist in production.`);
}
