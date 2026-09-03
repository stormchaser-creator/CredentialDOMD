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
 * The fields a settings finding would overwrite: the physician has a value,
 * and the register's differs. A profile finding writes a patch of several
 * fields at once while the row shows one of them as its label, so this is the
 * only thing that can tell the screen what accepting it actually costs.
 */
function replacedSettingsKeys(fields, settings) {
  return Object.keys(fields || {}).filter((k) => {
    const cur = clean(settings?.[k]);
    return cur !== "" && cur.toUpperCase() !== clean(fields[k]).toUpperCase();
  });
}

/**
 * Flag findings the physician already has, and drop nothing: an item on file
 * is shown as already on file rather than proposed a second time.
 * `existing` is the app's data object; `settings` is data.settings.
 *
 * A settings finding has a third outcome. It is not on file, and it is not
 * new either: it replaces something the physician typed. `replaces` names
 * those field keys, and everything downstream treats that as a row needing a
 * judgement rather than a row that may start ticked.
 */
export function markAlreadyOnFile(findings, existing = {}, settings = {}) {
  const have = new Set();
  for (const [section, items] of Object.entries(existing || {})) {
    for (const item of arr(items)) {
      for (const k of dedupeKeysOnFile(section, item)) have.add(k);
    }
  }
  return arr(findings).map((f) => {
    if (f.section === "settings") {
      const keys = Object.keys(f.fields || {});
      const already = keys.length > 0 && keys.every((k) =>
        clean(settings?.[k]).toUpperCase() === clean(f.fields[k]).toUpperCase());
      return { ...f, alreadyOnFile: already, replaces: replacedSettingsKeys(f.fields, settings) };
    }
    const k = dedupeKey(f.section, f.fields);
    return { ...f, alreadyOnFile: !!k && have.has(k) };
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

// ── Opening on one section ──────────────────────────────────────────────────

/**
 * A Setup row opens this screen already pointed at the section it is about,
 * and says what the registers actually hold for that section before the
 * search runs. Understating is fine here; overstating is not, so each line
 * names the gap as well as the answer.
 *
 * Keyed by the app section, which is what setupTasks calls `section`.
 * Publications has no Setup row of its own, and is reached from Settings.
 */
export const FOCUS_COPY = {
  education: {
    title: "Medical school and training",
    line: "Medicare states your degree and the year you graduated. It files most schools as \"OTHER\", so the school itself is not offered, and residency and fellowship are in neither register.",
  },
  workHistory: {
    title: "Work history",
    line: "Medicare lists the organizations enrolled under your NPI, with their address and phone. Your title and your dates are not in the register, so you add those.",
  },
  privileges: {
    title: "Hospital privileges",
    line: "Medicare lists the hospitals your claims came from. Each one is a lead to confirm with the hospital, never a privilege, and none of them carries a reappointment date.",
  },
  publications: {
    title: "Publications",
    line: "PubMed is searched on your author name, so the list will hold other people's papers. Read each one before you keep it.",
  },
};

/** The section key a caller may open on, or "" for the whole screen. */
export function focusSectionKey(section) {
  const k = String(section || "");
  return Object.prototype.hasOwnProperty.call(FOCUS_COPY, k) ? k : "";
}

/** True when a Setup row has something to offer from these registers. */
export function canFillFromPublicRecord(section) {
  return focusSectionKey(section) !== "";
}

/**
 * The groups split into the one that was asked for and the rest. The rest is
 * never dropped: a search that found a hospital while the physician was on
 * the Education row still found a hospital, and the screen says so.
 */
export function splitGroups(groups, focus) {
  const key = focusSectionKey(focus);
  if (!key) return { focused: arr(groups), rest: [] };
  return {
    focused: arr(groups).filter((g) => g.section === key),
    rest: arr(groups).filter((g) => g.section !== key),
  };
}

/** How many rows in these groups are still a decision. */
export function countPickable(groups) {
  return arr(groups).reduce((n, g) => n + arr(g.findings).filter(isSelectable).length, 0);
}

// ── Sections a plan can close ───────────────────────────────────────────────

/**
 * Sections this screen proposes into that the account may not be able to
 * open. App.jsx gates Privileges behind Pro, so accepting a hospital row on a
 * free plan would file a record into a page the physician cannot reach: it
 * would be in the account, counted nowhere, editable nowhere.
 *
 * The row is still shown. Hiding it would mean the register found something
 * and the screen said nothing, which is the failure this feature exists to
 * avoid. It is named, it says why it cannot be saved, and it cannot be
 * ticked.
 */
export const PLAN_LOCKED_SECTIONS = ["privileges"];

const PLAN_LOCK_NOTES = {
  privileges: "Hospital privileges is a Pro section. This row can be read here, and saved once the section is open to you.",
};

/**
 * Flag findings whose section this account cannot open. Runs after
 * markAlreadyOnFile, because a row already on file stays "already on file":
 * the record exists whatever the plan does, and calling it locked would read
 * as the app having lost it.
 */
export function markPlanLocks(findings, { isPro = false } = {}) {
  return arr(findings).map((f) => ({
    ...f,
    planLocked: !isPro && !f.alreadyOnFile && PLAN_LOCKED_SECTIONS.includes(f.section),
  }));
}

/** The one sentence a locked row says about itself. */
export function planLockNote(finding) {
  if (!finding?.planLocked) return "";
  return PLAN_LOCK_NOTES[finding.section]
    || "This section is not open on your plan, so the row cannot be saved yet.";
}

// ── Selection ───────────────────────────────────────────────────────────────

/**
 * A row the physician can tick. Already on file is not one of them, and
 * neither is a row whose section the plan keeps shut: the tick would write
 * somewhere the physician cannot look.
 */
export function isSelectable(finding) {
  return !!finding && !finding.alreadyOnFile && !finding.planLocked;
}

/**
 * What starts ticked. A register's own statement may; an inference never
 * does, because accepting a lead without reading it is the whole failure
 * this screen exists to prevent.
 *
 * A row that would overwrite something the physician typed does not either.
 * The register stating a value is not a reason to replace an answer already
 * given, and a profile row writes several fields behind a one-line label, so
 * a default tick there is a silent edit of the record.
 */
export function defaultSelectedIds(findings) {
  return arr(findings)
    .filter((f) => isSelectable(f) && f.confidence === "record" && !(f.replaces && f.replaces.length))
    .map((f) => f.id);
}

/**
 * What starts ticked when the screen was opened on one section.
 *
 * The folded sections start empty. A tick the physician cannot see is a tick
 * he did not make, and the footer counts every tick, so seeding the fold
 * would let Save write records that never appeared on screen. Opening the
 * fold shows them, and he ticks what he wants there.
 */
export function defaultSelectedIdsForFocus(findings, focus) {
  const key = focusSectionKey(focus);
  return defaultSelectedIds(key ? arr(findings).filter((f) => f.section === key) : findings);
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
      return "Medicare lists this as a practice location enrolled under your NPI. Confirm your title and dates.";
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

/** "a", "a and b", "a, b and c". One list voice for every line that reads
 * one out. */
export function joinWords(words) {
  const list = arr(words).map((w) => String(w || "")).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** What each profile field is called when a row has to name it. */
const SETTINGS_FIELD_LABELS = {
  name: "name",
  degreeType: "degree",
  address: "address",
  phone: "phone",
  primaryState: "primary state",
};

/**
 * "Replaces your address (350 W Thomas Rd, Phoenix, AZ) and primary state
 * (AZ)." The line a profile row needs before it can be ticked honestly: the
 * label shows only the incoming value, the patch writes every field in the
 * finding, and primaryState is what the renewal reminders and the CME state
 * are read from. Empty for a row that replaces nothing.
 */
export function replacesLine(finding, settings = {}) {
  const parts = arr(finding?.replaces).map((k) => {
    const label = SETTINGS_FIELD_LABELS[k] || k;
    const cur = clean(settings?.[k]);
    return cur ? `${label} (${cur})` : label;
  });
  return parts.length ? `Replaces your ${joinWords(parts)}.` : "";
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
  return joinWords(arr(needs).map((n) => NEED_LABELS[n] || String(n)));
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
