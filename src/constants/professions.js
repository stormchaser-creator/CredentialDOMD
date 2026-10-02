// The clinician's profession, and every rule that reads it.
//
// The stored value is profiles.degree_type / settings.degreeType: "" (not
// chosen yet), "MD", "DO", "PA" or "NP". Anything else read from the database
// ("MBBS", "md") is treated as unknown, exactly like blank: never assume.
//
// Pure and import free, so credentialTypes.js, the scanner and the edge
// functions (through scripts/sync-shared-app-modules.mjs) share one copy.

export const DEGREES = Object.freeze(["MD", "DO", "PA", "NP"]);
export const DEGREE_LABELS = Object.freeze({
  MD: "Doctor of Medicine",
  DO: "Doctor of Osteopathic Medicine",
  PA: "Physician Assistant",
  NP: "Nurse Practitioner",
});

export const isKnownDegree = (d) => DEGREES.includes(d);
export const isPhysicianDegree = (d) => d === "MD" || d === "DO";
export const isAdvancedPractice = (d) => d === "PA" || d === "NP";
/** A value a writer may store: one of DEGREES, or "" for not chosen. */
export const isStorableDegree = (d) => d === "" || isKnownDegree(d);

/** "physician" | "pa" | "np" | null (blank or unrecognised). */
export function professionOf(d) {
  if (d === "MD" || d === "DO") return "physician";
  if (d === "PA") return "pa";
  if (d === "NP") return "np";
  return null;
}

// ── Licence kinds ───────────────────────────────────────────────────
// "medical" keeps today's exact test, so MD and DO are unchanged.

export const PRACTICE_KINDS = Object.freeze({
  physician: Object.freeze(["medical"]),
  pa: Object.freeze(["pa"]),
  np: Object.freeze(["aprn", "rn"]),
});
export const practiceKindsFor = (d) => PRACTICE_KINDS[professionOf(d) || "physician"];

// Certifying bodies with their own national card. AACN certifies adult
// gerontology acute care NPs; its renewal rules are not yet verified.
export const CERT_BODIES = Object.freeze(["NCCPA", "AANPCB", "ANCC", "PNCB", "NCC", "AACN"]);
export const PA_CERT_BODIES = Object.freeze(["NCCPA"]);
export const NP_CERT_BODIES = Object.freeze(["AANPCB", "ANCC", "PNCB", "NCC", "AACN"]);

/** "NCCPA" from "Board Certification (NCCPA)", else null. */
export function certBodyOf(type) {
  const m = /^Board Certification \((NCCPA|AANPCB|ANCC|PNCB|NCC|AACN)\)$/.exec(String(type || "").trim());
  return m ? m[1] : null;
}

// A typed type can carry iPhone's curly apostrophe ("Physician’s Assistant
// License"), so the apostrophe is folded to the straight one before the test.
const PA_LICENSE = /physician('?s)? (assistant|associate) licen[sc]e/i;
const foldApostrophe = (t) => t.replace(/[‘’ʼ′]/g, "'");
const APRN_LICENSE = /\b(aprn|arnp|crnp|apn|nurse practitioner)\b.*\b(licen[sc]e|certificate|certification|recognition|approval|registration)\b/i;
const RN_LICENSE = /^\s*(rn|registered nurse)\b.*licen[sc]e/i;

/**
 * The kind of a licence-section record, by its type. First match wins:
 * cert, medical, pa, aprn, rn, rx, agreement, dea, csr; anything else null.
 */
export function licenseKindOf(type) {
  const t = String(type || "");
  if (certBodyOf(t)) return "cert";
  if (/medical license/i.test(t)) return "medical";
  if (t === "State Physician Assistant License" || PA_LICENSE.test(foldApostrophe(t))) return "pa";
  if (t === "APRN License (NP)" || APRN_LICENSE.test(t)) return "aprn";
  if (t === "RN License" || t === "RN License (Multistate)" || RN_LICENSE.test(t)) return "rn";
  if (/^\s*prescriptive authority\b/i.test(t)) return "rx";
  if (/^\s*practice agreement\b/i.test(t)) return "agreement";
  if (/dea/i.test(t)) return "dea";
  if (/controlled substance/i.test(t)) return "csr";
  return null;
}

export const isMultistateRn = (type) => licenseKindOf(type) === "rn" && /multistate/i.test(String(type || ""));

/** A licence that tracks a state's CE for this profession (blank = physician test). */
export const isPracticeLicense = (l, d) => practiceKindsFor(d).includes(licenseKindOf(l?.type));

// ── Certification role (one question on every certification record) ──
// ANCC, PNCB, NCC and AACN also certify RN specialties, and a PA may file a
// CAQ as a second NCCPA record, so the body alone never proves an NP or PA
// certification. Only PA-C and NP certification records get a national card
// or satisfy a "current certification" check.

export const CERT_ROLE_FIELD = "Certification role";
export const CERT_ROLES = Object.freeze(["PA-C", "NP certification", "RN specialty", "CAQ or other"]);
export const NATIONAL_ROLES = Object.freeze(["PA-C", "NP certification"]);

// Credential letters a certifier verifiably issues only to NPs
// (np.pncb.seven_year_cycle, np.ncc.pharmacology sources).
const NP_ONLY_LETTERS = Object.freeze({ PNCB: ["CPNP-PC", "CPNP-AC"], NCC: ["WHNP-BC", "NNP-BC"] });

const lettersIn = (name) => String(name || "").toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);

