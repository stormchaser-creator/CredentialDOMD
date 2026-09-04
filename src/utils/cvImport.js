/**
 * Reading a CV into the record.
 *
 * A physician's CV already states the degree, the training, the positions,
 * the licenses, the papers and the societies. Typing all of that a second
 * time is the reason a new account sits empty, so this reads it once.
 *
 * What this module is NOT: it is not the document scanner. That pipeline
 * (src/utils/documentScanner.js) answers "what one credential is this, and
 * what are its fields", one record for one section. A CV is thirty records
 * across seven sections, so it gets its own reader (src/utils/cvScan.js for
 * the network half) and its own review screen.
 *
 * What it IS: a producer of the same finding shape the public-record import
 * already uses, so every rule that import earned is inherited rather than
 * rewritten. markAlreadyOnFile, markPlanLocks, isSelectable, groupFindings,
 * buildSavePlan and savedSummary all come from publicRecord.js unchanged.
 *
 * Two rules that must not be softened:
 *
 *  1. EVERY finding is `confidence: "lead"`, and nothing starts ticked. A
 *     federal register stating a license number earns a default tick. A
 *     model reading prose off a PDF does not, whatever it says about its own
 *     confidence.
 *  2. Only sections in publicRecord.GROUP_ORDER are emitted. A section
 *     outside it has no group title, no dedupe key, and in the case of the
 *     Pro-gated ones no plan lock, so a row there could be ticked into a
 *     page the physician cannot open.
 *
 * Pure: no fetch, no React, no import.meta. scripts/cv-import.test.mjs runs
 * it under plain node.
 */

import { clean } from "./publicRecord.js";
import {
  EDUCATION_TYPES, WORK_HISTORY_TYPES, PRIVILEGE_TYPES, getLicenseTypes,
} from "../constants/credentialTypes.js";
import { STATES, STATE_NAMES } from "../constants/states.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => clean(v);

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * A CV states the precision it has, and no more. "2006" is a year, "June
 * 2006" is a month, and neither is a day.
 *
 * cvContent.longDate prints a stored YYYY-01-01 as the bare year and a
 * YYYY-MM-01 as the month, on purpose, so a date read at year precision
 * survives the round trip back onto the CV as the same year. A bare "2006"
 * would render blank in a date input, so it is never returned.
 */
export function cvYearDate(v) {
  const s = str(v);
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;

  // "June 2006", "Jun 2006", "2006 June"
  const word = s.match(/[A-Za-z]{3,}/);
  const year = s.match(/\b(19|20)\d{2}\b/);
  if (word && year) {
    const key = word[0].toLowerCase().slice(0, 3);
    const idx = MONTHS.findIndex((m) => m.slice(0, 3) === key);
    if (idx >= 0) return `${year[0]}-${String(idx + 1).padStart(2, "0")}-01`;
  }
  // "06/2006" or "6-2006"
  const numeric = s.match(/^(\d{1,2})[/-](\d{4})$/);
  if (numeric) {
    const m = Number(numeric[1]);
    if (m >= 1 && m <= 12) return `${numeric[2]}-${String(m).padStart(2, "0")}-01`;
  }
  if (year) return `${year[0]}-01-01`;
  return "";
}

const words = (v) => String(v).toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 3);

/**
 * A value the physician's own form would accept, or the list's own "Other".
 *
 * A CV writes "Spine Fellowship" where the form says "Fellowship Certificate",
 * and "Locums" where it says "Locum Tenens". Falling straight to "Other" makes
 * the physician re-pick every row, so a shared significant word counts, with
 * one word allowed to be a prefix of the other. Ambiguity still falls back:
 * "Other" is a wrong answer the physician can see and fix, and a confidently
 * wrong type is one they will not.
 */
function toOption(value, options) {
  const v = str(value);
  if (!v) return "Other";
  const lower = v.toLowerCase();
  const hit = options.find((o) => o.toLowerCase() === lower);
  if (hit) return hit;
  const loose = options.find((o) => {
    const bare = o.replace(/\s*\(.*\)\s*/g, "").trim().toLowerCase();
    return bare === lower || lower.includes(bare);
  });
  if (loose) return loose;

  const given = words(v);
  if (!given.length) return "Other";
  let best = null, bestScore = 0;
  for (const o of options) {
    if (o === "Other") continue;
    const score = words(o).reduce((n, w) => n + (given.some((g) =>
      g === w || (g.length >= 5 && w.startsWith(g)) || (w.length >= 5 && g.startsWith(w))) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = o; }
    else if (score === bestScore && score > 0 && best !== o) { best = best === null ? o : best; }
  }
  return bestScore > 0 ? best : "Other";
}

// A CV writes "California" as often as "CA", and the prompt asking for the
// code is not a guarantee. Both are read; anything else is left blank rather
// than guessed, because a wrong state files a license under the wrong board.
const STATE_BY_NAME = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toUpperCase(), code]),
);

function toState(value) {
  const v = str(value).toUpperCase();
  if (STATES.includes(v)) return v;
  return STATE_BY_NAME[v] || "";
}

