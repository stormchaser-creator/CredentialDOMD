// CPT Code Database — Central Index
// Merges curated specialty codes with CMS base codes + RVU data
// Curated codes take priority (they have richer synonyms/keywords)

import { NEUROSURGERY_CODES } from "./neurosurgery";
import { CMS_BASE_CODES } from "./cmsBase";
import { RVU_DATA } from "./rvuData";

// Build curated map — these override CMS base entries
const curatedMap = new Map();
NEUROSURGERY_CODES.forEach(c => curatedMap.set(c.code, c));
// Future: import and merge additional specialty files here

// Merge: curated codes override base, then add any curated codes not in base
const baseMap = new Map(CMS_BASE_CODES.map(c => [c.code, c]));

// Attach RVU data to each code object
function attachRVU(codeObj) {
  const rvu = RVU_DATA[codeObj.code];
  if (rvu) return { ...codeObj, wRVU: rvu.wRVU, totalRVU: rvu.totalRVU };
  return codeObj;
}

export const CPT_CODES = [
  // All base codes, overridden by curated where available
  ...CMS_BASE_CODES.map(base => attachRVU(curatedMap.get(base.code) || base)),
  // Any curated codes not in base
  ...NEUROSURGERY_CODES.filter(c => !baseMap.has(c.code)).map(attachRVU),
];

// Fast lookup by code
export const CPT_BY_CODE = Object.fromEntries(CPT_CODES.map(c => [c.code, c]));

// Category list for filtering
export const CPT_CATEGORIES = [...new Set(CPT_CODES.map(c => c.category).filter(Boolean))].sort();

// Check if a code has rich curated data
export function isCurated(code) {
  return curatedMap.has(code);
}
