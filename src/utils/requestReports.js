// Extensions spelled out so pure-node test scripts can import this module.
import { identifierReason } from "./identifierGate.js";
import { buildReferenceText } from "./referenceDraft.js";
import { withDegree } from "./outgoingText.js";
import { isCurrentJob } from "./helpers.js";
import { buildCvContent } from "./cvContent.js";
import { professionCopy } from "../constants/professionCopy.js";
import { noteForSelection } from "./requestPacket.js";

/**
 * The reports a request asks for, prepared from the physician's own records
 * before they open it.
 *
 * Owner ticket c3f23aa8 (2026-10-29): a request must arrive created and
 * ready for approval, with no multi-step process. Until then an ask for case
 * logs, an NPI, references, work history or a CV (requestPacket.js
 * REPORT_KINDS) was never prepared: the proposal said "report", the cover
 * note promised "These will follow separately:", and the physician had to
 * leave the request, build the report somewhere else and send it on its
 * own. Two real requests were exactly that: a recruiter asking for
 * references, and a credentialing specialist asking for case logs over a
 * date range.
 *
 * Each report ask is now answered from what the app already holds, with the
 * exporters the app already has:
 *   npi           the profile's NPI, written into the note
 *   references    the saved peer references, written into the note in the
 *                 same per-reference block the references share writes
 *                 (referenceDraft.js buildReferenceText: name, degree,
 *                 specialty, institution, relationship, known since, email,
 *                 phone; never the private notes)
 *   work_history  the work history list, written into the note
 *   case_logs     the case log PDF (caseLogReport.js buildCaseLogPdf) for
 *                 the range the ask states ("from 01/2026 to present" is Jan
 *                 1 2026 through today; no range is every case), attached
 *   cv            the Clinical CV PDF (cvPdf.js buildCvPdf), attached
 *
 * Nothing here is stored. The prepared proposal is computed from the
 * records each time the screen draws (hooks/useRequestProposals.js), so an
 * edit to a reference shows in the next draft, and the files are generated
 * from the same records at the tap that sends them
 * (utils/requestReportFiles.js). The note claims only what this module
 * prepared: an ask it could not prepare (no NPI on the profile, no
 * references saved, no cases in the range, a date range it could not read,
 * a field that looks like a patient identifier) keeps its "follows
 * separately" line, and the physician is told why on the request.
 *
 * Pure: no clock unless the caller leaves `now` out, no browser objects, so
 * scripts/request-reports.test.mjs runs it under plain node.
 */