/**
 * Does this string look like the physician rather than a credential?
 *
 * cvContent.namesThePhysician silently swaps a record's `name` for its type
 * when the name looks like the physician's own, because a scanned diploma
 * saved under "Daniel Logsdon" reads as nonsense on a CV. A parser that
 * writes the person's name into `name` would be feeding that swap on every
 * row. This is the same test, applied before the record is ever proposed.
 */
export function namesThePhysician(name, ownName) {
  const own = String(ownName || "").toLowerCase().replace(/[^a-z ]/g, "")
    .split(/\s+/).filter((w) => w.length > 2);
  if (!own.length) return false;
  const words = String(name || "").toLowerCase().replace(/[^a-z ]/g, "")
    .split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.length <= 5 && words.filter((w) => own.includes(w)).length >= Math.min(2, own.length);
}

/**
 * The model's reply, coerced into records the app's own forms would accept:
 * every select is a member of its list, every date is a real date, every
 * state is a real state code, and nothing carries a field the form has no
 * input for.
 */
export function normalizeCvSections(raw, { deg = "", name = "" } = {}) {
  const licenseTypes = getLicenseTypes(deg);
  const r = raw && typeof raw === "object" ? raw : {};

  const settings = {};
  const s = r.settings && typeof r.settings === "object" ? r.settings : {};
  for (const k of ["name", "email", "phone", "address", "website", "languages",
    "professionalSummary", "cvHighlights"]) {
    const v = str(s[k]);
    if (v) settings[k] = v;
  }
  const degree = str(s.degreeType).toUpperCase();
  if (degree === "MD" || degree === "DO") settings.degreeType = degree;
  const npi = str(s.npi).replace(/\D/g, "");
  if (npi.length === 10) settings.npi = npi;
  const specialties = arr(s.specialties).map(str).filter(Boolean);
  if (specialties.length) settings.specialties = specialties;

  // Two names to test against, not one: the profile may hold "Dan Logsdon"
  // while the CV prints "Daniel Logsdon", and a credential labelled with
  // either is still labelled with the physician.
  const ownNames = [name, settings.name].filter(Boolean);
  const isPerson = (given) => ownNames.some((own) => namesThePhysician(given, own));
  const credentialLabel = (given, fallback) =>
    (isPerson(given) ? "" : str(given)) || fallback;

  const education = arr(r.education).map((e) => {
    const type = toOption(e?.type, EDUCATION_TYPES);
    return {
      type,
      name: credentialLabel(e?.name, [type, str(e?.institution)].filter(Boolean).join(" - ")),
      institution: str(e?.institution),
      startDate: cvYearDate(e?.startDate),
      graduationDate: cvYearDate(e?.graduationDate || e?.endDate),
      fieldOfStudy: str(e?.fieldOfStudy),
      honors: str(e?.honors),
    };
  }).filter((e) => e.institution || e.name);

  const workHistory = arr(r.workHistory).map((w) => ({
    type: toOption(w?.type, WORK_HISTORY_TYPES),
    position: str(w?.position),
    employer: str(w?.employer),
    city: str(w?.city),
    state: toState(w?.state),
    startDate: cvYearDate(w?.startDate),
    endDate: cvYearDate(w?.endDate),
    // The form's own select is No / Yes, and cvContent.range falls back to
    // "current" on a blank end date either way.
    current: w?.current === true || /^(yes|true|current|present)$/i.test(str(w?.current)) ? "Yes" : "No",
    description: str(w?.description),
  })).filter((w) => w.employer || w.position);

  const licenses = arr(r.licenses).map((l) => {
    const type = toOption(l?.type, licenseTypes);
    const state = toState(l?.state);
    return {
      type,
      name: credentialLabel(l?.name, [type, state].filter(Boolean).join(" - ")),
      state,
      licenseNumber: str(l?.licenseNumber),
      issuedDate: cvYearDate(l?.issuedDate),
      expirationDate: cvYearDate(l?.expirationDate),
    };
  }).filter((l) => l.licenseNumber || l.state || l.type !== "Other");

  const privileges = arr(r.privileges).map((p) => {
    const type = toOption(p?.type, PRIVILEGE_TYPES);
    return {
      type,
      name: credentialLabel(p?.name, [type, str(p?.facility)].filter(Boolean).join(" - ")),
      facility: str(p?.facility),
      city: str(p?.city),
      state: toState(p?.state),
      appointmentDate: cvYearDate(p?.appointmentDate),
      expirationDate: cvYearDate(p?.expirationDate),
    };
  }).filter((p) => p.facility);

  const publications = arr(r.publications).map((p) => ({
    name: str(p?.name) || str(p?.citation).slice(0, 80),
    citation: str(p?.citation),
    year: str(p?.year).match(/(19|20)\d{2}/)?.[0] || "",
    doi: str(p?.doi),
    pmid: str(p?.pmid).replace(/\D/g, ""),
    url: str(p?.url),
  })).filter((p) => p.citation || p.name);

  const memberships = arr(r.memberships).map((m) => ({
    organization: str(m?.organization),
    role: str(m?.role),
    startDate: cvYearDate(m?.startDate),
    endDate: cvYearDate(m?.endDate),
  })).filter((m) => m.organization);

  return { settings, education, workHistory, licenses, privileges, publications, memberships };
}

