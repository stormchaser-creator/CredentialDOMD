// What a CME provider's accreditation means for a PA or an NP (DESIGN 4.6),
// read from the national certification rules, never from memory: a credit
// type a certifier's verified rule names counts, and a certifier whose
// accepted CE is not verified says so. Physicians get nothing here (their
// DO line is providerAoaLine).
//
// Pure: plain node tests import it.
import { CERTIFICATION_RULES } from "../constants/certificationRules.js";

// Provider accreditation labels (cmeProviders.js) and the app's category names.
const CATEGORY_OF = Object.freeze({
  "AMA PRA Category 1": "AMA PRA Category 1",
  "AAPA Category 1": "AAPA Category 1 CME",
  "AOA Category 1-A": "AOA Category 1-A",
  "AAFP Prescribed": "AAFP Prescribed Credit",
  "Joint Accreditation": "Joint Accreditation CE",
});

/** One sentence for a provider card, or "" when nothing verified applies. */
export function appProviderLine(accreditation = [], degreeType, rules = CERTIFICATION_RULES) {
  const cats = (accreditation || []).map((a) => CATEGORY_OF[a]).filter(Boolean);
  if (!cats.length) return "";
  if (degreeType === "PA") {
    const accepted = rules?.NCCPA?.cat1Accepted || [];
    const hit = cats.filter((c) => accepted.includes(c));
    return hit.length ? `NCCPA accepts ${hit.join(" and ")} as Category 1.` : "";
  }
  if (degreeType === "NP") {
    const parts = [];
    const ancc = rules?.ANCC?.formallyApproved || [];
    const hit = cats.filter((c) => ancc.includes(c));
    if (hit.length) parts.push(`ANCC accepts ${hit.join(" and ")} as formally approved.`);
    const aanpcb = rules?.AANPCB;
    if (aanpcb && !(Array.isArray(aanpcb.accepted) && aanpcb.accepted.length)) parts.push("AANPCB acceptance not yet verified.");
    return parts.join(" ");
  }
  return "";
}
