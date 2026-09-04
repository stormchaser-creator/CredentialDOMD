// CPT Code Database — Central Index
// Merges curated specialty codes with CMS base codes + RVU data
// Curated codes take priority (they have richer synonyms/keywords)

import { NEUROSURGERY_CODES } from "./neurosurgery.js";
import { SKULL_BASE_HEAD_NECK_CODES } from "./skullBaseHeadNeck.js";
import { CMS_BASE_CODES } from "./cmsBase.js";
import { ADDITIONAL_CODES } from "./additions.js";
import { RVU_DATA } from "./rvuData.js";

// Codes deleted from the CPT/PFS — never surface them
const DELETED = new Set(["61440", "61470", "61480", "99241", "49585"]);

// Build curated map — these override CMS base entries
const curatedMap = new Map();
NEUROSURGERY_CODES.forEach(c => curatedMap.set(c.code, c));
SKULL_BASE_HEAD_NECK_CODES.forEach(c => { if (!curatedMap.has(c.code)) curatedMap.set(c.code, c); });
ADDITIONAL_CODES.forEach(c => { if (!curatedMap.has(c.code)) curatedMap.set(c.code, c); });

// Merge: curated codes override base, then add any curated codes not in base
const baseMap = new Map(CMS_BASE_CODES.map(c => [c.code, c]));

// Attach RVU data (official CMS values, status, global period) to each code
function attachRVU(codeObj) {
  const rvu = RVU_DATA[codeObj.code];
  if (rvu) {
    return {
      ...codeObj,
      wRVU: rvu.wRVU, totalRVU: rvu.totalRVU, totalFacilityRVU: rvu.totalFacilityRVU,
      status: rvu.status, globalDays: rvu.global, cmsDesc: rvu.desc,
    };
  }
  return codeObj;
}

export const CPT_CODES = [
  // All base codes, overridden by curated where available
  ...CMS_BASE_CODES.filter(c => !DELETED.has(c.code)).map(base => attachRVU(curatedMap.get(base.code) || base)),
  // Any curated codes not in base
  ...[...curatedMap.values()].filter(c => !baseMap.has(c.code) && !DELETED.has(c.code)).map(attachRVU),
];

// Fast lookup by code
export const CPT_BY_CODE = Object.fromEntries(CPT_CODES.map(c => [c.code, c]));

// Category list for filtering
export const CPT_CATEGORIES = [...new Set(CPT_CODES.map(c => c.category).filter(Boolean))].sort();

// Check if a code has rich curated data
export function isCurated(code) {
  return curatedMap.has(code);
}

/** Every curated entry, keyed by code. The full CMS fee schedule is merged
 *  under these at call time by src/utils/cptCatalog.js, which loads it
 *  lazily so the 9,537-code table never rides in the main bundle. */
export const CURATED_BY_CODE = Object.fromEntries([...curatedMap.values()].map(c => [c.code, c]));
