/**
 * The whole fee schedule, loaded only when something actually needs it.
 *
 * src/constants/cpt/cmsAll.js is 9,537 codes and 739 KB. It must never ride in
 * the main bundle for a physician who opened the app to check a license
 * expiry, so it is imported dynamically and memoised. The curated entries in
 * src/constants/cpt/ stay static and small: they are what the cached system
 * block is built from.
 */

import { CURATED_BY_CODE } from "../constants/cpt/index.js";
import { mergeCatalog } from "./cptCandidates.js";

let cached = null;
let inflight = null;

/**
 * Every CPT code on the CY2026 fee schedule, curated descriptors on top.
 * Resolves to a { code: entry } map. Falls back to the curated set alone if
 * the chunk cannot be fetched, so a coder call offline degrades to what it
 * used to do rather than failing.
 */
export async function loadFullCatalog() {
  if (cached) return cached;
  if (!inflight) {
    inflight = import("../constants/cpt/cmsAll.js")
      .then(({ CMS_ALL }) => { cached = mergeCatalog(CURATED_BY_CODE, CMS_ALL); return cached; })
      .catch(() => { cached = mergeCatalog(CURATED_BY_CODE, {}); return cached; });
  }
  return inflight;
}

/** What is loaded right now, without waiting. Empty before the first load. */
export function loadedCatalog() {
  return cached;
}
