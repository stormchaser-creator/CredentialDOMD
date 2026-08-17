/**
 * CME transcript import: turn a CE Broker CE Report PDF, an ACCME PARS
 * learner file, a generic CSV/XLSX, or pasted text into review-ready CME
 * rows. Everything in here is pure (no React, no DOM) except the two
 * browser helpers at the bottom (file reading, Gemini call), so the
 * parsers run under plain node for the checks in scripts/cme-import.test.mjs.
 *
 * What was verified against a real source, and what was not:
 *  - CE Broker: the licensee-facing export is a PDF ("CE Report", Course
 *    History -> Export -> Export PDF). Verified from CE Broker help center
 *    articles 21038178138132 ("Download a PDF CE report") and 48106666469140
 *    and their sample image: columns Course (title + "# 20-xxxxxx" course
 *    number), Completed (M/D/YYYY), Provider (name + "# 50-xxxxx"), Reported
 *    by, Subject areas covered (bulleted), Credits earned (per subject, then
 *    a total). No licensee CSV/XLSX export is documented, and the report
 *    carries no certificate number and no AMA credit category.
 *  - ACCME PARS learner batch file: the Excel template accredited providers
 *    upload (accme.org/resource/excel-learner-batch-template/, file
 *    917_20240125_Learner_Excel_CME_MOC_Template.xlsx, downloaded and read
 *    2026-08-17). Row 1 is guidance text; row 2 is the header: Record Action,
 *    ACCME Activity ID, Completion Date, First Name, Last Name, Date of
 *    Birth, Licensing State, Licensing ID or NPI, Number of CME Credits,
 *    Certifying Board, Certifying Board ID, Total Board Credits, Credit
 *    Type, Credits Awarded for Credit Type, Additional Credit Type, ...
 *    It carries no activity title or provider name.
 *  - ACCME CME Passport transcript (what a physician downloads): layout
 *    taken from the sample transcript reproduced in ACCME's "Reviewing CME
 *    Credit Data: Getting Started in PARS" guide (accme.org, 2024): title
 *    "Accredited Continuing Education Transcript"; columns Completion Date,
 *    Activity (title, provider on the line below), Credits Earned ("7 AMA
 *    PRA Category 1 Credits", then board MOC points and their credit
 *    types). No certificate number.
 *  - ACCME PARS learner search: the same guide shows the on-screen columns
 *    Board, Name, DOB, Learner ID, Activity (+ Activity ID), Completion,
 *    Submission, Credits Awarded ("0.5 AMA PRA Category 1 Credit"), Status,
 *    with a "Download All Learners" action. The downloaded file itself
 *    could not be loaded, so those columns are matched by name only.
 *  - Anything else is "generic CSV" with a manual column-mapping step.
 */
import { CME_TOPICS } from "../constants/cmeTopics.js";
import { CME_CATEGORIES_MD, CME_CATEGORIES_DO } from "../constants/credentialTypes.js";

// ─────────────────────────────────────────────────────────────────────────
// Field vocabulary
// ─────────────────────────────────────────────────────────────────────────

export const IMPORT_FIELDS = [
  { key: "date", label: "Date completed" },
  { key: "title", label: "Activity / title" },
  { key: "provider", label: "Provider" },
  { key: "hours", label: "Hours / credits" },
  { key: "category", label: "Credit type" },
  { key: "topics", label: "Subject / topic" },
  { key: "certificateNumber", label: "Certificate #" },
];

/**
 * What the picker screen tells the physician about each supported source:
 * where the file comes from, which columns it carries, and how much of that
 * was verified. Only statements backed by a loaded document appear here.
 */
export const IMPORT_SOURCES = [
  {
    id: "cebroker-pdf",
    label: "CE Broker CE Report (PDF)",
    how: "CE Broker: Course History, Export, Export PDF.",
    columns: "Course (title and course number), Completed, Provider (and provider number), Reported by, Subject areas covered, Credits earned.",
    status: "Read directly. The report prints no certificate number and no AMA credit category, so credit type is set to AMA PRA Category 1 for you to confirm.",
    verified: true,
  },
  {
    id: "cmepassport-pdf",
    label: "ACCME CME Passport transcript (PDF)",
    how: "cmepassport.org: your transcript, saved or printed to PDF.",
    columns: "Completion Date, Activity (title with the provider beneath), Credits Earned (AMA PRA Category 1 credits, board MOC points and credit types).",
    status: "Read directly. Layout taken from the sample transcript in ACCME's PARS guide for state boards. No certificate number. Rows with only board MOC points get no hours (points are not CME hours); the points stay in notes.",
    verified: true,
  },
  {
    id: "pars-batch",
    label: "ACCME PARS learner Excel file",
    how: "The Excel batch file an accredited provider uploads to PARS (if a provider sends you their copy).",
    columns: "Record Action, ACCME Activity ID, Completion Date, learner name, Date of Birth, Licensing State, Licensing ID or NPI, Number of CME Credits, Certifying Board, Credit Type, Credits Awarded for Credit Type.",
    status: "Header row verified against ACCME's template. This file has no activity title or provider name; the Activity ID stands in as the title until you edit it.",
    verified: true,
  },
  {
    id: "pars-learner-search",
    label: "ACCME PARS learner search download",
    how: "PARS, Learners, Learner Search, Download All Learners (state board and provider accounts).",
    columns: "On screen: Board, Name, DOB, Learner ID, Activity, Completion, Submission, Credits Awarded, Status.",
    status: "The downloaded file's exact headers were not verified; columns are matched by name and you confirm the mapping.",
    verified: false,
  },
  {
    id: "generic",
    label: "Generic CSV, Excel, or pasted table",
    how: "Any other CME tracker, hospital education office, or society export.",
    columns: "Whatever the export carries; you map date, title, provider, hours, credit type, topic and certificate number to its columns.",
    status: "Generic CSV: nothing is assumed about the layout.",
    verified: false,
  },
];

// Header aliases, lowercase, matched as substrings after normalising
// punctuation. Order matters: first hit wins per field.
const HEADER_ALIASES = {
  date: ["completion date", "date completed", "completed", "completion", "date of completion", "activity date", "end date", "date earned", "credit date", "date"],
  title: ["activity title", "course title", "course name", "activity name", "title", "course", "activity", "program", "name of activity", "description", "event"],
  provider: ["provider name", "accredited provider", "provider", "sponsor", "organization", "institution", "presented by", "accreditor"],
  hours: ["number of cme credits", "credits earned", "credit hours", "cme credits", "hours awarded", "hours earned", "credits awarded", "contact hours", "credits", "credit", "hours", "hrs", "units", "ceu"],
  category: ["credit type", "credit category", "category", "credit designation", "type of credit", "designation", "activity type", "format", "delivery method"],
  topics: ["subject areas covered", "subject areas", "subject area", "subject", "topic", "topics", "content area", "practice area", "specialty"],
  certificateNumber: ["certificate number", "certificate #", "certificate no", "certificate id", "cert #", "certificate", "confirmation number", "confirmation #", "acc number", "activity id", "accme activity id", "course number", "course #", "tracking number", "record id"],
};