/**
 * The role a certification record answers: the member's stored answer, or a
 * prefill only where the answer is certain. null means ask.
 */
export function certificationRoleOf(record, licenses = []) {
  const body = certBodyOf(record?.type);
  if (!body) return null;
  const stored = record?.customFields?.[CERT_ROLE_FIELD];
  if (CERT_ROLES.includes(stored)) return stored;
  if (body === "AANPCB") return "NP certification";
  if (body === "NCCPA") {
    const nccpa = (licenses || []).filter(l => l && certBodyOf(l.type) === "NCCPA");
    return nccpa.length <= 1 ? "PA-C" : null;
  }
  const letters = NP_ONLY_LETTERS[body];
  if (letters && lettersIn(record?.name).some(x => letters.includes(x))) return "NP certification";
  return null;
}

/**
 * A national certifier's record of the profession's bodies whose role is not
 * answered yet: on file, but neither counted nor "missing" until answered.
 */
export function certificationRolePending(record, licenses = [], degreeType) {
  const body = certBodyOf(record?.type);
  if (!body) return false;
  const bodies = professionOf(degreeType) === "pa" ? PA_CERT_BODIES : professionOf(degreeType) === "np" ? NP_CERT_BODIES : [];
  return bodies.includes(body) && certificationRoleOf(record, licenses) === null;
}

/**
 * A state instrument that may have no end date: a practice agreement (Ohio
 * PA: "is not filed with the Board and does not expire") or a prescriptive
 * authority record. The member says so with "does not expire"; it is never
 * assumed, since some states do renew them.
 */
export const mayNotExpire = (type) => {
  const k = licenseKindOf(type);
  return k === "agreement" || k === "rx";
};

/** A PA-C or NP certification record (the role decides, never the body alone). */
export const isNationalCertification = (record, licenses = []) =>
  NATIONAL_ROLES.includes(certificationRoleOf(record, licenses));

// ── NUCC specialties (NUCC 26.1, nucc_261.csv "Display Name") ───────
// Stored in settings.specialties as NUCC:<code>:<Display Name>; every
// renderer prints the last segment, so the display name is what a
// credentialing office reads, never the bare code.

export const NUCC_PA_SPECIALTIES = Object.freeze([
  ["363AM0700X", "Medical Physician Assistant"],
  ["363AS0400X", "Surgical Physician Assistant"],
]);
export const NUCC_NP_SPECIALTIES = Object.freeze([
  ["363LA2100X", "Acute Care Nurse Practitioner"],
  ["363LA2200X", "Adult Health Nurse Practitioner"],
  ["363LC1500X", "Community Health Nurse Practitioner"],
  ["363LC0200X", "Critical Care Medicine Nurse Practitioner"],
  ["363LF0000X", "Family Nurse Practitioner"],
  ["363LG0600X", "Gerontology Nurse Practitioner"],
  ["363LN0000X", "Neonatal Nurse Practitioner"],
  ["363LN0005X", "Critical Care Neonatal Nurse Practitioner"],
  ["363LX0001X", "Obstetrics & Gynecology Nurse Practitioner"],
  ["363LX0106X", "Occupational Health Nurse Practitioner"],
  ["363LP0200X", "Pediatric Nurse Practitioner"],
  ["363LP0222X", "Critical Care Pediatric Nurse Practitioner"],
  ["363LP1700X", "Perinatal Nurse Practitioner"],
  ["363LP2300X", "Primary Care Nurse Practitioner"],
  ["363LP0808X", "Psychiatric/Mental Health Nurse Practitioner"],
  ["363LS0200X", "School Nurse Practitioner"],
  ["363LW0102X", "Women's Health Nurse Practitioner"],
]);
const NUCC_NAMES = new Map([...NUCC_PA_SPECIALTIES, ...NUCC_NP_SPECIALTIES]);

