/**
 * The client half of the public-record lookup: what to show, what may be
 * ticked, and what a tick actually writes.
 *
 * supabase/functions/public-record returns proposals and never writes. This
 * module turns that envelope into a review screen's model and, once the
 * physician has ticked rows, into the exact calls the app already uses
 * (updateSettings for the profile, addItem for every section). Pure, so
 * scripts/public-record-review.test.mjs can run it in plain node against the
 * envelope fixture captured live from the registers.
 *
 * Two rules from the function survive into here and must not be softened:
 *
 *   confidence "record"  the register states this. May start ticked.
 *   confidence "lead"    an inference the physician has to confirm. A CMS
 *                        facility affiliation is claims activity, and a
 *                        PubMed hit is a name match. Never ticked by default,
 *                        and every one carries the sentence that says why.
 *
 * Nothing here saves. buildSavePlan only describes the writes; the component
 * makes them, one accepted item at a time.
 *
 * The matching half (dedupeKey, markAlreadyOnFile) used to sit in the
 * function's normalize.ts, where it could never run: the function is not
 * given the physician's records and must not be. It lives here now, next to
 * the only data it can compare against, and is the single copy.
 */

import { licenseKey } from "./npiImport.js";

/** Values these registers use to mean "nothing here". Mirrors normalize.ts;
 * a browser module cannot import a Deno function file. */
const BLANKS = new Set(["", "--", "N/A", "NA", "NONE", "UNKNOWN", "NOT AVAILABLE"]);

export function clean(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return BLANKS.has(s.toUpperCase()) ? "" : s;
}

