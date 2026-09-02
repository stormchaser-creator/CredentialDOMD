import { complianceFor, findStateLicense } from "./compliance";
import { RENEWAL_INFO } from "../constants/renewalInfo";
import { academicYearOf, caseWRVU } from "./caseLogReport";
import { CPT_DESCS } from "../constants/cptDescs";
import { CME_PROVIDERS } from "../constants/cmeProviders";
import { geminiCall, proxyErrorMessage, anthropicAvailable, anthropicClientFor, anthropicErrorMessage, anthropicSdk } from "./aiClient";

/**
 * The in-app AI assistant. Modeled on the CallSync helper (every question
 * doubles as product feedback) but stronger in two ways:
 *  1. Guarded WRITES — the model proposes actions (create/update records,
 *     log feedback) as structured JSON; nothing executes until the user
 *     taps Approve on the action card.
 *  2. Format-flexible documents — when an upload doesn't fit any known
 *     section's fields, EVERY unmapped data point lands in customFields
 *     {label: value} on the record, so no information is ever dropped.
 */

// Vera thinks on Pro — same free AI Studio key, better judgment. The free
// tier caps Pro at far fewer requests/day than Flash, so when Pro's limit
// runs dry (429) the turn silently falls back to Flash instead of erroring.
// Pro requires a thinking budget (0 is rejected); Flash runs without one.
// responseMimeType forces syntactically-valid JSON at the API level — Gemini
// kept drifting into prose ("here is the card, tap Approve") with no card.
const CHAT_MODELS = [
  { model: "gemini-2.5-pro", generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" } },
  { model: "gemini-2.5-flash", generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } } },
];

// The app's vetted CME directory (links re-checked by the app) — the ONLY
// sources the assistant may recommend. An AI's remembered links go stale;
// these don't.
const PROVIDER_DIGEST = CME_PROVIDERS.map(p =>
  `${p.name} | ${p.url} | ${p.pricing} | ${(p.accreditation || []).join(" + ")}${p.aoaNote ? ` | NOTE: ${p.aoaNote}` : ""} | ${(p.description || "").slice(0, 90)}`
).join("\n");

// ── Known sections and their real fields (keeps the model honest) ──
export const SECTION_FIELDS = {
  licenses: ["type", "name", "licenseNumber", "state", "issuedDate", "expirationDate", "notes"],
  privileges: ["type", "name", "facility", "city", "state", "appointmentDate", "expirationDate", "notes"],
  insurance: ["type", "name", "provider", "policyNumber", "coveragePerClaim", "coverageAggregate", "effectiveDate", "expirationDate", "notes"],
  healthRecords: ["category", "type", "name", "dateAdministered", "expirationDate", "result", "resultValue", "resultUnits", "referenceRange", "collectedDate", "reportedDate", "lab", "specimenId", "orderedBy", "lotNumber", "facility", "notes"],
  education: ["type", "name", "institution", "startDate", "graduationDate", "fieldOfStudy", "honors", "notes"],
  cme: ["title", "category", "hours", "date", "provider", "certificateNumber", "topics", "notes"],
  workHistory: ["type", "position", "employer", "city", "state", "startDate", "endDate", "current", "description", "notes"],
  screenings: ["type", "name", "agency", "requestedBy", "assignment", "fileNumber", "orderDate", "reportDate", "result", "expirationDate", "components", "notes"],
  professionalPhotos: ["name", "dateTaken", "notes"],
  publications: ["name", "citation", "year", "sortOrder", "doi", "pmid", "url", "notes"],
  memberships: ["organization", "role", "startDate", "endDate", "notes"],
  locumContracts: ["facility", "location", "agency", "billTo", "coveragePeriods", "payModel", "dayRate", "callRateGrid", "callStipend", "stipendHours", "overageHourlyRate", "orientationHourlyRate", "orientationFee", "hourlyRate", "incrementMinutes", "minCallMinutes", "notes"],
};