/** The longest note the send accepts (requestFlow.ts MAX_APPROVE_TEXT), with room for the physician's own words. */
export const NOTE_BUDGET = 4500;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_WORDS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, twenty: 20, "twenty-four": 24, thirty: 30, "thirty-six": 36 };

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Today as "YYYY-MM-DD": `now` as given ("2026-10-30" or a Date), or the device's own date. */
export function todayOf(now) {
  if (typeof now === "string" && /^\d{4}-\d{2}-\d{2}/.test(now)) return now.slice(0, 10);
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** "2026-01-01" as "Jan 1, 2026". */
export function longDay(day) {
  const m = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(day || "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// One point in time as an ask writes it, at the start (`edge` "from") or the
// end (`edge` "to") of the span it names: "01/2026" is Jan 1 as a start and
// Jan 31 as an end. null for anything else.
function readPoint(raw, edge, today) {
  const s = String(raw || "").trim().toLowerCase().replace(/[.,]$/, "");
  if (!s) return null;
  if (/^(present|today|now|date|current|the present|present day|this date)$/.test(s)) return today;
  let m;
  const pick = (y, mo, d) => {
    if (y < 1950 || y > 2100 || mo < 1 || mo > 12) return null;
    if (d !== undefined) return d >= 1 && d <= lastDay(y, mo) ? iso(y, mo, d) : null;
    return edge === "from" ? iso(y, mo, 1) : iso(y, mo, lastDay(y, mo));
  };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return pick(Number(m[3]), Number(m[1]), Number(m[2]));
  if ((m = s.match(/^(\d{1,2})[/-](\d{4})$/))) return pick(Number(m[2]), Number(m[1]));
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return pick(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = s.match(/^(\d{4})[/-](\d{1,2})$/))) return pick(Number(m[1]), Number(m[2]));
  if ((m = s.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && MONTH_WORDS[m[1]]) return pick(Number(m[3]), MONTH_WORDS[m[1]], Number(m[2]));
  if ((m = s.match(/^([a-z]+)\.?,?\s+(\d{4})$/)) && MONTH_WORDS[m[1]]) return pick(Number(m[2]), MONTH_WORDS[m[1]]);
  if ((m = s.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    if (y < 1950 || y > 2100) return null;
    return edge === "from" ? iso(y, 1, 1) : iso(y, 12, 31);
  }
  return null;
}

// "12 months", "two years", "a year": a span in months, or null.
function readSpan(count, unit) {
  const c = String(count || "").toLowerCase();
  const n = /^\d+$/.test(c) ? Number(c) : c === "a" || c === "one" || c === "" ? 1 : NUMBER_WORDS[c];
  if (!n || n > 600) return null;
  return /^year/.test(String(unit).toLowerCase()) ? n * 12 : n;
}

function monthsBefore(today, months) {
  const [y, m, d] = today.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12), nm = total % 12 + 1;
  return iso(ny, nm, Math.min(d, lastDay(ny, nm)));
}

// Month names longest first, so "September" is not read as "Sep" and a stray "tember".
const MONTH_ALT = Object.keys(MONTH_WORDS).sort((a, b) => b.length - a.length).join("|");
const POINT = `(?:\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{1,2}[\\/-]\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{4}[\\/-]\\d{1,2}|(?:${MONTH_ALT})\\.?\\s+\\d{1,2},?\\s+\\d{4}|(?:${MONTH_ALT})\\.?,?\\s+\\d{4}|\\d{4}|present day|the present|present|today|now|date|current)`;
const TO = "(?:to|through|thru|until|till|-|\u2013|\u2014)";
const RANGE_RE = new RegExp(`(?:\\b(?:from|between|starting|beginning|since)\\s+)?\\b(${POINT})\\s*${TO}\\s*(?:the\\s+)?(${POINT})\\b`, "i");
const SINCE_RE = new RegExp(`\\b(?:from|since|starting(?:\\s+(?:from|in))?|beginning(?:\\s+(?:in|with))?|after)\\s+(${POINT})\\b`, "i");
const LAST_RE = /\b(?:(?:last|past|previous|prior|most recent|recent)\s+)?(\d{1,3}|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|twenty-four|thirty|thirty-six)?[\s-]*(months?|years?|mos?|yrs?)\b/i;
const YEAR_ONLY_RE = /\b(?:for|in|during|of|calendar year|year)\s+(\d{4})\b/i;
// Words that say an ask has a date range in it. One the parser cannot read
// is not "every case": the report would answer a question nobody asked.
const RANGE_HINT_RE = /\b(?:from|since|between|through|thru|until|last|past|previous|prior|recent|months?|years?|yrs?|mos?|\d{4}|\d{1,2}\/\d{1,2})\b/i;

/**
 * The date range an ask states, as { from, to, label } with from and to
 * "YYYY-MM-DD" inclusive; { all: true, label } when it states none; null
 * when it seems to state one the rules cannot read. `today` ends "to
 * present" and a rolling window.
 *
 *   "case logs from 01/2026 to present"  -> 2026-01-01 .. today
 *   "Logs 12-months", "last 12 months"   -> today minus 12 months .. today
 *   "since March 2025"                   -> 2025-03-01 .. today
 *   "case logs for 2025"                 -> 2025-01-01 .. 2025-12-31
 *   "case logs"                          -> every case
 */
export function caseLogRange(text, now) {
  const today = todayOf(now);
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const out = (from, to) => {
    if (!from || !to) return null;
    const end = to > today ? today : to;
    if (from > end) return null;
    return { from, to: end, label: `${longDay(from)} to ${longDay(end)}` };
  };
  let m = s.match(RANGE_RE);
  if (m) {
    const r = out(readPoint(m[1], "from", today), readPoint(m[2], "to", today));
    if (r) return r;
  }
  m = s.match(SINCE_RE);
  if (m) {
    const r = out(readPoint(m[1], "from", today), today);
    if (r) return r;
  }
  m = s.match(LAST_RE);
  if (m && (m[1] || /\b(?:last|past|previous|prior|recent)\b/i.test(m[0]))) {
    const months = readSpan(m[1], m[2]);
    if (months) return out(monthsBefore(today, months), today);
  }
  m = s.match(YEAR_ONLY_RE);
  if (m) {
    const r = out(readPoint(m[1], "from", today), readPoint(m[1], "to", today));
    if (r) return r;
  }
  if (RANGE_HINT_RE.test(s)) return null;
  return { all: true, label: "all cases" };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clean = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v)).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/** The first line of `values` that reads as a patient identifier, an SSN or a date of birth, as the gate words it; "" when none does. */
function identifierIn(values) {
  for (const v of values) {
    const why = identifierReason("", clean(v));
    if (why) return why;
  }
  return "";
}

/** "2020-07-01" as "Jul 2020"; a bare year as itself. */
function monthYear(v) {
  const s = clean(v);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return s;
}

function physicianLabel(settings) {
  const s = settings || {};
  return clean(s.name) ? withDegree(clean(s.name), clean(s.degreeType)) : professionCopy(s.degreeType, { audience: "third-party" }).fallbackName;
}

// ── Each kind ────────────────────────────────────────────────────────────────

function prepareNpi(data) {
  const raw = clean(data?.settings?.npi).replace(/[\s-]/g, "");
  if (!raw) return { why: "No NPI in your profile. Add it in Settings and it goes in the reply." };
  if (!/^\d{10}$/.test(raw)) return { why: "The NPI in your profile is not 10 digits. Check it in Settings." };
  return { prepared: { how: "text", text: `My NPI is ${raw}.` } };
}

function prepareReferences(data) {
  const refs = (Array.isArray(data?.peerReferences) ? data.peerReferences : []).filter((r) => r && typeof r === "object" && clean(r.name));
  if (!refs.length) return { why: "No references saved in the app. Add them under Peer References and they go in the reply." };
  const blocks = refs.map((r) => buildReferenceText(r));
  const hit = identifierIn(blocks.flatMap((b) => b.split("\n")));
  if (hit) return { why: `One of your saved references looks like it holds ${hit}. Check it before it is sent.` };
  const text = [`Professional reference${refs.length === 1 ? "" : "s"}:`, ...blocks.map((b, i) => `${i + 1}. ${b}`)].join("\n\n");
  return { prepared: { how: "text", text, count: refs.length } };
}

function workLine(w) {
  const what = clean(w.position) || clean(w.type) || "Position";
  const where = [clean(w.employer), [clean(w.city), clean(w.state)].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  const from = monthYear(w.startDate);
  const to = isCurrentJob(w.current) ? "present" : monthYear(w.endDate);
  const when = from && to ? `${from} to ${to}` : from ? `from ${from}` : to ? `until ${to}` : "";
  return `- ${[what, where, when].filter(Boolean).join(", ")}`;
}

function prepareWorkHistory(data) {
  const list = (Array.isArray(data?.workHistory) ? data.workHistory : [])
    .filter((w) => w && typeof w === "object" && (clean(w.position) || clean(w.employer)));
  if (!list.length) return { why: "No work history saved in the app. Add it under Work History and it goes in the reply." };
  const sorted = [...list].sort((a, b) => {
    const ca = isCurrentJob(a.current) ? 1 : 0, cb = isCurrentJob(b.current) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return clean(b.startDate).localeCompare(clean(a.startDate));
  });
  const lines = sorted.map(workLine);
  const hit = identifierIn(lines);
  if (hit) return { why: `An entry in your work history looks like it holds ${hit}. Check it before it is sent.` };
  return { prepared: { how: "text", text: ["Work history:", ...lines].join("\n"), count: lines.length } };
}

/** The cases a range covers: every case for { all }, otherwise the dated cases inside it, oldest first. */
export function casesInRange(cases, range) {
  const list = (Array.isArray(cases) ? cases : []).filter((c) => c && typeof c === "object");
  const inRange = range && range.all ? list : list.filter((c) => {
    const d = clean(c.date).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= range.from && d <= range.to;
  });
  return [...inRange].sort((a, b) => clean(a.date).localeCompare(clean(b.date)));
}

function prepareCaseLogs(data, item, now) {
  const range = caseLogRange(item.quote || item.ask, now);
  if (!range) return { why: "The date range in this ask could not be read. Export the case log for it from Case Logs." };
  const cases = casesInRange(data?.caseLogs, range);
  if (!cases.length) return { why: range.all ? "No cases logged in the app." : `No cases logged from ${range.label}.` };
  // The PDF prints these fields (caseLogReport.js buildCaseLogPdf). A case
  // log is gated on the way in, but a report mailed to a third party is
  // checked again on the way out.
  const hit = identifierIn(cases.flatMap((c) => [c.title, c.category, c.facility, c.role, Array.isArray(c.cptCodes) ? c.cptCodes.join(" ") : c.cptCodes]));
  if (hit) return { why: `A case in this range looks like it holds ${hit}. Check the case log before it is sent.` };
  const span = range.all ? "all cases" : range.label;
  return {
    prepared: {
      how: "file",
      file: "case_logs",
      label: `Case log, ${span} (${plural(cases.length, "case")})`,
      from: range.all ? null : range.from,
      to: range.all ? null : range.to,
      span: range.all ? null : range.label,
      count: cases.length,
    },
  };
}

function prepareCv(data) {
  let sections;
  try {
    sections = buildCvContent(data || {}, "clinical");
  } catch {
    return { why: "The CV could not be built from your records. Open CV Generator to export it." };
  }
  // The header alone is not a CV (CVGenerator.jsx says the same).
  if (!Array.isArray(sections) || sections.length <= 1) return { why: "Your CV is empty. Add work history, education or licenses and it is attached." };
  const strings = [];
  for (const s of sections) for (const it of (Array.isArray(s.items) ? s.items : [])) strings.push(it.primary, it.secondary, it.detail);
  const hit = identifierIn(strings);
  if (hit) return { why: `Something on your CV looks like it holds ${hit}. Check it in CV Generator before it is sent.` };
  return { prepared: { how: "file", file: "cv", label: "CV" } };
}

const PREPARERS = {
  npi: (data) => prepareNpi(data),
  references: (data) => prepareReferences(data),
  work_history: (data) => prepareWorkHistory(data),
  case_logs: (data, item, now) => prepareCaseLogs(data, item, now),
  cv: (data) => prepareCv(data),
};

/** The kinds this module prepares. */
export const PREPARED_KINDS = Object.freeze(Object.keys(PREPARERS));

/**
 * `proposal` with every report ask the records can answer prepared: the
 * item gains `prepared` (requestPacket.js reads it into the note) and the
 * note is rewritten for the proposal's own documents. An ask that cannot be
 * prepared gains `notPrepared`, the reason, for the physician only; its
 * note line still says it follows separately. A proposal with no report
 * asks comes back as the same object, so a request with nothing to prepare
 * is exactly what it was.
 *
 * Text goes into the note only while the note stays under NOTE_BUDGET; past
 * that, the longest text is left to follow separately rather than have the
 * send refuse the note or cut the sign-off off.
 */
export function prepareProposal(proposal, data, { fromName = "", now } = {}) {
  if (!proposal || typeof proposal !== "object" || !Array.isArray(proposal.items)) return proposal;
  const reportAt = proposal.items.map((it, i) => (it && typeof it === "object" && it.status === "report" && PREPARERS[it.kind] ? i : -1)).filter((i) => i >= 0);
  if (!reportAt.length) return proposal;
  const items = proposal.items.map((it) => (it && typeof it === "object" ? { ...it } : it));
  for (const i of reportAt) {
    const it = items[i];
    delete it.prepared;
    delete it.notPrepared;
    let r;
    try {
      r = PREPARERS[it.kind](data || {}, it, now);
    } catch {
      r = { why: "This could not be prepared from your records." };
    }
    if (r.prepared) it.prepared = r.prepared;
    else it.notPrepared = r.why;
  }
  const settings = data?.settings || {};
  const physician = { name: settings.name || "", degree: settings.degreeType || "" };
  const docIds = Array.isArray(proposal.docIds) ? proposal.docIds : [];
  const draft = () => noteForSelection({ ...proposal, items }, docIds, physician, fromName);
  let coverNote = draft();
  while (coverNote.length > NOTE_BUDGET) {
    let longest = -1;
    for (const i of reportAt) {
      const p = items[i].prepared;
      if (p && p.how === "text" && (longest < 0 || p.text.length > items[longest].prepared.text.length)) longest = i;
    }
    if (longest < 0) break;
    delete items[longest].prepared;
    items[longest].notPrepared = "Too long to write into the email. Send it from its own screen.";
    coverNote = draft();
  }
  return { ...proposal, items, coverNote };
}

/**
 * `rows` (document_requests) with each OPEN row's proposal prepared from
 * `data`. Replied and dismissed rows are left as they are: their proposal is
 * the record of what was asked, and the reply already went. Rows with
 * nothing to prepare come back as the same objects.
 */
export function withPreparedReports(rows, data, { now } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let changed = false;
  const out = list.map((r) => {
    if (!r || !r.proposal || !(r.status === undefined || r.status === null || r.status === "new")) return r;
    const p = prepareProposal(r.proposal, data, { fromName: r.from_name || "", now });
    if (p === r.proposal) return r;
    changed = true;
    return { ...r, proposal: p };
  });
  return changed ? out : list;
}

/**
 * The files a prepared proposal attaches at send time, in item order, one
 * per kind: [{ file: "case_logs" | "cv", label, from, to, span, count }].
 */
export function reportFileSpecs(proposal) {
  const items = Array.isArray(proposal?.items) ? proposal.items : [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const p = it && it.status === "report" && it.prepared;
    if (!p || p.how !== "file" || !p.file || !p.label) continue;
    const key = `${p.file}|${p.from || ""}|${p.to || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** The PDF's physician line and file names, the way the app's own exports write them. */
export { physicianLabel };
