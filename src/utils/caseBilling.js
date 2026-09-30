// What a logged case billed: its CPT codes with units, modifier and work
// RVU. One copy, read by the case detail view (CrudSection), the card and the
// totals (caseLogReport.caseWRVU) and the write path (recordWrite), so a case
// entered in the form can never show a total in its detail and 0 on its card.
//
// Extensions spelled out so pure-node test scripts can import this module.
import { CPT_DESCS } from "../constants/cptDescs.js";
import { CPT_BY_CODE } from "../constants/cpt/index.js";

const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

/**
 * The billed lines for a case. An imported case carries its own line detail
 * (customFields.cptDetail, with modifier and bundling adjustments the catalog
 * cannot reproduce); a case entered by hand has only its code list, priced
 * from the catalog.
 */
export function billedCodes(item) {
  const detail = item?.customFields?.cptDetail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map(c => ({
      code: c.code, units: c.units || 1, mod: c.mod || null,
      desc: c.desc || own(CPT_DESCS, c.code)?.d || own(CPT_BY_CODE, c.code)?.shortDesc || "",
      wRVU: c.wRVU ?? own(CPT_DESCS, c.code)?.w ?? own(CPT_BY_CODE, c.code)?.wRVU ?? 0,
      inferred: !!c.inferred,
    }));
  }
  if (!item?.cptCodes) return [];
  return codeTokens(item.cptCodes).map(tok => {
    const m = tok.match(/^(\w+?)(?:-(\d\d))?(?:\s*x(\d+))?$/i) || [];
    const code = m[1] || tok;
    return {
      code, units: m[3] ? parseInt(m[3], 10) : 1, mod: m[2] || null,
      desc: own(CPT_DESCS, code)?.d || own(CPT_BY_CODE, code)?.shortDesc || "",
      wRVU: own(CPT_DESCS, code)?.w ?? own(CPT_BY_CODE, code)?.wRVU ?? 0,
      inferred: false,
    };
  });
}

const round2 = (n) => Math.round(n * 100) / 100;

/** The case's billed work RVU: each line's wRVU times its units. */
export function billedWRVU(item) {
  return round2(billedCodes(item).reduce((t, c) => t + (Number(c.wRVU) || 0) * (c.units || 1), 0));
}

/** The code list as tokens ("61510-59 x2" stays one token). */
export function codeTokens(codes) {
  const list = Array.isArray(codes) ? codes : String(codes ?? "").split(/[,;]/);
  return list.map(t => String(t).trim()).filter(Boolean);
}

/** Two code lists name the same billing when their tokens match in any order. */
export function sameCodes(a, b) {
  const key = (v) => codeTokens(v).map(t => t.toUpperCase().replace(/\s+/g, "")).sort().join(",");
  return key(a) === key(b);
}