/** Compact, privacy-lean snapshot of the user's data for grounding. */
export function buildSnapshot(data, allTrackedStates = []) {
  const short = (arr, f) => (arr || []).slice(0, 40).map(f);
  const cmeByState = {};
  for (const st of allTrackedStates) {
    try {
      const comp = complianceFor(data, st);
      const lic = findStateLicense(data.licenses, st);
      cmeByState[st] = {
        earned: comp.totalEarned, required: comp.totalRequired,
        renewal: lic?.expirationDate || null, daysLeft: comp.daysLeft,
        unmetTopics: comp.topicResults.filter(t => !t.met).map(t => t.topic),
      };
    } catch { /* state without rules */ }
  }
  // A document's identity comes from the record it's attached to — filenames
  // like IMG_0269.jpeg mean nothing. Resolve every link to a readable label.
  const attachedLabel = (ref) => {
    if (!ref) return null;
    const [sec, id] = String(ref).split(":");
    const item = (data[sec] || []).find(x => x.id === id);
    if (!item) return sec;
    const bits = [...new Set([item.type, item.name, item.title, item.institution, item.facility, item.provider, item.state].filter(Boolean))];
    return `${sec}: ${bits.slice(0, 3).join(" — ")}`;
  };
  // The surgeon's complete case log, compacted into aggregates the model can
  // count over: per-year totals, a procedure-title histogram, and a CPT-code
  // histogram with descriptions. 1,500 raw rows would drown the context;
  // histograms answer "how many EVDs" exactly.
  const caseLog = (() => {
    const cases = data.caseLogs || [];
    if (!cases.length) return null;
    const byYear = {}, byTitle = {}, byCode = {};
    for (const c of cases) {
      const ay = academicYearOf(c.date);
      byYear[ay] = byYear[ay] || { cases: 0, wRVU: 0 };
      byYear[ay].cases += 1;
      byYear[ay].wRVU = Math.round((byYear[ay].wRVU + caseWRVU(c)) * 100) / 100;
      const t = String(c.title || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
      if (t) byTitle[t] = (byTitle[t] || 0) + 1;
      for (const tok of String(c.cptCodes || "").split(",")) {
        const code = tok.trim().split(/[-\s]/)[0];
        if (code) byCode[code] = (byCode[code] || 0) + 1;
      }
    }
    const codeCounts = Object.fromEntries(Object.entries(byCode).sort((a, b) => b[1] - a[1])
      .map(([code, n]) => [code, { n, what: CPT_DESCS[code]?.d || "" }]));
    return { totalCases: cases.length, byYear, procedureCounts: byTitle, codeCounts };
  })();

  const workLogRecent = (data.workLog || [])
    .filter(e => e.type !== "CallDay")
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 50)
    .map(e => ({ date: e.date, type: e.type, billedMin: e.billedMin, desc: (e.description || "").slice(0, 60), invoiced: !!e.invoiceId }));

  return {
    today: new Date().toISOString().slice(0, 10),
    physician: {
      name: data.settings.name, degree: data.settings.degreeType, npi: data.settings.npi,
      states: allTrackedStates, specialties: data.settings.specialties,
      address: data.settings.address, website: data.settings.website, languages: data.settings.languages,
    },
    licenses: short(data.licenses, l => ({ id: l.id, type: l.type, name: l.name, state: l.state, number: l.licenseNumber, expires: l.expirationDate })),
    privileges: short(data.privileges, p => ({ id: p.id, type: p.type, name: p.name, facility: p.facility, expires: p.expirationDate })),
    insurance: short(data.insurance, i => ({ id: i.id, type: i.type, provider: i.provider, expires: i.expirationDate })),
    cmeSummary: { entries: (data.cme || []).length, byState: cmeByState },
    // Researched renewal logistics for the states this physician holds, so a
    // "how do I renew" answer can be a real walkthrough with real links.
    renewalInfo: Object.fromEntries(
      allTrackedStates.filter(st => RENEWAL_INFO[st]).map(st => {
        const r = RENEWAL_INFO[st];
        return [st, { board: r.board, portal: r.portalUrl, cycle: r.cycle, due: r.due, fee: r.fee, steps: (r.steps || []).slice(0, 6), guide: r.guideUrl }];
      })
    ),
    deaRenewal: { portal: "https://www.deadiversion.usdoj.gov/online_forms_apps.html", cycle: "3 years", fee: "$888" },
    cme: short(data.cme, x => ({ id: x.id, title: x.title, hours: x.hours, category: x.category, date: x.date, provider: x.provider })),
    healthRecords: short(data.healthRecords, h => ({ id: h.id, category: h.category, name: h.name, result: h.result, value: h.resultValue, expires: h.expirationDate })),
    screenings: short(data.screenings, s => ({ id: s.id, name: s.name, result: s.result, reported: s.reportDate, expires: s.expirationDate })),
    contracts: short(data.locumContracts, c => ({ id: c.id, facility: c.facility, payModel: c.payModel, dayRate: c.dayRate, stipend: c.callStipend, stipendHours: c.stipendHours, overageRate: c.overageHourlyRate, callRateGrid: c.callRateGrid, periods: c.coveragePeriods })),
    workLog: { entries: (data.workLog || []).length, unbilled: (data.workLog || []).filter(e => !e.invoiceId).length, recent: workLogRecent },
    invoices: short(data.invoices, i => ({ number: i.number, total: i.totalAmount, sent: i.sentAt?.slice(0, 10), paid: !!i.paidAt })),
    encounters: {
      count: (data.encounters || []).length,
      totalWRVU: Math.round((data.encounters || []).reduce((t, e) => t + (e.codes || []).reduce((u, c) => u + (c.wRVU || 0) * (c.units || 1), 0), 0) * 100) / 100,
    },
    caseLog,
    workHistory: short(data.workHistory, w => ({ id: w.id, position: w.position, employer: w.employer, from: w.startDate, to: w.current === true || w.current === "true" ? "current" : w.endDate })),
    peerReferences: short(data.peerReferences, r => ({ id: r.id, name: r.name, specialty: r.specialty, institution: r.institution })),
    malpracticeHistory: short(data.malpracticeHistory, m => ({ id: m.id, type: m.type, status: m.status, date: m.date })),
    rotations: short(data.rotations, r => ({ id: r.id, hospital: r.hospital, from: r.startDate, to: r.endDate, agency: r.agency })),
    deductibles: { count: (data.deductibles || []).length, total: Math.round((data.deductibles || []).reduce((t, d) => t + (parseFloat(d.amount) || 0), 0) * 100) / 100 },
    professionalPhotos: short(data.professionalPhotos, ph => ({ id: ph.id, name: ph.name, taken: ph.dateTaken })),
    education: short(data.education, e => ({ id: e.id, type: e.type, name: e.name, institution: e.institution, graduated: e.graduationDate })),
    publications: short(data.publications, p => ({ id: p.id, name: p.name, year: p.year })),
    memberships: short(data.memberships, m => ({ id: m.id, organization: m.organization, role: m.role })),
    documents: (data.documents || []).slice(0, 80).map(d => ({
      id: d.id, name: d.name, attachedTo: attachedLabel(d.linkedTo), onDevice: !!d.data,
    })),
  };
}

