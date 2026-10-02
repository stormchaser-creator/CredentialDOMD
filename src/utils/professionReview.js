// Records filed under the other profession's types (DESIGN 1.8).
//
// A PA who imported NPPES licences, scanned a card or logged CME before
// choosing PA has them filed as a State Medical License and under MD CME
// categories (the only choices a blank member had). An MD or DO may hold a
// record typed for a PA or NP. This lists them so the member can retype each
// one or keep it as it is; "Keep as is" is stored on the record
// (customFields["Profession review"] = "kept") so it is not asked again.
// Physicians get no CME category review: their output is unchanged.
//
// Pure: the Home card renders this; retyping is an ordinary editItem.
import { getCMECategories, getLicenseTypes } from "../constants/credentialTypes.js";
import { certBodyOf, isAdvancedPractice, isPhysicianDegree, licenseKindOf } from "../constants/professions.js";
import { isInactive } from "./lifecycle.js";

export const PROFESSION_REVIEW_FIELD = "Profession review";
const kept = (r) => r?.customFields?.[PROFESSION_REVIEW_FIELD] === "kept";

// Physician-only record types a PA or NP would not hold.
const PHYSICIAN_TYPE = /^(Board Certification \((ABMS|AOA)\)|USMLE|COMLEX|ECFMG Certificate)$/;
const PHYSICIAN_EDUCATION = /doctor of (osteopathic )?medicine|\((md|do)\)$|residency certificate|internship certificate/i;
const PRACTICE_KINDS = { PA: ["pa"], NP: ["aprn", "rn"] };

/**
 * [{ section, id, record, reason, options }] for the member's profession.
 * `options` are the types (or categories) the record can be changed to.
 */
export function professionMismatches(data) {
  const deg = data?.settings?.degreeType;
  const out = [];
  if (isAdvancedPractice(deg)) {
    const practiceTypes = getLicenseTypes(deg).filter((t) => PRACTICE_KINDS[deg].includes(licenseKindOf(t)));
    for (const l of data.licenses || []) {
      if (!l || kept(l) || isInactive(l)) continue;
      if (licenseKindOf(l.type) === "medical") out.push({ section: "licenses", id: l.id, record: l, reason: "Filed as a medical license", options: practiceTypes });
      else if (PHYSICIAN_TYPE.test(String(l.type || ""))) out.push({ section: "licenses", id: l.id, record: l, reason: `Filed as ${l.type}`, options: getLicenseTypes(deg) });
    }
    for (const e of data.education || []) {
      if (e && !kept(e) && PHYSICIAN_EDUCATION.test(String(e.type || ""))) out.push({ section: "education", id: e.id, record: e, reason: `Filed as ${e.type}`, options: null });
    }
    const categories = getCMECategories(deg);
    for (const c of data.cme || []) {
      if (c && !kept(c) && c.category && !categories.includes(c.category)) out.push({ section: "cme", id: c.id, record: c, reason: `Logged as ${c.category}`, options: categories });
    }
  } else if (isPhysicianDegree(deg)) {
    for (const l of data.licenses || []) {
      if (!l || kept(l) || isInactive(l)) continue;
      const kind = licenseKindOf(l.type);
      const appCert = certBodyOf(l.type);
      if (kind === "pa" || kind === "aprn" || kind === "rn" || appCert) out.push({ section: "licenses", id: l.id, record: l, reason: `Filed as ${l.type}`, options: getLicenseTypes(deg) });
    }
  }
  return out;
}

/** The customFields patch for "Keep as is". */
export const keepAsIsPatch = (record) => ({ ...(record?.customFields || {}), [PROFESSION_REVIEW_FIELD]: "kept" });

// The name the old NPI import gave every licence ("TX Medical License"). A
// licence still carrying it is renamed with its new type, so a PA is never
// told a "medical license" is expiring; a name the member chose stays.
const IMPORTED_MEDICAL_NAME = /^\s*([A-Za-z]{2})\s+Medical License\s*$/;
const NAME_FOR_KIND = { pa: "Physician Assistant License", aprn: "APRN License", rn: "RN License" };

/** The record as retyped by the review: the new type (or CME category), and an imported name to match. */
export function retypedRecord(section, record, value) {
  if (section === "cme") return { ...record, category: value };
  const out = { ...record, type: value };
  const m = IMPORTED_MEDICAL_NAME.exec(String(record?.name || ""));
  const noun = NAME_FOR_KIND[licenseKindOf(value)];
  if (section === "licenses" && m && noun) {
    const multistate = /multistate/i.test(String(value || "")) ? " (Multistate)" : "";
    out.name = `${(record.state || m[1]).toUpperCase()} ${noun}${multistate}`;
  }
  return out;
}
