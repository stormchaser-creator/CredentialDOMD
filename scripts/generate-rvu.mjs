/**
 * Regenerate src/constants/cpt/rvuData.js from the official CMS Physician
 * Fee Schedule RVU file (scripts/data/PPRRVU2026_Jul_nonQPP.csv).
 *
 * Never hand-edit rvuData.js — rerun this when CMS releases an update:
 *   node scripts/generate-rvu.mjs
 *
 * The emitted table covers the app's curated code universe (neurosurgery +
 * E/M base + audit additions), with official work RVU, non-facility and
 * facility totals, status code, global days, and the official descriptor.
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const { NEUROSURGERY_CODES } = await import(join(repo, "src/constants/cpt/neurosurgery.js"));
const { CMS_BASE_CODES } = await import(join(repo, "src/constants/cpt/cmsBase.js"));
const { ADDITIONAL_CODES } = await import(join(repo, "src/constants/cpt/additions.js"));
const { SKULL_BASE_HEAD_NECK_CODES } = await import(join(repo, "src/constants/cpt/skullBaseHeadNeck.js"));

// Deleted/invalid codes flagged by the CMS audit — excluded everywhere
const DELETED = new Set(["61440", "61470", "61480", "99241", "49585"]);

const universe = new Set();
for (const c of NEUROSURGERY_CODES) universe.add(c.code);
for (const c of CMS_BASE_CODES) universe.add(c.code);
for (const c of ADDITIONAL_CODES) universe.add(c.code);
for (const c of SKULL_BASE_HEAD_NECK_CODES) universe.add(c.code);
// Keep every code the previous table already covered (idempotent regen)
try {
  const prev = await import(join(repo, "src/constants/cpt/rvuData.js"));
  for (const k of Object.keys(prev.RVU_DATA)) universe.add(k);
} catch { /* first run */ }
for (const d of DELETED) universe.delete(d);

// ── Parse the CMS CSV ──
const csv = readFileSync(join(here, "data/PPRRVU2026_Jul_nonQPP.csv"), "utf8");
const rows = csv.split(/\r?\n/);
// Header row is the one starting with "HCPCS,"
const headerIdx = rows.findIndex(r => r.startsWith("HCPCS,"));
const cms = new Map();
for (let i = headerIdx + 1; i < rows.length; i++) {
  const cols = rows[i].split(",");
  if (cols.length < 15) continue;
  const [hcpcs, mod, desc, status] = cols;
  if (!hcpcs || mod) continue; // skip TC/26/53 modifier rows
  if (!universe.has(hcpcs)) continue;
  cms.set(hcpcs, {
    desc: desc.trim(),
    status: status.trim(),
    wRVU: parseFloat(cols[5]) || 0,
    totalRVU: parseFloat(cols[11]) || 0,        // non-facility total
    totalFacilityRVU: parseFloat(cols[12]) || 0,
    global: (cols[14] || "").trim(),
  });
}

const missing = [...universe].filter(c => !cms.has(c)).sort();

// ── Emit rvuData.js ──
const stamp = new Date().toISOString().slice(0, 10);
let out = `/**
 * RVU data — GENERATED from the CMS Physician Fee Schedule.
 * Source: PPRRVU2026_Jul_nonQPP.csv (CY2026 July release, released 06/30/2026)
 * Generated ${stamp} by scripts/generate-rvu.mjs — DO NOT HAND-EDIT.
 *
 * wRVU  = physician work RVU
 * totalRVU = fully implemented NON-FACILITY total
 * totalFacilityRVU = fully implemented FACILITY total (hospital setting)
 * status: A=active, B=bundled (never paid separately), C=carrier-priced,
 *         I=invalid for Medicare (may still be commercially payable)
 * global: 000/010/090 day global period, XXX=n/a, ZZZ=add-on code
 */

export const RVU_DATA = {
`;
for (const code of [...cms.keys()].sort()) {
  const r = cms.get(code);
  out += `  "${code}": { wRVU: ${r.wRVU}, totalRVU: ${r.totalRVU}, totalFacilityRVU: ${r.totalFacilityRVU}, status: ${JSON.stringify(r.status)}, global: ${JSON.stringify(r.global)}, desc: ${JSON.stringify(r.desc)} },\n`;
}
out += `};\n`;
writeFileSync(join(repo, "src/constants/cpt/rvuData.js"), out);
console.log(`rvuData.js written: ${cms.size} codes`);
if (missing.length) console.log(`NOT FOUND in CMS file (check/remove): ${missing.join(", ")}`);