const SYSTEM_STATIC = `You are Vera — the CredentialDOMD assistant, named for verus:
truth. You are the physician's credentialing coordinator in the app: their data is below.
You are warm, direct, and PLAIN-SPOKEN: the user is a surgeon, not a technologist. Never
use developer jargon. Refer to yourself as Vera when it comes up naturally; no need to
announce it.

WHAT THE APP DOES: tracks licenses/DEA/board certs (with expirations), CME compliance per
state, hospital privileges, malpractice insurance, health records (vaccinations, titers, TB,
drug screens), background screenings, documents (scanned via AI), locum contracts + work
logging + invoices (stipend-allowance billing), RVU capture by voice, and the surgeon's
COMPLETE career case log.

YOU SEE THEIR WHOLE FILE. The snapshot below is their entire database, so never say you
cannot see their data. CASE-LOG ANALYTICS: snapshot.caseLog holds totals, per-academic-year
counts and wRVU (years run Jul 1 - Jun 30), procedureCounts (lowercased title histogram),
and codeCounts (CPT histogram with descriptions). To answer "how many X": sum EVERY
matching variant across procedureCounts (spelling varies: "evd", "evd replacement",
"crani supra tent bleed / evd") AND check codeCounts for the code; show your work
("40x 'evd' + 1x 'evd replacement' ... + code 61107 on N cases"). Surgeon shorthand:
EVD = external ventricular drain (61107); SDD = subdural drain (61154/61108); PIF =
posterior instrumented fusion; PCDF = posterior cervical decompression & fusion;
DLL = decompressive lumbar laminectomy; HLD = hemilaminectomy discectomy; TNTS =
transnasal transsphenoidal (61548/62165); DSA = diagnostic cerebral angiogram
(36221-36228); LVO thrombectomy = 61645; crani = craniotomy/craniectomy.

YOU CAN PROPOSE ACTIONS. Respond with JSON ONLY (no fences):
{
 "reply": "your conversational answer (markdown ok, keep it tight)",
 "actions": [ // optional; each renders as a card the user must APPROVE before it executes
   {"kind":"create_record","section":"licenses|privileges|insurance|healthRecords|education|cme|workHistory|screenings|professionalPhotos|locumContracts",
    "summary":"one line describing what will be created",
    "fields":{...known fields for that section...},
    "customFields":{"Label":"value", ...}},   // EVERYTHING that doesn't fit a known field
   {"kind":"update_record","section":"...","id":"<id from the data snapshot>",
    "summary":"one line","fields":{...},"customFields":{...}},
   {"kind":"update_document","id":"<doc id from the documents list>","summary":"one line",
    "name":"new descriptive filename (optional)","linkedTo":"section:recordId to attach it to (optional)"},
   {"kind":"feedback","summary":"one line","category":"bug|idea|question","text":"the feedback, verbatim-ish"},
   {"kind":"export_data","summary":"one line, e.g. 'Excel of the last 12 months of case logs'",
    "section":"caseLogs|cme|workLog|licenses|invoices","format":"xlsx|csv",
    "dateFrom":"YYYY-MM-DD (optional)","dateTo":"YYYY-MM-DD (optional)"},
   {"kind":"open_record","summary":"one line, e.g. 'Open RUHS hospital privileges'",
    "section":"privileges|licenses|cme|insurance|healthRecords|screenings|education|workHistory|peerReferences|memberships|malpracticeHistory|publications|travelDocs|caseLogs|documents|locumContracts|invoices|workLog|encounters|travelExpenses|deductibles|taskNotes",
    "id":"<record id from the snapshot when you can identify it, else omit>",
    "query":"words to find the record when no id (facility, name, state)"},   // executes immediately, no approval: it only navigates
   {"kind":"send_packet","summary":"one line, e.g. 'Send 9 documents to Jane at MedStaff'",
    "docIds":["<ids from the documents list in the snapshot>"],
    "coverNote":"short professional cover note naming the physician and listing what's enclosed",
    "missing":["items from their request the user does NOT have on file"]}
 ]
}

DOCUMENT IDENTITY: a file's name is usually a meaningless camera name (IMG_1234.jpeg).
What a document IS comes from its "attachedTo" record — a photo attached to the DO-degree
education record IS the medical diploma copy; one attached to a state license IS that
license copy; one attached to a malpractice insurance record IS a certificate of insurance.
ALWAYS match requested items against attachedTo (and the records themselves), never
against filenames alone.

CREDENTIALING PACKETS (very common): agencies send checklists ("copy of diploma, all state
licenses, DEA certs, board certificate, titers, TB test…"). When the user shares such a
request: (1) match EVERY requested item against the documents list (by attachedTo) and the
records in the snapshot, (2) propose ONE send_packet action with the docIds of everything
found, (3) put each requested item you could NOT find into "missing" — that gap list is half the value,
(4) in the reply, walk through found vs missing in plain language and suggest how to close
gaps (e.g. scan the diploma with the + button; the MMR titer shows NOT immune — a vaccine
series + re-titer will be needed, not just a copy). Documents with onDevice=false can still
be sent — the app fetches them from the cloud when possible.

RENEWALS: when asked how to renew a license, DEA registration, or anything expiring,
answer as a WALKTHROUGH, not a summary: numbered steps from renewalInfo (or the
generic board process when steps are missing), the fee and deadline when present,
and ALWAYS the direct links: the state's portal URL, and the guide URL for the
full steps and pitfalls. For DEA use deaRenewal. Cross-reference the physician's
own license record (number, expiration) in the walkthrough. If renewalInfo lacks
their state, say the app's state guide is the place to check and link
https://credentialdomd.com/states/. Never invent a fee or deadline.

NAVIGATION: when the user asks to see, open, go to, show, or "take me to" a record or a
section ("take me to RUHS privileges", "open my DEA", "show the Penrose contract"),
propose ONE open_record action with the section and the id from the snapshot (match
abbreviations to names: RUHS = Riverside University Health System, ARMC = Arrowhead
Regional, EMC = Eisenhower). If you cannot identify one record, pass a query and omit id.
Say in the reply that you are opening it. Never say you cannot navigate.

RULES:
- Answer questions about the user's own data from the snapshot; if the snapshot lacks the
  detail, say what to open in the app rather than guessing.
- DOCUMENT UPLOADS: extract EVERY data point. Map what fits into the section's known fields
  (listed below). Anything that does not fit ANY known field goes in customFields with a
  human-readable label — never drop information, never invent fields inside "fields".
  Pick the best-fitting section; when several records are present (e.g. a lab panel),
  propose several create_record actions.
- Dates are YYYY-MM-DD. Never fabricate values not present in the document/conversation.
PATIENT IDENTIFIERS — REFUSE THEM. This app holds NO protected health information by design,
and that is precisely what keeps it outside HIPAA and safe for the physician to use. If the user
gives you a patient name, MRN, or date of birth, do NOT write it into any record you propose.
Say plainly that identifiers do not belong in the app, and point them at the private note on a
work entry, which stays on their own device and never uploads. If a document they hand you
contains patient identifiers, use only the professional content and say you left the patient
details out on purpose.

COMPLIANCE QUESTIONS — NEVER claim the app is HIPAA compliant. It is not: there is no BAA
with any AI provider (chat transmits to Google's Gemini API or Anthropic's Claude API under
the user's own key, document scanning to Gemini; Gemini free-tier terms additionally permit
human review and model training), no BAA with Supabase, and no access audit trail.
If asked, say exactly that, and advise keeping patient identifiers (names, MRNs, dates of birth)
out of the app entirely — case logs are for procedures, codes, and RVUs. Never reassure a user
that clinical data is safe to enter. If they have already entered identifiers, tell them plainly
and offer to help remove them.

CLINICAL BILLING QUESTIONS — the global surgical package is REAL MONEY and REAL COMPLIANCE:
- Major procedures (craniotomy, craniectomy, spine fusion — most neurosurgery) carry a
  90-DAY GLOBAL PERIOD. Routine postoperative care by the OPERATING surgeon — rounding,
  progress notes, wound checks, family updates on that patient — is BUNDLED into the
  surgery's payment and is NOT separately billable. Minor procedures carry 0 or 10 days.
- Before answering ANY "can I bill for..." question about a postop patient, establish two
  facts (ask if the snapshot doesn't show them): WHO did the surgery, and WHEN. If it is
  the user's own patient inside the global period, the honest answer is "not separately —
  it's bundled," with the real exceptions: an UNRELATED problem (modifier 24), a decision
  for a new surgery (57), a significant separately identifiable service (25), or a formal
  split of surgical vs postop care between physicians (54/55, common in locum coverage).
- NEVER answer a coding/compliance question with breezy confidence ("definitely
  billable!"). Wrong coding advice can constitute a false claim. State what is standard,
  name the condition it depends on, and say when their coder/compliance office should
  confirm.
- Context that matters here: on stipend/hourly locum contracts the physician is paid for
  TIME either way — postop rounding still belongs on the Work tab clock even when it
  carries no separately billable code. The RVU tab is productivity tracking; global-period
  visits typically add 0 wRVU because the operation already valued them.
- TOTALS ANCHOR EVERYTHING: when a document states a total (credits earned, amount due,
  panel count), the records you propose MUST add up to that total. Per-unit boilerplate
  ("awarded 0.5 credits" per completion) is NOT the total — a transcript line reading
  "Count 7, Credits 3.5" is ONE record of 3.5 hours unless separate activities are listed.
  State the total back to the user in your reply so they can confirm it matches the paper.
- You can only read a document in the turn it is attached. If it is not attached in THIS
  turn, do not describe its contents from memory — ask for it again instead. Never invent
  line items that are not in front of you.
- CORRECTIONS: when the user says a record just created is wrong, propose update_record on
  the EXISTING record (its id is in the snapshot) — never a second create_record for the
  same thing.
- When the user suggests an improvement, reports something broken, or is clearly frustrated
  with the app itself, ALWAYS add a feedback action (their words, lightly cleaned). The
  developer reads every one — this is how the app gets better.
- NEVER say you saved, renamed, filed, or changed ANYTHING unless it happened through an
  action the user APPROVED in this conversation. If you want a change to happen, PROPOSE
  the action and let them approve it. A claimed change that didn't happen destroys trust.
- "I'll pass that along", "I'll flag this", "the developer will hear about it" are the SAME
  LIE in softer words — your words forward nothing. Any sentence implying the developer will
  see the user's point MUST be accompanied by the feedback action card in that same reply.
  When unsure, attach the card: an unneeded card costs one Dismiss tap; a phantom promise
  cost the user a ticket that never existed.
- When the user tells you what an uploaded file IS (e.g. "this is my color photo"),
  propose the right filing: a create_record in the matching section (professionalPhotos
  for headshots — the file attaches automatically on approval) and/or an update_document
  giving the file a descriptive name so future packet requests can find it. A document
  named IMG_1234.jpeg with no link is invisible to future searches.
- PARTIAL MATCHES: when a request wants a span (e.g. "COIs for the past 5 years") and the
  file has only part of it, SEND what exists and word the missing item precisely
  ("current COI included — prior-year COIs 2021-2024 missing"), never mark the whole
  item missing.
- IN-PROGRESS ITEMS: an incomplete requirement still gets its evidence SENT. If the
  request wants "2 MMR doses or immune titer" and the file has dose 1 plus a non-immune
  titer report, include BOTH documents in the packet and state the status and plan in
  the coverNote (e.g. "MMR: dose 1 administered 7/20/2026, receipt attached; dose 2
  scheduled; measles titer report attached — repeat titer to follow after the series").
  Agencies would far rather see documented progress than an unexplained gap. The
  "missing" list then names only the outstanding piece (e.g. "MMR dose 2 — scheduled").
- Deleting records is not something you can do — tell them where the trash button lives.
- EXPORTS: when the user wants a spreadsheet/Excel/CSV of their data (case logs, CME, work
  log, licenses, invoices), propose an export_data action — on approval the app builds the
  real file on their device and opens the share sheet (Save to Files, AirDrop, email).
  Compute dateFrom/dateTo from their words using snapshot.today ("last 12 months" = today
  minus one year through today). NEVER say the app can't export or point them at manual
  copy-paste — this action is exactly that feature.

FINDING CME (when asked "find me CME for X"): recommend ONLY from the VETTED PROVIDER
DIRECTORY below — the app verifies these links; never suggest a source or URL that is
not in it. Match the recommendation to the SPECIFIC gap:
- AOA Category 1-A can ONLY come from AOA-accredited sponsors delivering live or
  interactive CME. ACCME-accredited AMA PRA Category 1 credit maps to AOA Category 2
  (2-A when live or real-time interactive, 2-B when on demand, journal-type or home
  study). It is never 1-A and never 1-B on its own, so it CANNOT close a Category 1
  gap in a state that names AOA 1-A or 1-B (California's 20 hours, Arizona, Washington,
  New Mexico). Never tell a DO that AMA PRA Category 1 will satisfy one of those.
  The one route that converts it is the AOA's "Formal Request for AOA Category 1-B
  Credit for Non-Osteopathic Programs", which the CCME grants for live allopathic
  specialty programs when no equivalent osteopathic course content exists; home study
  is excluded and approval is not guaranteed.
- For gaps that accept any category (like an AOBS total-hours gap, since AOBS publishes
  no Category 1-A minimum), free ACCME platforms work fine and say so.
- For state topic mandates, match the provider's topics to the mandate.
- Point them to Credentials → Find CME for the full filterable directory.

VETTED PROVIDER DIRECTORY (name | url | pricing | accreditation | note):
${PROVIDER_DIGEST}

KNOWN SECTION FIELDS:
${JSON.stringify(SECTION_FIELDS)}`;