/** "NUCC:363LF0000X:Family Nurse Practitioner", or null for a code not offered. */
export function nuccSpecialtyId(code) {
  const name = NUCC_NAMES.get(String(code || "").trim().toUpperCase());
  return name ? `NUCC:${String(code).trim().toUpperCase()}:${name}` : null;
}
export const isNuccSpecialtyId = (id) => String(id || "").startsWith("NUCC:");

// ── NPPES (NUCC taxonomy and credential strings) ────────────────────

/** "physician" | "pa" | "np" | "rn" | null. CNS, CRNA, CNM and AA are none of these. */
export function professionFromTaxonomy(code) {
  const c = String(code || "").trim().toUpperCase();
  if (/^20/.test(c)) return "physician";
  if (/^363A/.test(c)) return "pa";
  if (/^363L/.test(c)) return "np";
  if (/^163W/.test(c)) return "rn";
  return null;
}

/**
 * MD or DO from a registry credential string ("D.O.", "M.D.", "MD, PHD",
 * "DO FACOS"). Dots are stripped and whole tokens matched so "MD" inside
 * another word cannot flip the degree. Empty when neither is present.
 */
export function degreeFromCredential(credential) {
  const cred = String(credential || "").toUpperCase().replace(/\./g, "");
  if (/\bDO\b/.test(cred)) return "DO";
  if (/\bMD\b/.test(cred)) return "MD";
  return "";
}

const PA_TOKENS = new Set(["PA-C", "PAC", "RPA-C", "RPAC", "R-PAC", "PA"]);
const PA_PHRASES = ["PHYSICIAN ASSISTANT", "PHYSICIANS ASSISTANT", "PHYSICIAN'S ASSISTANT"];
const NP_TOKENS = new Set([
  "NP", "NP-C", "FNP", "FNP-C", "FNP-BC", "CRNP", "ARNP", "CNP", "APRN-CNP", "PNP", "CPNP",
  "CPNP-PC", "CPNP-AC", "AGACNP-BC", "AGACNP", "PMHNP", "PMHNP-C", "WHNP", "WHNP-BC", "NNP", "NNP-BC",
  "ENP-C", "A-GNP-C",
]);
const NP_PHRASES = ["NURSE PRACTITIONER"];

/** Uppercase, dots removed, "PA - C" / "PA C" / "PA- C" read as "PA-C". */
function credentialText(credential) {
  return String(credential || "").toUpperCase().replace(/\./g, "")
    .replace(/\bPA\s*-\s*C\b/g, "PA-C").replace(/\bPA C\b/g, "PA-C").replace(/\s+/g, " ").trim();
}

/** Which of "pa" and "np" a credential string names, as a set. */
function credentialProfessions(credential) {
  const text = credentialText(credential);
  const tokens = text.split(/[,;/ ]+/).filter(Boolean);
  const out = new Set();
  if (tokens.some(t => PA_TOKENS.has(t)) || PA_PHRASES.some(p => text.includes(p))) out.add("pa");
  if (tokens.some(t => NP_TOKENS.has(t)) || NP_PHRASES.some(p => text.includes(p))) out.add("np");
  return out;
}

const taxonomyRows = (taxonomies) => (Array.isArray(taxonomies) ? taxonomies : []).filter(t => t && t.code);
const isPrimaryRow = (t) => t.isPrimary === true || t.primary === true;

/**
 * The profession a registry record supports, with the reason. Never assumes:
 *  0. a 363A/363L primary taxonomy with an MD/DO credential, or a credential
 *     naming both a physician and a PA/NP on a non-physician record, is a
 *     conflict: blank, reported.
 *  1. MD/DO credential tokens (physicians identical to before)
 *  2. primary taxonomy (363A PA, 363L NP; a 20* physician stays blank, MD vs DO unknown)
 *  3. every taxonomy: exactly PA, or exactly NP (RN rows ignored)
 *  4. PA/NP credential tokens, when only one profession is named
 * Returns { degree: "MD"|"DO"|"PA"|"NP"|"", source, conflict }.
 */
