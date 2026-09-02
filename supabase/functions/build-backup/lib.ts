import { isOwnStorageObject } from "../_shared/storagePath.ts";
/**
 * Pure helpers for the monthly backup: no Deno, no network, no JSZip.
 *
 * Everything here is deterministic so scripts/backup-smoke.mjs can import this
 * exact file (Node 24 strips the types on import) and prove the archive layout
 * from a fake dataset without touching Supabase. Keep it erasable TypeScript:
 * types and interfaces only, no enums, no parameter properties, no namespaces,
 * or Node stops being able to load it.
 */

export type Row = Record<string, unknown>;

export interface Section {
  table: string;   // Postgres table
  key: string;     // app collection key (TABLE_MAP in src/lib/supabase.js)
  label: string;   // what a physician calls it
}

/** Every table the app syncs, in the order the archive lists them. */
export const SECTIONS: Section[] = [
  { table: "licenses", key: "licenses", label: "Licenses, DEA and certifications" },
  { table: "cme", key: "cme", label: "CME" },
  { table: "privileges", key: "privileges", label: "Hospital privileges" },
  { table: "insurance", key: "insurance", label: "Insurance" },
  { table: "health_records", key: "healthRecords", label: "Health records" },
  { table: "education", key: "education", label: "Education and training" },
  { table: "case_logs", key: "caseLogs", label: "Case log" },
  { table: "work_history", key: "workHistory", label: "Work history" },
  { table: "peer_references", key: "peerReferences", label: "Peer references" },
  { table: "malpractice_history", key: "malpracticeHistory", label: "Malpractice history" },
  { table: "documents", key: "documents", label: "Documents" },
  { table: "share_log", key: "shareLog", label: "Share log" },
  { table: "notification_log", key: "notificationLog", label: "Notification log" },
  { table: "locum_contracts", key: "locumContracts", label: "Locum contracts" },
  { table: "work_log", key: "workLog", label: "Work log" },
  { table: "encounters", key: "encounters", label: "Encounters" },
  { table: "screenings", key: "screenings", label: "Screenings" },
  { table: "alert_acks", key: "alertAcks", label: "Snoozed alerts" },
  { table: "professional_photos", key: "professionalPhotos", label: "Professional photos" },
  { table: "publications", key: "publications", label: "Publications" },
  { table: "travel_docs", key: "travelDocs", label: "Travel documents" },
  { table: "travel_expenses", key: "travelExpenses", label: "Travel expenses" },
  { table: "tax_payments", key: "taxPayments", label: "Tax payments" },
  { table: "schedule_days", key: "scheduleDays", label: "Schedule" },
  { table: "task_notes", key: "taskNotes", label: "Task notes" },
  { table: "duty_days", key: "dutyDays", label: "Duty days" },
  { table: "professional_memberships", key: "memberships", label: "Memberships" },
  { table: "invoices", key: "invoices", label: "Invoices" },
  { table: "deductibles", key: "deductibles", label: "Deductions" },
  { table: "rotations", key: "rotations", label: "Rotations" },
];

/** Columns that must never leave Postgres inside an archive. */
export const PROFILE_SECRET_FIELDS = ["api_key", "anthropic_api_key"];

/** 120 MB of source bytes per ZIP part. Bigger accounts get part 2, 3, ... */
// Source bytes per part. JSZip holds the inputs and the generated output at
// the same time, so peak memory is roughly twice this against a 256 MB
// isolate. Raise with the BACKUP_PART_MAX_BYTES secret only after watching a
// real build succeed.
export const PART_CAP_BYTES = 48 * 1024 * 1024;

/**
 * Signed links live 15 minutes. backup-link mints one for each Download tap on
 * the Data and Backup page; the monthly email carries none, so a read or
 * forwarded inbox never holds a way into the archive.
 */
export const LINK_TTL_SECONDS = 15 * 60;

/** Where the email sends people: the app's Data and Backup page. */
export const BACKUP_PAGE_URL = "https://credentialdomd.com/app/#backups";
export const BACKUP_PAGE_PATH = "More > Data and Backup";