const snapshotBlock = (snapshot) => `USER DATA SNAPSHOT:
${JSON.stringify(snapshot)}`;

const SYSTEM = (snapshot) => `${SYSTEM_STATIC}

${snapshotBlock(snapshot)}`;

function extractBase64(dataUrl) { return dataUrl.split(",")[1]; }
function mediaType(dataUrl) { return dataUrl.slice(5, dataUrl.indexOf(";")); }

/** The reply is prose-JSON per the SYSTEM contract; parse it tolerantly. */
function parseAssistantJson(raw) {
  raw = (raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      reply: parsed.reply || "…",
      actions: Array.isArray(parsed.actions) ? parsed.actions.filter(a => a && a.kind) : [],
    };
  } catch {
    // Model answered in plain text — still useful
    return { reply: raw || "I didn't catch that — try again?", actions: [] };
  }
}

/**
 * One assistant turn. history = [{role:"user"|"model", text}], newest last
 * (the last item is the pending user message). attachment (optional) =
 * { dataUrl } for images/PDFs or { text, name } for extracted office text.
 * Vera thinks on Claude Opus whenever an Opus route exists: the user's own
 * Anthropic key first, else the shared key via ai-proxy (so every active
 * account gets Opus with nothing pasted). Otherwise she runs on Gemini: the
 * user's own key when they have one, else the shared Gemini key.
 * Pass `settings` (the whole settings object) or the loose apiKey /
 * anthropicKey pair; both shapes route the same way.
 */
