#!/usr/bin/env node
// Refuse to deploy a client that syncs a table production does not have.
//
// Every key in TABLE_MAP (src/lib/supabase.js) is loaded at sign-in, and
// assertCompleteAccountRecords fails the WHOLE account load when any of them
// errors. So a client build that lists a table before its migration has been
// applied does not degrade one feature: it locks every user out. Until this
// check existed, the only thing preventing that was a written procedure.
//
// It asks PostgREST, the same API the browser uses, about each table with the
// public key. An existing table answers 200 or 401 "permission denied"; only a
// table the schema cache does not know answers 404 PGRST205. It fails closed:
// if production cannot be reached at all, the deploy stops too, because a
// deploy that cannot see the database cannot prove it is safe.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function tableMapTables(source) {
  const start = source.indexOf("const TABLE_MAP = {");
  if (start < 0) throw new Error("TABLE_MAP not found in src/lib/supabase.js");
  const block = source.slice(start, source.indexOf("\n};", start));
  return [...block.matchAll(/^\s*\w+:\s*"([a-z0-9_]+)"/gm)].map(m => m[1]);
}

/** Classify one PostgREST answer. Only a definite "no such table" is missing. */
export function classify(status, body) {
  if (status === 404 && body && body.code === "PGRST205") return "missing";
  if (status === 200 || status === 206) return "present";
  if ((status === 401 || status === 403) && body && body.code === "42501") return "present";
  return "unknown";
}

async function probe(url, key, table, fetchImpl = fetch) {
  let last = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(`${url}/rest/v1/${table}?limit=0`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      last = classify(res.status, body);
      if (last !== "unknown") return last;
    } catch { last = "unreachable"; }
    await new Promise(r => setTimeout(r, 750 * attempt));
  }
  return last;
}

export async function checkTables({ url, key, source, fetchImpl }) {
  const tables = tableMapTables(source);
  const results = await Promise.all(tables.map(async t => [t, await probe(url, key, t, fetchImpl)]));
  const missing = results.filter(([, s]) => s === "missing").map(([t]) => t);
  const unsure = results.filter(([, s]) => s !== "missing" && s !== "present").map(([t, s]) => `${t} (${s})`);
  return { tables, missing, unsure };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("check-tables-exist: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required.");
    process.exit(1);
  }
  const source = readFileSync(resolve(here, "../src/lib/supabase.js"), "utf8");
  const { tables, missing, unsure } = await checkTables({ url, key, source });
  if (missing.length) {
    console.error(`check-tables-exist: the client syncs ${missing.length} table(s) production does not have: ${missing.join(", ")}`);
    console.error("Apply the migration and verify it BEFORE deploying a client that lists these in TABLE_MAP, or every account load fails.");
    process.exit(1);
  }
  if (unsure.length) {
    console.error(`check-tables-exist: could not confirm ${unsure.join(", ")}. Refusing to deploy blind.`);
    process.exit(1);
  }
  console.log(`check-tables-exist: all ${tables.length} synced tables exist in production.`);
}