export const BACKUP_BUCKET = "backups";
export const DOCUMENTS_BUCKET = "documents";

/** The one sentence that has to be true in every archive and every email. */
export const VAULT_NOTE =
  "Your private vault is not in this archive. Patient identifiers stay on your device and never reach our servers, so nothing from the vault can be in a backup built here.";
export const KEYS_NOTE =
  "Your AI keys are not in this archive either. They live on the device that set them.";

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${b} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return (Number(n) || 0).toLocaleString("en-US");
}

/** "2026-08" to "August 2026". */
export function monthLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  if (!m) return String(period || "");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** ISO timestamp to "September 21, 2026". */
export function longDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** YYYY-MM for the month a build is running in. */
export function periodFor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * "Dr. Eric Whitney, MD" to "Eric"; falls back to the mailbox name.
 *
 * The version in send-reminders/index.ts strips "Dr" but leaves the dot behind,
 * so the first token is "." and every physician who writes their name with a
 * title gets greeted by their email mailbox instead. This one drops the
 * punctuation too and skips single-letter initials.
 */
export function firstName(name: string | null | undefined, email: string): string {
  const cleaned = String(name || "")
    .replace(/\b(dr|prof|mr|mrs|ms|md|do|mbbs|phd|dds|dmd)\b\.?/gi, " ")
    .replace(/[^A-Za-z'\- ]+/g, " ")
    .trim();
  for (const token of cleaned.split(/\s+/)) {
    if (token.length >= 2 && /^[a-z'-]+$/i.test(token)) {
      return token[0].toUpperCase() + token.slice(1).toLowerCase();
    }
  }
  return String(email || "").split("@")[0] || "Doctor";
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Filenames can arrive from a forwarded email, so a cell must never be
  // read as a formula when the README tells the physician to open this in
  // Excel. A leading apostrophe makes it text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Header row from the union of every row's keys, in first-seen order, so a
 * column that only some rows carry still makes it into the file. Leading BOM
 * so Excel opens UTF-8 correctly.
 */
export function toCsv(rows: Row[]): string {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r || {})) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  const lines = [cols.map(csvCell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell((r || {})[c])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** CSV from an explicit header list, for index.csv where the order is fixed. */
export function toCsvWithHeaders(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ── File names ───────────────────────────────────────────────────────────────

export function safeFilename(name: string | null | undefined, fallback: string): string {
  // deno-lint-ignore no-control-regex
  const n = String(name ?? "").trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 180)
    .trim();
  return n || fallback;
}

/** A second "DEA.pdf" becomes "DEA (2).pdf" so the two are still tellable apart. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!taken.has(cand.toLowerCase())) { taken.add(cand.toLowerCase()); return cand; }
  }
  const cand = `${base} (${Math.random().toString(16).slice(2, 10)})${ext}`;
  taken.add(cand.toLowerCase());
  return cand;
}

export function backupObjectName(period: string, part: number, parts: number): string {
  return parts > 1
    ? `CredentialDOMD-backup-${period}-part-${part}.zip`
    : `CredentialDOMD-backup-${period}.zip`;
}

export function backupStoragePath(authUserId: string, period: string, part: number, parts: number, runId?: string): string {
  // runId keeps a rebuild from overwriting the object an earlier backups row
  // still points at (that row would keep its old size and counts and lie).
  const dir = runId ? `${period}/${runId}` : period;
  return `${authUserId}/${dir}/${backupObjectName(period, part, parts)}`;
}

// ── Records and their documents ──────────────────────────────────────────────

const LABEL_FIELDS = [
  "name", "title", "hospital", "institution", "employer", "organization",
  "facility", "school", "program", "procedure", "activity", "type",
  "carrier", "description", "state",
];

/** The words a physician would use for one record, for a file name. */
export function recordLabel(row: Row | null | undefined): string {
  if (!row) return "";
  for (const f of LABEL_FIELDS) {
    const v = row[f];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 60);
  }
  return "";
}

/** documents.linked_to is "<appKey>:<uuid>", e.g. "healthRecords:abd0...". */
export function parseLinkedTo(linkedTo: unknown): { key: string; id: string } | null {
  const s = String(linkedTo ?? "").trim();
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) return null;
  return { key: s.slice(0, i), id: s.slice(i + 1) };
}

/** "<appKey>:<id>" to the row, so linked_to resolves in one lookup. */
export function buildRecordIndex(dataByTable: Record<string, Row[]>): Map<string, Row> {
  const index = new Map<string, Row>();
  for (const s of SECTIONS) {
    for (const row of dataByTable[s.table] || []) {
      const id = row && row.id;
      if (id) index.set(`${s.key}:${String(id)}`, row);
    }
  }
  return index;
}

export interface DocInput {
  id: string;
  name?: string | null;
  mime_type?: string | null;
  type?: string | null;
  size_bytes?: number | null;
  size?: number | null;
  storage_path?: string | null;
  linked_to?: string | null;
  uploaded_at?: string | null;
  created_at?: string | null;
}

export interface PreparedDoc {
  id: string;
  path: string;          // object key inside the documents bucket
  originalName: string;  // what the physician uploaded
  label: string;         // the record it hangs off, "" when unlinked
  fileName: string;      // deduped name inside documents/
  size: number;          // best known source size, for the part split
  uploadedAt: string;
  linkedRecord: string;  // "Licenses: DEA Registration", or ""
}

export interface SkippedDoc {
  name: string;
  reason: string;
}

/**
 * Turn documents rows into archive entries.
 *
 * Only paths inside the caller's own storage folder are ever read: a user can
 * edit their own row's storage_path, and the service role must not become a way
 * around storage RLS. Anything else is skipped and reported, never dropped in
 * silence. `sizeByPath` is real object metadata from storage.list when we have
 * it, because size_bytes on the row is only as good as the client that wrote it.
 */
export function prepareDocuments(
  docs: DocInput[],
  authUserId: string,
  recordIndex: Map<string, Row>,
  sizeByPath?: Map<string, number>,
): { items: PreparedDoc[]; skipped: SkippedDoc[] } {
  const items: PreparedDoc[] = [];
  const skipped: SkippedDoc[] = [];
  const taken = new Set<string>();
  const sectionByKey = new Map(SECTIONS.map((s) => [s.key, s]));

  const ordered = [...docs].sort((a, b) => {
    const av = String(a.uploaded_at || a.created_at || "");
    const bv = String(b.uploaded_at || b.created_at || "");
    return av === bv ? String(a.id).localeCompare(String(b.id)) : av.localeCompare(bv);
  });

  for (const d of ordered) {
    const originalName = safeFilename(d.name, `document-${items.length + 1}`);
    const path = String(d.storage_path || (authUserId ? `${authUserId}/${d.id}` : ""));
    if (!isOwnStorageObject(authUserId, path)) {
      skipped.push({ name: originalName, reason: "the file is not stored in your account folder" });
      continue;
    }

    const link = parseLinkedTo(d.linked_to);
    const row = link ? recordIndex.get(`${link.key}:${link.id}`) : null;
    const label = recordLabel(row);
    const section = link ? sectionByKey.get(link.key) : undefined;

    const base = label ? `${label} - ${originalName}` : originalName;
    const fileName = uniqueName(safeFilename(base, originalName), taken);

    const known = sizeByPath ? sizeByPath.get(path) : undefined;
    const size = Math.max(0, Number(known ?? d.size_bytes ?? d.size ?? 0) || 0);

    items.push({
      id: String(d.id),
      path,
      originalName,
      label,
      fileName,
      size,
      uploadedAt: String(d.uploaded_at || d.created_at || ""),
      linkedRecord: section ? (label ? `${section.label}: ${label}` : section.label) : "",
    });
  }
  return { items, skipped };
}

/**
 * Split documents into parts of at most `capBytes` of source bytes. A single
 * file over the cap gets its own part rather than being dropped. Always returns
 * at least one part, so an account with no documents still gets one archive.
 */
export function planDocumentParts<T extends { size: number }>(items: T[], capBytes: number): T[][] {
  if (!items.length) return [[]];
  const cap = Math.max(1, Number(capBytes) || PART_CAP_BYTES);
  const parts: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const it of items) {
    const size = Math.max(0, Number(it.size) || 0);
    if (cur.length && curBytes + size > cap) { parts.push(cur); cur = []; curBytes = 0; }
    cur.push(it);
    curBytes += size;
  }
  parts.push(cur);
  return parts;
}

// ── Archive contents ─────────────────────────────────────────────────────────

export function stripProfile(profile: Row | null | undefined): Row {
  const out: Row = { ...(profile || {}) };
  for (const f of PROFILE_SECRET_FIELDS) delete out[f];
  return out;
}

export interface SnapshotMeta {
  period: string;
  generatedAt: string;
  part: number;
  parts: number;
  appVersion?: string;
}

/**
 * data/backup.json, the complete machine-readable copy.
 *
 * `data` is keyed by Postgres table name and rows keep their database column
 * names exactly as stored, so the snapshot is a faithful copy. `table_map`
 * carries table name to app collection key, so an importer never has to guess.
 */
export function buildSnapshot(
  profile: Row | null | undefined,
  dataByTable: Record<string, Row[]>,
  meta: SnapshotMeta,
): Row {
  const data: Record<string, Row[]> = {};
  const counts: Record<string, number> = {};
  const tableMap: Record<string, string> = {};
  let recordCount = 0;
  for (const s of SECTIONS) {
    const rows = dataByTable[s.table] || [];
    data[s.table] = rows;
    counts[s.table] = rows.length;
    tableMap[s.table] = s.key;
    recordCount += rows.length;
  }
  return {
    format: "credentialdomd-backup",
    version: 1,
    app: "CredentialDOMD",
    generated_at: meta.generatedAt,
    period: meta.period,
    part: meta.part,
    parts: meta.parts,
    record_count: recordCount,
    counts,
    table_map: tableMap,
    excluded: {
      private_vault: "Patient identifiers stay on the device and never reach the server.",
      ai_keys: "profiles.api_key and profiles.anthropic_api_key are stripped before the archive is written.",
    },
    profile: stripProfile(profile),
    data,
  };
}

export function countRecords(dataByTable: Record<string, Row[]>): number {
  let n = 0;
  for (const s of SECTIONS) n += (dataByTable[s.table] || []).length;
  return n;
}

export interface TextEntry {
  path: string;
  text: string;
}

/** data/backup.json plus one CSV per non-empty section. Part 1 only. */
export function dataEntries(
  profile: Row | null | undefined,
  dataByTable: Record<string, Row[]>,
  meta: SnapshotMeta,
): TextEntry[] {
  const entries: TextEntry[] = [
    { path: "data/backup.json", text: JSON.stringify(buildSnapshot(profile, dataByTable, meta), null, 2) },
  ];
  for (const s of SECTIONS) {
    const rows = dataByTable[s.table] || [];
    if (!rows.length) continue;
    entries.push({ path: `data/${s.table}.csv`, text: toCsv(rows) });
  }
  return entries;
}

export function documentIndexCsv(items: PreparedDoc[]): string {
  return toCsvWithHeaders(
    ["file", "original name", "linked record", "uploaded date", "size (bytes)"],
    items.map((i) => [`documents/${i.fileName}`, i.originalName, i.linkedRecord, i.uploadedAt, i.size]),
  );
}

// ── README.html ──────────────────────────────────────────────────────────────

export interface ReadmeInfo {
  period: string;
  generatedAt: string;
  part: number;
  parts: number;
  physicianName: string;
  recordCount: number;
  sectionCounts: { label: string; table: string; count: number }[];
  documentCount: number;      // files in this part
  totalDocumentCount: number; // files across every part
  documentBytes: number;      // source bytes in this part
  skipped: SkippedDoc[];
  hasData: boolean;           // this part carries data/
}

export function renderReadme(info: ReadmeInfo): string {
  const nonEmpty = info.sectionCounts.filter((s) => s.count > 0);
  const multi = info.parts > 1;
  const rows = nonEmpty
    .map((s) => `<tr><td>${escapeHtml(s.label)}</td><td class="n">${formatCount(s.count)}</td><td class="f">data/${escapeHtml(s.table)}.csv</td></tr>`)
    .join("\n");

  const skippedBlock = info.skipped.length
    ? `<h2>Files that could not be read</h2>
<p>${formatCount(info.skipped.length)} file${info.skipped.length === 1 ? "" : "s"} in your account could not be pulled into this archive. Nothing was deleted. Open the app, check these documents, and re-upload any that will not open.</p>
<ul>
${info.skipped.map((s) => `<li>${escapeHtml(s.name)} <span class="muted">(${escapeHtml(s.reason)})</span></li>`).join("\n")}
</ul>`
    : "";

  const partBlock = multi
    ? `<p class="callout">This is part ${info.part} of ${info.parts}. Your documents did not fit in one file, so they were split. The data files (backup.json and the CSVs) are in part 1. Keep all ${info.parts} files together.</p>`
    : "";

  const dataBlock = info.hasData
    ? `<h2>Your records</h2>
<p>${formatCount(info.recordCount)} record${info.recordCount === 1 ? "" : "s"} across ${formatCount(nonEmpty.length)} section${nonEmpty.length === 1 ? "" : "s"}. Every section has a CSV you can open in Excel or Numbers. The same records are in <code>data/backup.json</code>.</p>
<table>
<thead><tr><th>Section</th><th class="n">Records</th><th>File</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
    : `<h2>Your records</h2>
<p>The record files live in part 1 of this backup. This part holds documents only.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CredentialDOMD backup, ${escapeHtml(monthLabel(info.period))}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; color: #14202e; background: #fff; }
  h1 { font-size: 1.55rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  .sub { color: #5b6b7c; margin: 0 0 1.5rem; }
  .muted { color: #5b6b7c; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .95rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #dde3ea; }
  th { font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.f { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; color: #5b6b7c; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f2f5f8; padding: .1em .35em; border-radius: 3px; }
  ul { padding-left: 1.2rem; }
  .callout { background: #f2f5f8; border-left: 3px solid #2f6f9f; padding: .75rem 1rem; border-radius: 0 4px 4px 0; }
  .warn { background: #fff6e8; border-left-color: #b8730f; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #10161d; }
    .sub, .muted, td.f { color: #9bb0c3; }
    th, td { border-bottom-color: #253243; }
    code, .callout { background: #1a232e; }
    .warn { background: #2a2114; }
  }
</style>
</head>
<body>
<h1>Your CredentialDOMD backup</h1>
<p class="sub">${escapeHtml(info.physicianName)} &middot; ${escapeHtml(monthLabel(info.period))} &middot; generated ${escapeHtml(longDate(info.generatedAt))}</p>

${partBlock}

<p>This is a complete copy of everything your CredentialDOMD account holds in the cloud: your records, your profile, and every document you have uploaded. It is yours to keep. Nothing here needs the app or an internet connection to read.</p>

${dataBlock}

<h2>Your documents</h2>
<p>${formatCount(info.documentCount)} file${info.documentCount === 1 ? "" : "s"} in this part, ${escapeHtml(formatBytes(info.documentBytes))}${multi ? `, out of ${formatCount(info.totalDocumentCount)} in the full backup` : ""}. They are in the <code>documents/</code> folder, named for the record they belong to. <code>documents/index.csv</code> lists every file with its original name, the record it is attached to, when it was uploaded, and its size.</p>

<h2>What is not in here</h2>
<div class="callout warn">
<p><strong>${escapeHtml(VAULT_NOTE)}</strong></p>
<p>${escapeHtml(KEYS_NOTE)}</p>
</div>
<p>To keep a copy of the private vault, export it from the device that holds it: More, then Data and Backup, then Private notes, then Export.</p>

${skippedBlock}

<h2>How to open this</h2>
<ul>
<li>Unzip the file. Everything inside is a plain file: HTML, JSON, CSV, and your original documents.</li>
<li>CSV files open in Excel, Numbers, or Google Sheets.</li>
<li><code>data/backup.json</code> is the complete machine-readable copy of every record, ready for whatever comes next. Loading a server backup straight back into the app is not a one-tap feature yet, so if you ever need that, write to stormchaser@elryx.com and we will do it with you. The CSVs and your documents need nothing but a spreadsheet and a file viewer.</li>
<li>Your documents are ordinary PDFs and images. Open them with anything.</li>
</ul>

<h2>Turning these off</h2>
<p>Monthly backups are on for every account. To stop them, open the app, go to More, then Data and Backup, and turn Monthly backup off. You can still build one on demand from the same screen.</p>

<p class="sub">CredentialDOMD &middot; questions to stormchaser@elryx.com</p>
</body>
</html>
`;
}

// ── The email ────────────────────────────────────────────────────────────────

export interface EmailInfo {
  greetingName: string;
  period: string;
  recordCount: number;
  sectionCount: number;
  documentCount: number;
  documentBytes: number;
  builtParts: number;     // ZIP parts that exist in the bucket
  archiveBytes: number;   // those parts together
  skippedCount: number;
  missingParts?: number;  // parts that failed to build, so the email cannot claim to be whole
  pageUrl?: string;       // defaults to BACKUP_PAGE_URL
}

export function backupSubject(period: string): string {
  return `Your CredentialDOMD backup for ${monthLabel(period)}`;
}

/**
 * Plain text, no em dashes, no hedging. Says what is inside, where to get it,
 * what is deliberately missing, and how to stop the emails.
 *
 * Deliberately NOT in here: a link to the file. The archive holds every scan
 * the physician ever uploaded (passport, DEA, driver's license), and an inbox
 * is read by more people than its owner. The only way to the ZIP is the Data
 * and Backup page, signed in, through a link that lives 15 minutes.
 */
export function renderEmailText(info: EmailInfo): string {
  const multi = info.builtParts > 1;
  const pageUrl = info.pageUrl || BACKUP_PAGE_URL;
  const inside = [
    `  ${formatCount(info.recordCount)} record${info.recordCount === 1 ? "" : "s"} across ${formatCount(info.sectionCount)} section${info.sectionCount === 1 ? "" : "s"}`,
    `  ${formatCount(info.documentCount)} document${info.documentCount === 1 ? "" : "s"}, ${formatBytes(info.documentBytes)}`,
    "  README.html, which explains every file",
    "  data/backup.json, the complete machine-readable copy",
    "  One CSV per section, for Excel or Numbers",
  ].join("\n");

  const size = multi
    ? `The archive is ${formatCount(info.builtParts)} files, ${formatBytes(info.archiveBytes)} together. Download all of them.`
    : `The file is ${formatBytes(info.archiveBytes)}.`;
  const where = [
    "Where to get it:",
    `  Open ${pageUrl}`,
    `  In the app that is ${BACKUP_PAGE_PATH}. Tap Download next to ${monthLabel(info.period)}.`,
    `  ${size}`,
  ].join("\n");

  const skipped = info.skippedCount
    ? `\n${formatCount(info.skippedCount)} document${info.skippedCount === 1 ? "" : "s"} could not be read and ${info.skippedCount === 1 ? "is" : "are"} listed by name in the README.html inside the archive. Nothing was deleted.\n`
    : "";

  const missing = Number(info.missingParts) || 0;
  const opening = missing
    ? `Your CredentialDOMD backup for ${monthLabel(info.period)} is ready, but ${formatCount(missing)} of its ${formatCount(missing + info.builtParts)} parts did not finish building. What is there is real and complete as far as it goes. Build a new backup from ${BACKUP_PAGE_PATH}, and write to us if it fails again.`
    : `Your complete CredentialDOMD backup for ${monthLabel(info.period)} is ready.`;

  return `${info.greetingName},

${opening}

What is inside:
${inside}

${where}

This email has no link to the file. Downloads happen only from your signed-in account, and each link works for 15 minutes.

${VAULT_NOTE} ${KEYS_NOTE}
${skipped}
To stop these monthly backups, open ${BACKUP_PAGE_PATH} and turn Monthly backup off.

CredentialDOMD
`;
}