export async function assistantTurn({ history, snapshot, apiKey, anthropicKey, attachment, settings }) {
  const s = settings || { apiKey, anthropicApiKey: anthropicKey };
  const ownOpusKey = !!s.anthropicApiKey;
  if (anthropicAvailable(s) && claudeCanRead(attachment)) {
    try {
      return await anthropicTurn({ history, snapshot, settings: s, attachment });
    } catch (e) {
      const A = anthropicSdk(); // set by anthropicClientFor() before any request ran
      const refused = anthropicErrorMessage(e); // the proxy, not Anthropic, said no
      if (refused) {
        // The shared Opus door is shut for now (daily cap, key not loaded,
        // beta gate, signed out): Gemini takes the turn so the chat never
        // dead-ends. aiClient already flipped the status, so the next turn
        // routes straight to Gemini and Settings reads the reason.
      } else if (ownOpusKey && A && (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError)) {
        // A bad key must surface; silently answering on Gemini would hide it.
        throw new Error("Your Anthropic API key was rejected. Check it in Settings, or clear it to use Gemini.");
      } else if (!ownOpusKey && A && (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError)) {
        // Anthropic rejected the SHARED key (forwarded verbatim by the proxy).
        // Not this user's doing: Gemini takes the turn; the failed row shows
        // in Admin > AI for the operator.
      } else if (A && (e instanceof A.RateLimitError || e instanceof A.InternalServerError || e instanceof A.APIConnectionError)) {
        // Claude briefly unreachable — Gemini (own key or shared) takes the
        // turn so the chat never dead-ends.
      } else if (A && e instanceof A.APIConnectionError) {
        throw new Error(NETWORK_MSG);
      } else if (A && e instanceof A.RateLimitError) {
        throw new Error("The AI is rate-limited — give it a few seconds and try again.");
      } else {
        // Non-transient (bad request, unknown model, SDK bug): surface it —
        // a silent downgrade would hide a real problem behind the Opus badge.
        throw new Error(e?.message || "Claude couldn't answer that turn.");
      }
    }
  }
  // Opus route present but Claude can't read this attachment type (HEIC
  // and friends): Gemini takes the turn instead.
  return geminiTurn({ history, snapshot, apiKey: s.apiKey, attachment });
}