function normHeader(h) {
  return String(h ?? "").toLowerCase().replace(/[_\-./]+/g, " ").replace(/[^a-z0-9#\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Guess which column feeds which field. Returns { field: columnIndex|null }.
 * A column is used once; the most specific alias wins.
 */
export function guessMapping(headers) {
  const norm = (headers || []).map(normHeader);
  const mapping = {};
  for (const { key } of IMPORT_FIELDS) mapping[key] = null;
  const usedCols = new Set();
  // All (field, alias) pairs, most specific (longest) alias first, so
  // "accme activity id" beats "activity" and "number of cme credits" beats "credits".
  const pairs = [];
  for (const { key } of IMPORT_FIELDS) HEADER_ALIASES[key].forEach((alias, rank) => pairs.push({ key, alias, rank }));
  pairs.sort((a, b) => b.alias.length - a.alias.length || a.rank - b.rank);
  const claim = (key, idx) => { if (mapping[key] == null && !usedCols.has(idx)) { mapping[key] = idx; usedCols.add(idx); } };
  // pass 1: exact header match
  for (const { key, alias } of pairs) {
    const idx = norm.findIndex((h, i) => !usedCols.has(i) && h === alias);
    if (idx !== -1) claim(key, idx);
  }
  // pass 2: whole-word substring
  for (const { key, alias } of pairs) {
    if (mapping[key] != null) continue;
    const re = new RegExp(`(^|\\s)${alias.replace(/[#]/g, "\\#")}(\\s|$)`);
    const idx = norm.findIndex((h, i) => !usedCols.has(i) && re.test(h));
    if (idx !== -1) claim(key, idx);
  }
  return mapping;
}

/**
 * Identify the source from a header row.
 * Returns { id, label, verified, note }.
 */
export function detectSource(headers) {
  const norm = (headers || []).map(normHeader);
  const has = (...names) => names.every(n => norm.some(h => h === n));
  const hasAny = (...names) => names.some(n => norm.some(h => h === n));

  if (has("record action", "accme activity id", "completion date", "number of cme credits")) {
    return {
      id: "pars-batch",
      label: "ACCME PARS learner batch file",
      verified: true,
      note: "Columns verified against the ACCME Excel learner batch template. This file has no activity title or provider name: the ACCME Activity ID is kept as the title until you edit it. CME credits are treated as AMA PRA Category 1.",
    };
  }
  if (hasAny("accme activity id", "activity id") && hasAny("completion date", "date completed") && hasAny("activity title", "activity name", "title")) {
    return {
      id: "pars-learner",
      label: "ACCME PARS learner report",
      verified: false,
      note: "Columns matched by name (activity ID, title, completion date, credits). The exact PARS learner report layout could not be verified, so check the mapping below.",
    };
  }
  if (has("learner id", "activity", "completion") && hasAny("credits awarded", "credits")) {
    return {
      id: "pars-learner-search",
      label: "ACCME PARS learner search download",
      verified: false,
      note: "Columns match the PARS Learner Search screen (Board, Name, DOB, Learner ID, Activity, Completion, Submission, Credits Awarded, Status). The downloaded file's exact headers were not verified, so check the mapping below. Credits print as \"N AMA PRA Category 1 Credit\"; the number and the credit type are both read from that column.",
    };
  }
  if (hasAny("subject areas covered", "subject areas") && hasAny("credits earned", "hours earned") && hasAny("completed", "completion date", "date completed")) {
    return {
      id: "cebroker-table",
      label: "CE Broker course history (table)",
      verified: false,
      note: "Column names match the CE Broker CE Report. CE Broker documents a PDF export only, so a spreadsheet with these columns is treated as generic and mapped by name.",
    };
  }
  return {
    id: "generic",
    label: "Generic CSV",
    verified: false,
    note: "Unrecognised layout. Map the columns below; a row needs at least a date or a title.",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Delimited text (CSV / TSV / pasted table)
// ─────────────────────────────────────────────────────────────────────────

/** Pick , ; tab or | by which one splits the first non-empty lines most consistently. */
export function sniffDelimiter(text) {
  const lines = String(text || "").split(/\r?\n/).filter(l => l.trim()).slice(0, 10);
  let best = ",", bestScore = -1;
  for (const d of ["\t", ",", ";", "|"]) {
    const counts = lines.map(l => l.split(d).length - 1);
    const min = Math.min(...counts), max = Math.max(...counts);
    if (min === 0) continue;
    const score = min * 10 - (max - min);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** RFC 4180-ish parser: quotes, doubled quotes, embedded newlines, BOM, CRLF. */
export function parseCSV(text, delimiter) {
  let s = String(text || "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const d = delimiter || sniffDelimiter(s);
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === d) {
      row.push(cell); cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  // Drop fully blank rows and trim cells
  return rows.map(r => r.map(v => v.trim())).filter(r => r.some(v => v !== ""));
}

/**
 * Pasted or PDF text as a table: tab / comma / semicolon / pipe delimited
 * when that splits every line the same way, otherwise columns are runs of
 * 2+ spaces (how extractPdfText marks column gaps). Returns null when the
 * text does not split into at least two columns on most lines.
 */
export function textToTable(text) {
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  const d = sniffDelimiter(raw);
  const delimCounts = lines.map(l => l.split(d).length);
  const consistent = delimCounts.filter(c => c >= 2).length >= lines.length * 0.6;
  if (consistent && (d === "\t" || d === "," || d === ";" || d === "|")) return parseCSV(raw, d);
  const table = lines.map(l => l.trim().split(/ {2,}|\t+/).map(c => c.trim()));
  const multi = table.filter(r => r.length >= 2).length;
  return multi >= lines.length * 0.5 ? table : null;
}

/**
 * Some exports lead with a title block ("CE Report", "Created: ...") before
 * the real header. Find the first row that looks like a header: at least
 * two cells that match known aliases.
 */
export function findHeaderRow(table) {
  let best = -1, bestScore = 0;
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const row = table[i] || [];
    // Header cells are short labels; guidance rows (like row 1 of the ACCME
    // template) are sentences, so only count matches on short cells.
    const shortRow = row.map(c => (String(c ?? "").trim().length <= 40 ? c : ""));
    const m = guessMapping(shortRow);
    let score = Object.values(m).filter(v => v != null).length;
    if (score < 2) continue;
    if (detectSource(shortRow).id !== "generic") score += 10;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

/**
 * Pick the sheet of a workbook that looks like the transcript: the one whose
 * header row maps the most fields (a template's ValidValues / Reference
 * sheets lose to the data sheet even when they have more rows).
 * `sheets` = [{ name, table }]. Returns the chosen { name, table }.
 */
export function pickSheet(sheets) {
  let best = null, bestScore = -1;
  for (const s of sheets || []) {
    const table = s.table || [];
    if (!table.length) continue;
    const hi = findHeaderRow(table);
    let score = 0;
    if (hi >= 0) {
      const m = guessMapping(table[hi]);
      score = Object.values(m).filter(v => v != null).length * 100;
      if (detectSource(table[hi]).id !== "generic") score += 1000;
    }
    score += Math.min(table.length, 99);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// Value normalisers
// ─────────────────────────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function ymd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += y < 50 ? 2000 : 1900;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1950 && y <= 2100)) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Any common date spelling -> YYYY-MM-DD, or "" when unreadable. */
export function normalizeDate(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) return isNaN(v) ? "" : ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === "number") {
    // Excel serial date (days since 1899-12-30)
    if (v > 20000 && v < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return "";
  }
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) return ymd(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) return ymd(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:\s.*)?$/))) return ymd(m[3], m[1], m[2]);
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()] || (m[1].toLowerCase() === "sept" ? 9 : 0);
    return mo ? ymd(m[3], mo, m[2]) : "";
  }
  if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]+(\d{4})$/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? ymd(m[3], mo, m[1]) : "";
  }
  if ((m = s.match(/^(\d{8})$/))) return ymd(m[1].slice(0, 4), m[1].slice(4, 6), m[1].slice(6, 8));
  if (/^\d+(\.\d+)?$/.test(s)) return normalizeDate(Number(s));
  return "";
}

/** "1.5", "1.50 hrs", "2 AMA PRA Category 1 Credits", "0.5 credit" -> number, else null. */
export function parseHours(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) && v >= 0 ? v : null;
  const s = String(v).replace(/,/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isFinite(n) && n >= 0 && n <= 1000 ? n : null;
}

/**
 * Map a credit-type string from a transcript to one of the app's category
 * strings (the CME form's select options) for the physician's degree.
 * Returns { category, assumed } where assumed=true means the source did not
 * say and we defaulted to AMA PRA Category 1.
 */
export function mapCreditType(raw, deg) {
  const list = deg === "DO" ? CME_CATEGORIES_DO : CME_CATEGORIES_MD;
  const s = String(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
  const pick = (name) => list.includes(name) ? name : "Other";
  if (!s) return { category: pick("AMA PRA Category 1"), assumed: true };
  // Exact option name typed in
  const exact = list.find(c => c.toLowerCase() === s);
  if (exact) return { category: exact, assumed: false };

  if (/aoa/.test(s) || /\b(1|2)-?[ab]\b/.test(s)) {
    if (/1-?a\b/.test(s)) return { category: pick("AOA Category 1-A"), assumed: false };
    if (/1-?b\b/.test(s)) return { category: pick("AOA Category 1-B"), assumed: false };
    if (/2-?a\b/.test(s)) return { category: pick("AOA Category 2-A"), assumed: false };
    if (/2-?b\b/.test(s)) return { category: pick("AOA Category 2-B"), assumed: false };
  }
  if (/moc part iv|part 4|practice assessment|improvement in medical practice|improvement in health|quality improvement|performance in practice|practice improvement|pi cme|component 4/.test(s)) {
    return { category: pick(deg === "DO" ? "OCC Component 4 (Practice Assessment)" : "MOC Part IV (Practice Improvement)"), assumed: false };
  }
  if (/self.?assessment|sam\b|self assessment examination/.test(s)) {
    return { category: pick(deg === "DO" ? "OCC Component 2 (Lifelong Learning)" : "Self-Assessment"), assumed: false };
  }
  if (/moc part ii|part 2|lifelong learning|medical knowledge|component 2|llsa|(^|[^a-z])moc([^a-z]|$)(?!.*(category 1|ama pra))/.test(s) && !/category 1|ama pra|cat\.? ?1/.test(s)) {
    return { category: pick(deg === "DO" ? "OCC Component 2 (Lifelong Learning)" : "MOC Part II (Lifelong Learning)"), assumed: false };
  }
  if (/grand rounds/.test(s)) return { category: pick("Grand Rounds"), assumed: false };
  if (/category 2|cat\.? ?2|\bcat2\b/.test(s)) return { category: pick("AMA PRA Category 2"), assumed: false };
  if (/category 1|cat\.? ?1|\bcat1\b|ama pra|pra cat|accredited cme|prescribed|\bcme\b|\bce\b|contact hour|credit|hour|general|live|anytime|enduring|internet|home study|conference|lecture|other/.test(s)) {
    return { category: pick("AMA PRA Category 1"), assumed: !/category 1|cat\.? ?1|\bcat1\b|ama pra|pra cat|accredited cme/.test(s) };
  }
  return { category: pick("AMA PRA Category 1"), assumed: true };
}

// Topic keyword map, matched against title + subject text (lowercase).
const TOPIC_PATTERNS = [
  ["Opioid Prescribing", /opioid|opiate|naloxone|narcotic/],
  ["Pain Management", /\bpain\b|analges/],
  ["Controlled Substances", /controlled substance|schedule ii|schedule 2|\bdea\b|pdmp|prescription monitoring|prescription drug monitoring/],
  ["Ethics", /ethic|professionalism|boundar|professional conduct|jurisprudence|medical law/],
  ["Infection Control", /infection|hand hygiene|steriliz|bloodborne|blood.borne|antimicrobial|antibiotic|sepsis|hepatitis|covid|influenza|pandemic/],
  ["Patient Safety", /patient safety|safe practice|surgical safety|safety/],
  ["Medical Errors Prevention", /medical error|prevention of medical|root cause|adverse event|diagnostic error/],
  ["Risk Management", /risk management|malpractice|liability|medico.?legal|informed consent|documentation/],
  ["Suicide Prevention", /suicid/],
  ["Cultural Competency", /cultural|health equity|health disparit|diversity|lgbt|linguistic|underserved/],
  ["Implicit Bias", /implicit bias|unconscious bias|\bbias\b/],
  ["End-of-Life Care", /end.of.life|hospice|advance directive|advance care planning|dying|goals of care|polst/],
  ["Geriatric Medicine", /geriatric|elder|older adult|dementia|alzheimer|aging|falls? prevention/],
  ["Domestic Violence", /domestic violence|intimate partner|\bipv\b|family violence|partner abuse/],
  ["Child Abuse Recognition", /child abuse|child maltreatment|abuse and neglect|abusive head trauma|shaken baby|mandated reporter/],
  ["Human Trafficking", /traffick/],
  ["Pharmacology", /pharmacol|pharmacotherap|drug interaction|medication management|therapeutics|prescription drug/],
  ["Telemedicine", /telemedicine|telehealth|virtual care|remote patient/],
  ["Sexual Harassment Prevention", /sexual harassment|harassment|sexual misconduct/],
  ["HIV/AIDS", /\bhiv\b|\baids\b|prep\b|antiretroviral/],
  ["Palliative Care", /palliative|comfort care|symptom management/],
  ["Mental Health", /mental health|depression|anxiety|psychiatr|behavioral health|burnout|wellness|ptsd|bipolar|schizophren/],
  ["Substance Use Disorders", /substance use|substance abuse|addiction|alcohol|\bsud\b|\bmat\b|buprenorphine|methadone|mate act|opioid use disorder|\boud\b|drug abuse|chemical dependenc/],
  ["Prescriptive Practice", /prescriptive practice|prescribing practice|safe prescribing|responsible prescribing|appropriate prescribing|prescribing/],
  ["Trauma-Informed Care", /trauma.informed/],
];

/** Guess topic tags from a title (and optional subject text) using keywords; only returns strings from CME_TOPICS. */
export function guessTopics(text, subjects = "") {
  const hay = `${text || ""} ${subjects || ""}`.toLowerCase();
  if (!hay.trim()) return [];
  const out = [];
  for (const [topic, re] of TOPIC_PATTERNS) {
    if (CME_TOPICS.includes(topic) && re.test(hay)) out.push(topic);
  }
  // Direct subject-area names from the source (e.g. CE Broker "Medical Errors")
  for (const t of CME_TOPICS) {
    if (t === "General / No Specific Topic") continue;
    const stem = t.toLowerCase().replace(/\s*\(.*\)/, "").split("/")[0].trim();
    if (stem.length > 3 && hay.includes(stem) && !out.includes(t)) out.push(t);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Row building, dedupe, entry shaping
// ─────────────────────────────────────────────────────────────────────────

let rowSeq = 0;
function newRow(fields, extra = {}) {
  return {
    key: `imp-${++rowSeq}`,
    include: true,
    date: "",
    title: "",
    provider: "",
    hours: null,
    category: "",
    categoryAssumed: false,
    topics: [],
    certificateNumber: "",
    notes: "",
    raw: null,
    warnings: [],
    duplicate: false,
    ...fields,
    ...extra,
  };
}

// Ligatures and odd spacing from PDF text (e.g. "Traf\ufb01cking") -> plain text
function cleanText(v) {
  return String(v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function finishRow(r, deg) {
  r.title = cleanText(r.title);
  r.provider = cleanText(r.provider);
  r.rawSubjects = cleanText(r.rawSubjects);
  r.certificateNumber = cleanText(r.certificateNumber);
  const cat = mapCreditType(r.rawCategory, deg);
  r.category = r.category || cat.category;
  r.categoryAssumed = r.categoryAssumed || (!r.rawCategory ? true : cat.assumed);
  if (!r.topics?.length) r.topics = guessTopics(r.title, r.rawSubjects);
  const w = [];
  if (!r.date) w.push("no date");
  if (!r.title) w.push("no title");
  if (r.hours == null) w.push("no hours");
  r.warnings = w;
  delete r.rawCategory;
  delete r.rawSubjects;
  return r;
}

/**
 * Apply a column mapping to a table (array of arrays). `headerIndex` is the
 * row holding column names (-1 for none). Returns rows ready for review.
 */
export function rowsFromTable(table, mapping, { deg, headerIndex = 0, source, ownerName = "" } = {}) {
  const out = [];
  const get = (r, key) => (mapping[key] == null ? "" : (r[mapping[key]] ?? ""));
  const headers = headerIndex >= 0 ? (table[headerIndex] || []).map(normHeader) : [];
  const boardIdx = headers.findIndex(h => h === "certifying board");
  // PARS batch files list one row per learner: only Add rows for THIS
  // physician count; anything else is unticked and labelled.
  const actionIdx = headers.findIndex(h => h === "record action");
  const firstIdx = headers.findIndex(h => h === "first name");
  const lastIdx = headers.findIndex(h => h === "last name");
  const ownerToks = String(ownerName || "").toLowerCase().replace(/\b(dr|md|do|phd|jr|sr|ii|iii)\b\.?/g, "").split(/[^a-z]+/).filter(t => t.length >= 2);
  const learnerMatches = (first, last) => {
    if (!ownerToks.length) return true;
    const toks = `${first} ${last}`.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    if (!toks.length) return true;
    return toks.some(t => ownerToks.includes(t)) && (ownerToks.includes(String(last || "").toLowerCase()) || ownerToks.length < 2);
  };
  for (let i = headerIndex + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || !r.some(v => String(v ?? "").trim() !== "")) continue;
    let learnerNote = "", differentLearner = false, skipRow = false;
    if (source?.id === "pars-batch") {
      const action = actionIdx >= 0 ? String(r[actionIdx] ?? "").trim().toLowerCase() : "";
      if (action && action !== "add") skipRow = true; // Delete / Update rows are not new credit
      const first = firstIdx >= 0 ? String(r[firstIdx] ?? "").trim() : "";
      const last = lastIdx >= 0 ? String(r[lastIdx] ?? "").trim() : "";
      if (first || last) { learnerNote = `learner: ${[first, last].filter(Boolean).join(" ")}`; differentLearner = !learnerMatches(first, last); }
    }
    if (skipRow) continue;
    const dateRaw = get(r, "date");
    const titleRaw = String(get(r, "title") ?? "").trim();
    const hoursRaw = get(r, "hours");
    // PARS batch template: no title column, use the Activity ID as a stand-in
    let title = titleRaw;
    if (!title && source?.id === "pars-batch" && mapping.certificateNumber != null) {
      title = `ACCME activity ${String(r[mapping.certificateNumber] ?? "").trim()}`.trim();
    }
    const date = normalizeDate(dateRaw);
    const hours = parseHours(hoursRaw);
    if (!date && !title && hours == null) continue; // totals / blank spacer rows
    // Skip a "Total" footer line
    if (/^total/i.test(title) && !date) continue;
    // "0.5 AMA PRA Category 1 Credit" in the credits column names the credit
    // type as well as the number; use it when there is no credit-type column.
    let rawCategory = String(get(r, "category") ?? "").trim();
    if (!rawCategory && typeof hoursRaw === "string" && /category|aoa|ama pra|moc|self.?assessment/i.test(hoursRaw)) rawCategory = hoursRaw.replace(/^[\d.,\s]+/, "").trim();
    const row = newRow({
      date, title,
      provider: String(get(r, "provider") ?? "").trim(),
      hours,
      certificateNumber: String(get(r, "certificateNumber") ?? "").trim(),
      rawCategory,
      rawSubjects: String(get(r, "topics") ?? "").trim(),
      raw: r,
    });
    if (source?.id === "pars-batch" || source?.id === "pars-learner") {
      // PARS reports accredited (AMA PRA Category 1) CME credit; the board
      // MOC credit type columns describe MOC points, not the CME hours.
      const mocType = row.rawCategory;
      row.rawCategory = "AMA PRA Category 1";
      const b = boardIdx >= 0 ? String(r[boardIdx] ?? "").trim() : "";
      const bits = [];
      if (learnerNote) bits.unshift(learnerNote);
      if (b) bits.push(`PARS: reported for ${b} MOC`);
      if (mocType) bits.push(`MOC credit type: ${mocType}`);
      row.notes = bits.join("; ");
      if (differentLearner) { row.include = false; row.warnings = [...(row.warnings || []), "different learner"]; }
    }
    out.push(finishRow(row, deg));
  }
  return out;
}

/** Stable key for "same activity": date + title + hours. */
export function dedupeKey(e) {
  const t = String(e.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const h = e.hours == null || e.hours === "" ? "" : String(parseFloat(e.hours));
  return `${e.date || ""}|${t}|${h}`;
}

/** Flag rows already in the log (or repeated in the import) and untick them. */
export function markDuplicates(rows, existing = []) {
  const seen = new Set((existing || []).map(dedupeKey));
  return rows.map(r => {
    const k = dedupeKey(r);
    const dup = seen.has(k);
    seen.add(k);
    return { ...r, duplicate: dup, include: dup ? false : r.include };
  });
}

/** Shape a review row into the object addItem("cme", ...) expects (id added by caller). */
export function toCmeEntry(row) {
  const entry = {
    title: row.title || "",
    category: row.category || "",
    hours: row.hours == null ? "" : String(row.hours),
    date: row.date || "",
    provider: row.provider || "",
    certificateNumber: row.certificateNumber || "",
    topics: [...(row.topics || [])],
    notes: row.notes || "",
  };
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────
// Free text (pasted transcript, or text pulled out of a PDF)
// ─────────────────────────────────────────────────────────────────────────

const DATE_TOKEN = /(\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b)/i;
const HOURS_TOKEN = /(\d+(?:\.\d+)?)\s*(?:AMA PRA Category 1 Credits?|AMA PRA Cat(?:egory)? ?1|Category 1 Credits?|credit hours?|credits?|hours?|hrs?|CME|CE|units?)\b/i;

/**
 * Line-oriented heuristic for pasted transcripts: any line with a date is
 * a row; hours are the number closest to a "credit/hour" word, or the last
 * small decimal on the line; the title is the longest remaining text run.
 * Also tries the CE Broker "date on the same line as the title" shape.
 */
export function parseTranscriptText(text, { deg } = {}) {
  // Keep column gaps (tabs or 2+ spaces) so title / provider can be told apart
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(l => l.replace(/\t+/g, "   ").replace(/ {2,}/g, "   ").trim()).filter(Boolean);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dm = line.match(DATE_TOKEN);
    if (!dm) continue;
    const date = normalizeDate(dm[1]);
    if (!date) continue;
    let rest = line.replace(dm[1], " ");
    let hours = null;
    const hm = rest.match(HOURS_TOKEN);
    if (hm) { hours = parseFloat(hm[1]); rest = rest.replace(hm[0], " "); }
    else {
      // last standalone number in the line that is a plausible credit count
      const nums = [...rest.matchAll(/(?:^|\s)(\d{1,3}(?:\.\d{1,2})?)(?=\s|$)/g)].map(m => ({ v: parseFloat(m[1]), s: m[0] }));
      const cand = nums.filter(n => n.v > 0 && n.v <= 100).pop();
      if (cand) { hours = cand.v; rest = rest.replace(cand.s, " "); }
    }
    let rawCategory = "";
    const cm = rest.match(/(AOA Category [12]-?[AB]|AMA PRA Category [12]|Category [12]|Cat(?:egory)? ?1-?[AB])/i);
    if (cm) { rawCategory = cm[1]; rest = rest.replace(cm[0], " ").replace(/\(\s*\)/g, " "); }
    // Split the remainder on 2+ spaces, tabs, or pipes: longest chunk is the title
    const chunks = rest.split(/\s{2,}|\t|\s\|\s|\s+#\s*\d+-\d+/).map(c => c.replace(/^[\s•·,;:-]+|[\s•·,;:-]+$/g, "")).filter(Boolean);
    chunks.sort((a, b) => b.length - a.length);
    const title = chunks[0] || "";
    const provider = chunks[1] && chunks[1].length > 2 && !/^\d+$/.test(chunks[1]) ? chunks[1] : "";
    if (!title && hours == null) continue;
    rows.push(finishRow(newRow({ date, title, provider, hours, rawCategory, raw: line }), deg));
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// PDF text extraction (no pdf.js in this bundle: a small reader for the
// content streams, with ToUnicode CMaps so browser-generated PDFs like the
// CE Broker CE Report come out as words rather than glyph codes)
// ─────────────────────────────────────────────────────────────────────────

function latin1(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}

async function defaultInflate(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress PDF streams.");
  const tryFmt = async (fmt) => {
    const ds = new DecompressionStream(fmt);
    const w = ds.writable.getWriter();
    w.write(bytes); w.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
  };
  try { return await tryFmt("deflate"); } catch { return tryFmt("deflate-raw"); }
}

// Read one PDF object value starting at position i in text. Returns [value, nextIndex].
// Values come back as strings of the raw source, so callers can regex them.
function readValue(t, i) {
  while (i < t.length && /\s/.test(t[i])) i++;
  if (t.startsWith("<<", i)) {
    let depth = 0, j = i;
    while (j < t.length) {
      if (t.startsWith("<<", j)) { depth++; j += 2; continue; }
      if (t.startsWith(">>", j)) { depth--; j += 2; if (depth === 0) break; continue; }
      if (t[j] === "(") { j = skipString(t, j); continue; }
      j++;
    }
    return [t.slice(i, j), j];
  }
  if (t[i] === "[") {
    let depth = 0, j = i;
    while (j < t.length) {
      if (t[j] === "[") depth++;
      else if (t[j] === "]") { depth--; if (depth === 0) { j++; break; } }
      else if (t[j] === "(") { j = skipString(t, j); continue; }
      else if (t.startsWith("<<", j)) { const [, k] = readValue(t, j); j = k; continue; }
      j++;
    }
    return [t.slice(i, j), j];
  }
  if (t[i] === "(") { const j = skipString(t, i); return [t.slice(i, j), j]; }
  if (t[i] === "<") { const j = t.indexOf(">", i); return [t.slice(i, j + 1), j + 1]; }
  if (t[i] === "/") { let j = i + 1; while (j < t.length && /[^\s/[\]<>(){}%]/.test(t[j])) j++; return [t.slice(i, j), j]; }
  // number, possibly an indirect ref "12 0 R"
  const m = /^(\d+)\s+(\d+)\s+R\b/.exec(t.slice(i, i + 40));
  if (m) return [m[0], i + m[0].length];
  let j = i; while (j < t.length && /[^\s/[\]<>(){}%]/.test(t[j])) j++;
  return [t.slice(i, j), j];
}

function skipString(t, i) { // t[i] === "("
  let depth = 0, j = i;
  while (j < t.length) {
    const c = t[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) { j++; break; } }
    j++;
  }
  return j;
}

function dictGet(dict, key) {
  if (!dict) return null;
  const re = new RegExp(`/${key}(?=[\\s\\/\\[<(]|$)`, "g");
  let m;
  while ((m = re.exec(dict))) {
    const [v] = readValue(dict, m.index + m[0].length);
    if (v !== undefined && v !== "") return v;
  }
  return null;
}

function refNum(v) { const m = /^(\d+)\s+\d+\s+R$/.exec(String(v || "").trim()); return m ? Number(m[1]) : null; }

// PDF literal string -> raw byte string (escapes resolved)
function decodeLiteral(src) {
  let out = "", i = 1;
  const end = src.length - 1;
  while (i < end) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === "n") { out += "\n"; i += 2; }
      else if (n === "r") { out += "\r"; i += 2; }
      else if (n === "t") { out += "\t"; i += 2; }
      else if (n === "b") { out += "\b"; i += 2; }
      else if (n === "f") { out += "\f"; i += 2; }
      else if (n === "\n") { i += 2; }
      else if (n === "\r") { i += src[i + 2] === "\n" ? 3 : 2; }
      else if (/[0-7]/.test(n)) {
        let oct = "", k = i + 1;
        while (k < i + 4 && /[0-7]/.test(src[k])) oct += src[k++];
        out += String.fromCharCode(parseInt(oct, 8)); i = k;
      } else { out += n; i += 2; }
    } else { out += c; i++; }
  }
  return out;
}

function decodeHex(src) {
  const hex = src.slice(1, -1).replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, "0"), 16));
  return out;
}

// ToUnicode CMap -> { map: Map<code, string>, bytes: 1|2 }
function parseCMap(text) {
  const map = new Map();
  let bytes = 0;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m;
  while ((m = cs.exec(text))) {
    const hexes = m[1].match(/<([0-9a-fA-F]+)>/g) || [];
    for (const h of hexes) bytes = Math.max(bytes, Math.ceil((h.length - 2) / 2));
  }
  const utf16 = (hex) => {
    let s = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length % 4 === 2) s += String.fromCharCode(parseInt(hex.slice(-2), 16)); // 1-byte dst
    return s;
  };
  const bc = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bc.exec(text))) {
    const toks = m[1].match(/<[0-9a-fA-F]*>/g) || [];
    for (let i = 0; i + 1 < toks.length; i += 2) {
      const src = toks[i].slice(1, -1), dst = toks[i + 1].slice(1, -1);
      if (!bytes) bytes = Math.ceil(src.length / 2);
      map.set(parseInt(src, 16), utf16(dst));
    }
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = br.exec(text))) {
    const body = m[1];
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]*>)/g;
    let r;
    while ((r = re.exec(body))) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
      if (!bytes) bytes = Math.ceil(r[1].length / 2);
      if (hi - lo > 65535) continue;
      if (r[3][0] === "[") {
        const dsts = r[3].match(/<([0-9a-fA-F]*)>/g) || [];
        for (let k = 0; k < dsts.length && lo + k <= hi; k++) map.set(lo + k, utf16(dsts[k].slice(1, -1)));
      } else {
        const dst = r[3].slice(1, -1);
        const base = utf16(dst);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return { map, bytes: bytes || 1 };
}