// ── Findings ────────────────────────────────────────────────────────────────

const yearOf = (d) => (str(d) ? String(d).slice(0, 4) : "");
const dateRange = (a, b, current) => {
  const from = yearOf(a);
  const to = current === "Yes" ? "current" : yearOf(b);
  if (!from && !to) return "";
  return `${from || "?"} to ${to || "current"}`;
};

/** What the physician still has to add before the record is any use. */
function needsFor(section, item) {
  const needs = [];
  if (section === "licenses" && !item.expirationDate) needs.push("expirationDate");
  if (section === "education" && !item.graduationDate) needs.push("graduationDate");
  if (section === "privileges" && !item.expirationDate) needs.push("expirationDate");
  if (section === "workHistory" && !item.startDate) needs.push("startDate");
  return needs;
}

/**
 * The model's reply as review rows.
 *
 * `kind: "cvRow"` on every one, which is what publicRecord.leadNote keys the
 * sentence off. Ids are stable and prefixed so a second import of the same
 * CV produces the same ids, and requestSourceFor returns "" for them, which
 * is correct: there is no register here to ask again.
 */
export function cvFindings(raw, { data = {}, settings = {} } = {}) {
  const deg = settings.degreeType || "";
  const name = settings.name || "";
  const secs = normalizeCvSections(raw, { deg, name });
  const out = [];
  const source = { name: "Your CV", url: "" };
  const push = (section, idx, label, detail, fields) => {
    out.push({
      id: `cv:${section}:${idx}`,
      section,
      kind: "cvRow",
      label,
      detail,
      confidence: "lead",
      fields,
      needs: needsFor(section, fields),
      source,
    });
  };

  // Profile fields are proposed one at a time rather than as a single patch,
  // because a CV states a phone the physician may have replaced and an
  // address they may have left, and one tick for the lot would be a silent
  // edit of the record.
  const SETTINGS_LABELS = {
    name: "Name", degreeType: "Degree", npi: "NPI", email: "Email", phone: "Phone",
    address: "Address", website: "Website", languages: "Languages",
    specialties: "Specialties", professionalSummary: "Professional summary",
    cvHighlights: "CV highlights",
  };
  Object.keys(secs.settings).forEach((k, i) => {
    const v = secs.settings[k];
    const shown = Array.isArray(v) ? v.join(", ") : String(v);
    push("settings", `${k}`, `${SETTINGS_LABELS[k] || k}: ${shown.slice(0, 90)}`, "", { [k]: v });
    void i;
  });

  secs.education.forEach((e, i) => {
    const years = [yearOf(e.startDate), yearOf(e.graduationDate)].filter(Boolean).join(" to ");
    push("education", i, e.name || e.type,
      [e.institution, years, e.fieldOfStudy].filter(Boolean).join(" | "), e);
  });

  secs.workHistory.forEach((w, i) => {
    push("workHistory", i, w.employer || w.position,
      [w.position, [w.city, w.state].filter(Boolean).join(", "),
        dateRange(w.startDate, w.endDate, w.current)].filter(Boolean).join(" | "), w);
  });

  secs.licenses.forEach((l, i) => {
    push("licenses", i, [l.type, l.state].filter(Boolean).join(" - "),
      [l.licenseNumber ? `No. ${l.licenseNumber}` : "", l.expirationDate ? `expires ${l.expirationDate}` : ""]
        .filter(Boolean).join(" | "), l);
  });

  secs.privileges.forEach((p, i) => {
    push("privileges", i, p.facility,
      [p.type, [p.city, p.state].filter(Boolean).join(", ")].filter(Boolean).join(" | "), p);
  });

  secs.publications.forEach((p, i) => {
    push("publications", i, p.name || "Publication", p.citation, p);
  });

  secs.memberships.forEach((m, i) => {
    push("memberships", i, m.organization,
      [m.role, dateRange(m.startDate, m.endDate, "No")].filter(Boolean).join(" | "), m);
  });

  void data;
  return out;
}

/**
 * Nothing starts ticked. publicRecord.defaultSelectedIds seeds every
 * `confidence: "record"` row, and no CV row is one, so this is the same
 * answer said out loud: a model reading a PDF is never a reason to write a
 * record the physician has not read.
 */
export function defaultSelectedCvIds() {
  return [];
}

/** The ids in one group, for the "tick all here" button a thirty-row import needs. */
export function selectableIdsIn(group) {
  return arr(group?.findings)
    .filter((f) => !f.alreadyOnFile && !f.planLocked)
    .map((f) => f.id);
}

/**
 * How the physician's own file names a CV, so the setup row can tell it is
 * done. The accented spelling is matched explicitly because a word boundary
 * does not see "e" with an acute as a word character, and "Resume 2026.pdf"
 * and "Resume 2026.pdf" spelled either way are the same file.
 */
export const CV_FILENAME_RE = /(^|[^a-z])(cv|curriculum[ _-]?vitae|r[e\u00e9]sum[e\u00e9]?)([^a-z]|$)/i;