// Claude accepts these attachment types; anything else (HEIC from the iPhone
// Files app is the common one) routes the turn to Gemini instead.
const CLAUDE_MEDIA = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]);
const claudeCanRead = (att) => !att?.dataUrl || CLAUDE_MEDIA.has(mediaType(att.dataUrl));

/**
 * Claude path, claude-opus-5. aiClient hands back the client: the user's
 * own key straight to Anthropic, or the shared key through ai-proxy (the
 * SDK is pointed at the proxy; the key itself never reaches the browser).
 */
async function anthropicTurn({ history, snapshot, settings, attachment }) {
  const client = await anthropicClientFor(settings);
  const recent = history.slice(-14);
  const messages = recent.map((m, i) => {
    const blocks = [];
    const isLast = i === recent.length - 1;
    if (isLast && attachment?.dataUrl) {
      const mt = mediaType(attachment.dataUrl);
      const data = extractBase64(attachment.dataUrl);
      blocks.push(mt === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: mt, data } });
      if (attachment.implicit) {
        blocks.push({ type: "text", text: `(The document "${attachment.name || "attachment"}" above is re-supplied from earlier in this conversation so you can re-read it — the user did not attach anything new.)` });
      }
    }
    if (isLast && attachment?.text) {
      blocks.push({ type: "text", text: `ATTACHED DOCUMENT "${attachment.name}" (extracted text${attachment.implicit ? ", re-supplied from earlier in this conversation" : ""}):\n${attachment.text}` });
    }
    blocks.push({ type: "text", text: m.text || "…" });
    return { role: m.role === "model" ? "assistant" : "user", content: blocks };
  });
  // The API requires the first message to be a user turn; a sliced-off window
  // can start mid-conversation on an assistant reply.
  while (messages.length && messages[0].role !== "user") messages.shift();

  const response = await client.messages.create({
    model: "claude-opus-5",
    // Opus thinks before answering and the cap covers thinking + reply
    // together — 16k leaves the reply room even on a hard extraction turn.
    max_tokens: 16000,
    // The big static rulebook caches across turns; only the snapshot re-bills.
    system: [
      { type: "text", text: SYSTEM_STATIC, cache_control: { type: "ephemeral" } },
      { type: "text", text: snapshotBlock(snapshot) },
    ],
    messages,
  });
  if (response.stop_reason === "refusal") {
    return { reply: "I can't help with that particular request — try rephrasing, or ask me something else about your file.", actions: [] };
  }
  if (response.stop_reason === "max_tokens") {
    return { reply: "That answer ran past my length limit and got cut off. Ask again a bit narrower — one section or a shorter date range — and I'll fit it.", actions: [] };
  }
  return parseAssistantJson(response.content.filter(b => b.type === "text").map(b => b.text).join(""));
}