// CIDFont /W array: [ c [w1 w2 ...]  c1 c2 w ... ] -> Map(code -> width/1000)
function parseCidWidths(txt) {
  const map = new Map();
  if (!txt) return map;
  const toks = txt.replace(/[[\]]/g, m => ` ${m} `).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const num = (t) => /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
  while (i < toks.length) {
    const c = num(toks[i]);
    if (c == null) { i++; continue; }
    if (toks[i + 1] === "[") {
      let j = i + 2, code = c;
      while (j < toks.length && toks[j] !== "]") { const w = num(toks[j]); if (w != null) map.set(code++, w); j++; }
      i = j + 1;
    } else {
      const c2 = num(toks[i + 1]), w = num(toks[i + 2]);
      if (c2 != null && w != null && c2 - c < 65536) { for (let k = c; k <= c2; k++) map.set(k, w); }
      i += 3;
    }
  }
  return map;
}

// 3x2 affine helpers: [a b c d e f]
const I = [1, 0, 0, 1, 0, 0];
function mul(m, n) { // m then n
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

// Tokenise a content stream into operands + operators and emit text runs.
function runsFromContent(content, fonts) {
  const runs = [];
  let ctm = I; const gsStack = [];
  let tm = I, tlm = I, TL = 0, size = 0, font = null, Tz = 1;
  const ops = [];
  const flushOp = (op) => {
    const n = ops.map(Number);
    switch (op) {
      case "q": gsStack.push(ctm); break;
      case "Q": ctm = gsStack.pop() || I; break;
      case "cm": if (ops.length >= 6) ctm = mul(n.slice(-6), ctm); break;
      case "BT": tm = tlm = I; break;
      case "Tf": font = fonts[String(ops[ops.length - 2]).slice(1)] || null; size = n[n.length - 1] || 0; break;
      case "TL": TL = n[n.length - 1] || 0; break;
      case "Tz": Tz = (n[n.length - 1] || 100) / 100; break;
      case "Td": tlm = mul([1, 0, 0, 1, n[n.length - 2] || 0, n[n.length - 1] || 0], tlm); tm = tlm; break;
      case "TD": TL = -(n[n.length - 1] || 0); tlm = mul([1, 0, 0, 1, n[n.length - 2] || 0, n[n.length - 1] || 0], tlm); tm = tlm; break;
      case "Tm": if (ops.length >= 6) { tlm = n.slice(-6); tm = tlm; } break;
      case "T*": tlm = mul([1, 0, 0, 1, 0, -TL], tlm); tm = tlm; break;
      case "Tj": case "'": case '"': {
        if (op !== "Tj") { tlm = mul([1, 0, 0, 1, 0, -TL], tlm); tm = tlm; }
        const s = ops[ops.length - 1];
        if (typeof s === "object" && s.str != null) show(s.str);
        break;
      }
      case "TJ": {
        const arr = ops[ops.length - 1];
        if (Array.isArray(arr)) {
          let text = "", w = 0;
          for (const el of arr) {
            if (typeof el === "object" && el.str != null) { text += decodeStr(el.str); w += rawWidth(el.str); }
            else if (typeof el === "number") { w -= el / 1000; if (el < -180) text += " "; }
          }
          emit(text, w);
        }
        break;
      }
      default: break;
    }
    ops.length = 0;
  };
  const decodeStr = (raw) => {
    if (font && font.map) {
      let out = "";
      const b = font.bytes || 1;
      for (let i = 0; i < raw.length; i += b) {
        let code = 0;
        for (let k = 0; k < b; k++) code = (code << 8) | (raw.charCodeAt(i + k) || 0);
        const ch = font.map.get(code);
        out += ch != null ? ch : (b === 1 ? raw[i] : "\ufffd");
      }
      return out;
    }
    if (font && font.twoByte) return raw.replace(/[\s\S]{2}/g, () => "\ufffd");
    return raw;
  };
  // Width of a raw byte string in text-space units (font size 1)
  const rawWidth = (raw) => {
    const b = font?.bytes || 1;
    let w = 0;
    for (let i = 0; i < raw.length; i += b) {
      let code = 0;
      for (let k = 0; k < b; k++) code = (code << 8) | (raw.charCodeAt(i + k) || 0);
      const gw = font?.widths?.get(code);
      w += (gw != null ? gw : (font?.dw || 500)) / 1000;
    }
    return w;
  };
  const show = (raw) => emit(decodeStr(raw), rawWidth(raw));
  const emit = (text, w1) => {
    if (!text) return;
    const M = mul(tm, ctm);
    const scale = Math.hypot(M[0], M[1]) || 1;
    const fs = size * scale;
    const adv = (w1 != null ? w1 : text.length * 0.5) * size * Tz;
    runs.push({ x: M[4], y: M[5], text, size: fs, w: adv * scale });
    tm = mul([1, 0, 0, 1, adv, 0], tm);
  };

  const t = content;
  let i = 0;
  const L = t.length;
  while (i < L) {
    const c = t[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0") { i++; continue; }
    if (c === "%") { while (i < L && t[i] !== "\n" && t[i] !== "\r") i++; continue; }
    if (c === "(") { const j = skipString(t, i); ops.push({ str: decodeLiteral(t.slice(i, j)) }); i = j; continue; }
    if (c === "<") {
      if (t[i + 1] === "<") { const [, j] = readValue(t, i); ops.push({ dict: true }); i = j; continue; }
      const j = t.indexOf(">", i); ops.push({ str: decodeHex(t.slice(i, j + 1)) }); i = j + 1; continue;
    }
    if (c === "[") {
      // array of strings/numbers (TJ)
      const arr = []; let j = i + 1;
      while (j < L && t[j] !== "]") {
        const d = t[j];
        if (d === "(") { const k = skipString(t, j); arr.push({ str: decodeLiteral(t.slice(j, k)) }); j = k; }
        else if (d === "<") { const k = t.indexOf(">", j); arr.push({ str: decodeHex(t.slice(j, k + 1)) }); j = k + 1; }
        else if (/[\d.+-]/.test(d)) { let k = j; while (k < L && /[\d.+-]/.test(t[k])) k++; arr.push(parseFloat(t.slice(j, k))); j = k; }
        else j++;
      }
      ops.push(arr); i = j + 1; continue;
    }
    if (c === "/") { let j = i + 1; while (j < L && /[^\s/[\]<>(){}%]/.test(t[j])) j++; ops.push(t.slice(i, j)); i = j; continue; }
    if (/[\d.+-]/.test(c)) { let j = i; while (j < L && /[\d.+-]/.test(t[j])) j++; ops.push(parseFloat(t.slice(i, j))); i = j; continue; }
    if (c === "]" || c === "{" || c === "}") { i++; continue; }
    // operator
    let j = i; while (j < L && /[A-Za-z'"*]/.test(t[j])) j++;
    if (j === i) { i++; continue; }
    const op = t.slice(i, j); i = j;
    if (op === "BI") { const k = t.indexOf("EI", i); i = k === -1 ? L : k + 2; ops.length = 0; continue; }
    flushOp(op);
  }
  return runs;
}

/** Group positioned runs into lines (top to bottom, left to right). */
export function linesFromRuns(runs) {
  const sorted = [...runs].filter(r => r.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const tol = Math.max(2, (r.size || 10) * 0.45);
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && Math.abs(line.y - r.y) <= tol) { line.runs.push(r); }
    else lines.push({ y: r.y, runs: [r] });
  }
  for (const ln of lines) {
    ln.runs.sort((a, b) => a.x - b.x);
    let text = "";
    let prev = null;
    for (const r of ln.runs) {
      if (prev) {
        const fs = prev.size || 10;
        const prevEnd = prev.x + (prev.w != null ? prev.w : prev.text.length * 0.5 * fs);
        const gap = r.x - prevEnd;
        if (gap > fs * 1.0) text += "\t";
        else if (gap > fs * 0.12 && !text.endsWith(" ") && !r.text.startsWith(" ")) text += " ";
      }
      text += r.text;
      prev = r;
    }
    // Single spaces inside a cell, three spaces between columns
    ln.text = text.replace(/[ \u00a0]+/g, " ").replace(/\s*\t\s*/g, "   ").trim();
    ln.x = ln.runs[0].x;
  }
  return lines;
}

/**
 * Extract text runs from a PDF. Returns { pages: [{ runs, lines }], text, encrypted }.
 * `inflate(Uint8Array) -> Promise<Uint8Array>` may be supplied (node tests use zlib).
 */
export async function extractPdfText(input, opts = {}) {
  const inflate = opts.inflate || defaultInflate;
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const src = latin1(u8);
  if (!/%PDF-/.test(src.slice(0, 1024))) throw new Error("Not a PDF file.");
  if (/\/Encrypt\s/.test(src)) throw new Error("This PDF is password protected. Export it again without a password, or paste the text.");

  // 1. Index every "N 0 obj" body, expanding object streams.
  const objs = new Map(); // num -> { dict, streamStart, streamEnd }
  const re = /(?:^|[\s>\]}])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const streamsToExpand = [];
  while ((m = re.exec(src))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = src.indexOf("endobj", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    const sIdx = body.search(/stream(\r\n|\n|\r)/);
    let dict = body, stream = null;
    if (sIdx !== -1) {
      dict = body.slice(0, sIdx);
      const dataStart = start + sIdx + body.slice(sIdx).match(/stream(\r\n|\n|\r)/)[0].length;
      let dataEnd = src.indexOf("endstream", dataStart);
      if (dataEnd === -1) dataEnd = src.length;
      // trailing EOL before endstream is not data
      let de = dataEnd; if (src[de - 1] === "\n") de--; if (src[de - 1] === "\r") de--;
      stream = [dataStart, de];
      re.lastIndex = dataEnd; // do not scan binary for "obj"
    }
    objs.set(num, { dict: dict.trim(), stream });
    if (stream && /\/Type\s*\/ObjStm/.test(dict)) streamsToExpand.push(num);
  }

  const streamBytes = async (o) => {
    if (!o?.stream) return null;
    let bytes = u8.subarray(o.stream[0], o.stream[1]);
    const filter = dictGet(o.dict, "Filter") || "";
    if (/FlateDecode/.test(filter)) {
      if (/ASCII85|ASCIIHex|LZW|RunLength|DCT|JPX|CCITT/.test(filter)) return null;
      try { bytes = await inflate(bytes); } catch { return null; }
    } else if (filter && filter !== "[]") return null;
    return bytes;
  };
  const streamText = async (o) => { const b = await streamBytes(o); return b ? latin1(b) : null; };

  for (const num of streamsToExpand) {
    const o = objs.get(num);
    const text = await streamText(o);
    if (!text) continue;
    const N = Number(dictGet(o.dict, "N")) || 0;
    const First = Number(dictGet(o.dict, "First")) || 0;
    const header = text.slice(0, First).trim().split(/\s+/).map(Number);
    for (let k = 0; k < N; k++) {
      const onum = header[2 * k], off = header[2 * k + 1];
      const next = k + 1 < N ? header[2 * k + 3] : undefined;
      if (onum == null || off == null) continue;
      const body = text.slice(First + off, next != null ? First + next : undefined).trim();
      if (!objs.has(onum)) objs.set(onum, { dict: body, stream: null });
    }
  }

  const resolve = (v) => { const n = refNum(v); return n != null ? objs.get(n) : null; };
  const resolveDict = (v) => { if (v == null) return null; if (String(v).trim().startsWith("<<")) return String(v); return resolve(v)?.dict || null; };

  // 2. Fonts: name -> decoder, cached per font object number.
  const fontCache = new Map();
  const loadFont = async (ref) => {
    const n = refNum(ref);
    const key = n != null ? n : ref;
    if (fontCache.has(key)) return fontCache.get(key);
    const dict = resolveDict(ref);
    let f = { map: null, bytes: 1, twoByte: false, widths: null, dw: 500 };
    if (dict) {
      const enc = dictGet(dict, "Encoding") || "";
      const subtype = dictGet(dict, "Subtype") || "";
      f.twoByte = /Identity|Type0/.test(enc + subtype);
      const tu = dictGet(dict, "ToUnicode");
      const tuObj = resolve(tu);
      if (tuObj) {
        const cm = await streamText(tuObj);
        if (cm && /bf(char|range)/.test(cm)) {
          const parsed = parseCMap(cm);
          f.map = parsed.map;
          f.bytes = f.twoByte ? Math.max(2, parsed.bytes) : parsed.bytes;
        }
      }
      // Glyph widths, so runs get a real extent (spaces vs kerning, column gaps)
      try {
        if (/Type0/.test(subtype)) {
          const desc = dictGet(dict, "DescendantFonts") || "";
          const dref = (desc.match(/\d+\s+\d+\s+R/) || [])[0];
          const cid = dref ? resolveDict(dref) : (desc.startsWith("[") ? (readValue(desc, 1)[0]) : null);
          if (cid) {
            f.dw = Number(dictGet(cid, "DW")) || 1000;
            const W = dictGet(cid, "W");
            const Wtxt = W && !W.startsWith("[") ? (resolve(W)?.dict || "") : (W || "");
            f.widths = parseCidWidths(Wtxt);
          }
        } else {
          const fc = Number(dictGet(dict, "FirstChar")) || 0;
          const Wv = dictGet(dict, "Widths");
          const Wtxt = Wv && !Wv.startsWith("[") ? (resolve(Wv)?.dict || "") : (Wv || "");
          const nums = (Wtxt.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
          if (nums.length) { f.widths = new Map(); nums.forEach((w, i) => f.widths.set(fc + i, w)); f.dw = 0; }
          else f.dw = 500;
        }
      } catch { /* widths stay approximate */ }
    }
    fontCache.set(key, f);
    return f;
  };
  const fontsFromResources = async (resVal) => {
    const res = resolveDict(resVal);
    const out = {};
    if (!res) return out;
    const fontDict = resolveDict(dictGet(res, "Font"));
    if (!fontDict) return out;
    const inner = fontDict.slice(2, -2);
    const fre = /\/([^\s/[\]<>(){}%]+)\s+(\d+\s+\d+\s+R|<<)/g;
    let fm;
    while ((fm = fre.exec(inner))) {
      if (fm[2] === "<<") { const [v] = readValue(inner, fm.index + fm[0].length - 2); out[fm[1]] = await loadFont(v); fre.lastIndex = fm.index + fm[0].length - 2 + v.length; }
      else out[fm[1]] = await loadFont(fm[2]);
    }
    return out;
  };

  // 3. Page order from the page tree; fall back to file order.
  let pageNums = [];
  const catalog = [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  const walk = (ref, depth = 0) => {
    if (depth > 60) return;
    const n = refNum(ref); const o = n != null ? objs.get(n) : null;
    if (!o) return;
    if (/\/Type\s*\/Pages/.test(o.dict)) {
      const kids = dictGet(o.dict, "Kids") || "";
      for (const k of kids.match(/\d+\s+\d+\s+R/g) || []) walk(k, depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) pageNums.push(n);
  };
  if (catalog) walk(dictGet(catalog[1].dict, "Pages"));
  if (!pageNums.length) pageNums = [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dict)).map(([n]) => n);

  const pages = [];
  for (const pn of pageNums) {
    const page = objs.get(pn);
    // Resources may be inherited from the parent Pages node
    let resVal = dictGet(page.dict, "Resources");
    let parent = dictGet(page.dict, "Parent"), hops = 0;
    while (!resVal && parent && hops++ < 20) { const po = resolve(parent); if (!po) break; resVal = dictGet(po.dict, "Resources"); parent = dictGet(po.dict, "Parent"); }
    const fonts = await fontsFromResources(resVal);
    const contents = dictGet(page.dict, "Contents") || "";
    const refs = contents.match(/\d+\s+\d+\s+R/g) || [];
    let content = "";
    for (const r of refs) { const t = await streamText(resolve(r)); if (t) content += t + "\n"; }
    const runs = content ? runsFromContent(content, fonts) : [];
    pages.push({ runs, lines: linesFromRuns(runs) });
  }
  const text = pages.map(p => p.lines.map(l => l.text).join("\n")).join("\n\n");
  const bad = (text.match(/�/g) || []).length;
  return { pages, text, unreadable: text.replace(/\s/g, "").length > 0 && bad / Math.max(1, text.replace(/\s/g, "").length) > 0.3 };
}

// ─────────────────────────────────────────────────────────────────────────
// CE Broker "CE Report" PDF layout
// ─────────────────────────────────────────────────────────────────────────

const CEB_HEADERS = ["Course", "Completed", "Provider", "Reported by", "Subject areas", "Credits"];

/** True when the extracted text looks like a CE Broker CE Report. */
export function looksLikeCeBroker(text) {
  const t = String(text || "");
  return /CE Report/i.test(t) && /CE Summary/i.test(t) && /Subject areas/i.test(t) && /Credits/.test(t) && /earned/i.test(t);
}

/**
 * Parse pages of positioned runs (from extractPdfText) laid out like the
 * CE Broker CE Report. Columns come from the header row (the header words
 * may wrap onto two lines, so each header word is matched on its own); a
 * row starts at every M/D/YYYY line in the Completed column. Cell text is
 * rebuilt line by line so kerned runs ("3/1" + "1/2024") rejoin correctly.
 */
export function parseCeBrokerPages(pages, { deg } = {}) {
  const rows = [];
  let cols = null; // [{name, x}] sorted by x, reused for continuation pages without a header
  const isNumberTag = (s) => /^#\s*\d+-\d+/.test(s);
  const isFooter = (s) => /^page \d+|^created:|^ce ?broker$/i.test(s);
  const colText = (runs) => linesFromRuns(runs).map(l => l.text);
  for (const page of pages) {
    const runs = page.runs.filter(r => r.text.trim());
    const hdr = [];
    for (const name of CEB_HEADERS) {
      const cands = runs.filter(r => r.text.trim().toLowerCase().startsWith(name.toLowerCase()));
      if (cands.length) hdr.push({ name, run: cands.sort((a, b) => b.y - a.y)[0] });
    }
    let headerY = null;
    if (hdr.length >= 4) {
      const ys = hdr.map(h => h.run.y).sort((a, b) => a - b);
      const mid = ys[Math.floor(ys.length / 2)];
      const near = hdr.filter(h => Math.abs(h.run.y - mid) < 30); // wrapped header words sit one line above/below
      if (near.length >= 4) {
        cols = near.map(h => ({ name: h.name, x: h.run.x })).sort((a, b) => a.x - b.x);
        headerY = Math.min(...near.map(h => h.run.y));
      }
    }
    if (!cols) continue;
    const colOf = (x) => { let c = cols[0]; for (const k of cols) if (x >= k.x - 6) c = k; return c.name; };
    // Body = everything below the lowest header word (minus the wrapped second header line)
    let body = runs.filter(r => headerY == null || r.y < headerY - 2);
    body = body.filter(r => !(headerY != null && r.y > headerY - 16 && /^(covered|earned)$/i.test(r.text.trim())));
    const dateLines = linesFromRuns(body.filter(r => colOf(r.x) === "Completed"))
      .filter(l => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(l.text.trim()))
      .sort((a, b) => b.y - a.y);
    for (let i = 0; i < dateLines.length; i++) {
      const top = dateLines[i].y + 4;
      const bottom = i + 1 < dateLines.length ? dateLines[i + 1].y + 4 : -Infinity;
      const inRow = body.filter(r => r.y <= top && r.y > bottom);
      const byCol = {};
      for (const r of inRow) (byCol[colOf(r.x)] ||= []).push(r);
      const courseLines = colText(byCol.Course || []).filter(s => !isFooter(s));
      const providerLines = colText(byCol.Provider || []);
      const subjectLines = colText(byCol["Subject areas"] || []);
      const creditLines = colText(byCol.Credits || []);
      const reportedBy = colText(byCol["Reported by"] || []).join(" ");
      const title = courseLines.filter(s => !isNumberTag(s)).join(" ").replace(/\s+/g, " ").trim();
      const courseNo = courseLines.find(isNumberTag);
      const provider = providerLines.filter(s => !isNumberTag(s)).join(" ").replace(/\s+/g, " ").trim();
      const providerNo = providerLines.find(isNumberTag);
      // Subjects: bullets start a new subject; a line without a bullet continues the previous one
      const subjects = [];
      for (const s of subjectLines) {
        const t = s.replace(/^[\u2022\u00b7\-\s]+/, "").trim();
        if (!t) continue;
        if (/^[\u2022\u00b7]/.test(s.trim()) || !subjects.length) subjects.push(t); else subjects[subjects.length - 1] += ` ${t}`;
      }
      const credits = creditLines.map(s => parseFloat(s)).filter(n => isFinite(n));
      const hours = credits.length ? credits[credits.length - 1] : null; // the bold total prints last
      const noteBits = [];
      if (courseNo) noteBits.push(`CE Broker course ${courseNo.replace(/^#\s*/, "#")}`);
      if (providerNo) noteBits.push(`provider ${providerNo.replace(/^#\s*/, "#")}`);
      if (reportedBy) noteBits.push(`reported by ${reportedBy}`);
      if (subjects.length) noteBits.push(`subject: ${subjects.join(", ")}`);
      rows.push(finishRow(newRow({
        date: normalizeDate(dateLines[i].text.trim()),
        title,
        provider,
        hours,
        rawCategory: "", // the CE Report does not state an AMA category
        rawSubjects: subjects.join(" "),
        notes: noteBits.join("; "),
        raw: linesFromRuns(inRow).map(l => l.text).join(" | "),
      }), deg));
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// ACCME CME Passport "Accredited Continuing Education Transcript"
// ─────────────────────────────────────────────────────────────────────────

/** True when the text looks like a CME Passport transcript. */
export function looksLikeCmePassport(text) {
  const t = String(text || "");
  return /Accredited Continuing Education Transcript/i.test(t) && /Completion Date/i.test(t) && /Credits Earned/i.test(t);
}

// "7 AMA PRA Category 1 Credits", "5 ABO Points", "7 Lifelong Learning"
const CREDIT_CHUNK = /^(\d+(?:\.\d+)?)\s+(AMA PRA[\s\S]*|AOA[\s\S]*|[A-Za-z]+\s+(?:MOC\/CC\s+)?Points?|Lifelong Learning[\s\S]*|Self.?Assessment[\s\S]*|Medical Knowledge[\s\S]*|Patient Safety[\s\S]*|Practice Assessment[\s\S]*|Improvement in[\s\S]*|Performance in Practice[\s\S]*|Accredited CME[\s\S]*|Category [12][\s\S]*|Credits?\b[\s\S]*|MOC[\s\S]*)$/i;
const CMEP_SKIP = /^(official transcript|published\b|\d+ of \d+$|\d{3} michigan ave|the activities and credit below|transcript dates|completion date\s)/i;

/**
 * Line-oriented parser for the CME Passport transcript text (from
 * extractPdfText or a paste). A row starts at a line that begins with
 * M/D/YYYY. Columns are separated by 2+ spaces or a tab. Within a row, a
 * chunk that starts with a number followed by a credit word is a credit
 * line: AMA PRA credits give the hours; board points and MOC credit types go
 * to notes (and stand in for hours when the row has no AMA PRA line). Text
 * chunks after the title are the provider, with earlier extras treated as a
 * wrapped title.
 */
export function parseCmePassportText(text, { deg } = {}) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  const rows = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const extra = cur.textChunks;
    let title = cur.title;
    let provider = "";
    if (extra.length) { provider = extra[extra.length - 1]; if (extra.length > 1) title = [title, ...extra.slice(0, -1)].join(" "); }
    let hours = null, rawCategory = "";
    const notes = [];
    for (const c of cur.creditChunks) {
      const m = c.match(/^(\d+(?:\.\d+)?)\s+(.*)$/);
      if (!m) continue;
      const n = parseFloat(m[1]);
      const what = m[2].replace(/™|\(tm\)/gi, "").trim();
      if (/AMA PRA Category 1|AOA Category|Category 1/i.test(what) && hours == null) { hours = n; rawCategory = what; }
      else if (/AMA PRA Category 2/i.test(what) && hours == null) { hours = n; rawCategory = what; }
      else notes.push(`${m[1]} ${what}`);
    }
    if (hours == null && notes.length) {
      // MOC-only line: board points are NOT CME hours (the state total sums
      // every category), so hours stay empty; the credit type names the
      // kind and the points ride along in notes for the reviewer.
      const type = notes.find(n => !/points?$/i.test(n));
      rawCategory = type ? type.replace(/^[\d.]+\s+/, "") : "MOC";
    }
    rows.push(finishRow(newRow({
      date: cur.date, title, provider, hours, rawCategory,
      notes: notes.length ? `CME Passport: ${notes.join(", ")}` : "",
      raw: cur.lines.join(" | "),
    }), deg));
    cur = null;
  };
  let started = false;
  for (const line of lines) {
    if (/completion date/i.test(line) && /credits earned/i.test(line)) { started = true; continue; }
    if (!started) continue;
    if (CMEP_SKIP.test(line)) { if (/^official transcript/i.test(line)) flush(); continue; }
    const dm = line.match(/^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s{2,}|\t|$)/);
    const chunks = line.split(/ {2,}|\t/).map(c => c.trim()).filter(Boolean);
    if (dm) {
      flush();
      const date = normalizeDate(dm[1]);
      if (!date) continue;
      cur = { date, title: "", textChunks: [], creditChunks: [], lines: [line] };
      for (const c of chunks.slice(1)) {
        if (CREDIT_CHUNK.test(c)) cur.creditChunks.push(c);
        else if (!cur.title) cur.title = c;
        else cur.textChunks.push(c);
      }
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    for (const c of chunks) {
      if (CREDIT_CHUNK.test(c)) cur.creditChunks.push(c);
      else cur.textChunks.push(c);
    }
  }
  flush();
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Browser helpers (file reading, Gemini structuring)
// ─────────────────────────────────────────────────────────────────────────

export const IMPORT_ACCEPT = [
  ".csv", "text/csv", ".tsv", ".txt", "text/plain",
  ".xls", "application/vnd.ms-excel",
  ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf", "application/pdf",
].join(",");

/**
 * Read a picked file into a neutral shape:
 *  { kind: "table", table }        CSV / TSV / XLS / XLSX
 *  { kind: "text", text }          TXT
 *  { kind: "pdf", pages, text, unreadable, dataUrl }
 */
export async function readImportFile(file) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (name.endsWith(".pdf") || type === "application/pdf") {
    const buf = await file.arrayBuffer();
    const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = e => res(e.target.result); fr.onerror = rej; fr.readAsDataURL(file); });
    let ex = { pages: [], text: "", unreadable: true };
    try { ex = await extractPdfText(buf); } catch (err) { ex.error = err.message; }
    return { kind: "pdf", ...ex, dataUrl, size: file.size };
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || type.includes("spreadsheetml") || type === "application/vnd.ms-excel") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
    const sheets = wb.SheetNames.map(n => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" });
      const table = rows.filter(r => r.some(v => String(v).trim() !== "")).map(r => r.map(v => String(v ?? "").trim()));
      return { name: n, table };
    });
    const best = pickSheet(sheets);
    return { kind: "table", table: best?.table || [], sheet: best?.name || "", sheetCount: sheets.filter(s => s.table.length).length };
  }
  const text = await file.text();
  if (name.endsWith(".csv") || name.endsWith(".tsv") || type === "text/csv" || /[\t;|]/.test(text.split("\n")[0] || "")) {
    return { kind: "table", table: parseCSV(text) };
  }
  return { kind: "text", text };
}

const GEMINI_MODEL = "gemini-2.5-flash";

const TRANSCRIPT_PROMPT = (deg) => `You read continuing medical education transcripts and course histories for a physician (${deg === "DO" ? "DO" : "MD"}). Return ONLY a JSON array, no markdown. One object per completed activity:
{"date":"YYYY-MM-DD","title":"...","provider":"...","hours":number,"creditType":"...","subjects":"...","certificateNumber":"..."}
Rules: date is the completion date. hours is the credit total for that activity (a number). creditType is the credit designation as printed (for example "AMA PRA Category 1", "AOA Category 1-A", "MOC Part II"); use "" if the document does not say. subjects is any subject-area or topic text printed for the row (comma separated) or "". certificateNumber is a certificate or confirmation number if printed, else "" (a CE Broker course tracking number like 20-123456 is NOT a certificate number; leave it out). Do not invent rows, dates, hours, or numbers that are not printed. Skip summary and total lines.`;

/**
 * Ask Gemini to structure a transcript. Pass { text } (preferred, cheaper)
 * or { pdfDataUrl } when local text extraction produced nothing readable.
 * Returns review rows.
 */
export async function structureTranscriptWithAI({ text, pdfDataUrl }, deg, apiKey) {
  if (!apiKey) throw new Error("No Gemini API key in Settings.");
  const parts = [];
  if (text && text.trim()) parts.push({ text: `TRANSCRIPT TEXT:\n\n${text.slice(0, 120000)}` });
  else if (pdfDataUrl) parts.push({ inlineData: { mimeType: "application/pdf", data: pdfDataUrl.split(",")[1] } });
  else throw new Error("Nothing to send.");
  parts.push({ text: "List every completed activity as JSON. Return only the JSON array." });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TRANSCRIPT_PROMPT(deg) }] },
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json" },
    }),
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error("Invalid Gemini API key. Check Settings.");
    if (response.status === 429) throw new Error("Rate limited by the AI service. Try again in a moment.");
    throw new Error("The AI service could not read this transcript.");
  }
  const json = await response.json();
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return rowsFromAI(raw, deg);
}

/** Turn the model's JSON text into review rows (exported so the shape is testable). */
export function rowsFromAI(raw, deg) {
  const clean = String(raw || "").replace(/```json|```/g, "").trim();
  let arr;
  try { arr = JSON.parse(clean); } catch { throw new Error("The AI reply was not valid JSON."); }
  if (!Array.isArray(arr)) arr = arr?.rows || arr?.activities || [];
  return arr.filter(o => o && typeof o === "object").map(o => finishRow(newRow({
    date: normalizeDate(o.date),
    title: String(o.title || "").trim(),
    provider: String(o.provider || "").trim(),
    hours: parseHours(o.hours),
    certificateNumber: String(o.certificateNumber || "").trim(),
    rawCategory: String(o.creditType || "").trim(),
    rawSubjects: String(o.subjects || "").trim(),
    raw: o,
  }), deg));
}