export function nppesProfession({ credential, taxonomies } = {}) {
  const rows = taxonomyRows(taxonomies);
  const primary = rows.find(isPrimaryRow) || rows[0] || null;
  const primaryKind = primary ? professionFromTaxonomy(primary.code) : null;
  const physicianDegree = degreeFromCredential(credential);
  const named = credentialProfessions(credential);
  if (physicianDegree) {
    const appPrimary = primaryKind === "pa" || primaryKind === "np";
    const mixed = named.size > 0 && primary && primaryKind !== "physician";
    if (appPrimary || mixed) {
      return { degree: "", source: "conflict", conflict: { credential: String(credential || ""), taxonomy: primary?.code || "" } };
    }
    return { degree: physicianDegree, source: "credential", conflict: null };
  }
  if (primaryKind === "pa") return { degree: "PA", source: "taxonomy", conflict: null };
  if (primaryKind === "np") return { degree: "NP", source: "taxonomy", conflict: null };
  if (primaryKind === "physician") return { degree: "", source: "physician-taxonomy", conflict: null };
  const kinds = new Set(rows.map(t => professionFromTaxonomy(t.code)).filter(k => k && k !== "rn"));
  if (kinds.size === 1 && kinds.has("pa")) return { degree: "PA", source: "taxonomies", conflict: null };
  if (kinds.size === 1 && kinds.has("np")) return { degree: "NP", source: "taxonomies", conflict: null };
  if (named.size === 1) {
    return { degree: named.has("pa") ? "PA" : "NP", source: "credential", conflict: null };
  }
  return { degree: "", source: "none", conflict: null };
}

/** "MD" | "DO" | "PA" | "NP" | "" for a registry record. */
export const degreeFromNppes = (record) => nppesProfession(record || {}).degree;

/** The licence type the app files an imported physician licence under, by degree. */
export function licenseTypeFor(degreeType) {
  return String(degreeType || "").toUpperCase() === "DO" ? "State Medical License (DO)" : "State Medical License";
}

/**
 * Type and name for one imported registry licence row. MD and DO accounts
 * get today's medical licence exactly. A blank account keeps today's result
 * except for rows the taxonomy shows are PA, APRN or RN licences. A PA or NP
 * account types every row by its taxonomy.
 */
export function licenseTypeForNppesRow(row, degreeType) {
  const st = String(row?.state || "").trim().toUpperCase();
  const medical = { type: licenseTypeFor(degreeType), name: `${st} Medical License` };
  if (isPhysicianDegree(degreeType)) return medical;
  const kind = professionFromTaxonomy(row?.taxonomyCode);
  if (kind === "pa") return { type: "State Physician Assistant License", name: `${st} Physician Assistant License` };
  if (kind === "np") return { type: "APRN License (NP)", name: `${st} APRN License` };
  if (kind === "rn") return { type: "RN License", name: `${st} RN License` };
  if (!isAdvancedPractice(degreeType)) return medical;
  if (kind === "physician") return { type: "State Medical License", name: `${st} Medical License` };
  return { type: "Other", name: `${st} license (${row?.description || "type not known"})` };
}

/**
 * What an NPPES lookup may do to the stored profession. A PA or NP answer
 * fills a blank (or unrecognised) profession only. An MD or DO answer keeps
 * each site's old rule (Settings replaces a blank, MD or DO; Setup fills a
 * blank only) and never replaces a chosen PA or NP. A disagreement with a
 * chosen profession, or a conflicting record, comes back as a finding for
 * the member to look at, never as a change.
 * Returns { degree: string | null (null = leave as is), finding: object | null }.
 */
export function degreeAfterNppes(current, record, { site = "settings" } = {}) {
  const { degree, conflict } = nppesProfession(record || {});
  const cur = current || "";
  if (conflict) return { degree: null, finding: { kind: "conflict", ...conflict } };
  if (!degree) return { degree: null, finding: null };
  if (degree === cur) return { degree: null, finding: null };
  if (isPhysicianDegree(degree)) {
    if (isAdvancedPractice(cur)) return { degree: null, finding: { kind: "differs", registry: degree, chosen: cur } };
    if (site === "setup") return { degree: cur ? null : degree, finding: null };
    return { degree, finding: null };
  }
  if (!isKnownDegree(cur)) return { degree, finding: null };
  return { degree: null, finding: { kind: "differs", registry: degree, chosen: cur } };
}