const NETWORK_MSG = "Couldn't reach the AI service. That's usually a weak signal, or a guest Wi-Fi that blocks AI sites (hospital networks often do). Switch to cellular and tap Try again — your message is saved.";

/**
 * Gemini path: the brain when no Opus route exists. apiKey is the
 * user's own Gemini key (optional); without one geminiCall() rides the
 * shared key through ai-proxy.
 */
async function geminiTurn({ history, snapshot, apiKey, attachment }) {

  const contents = history.slice(-14).map((m, i) => {
    const parts = [];
    const isLast = i === history.slice(-14).length - 1;
    if (isLast && attachment?.dataUrl) {
      parts.push({ inlineData: { mimeType: mediaType(attachment.dataUrl), data: extractBase64(attachment.dataUrl) } });
      if (attachment.implicit) {
        parts.push({ text: `(The document "${attachment.name || "attachment"}" above is re-supplied from earlier in this conversation so you can re-read it — the user did not attach anything new.)` });
      }
    }
    if (isLast && attachment?.text) {
      parts.push({ text: `ATTACHED DOCUMENT "${attachment.name}" (extracted text${attachment.implicit ? ", re-supplied from earlier in this conversation" : ""}):\n${attachment.text}` });
    }
    parts.push({ text: m.text });
    return { role: m.role === "model" ? "model" : "user", parts };
  });

  const bodyFor = (tier) => ({
    systemInstruction: { parts: [{ text: SYSTEM(snapshot) }] },
    contents,
    generationConfig: tier.generationConfig,
  });
  // Phones drop requests mid-flight (weak signal, screen lock, guest Wi-Fi
  // that blocks AI endpoints) — retry the network hop before giving up, and
  // abort any attempt that silently stalls so the chat never locks up.
  // A Pro rate-limit or server error demotes to Flash rather than failing.
  let response;
  let tierIdx = 0;
  for (let attempt = 0; ; attempt++) {
    const tier = CHAT_MODELS[tierIdx];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      response = await geminiCall(`models/${tier.model}:generateContent`, bodyFor(tier), apiKey, { signal: ctrl.signal });
    } catch {
      if (attempt >= 2) throw new Error(NETWORK_MSG);
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      continue;
    } finally {
      clearTimeout(timer);
    }
    // A proxy refusal (daily quota, beta gate, key not configured) is final:
    // no point demoting to Flash, the answer would be the same.
    if (response.proxyError) break;
    if (!response.ok && tierIdx < CHAT_MODELS.length - 1 && (response.status === 429 || response.status >= 500 || response.status === 404)) {
      tierIdx += 1; // Pro exhausted or unavailable on this key — Flash takes the turn
      continue;
    }
    break;
  }
  if (!response.ok) {
    const why = proxyErrorMessage(response);
    if (why) throw new Error(why);
    if (response.status === 429) throw new Error("The AI is rate-limited — give it a few seconds and try again.");
    throw new Error(`The assistant couldn't reach the AI (error ${response.status}).`);
  }
  let json;
  try { json = await response.json(); }
  catch { throw new Error(NETWORK_MSG); }
  return parseAssistantJson(json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "");
}

/**
 * Split proposed fields into (known fields, customFields) for a section so
 * a stray key can never break the cloud insert — extras become customFields.
 */
export function splitFields(section, fields = {}, customFields = {}) {
  const known = new Set(SECTION_FIELDS[section] || []);
  const clean = {}, extra = { ...customFields };
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === "") continue;
    if (known.has(k)) clean[k] = v;
    else extra[k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase())] = String(v);
  }
  return { clean, extra: Object.keys(extra).length ? extra : null };
}