const norm = (v) => clean(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
const arr = (v) => (Array.isArray(v) ? v : []);

// ── Matching against what is already on file ────────────────────────────────

/**
 * The identity of a record inside one section. Two records with the same key
 * are the same thing however it was typed. Sections whose records have no
 * natural key return "" and are never auto-matched.
 */
export function dedupeKey(section, item) {
  if (section === "licenses") {
    const k = licenseKey(item?.state, clean(item?.licenseNumber));
    return k === "|" ? "" : `licenses:${k}`;
  }
  if (section === "privileges") {
    const f = norm(item?.facility || item?.name);
    return f ? `privileges:${f}` : "";
  }
  if (section === "workHistory") {
    const e = norm(item?.employer);
    return e ? `workHistory:${e}` : "";
  }
  if (section === "publications") {
    const pmid = norm(item?.pmid);
    if (pmid) return `publications:pmid:${pmid}`;
    const doi = norm(item?.doi);
    if (doi) return `publications:doi:${doi}`;
    const cite = norm(item?.citation || item?.name).slice(0, 60);
    return cite ? `publications:cite:${cite}` : "";
  }
  if (section === "memberships") {
    const o = norm(item?.organization);
    return o ? `memberships:${o}` : "";
  }
  if (section === "education") {
    const i = norm(item?.institution);
    if (i) return `education:${i}`;
    // Medicare files the school as "OTHER", so the medical school finding
    // carries a degree type and no institution. A physician holds one MD or
    // one DO, so the degree alone identifies the row already on file.
    const t = norm(item?.type);
    return t ? `education:type:${t}` : "";
  }
  return "";
}

/**
 * Every key a record already on file answers to. An education row typed with
 * a school also answers to its degree, so a finding that has the degree and
 * no school still recognizes it.
 */
function dedupeKeysOnFile(section, item) {
  const keys = [dedupeKey(section, item)];
  if (section === "education") {
    const t = norm(item?.type);
    if (t) keys.push(`education:type:${t}`);
  }
  return keys.filter(Boolean);
}

/**
 * Flag findings the physician already has, and drop nothing: an item on file
 * is shown as already on file rather than proposed a second time.
 * `existing` is the app's data object; `settings` is data.settings.
 */
export function markAlreadyOnFile(findings, existing = {}, settings = {}) {
  const have = new Set();
  for (const [section, items] of Object.entries(existing || {})) {
    for (const item of arr(items)) {
      for (const k of dedupeKeysOnFile(section, item)) have.add(k);
    }
  }
  return arr(findings).map((f) => {
    let already = false;
    if (f.section === "settings") {
      const keys = Object.keys(f.fields || {});
      already = keys.length > 0 && keys.every((k) =>
        clean(settings?.[k]).toUpperCase() === clean(f.fields[k]).toUpperCase());
    } else {
      const k = dedupeKey(f.section, f.fields);
      already = !!k && have.has(k);
    }
    return { ...f, alreadyOnFile: already };
  });
}

// ── Grouping ────────────────────────────────────────────────────────────────

export const GROUP_ORDER = [
  "settings", "licenses", "education", "workHistory", "privileges", "publications", "memberships",
];

export const GROUP_TITLES = {
  settings: "Profile",
  licenses: "Licenses",
  education: "Education",
  workHistory: "Work history",
  privileges: "Privileges",
  publications: "Publications",
  memberships: "Memberships",
};

/** Findings in the order the screen reads them: facts before leads. */
export function sortFindings(findings) {
  return [...arr(findings)].sort((a, b) => {
    const s = GROUP_ORDER.indexOf(a.section) - GROUP_ORDER.indexOf(b.section);
    if (s !== 0) return s;
    if (a.confidence !== b.confidence) return a.confidence === "record" ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** One entry per section that has findings, in GROUP_ORDER. */
export function groupFindings(findings) {
  const out = [];
  for (const section of GROUP_ORDER) {
    const items = arr(findings).filter((f) => f.section === section);
    if (items.length) out.push({ section, title: GROUP_TITLES[section] || section, findings: items });
  }
  // A section the function grows later still shows up rather than vanishing.
  for (const f of arr(findings)) {
    if (GROUP_ORDER.includes(f.section)) continue;
    const hit = out.find((g) => g.section === f.section);
    if (hit) hit.findings.push(f);
    else out.push({ section: f.section, title: GROUP_TITLES[f.section] || f.section, findings: [f] });
  }
  return out;
}

// ── Selection ───────────────────────────────────────────────────────────────

/** A row the physician can tick. Already on file is not one of them. */
export function isSelectable(finding) {
  return !!finding && !finding.alreadyOnFile;
}

/**
 * What starts ticked. A register's own statement may; an inference never
 * does, because accepting a lead without reading it is the whole failure
 * this screen exists to prevent.
 */
export function defaultSelectedIds(findings) {
  return arr(findings)
    .filter((f) => isSelectable(f) && f.confidence === "record")
    .map((f) => f.id);
}

/** The one sentence that says why a lead is a lead. */
export function leadNote(finding) {
  if (!finding || finding.confidence !== "lead") return "";
  switch (finding.kind) {
    case "facilityAffiliation":
      return "Medicare claims show you working here. Confirm before treating it as a privilege.";
    case "publication":
      return "Matched by name; check it is yours.";
    case "practiceOrganization":
      return "Medicare claims show you billing here. Confirm your title and dates.";
    default:
      return "Confirm this before you rely on it.";
  }
}

/**
 * The line a physician judges the row by, when the label alone is not enough
 * to tell whether it is theirs.
 *
 * A paper matched on a surname and an initial is the case that matters: the
 * title says nothing about whose it is, and the co-authors, the journal and
 * the year are what settle it. The function already assembled exactly that
 * into the citation it would write onto the CV, so that is the line shown.
 *
 * A hospital or an employer carries its city and state in the label already,
 * so there is nothing to add.
 */
export function evidenceLine(finding) {
  if (finding?.section === "publications") return clean(finding?.fields?.citation);
  return "";
}

const NEED_LABELS = {
  expirationDate: "expiration date",
  graduationDate: "graduation date",
  appointmentDate: "appointment date",
  startDate: "start date",
  endDate: "end date",
  institution: "school",
  type: "type",
  position: "title",
  name: "name",
};

/** "expiration date and type", for the line that says what to add after. */
export function needsLabel(needs) {
  const words = arr(needs).map((n) => NEED_LABELS[n] || String(n)).filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function countSelected(findings, selectedIds) {
  const sel = new Set(arr(selectedIds));
  return arr(findings).filter((f) => isSelectable(f) && sel.has(f.id)).length;
}

// ── Retrying one register ───────────────────────────────────────────────────

/** SourceReport id (what the function reports) → the `sources` value the
 * function accepts in a request body. */
const REPORT_TO_REQUEST = {
  nppes: "nppes",
  cmsClinician: "cms",
  cmsAffiliation: "affiliations",
  cmsHospital: "affiliations",
  pubmed: "pubmed",
};

export const REQUEST_SOURCES = ["nppes", "cms", "affiliations", "pubmed"];

/** Which register a finding came from, by the id the function stamped. */
export function requestSourceFor(finding) {
  const id = String(finding?.id ?? finding ?? "");
  if (id.startsWith("nppes:")) return "nppes";
  if (id.startsWith("pubmed:")) return "pubmed";
  if (id.startsWith("cms:privilege:")) return "affiliations";
  if (id.startsWith("cms:")) return "cms";
  return "";
}

export function requestSourceForReport(reportId) {
  return REPORT_TO_REQUEST[String(reportId || "")] || "";
}

/** The registers worth asking again, from an envelope's `errors`. */
export function retrySources(errors) {
  const out = [];
  for (const e of arr(errors)) {
    const key = requestSourceForReport(e?.source);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The failed registers by name, for a banner that says which one went down. */
export function failedSourceNames(envelope) {
  const byId = new Map(arr(envelope?.sources).map((s) => [s.id, s.name]));
  const names = [];
  for (const e of arr(envelope?.errors)) {
    const name = byId.get(e?.source) || e?.source;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * A retry answers for some registers only. The findings from those registers
 * are replaced, everything already on screen stays, and a register that
 * answered this time stops being an error.
 */
export function mergeEnvelopes(prev, next, keys) {
  const replaced = new Set(arr(keys));
  const kept = arr(prev?.findings).filter((f) => !replaced.has(requestSourceFor(f)));
  const findings = sortFindings([...kept, ...arr(next?.findings)]);

  const reports = new Map(arr(prev?.sources).map((s) => [s.id, s]));
  for (const s of arr(next?.sources)) reports.set(s.id, s);

  const errors = [
    ...arr(prev?.errors).filter((e) => !replaced.has(requestSourceForReport(e?.source))),
    ...arr(next?.errors),
  ];

  return {
    npi: prev?.npi || next?.npi || "",
    fetchedAt: next?.fetchedAt || prev?.fetchedAt || "",
    findings,
    sources: [...reports.values()],
    errors,
  };
}

// ── What a tick writes ──────────────────────────────────────────────────────

/**
 * The writes the accepted rows amount to, and nothing else. Settings findings
 * merge into one patch for updateSettings; every other finding becomes one
 * record for addItem, shaped by the function for that section's own form.
 * A row already on file is never written, whatever the selection says.
 *
 * `makeId` is passed in (generateId in the app, a counter in the tests) so
 * this stays pure.
 */
export function buildSavePlan(findings, selectedIds, makeId = () => "") {
  const sel = new Set(arr(selectedIds));
  const settings = {};
  const settingsFindings = [];
  const items = [];
  for (const f of arr(findings)) {
    if (!isSelectable(f) || !sel.has(f.id)) continue;
    if (f.section === "settings") {
      Object.assign(settings, f.fields || {});
      settingsFindings.push(f);
    } else {
      items.push({ section: f.section, item: { id: makeId(), ...(f.fields || {}) }, finding: f });
    }
  }
  return {
    settings,
    settingsFindings,
    items,
    count: settingsFindings.length + items.length,
  };
}

/** What was saved, grouped the way the screen showed it. */
export function savedSummary(plan) {
  const findings = [
    ...arr(plan?.settingsFindings),
    ...arr(plan?.items).map((i) => i.finding),
  ].filter(Boolean);
  return groupFindings(sortFindings(findings));
}
