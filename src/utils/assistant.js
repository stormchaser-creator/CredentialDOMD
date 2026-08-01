import { complianceFor, findStateLicense } from "./compliance";
import { CME_PROVIDERS } from "../constants/cmeProviders";

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

const GEMINI_MODEL = "gemini-2.5-flash";

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
  locumContracts: ["facility", "location", "agency", "billTo", "coveragePeriods", "callStipend", "stipendHours", "overageHourlyRate", "orientationHourlyRate", "orientationFee", "hourlyRate", "incrementMinutes", "minCallMinutes", "notes"],
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
  return {
    today: new Date().toISOString().slice(0, 10),
    physician: { name: data.settings.name, degree: data.settings.degreeType, npi: data.settings.npi, states: allTrackedStates },
    licenses: short(data.licenses, l => ({ id: l.id, type: l.type, name: l.name, state: l.state, number: l.licenseNumber, expires: l.expirationDate })),
    privileges: short(data.privileges, p => ({ id: p.id, type: p.type, name: p.name, facility: p.facility, expires: p.expirationDate })),
    insurance: short(data.insurance, i => ({ id: i.id, type: i.type, provider: i.provider, expires: i.expirationDate })),
    cmeSummary: { entries: (data.cme || []).length, byState: cmeByState },
    cme: short(data.cme, x => ({ id: x.id, title: x.title, hours: x.hours, category: x.category, date: x.date, provider: x.provider })),
    healthRecords: short(data.healthRecords, h => ({ id: h.id, category: h.category, name: h.name, result: h.result, value: h.resultValue, expires: h.expirationDate })),
    screenings: short(data.screenings, s => ({ id: s.id, name: s.name, result: s.result, reported: s.reportDate, expires: s.expirationDate })),
    contracts: short(data.locumContracts, c => ({ id: c.id, facility: c.facility, stipend: c.callStipend, stipendHours: c.stipendHours, overageRate: c.overageHourlyRate, periods: c.coveragePeriods })),
    workLog: { entries: (data.workLog || []).length, unbilled: (data.workLog || []).filter(e => !e.invoiceId).length },
    invoices: short(data.invoices, i => ({ number: i.number, total: i.totalAmount, sent: i.sentAt?.slice(0, 10), paid: !!i.paidAt })),
    encounters: { count: (data.encounters || []).length },
    education: short(data.education, e => ({ id: e.id, type: e.type, name: e.name, institution: e.institution, graduated: e.graduationDate })),
    publications: short(data.publications, p => ({ id: p.id, name: p.name, year: p.year })),
    memberships: short(data.memberships, m => ({ id: m.id, organization: m.organization, role: m.role })),
    documents: (data.documents || []).slice(0, 80).map(d => ({
      id: d.id, name: d.name, attachedTo: attachedLabel(d.linkedTo), onDevice: !!d.data,
    })),
  };
}

const SYSTEM = (snapshot) => `You are the CredentialDOMD Assistant — the in-app AI for a physician
credential-management app used by one physician (their data is below). You are warm, direct,
and PLAIN-SPOKEN: the user is a surgeon, not a technologist. Never use developer jargon.

WHAT THE APP DOES: tracks licenses/DEA/board certs (with expirations), CME compliance per
state, hospital privileges, malpractice insurance, health records (vaccinations, titers, TB,
drug screens), background screenings, documents (scanned via AI), locum contracts + work
logging + invoices (stipend-allowance billing), and RVU capture by voice.

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

RULES:
- Answer questions about the user's own data from the snapshot; if the snapshot lacks the
  detail, say what to open in the app rather than guessing.
- DOCUMENT UPLOADS: extract EVERY data point. Map what fits into the section's known fields
  (listed below). Anything that does not fit ANY known field goes in customFields with a
  human-readable label — never drop information, never invent fields inside "fields".
  Pick the best-fitting section; when several records are present (e.g. a lab panel),
  propose several create_record actions.
- Dates are YYYY-MM-DD. Never fabricate values not present in the document/conversation.
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

FINDING CME (when asked "find me CME for X"): recommend ONLY from the VETTED PROVIDER
DIRECTORY below — the app verifies these links; never suggest a source or URL that is
not in it. Match the recommendation to the SPECIFIC gap:
- AOA Category 1-A can ONLY come from AOA-accredited sponsors (AMA PRA Category 1 credit
  maps to AOA Category 2, never 1-A). For gaps that accept any category (like an AOBS
  total-hours gap), free ACCME platforms work fine and say so.
- For state topic mandates, match the provider's topics to the mandate.
- Point them to Credentials → Find CME for the full filterable directory.

VETTED PROVIDER DIRECTORY (name | url | pricing | accreditation | note):
${PROVIDER_DIGEST}

KNOWN SECTION FIELDS:
${JSON.stringify(SECTION_FIELDS)}

USER DATA SNAPSHOT:
${JSON.stringify(snapshot)}`;

function extractBase64(dataUrl) { return dataUrl.split(",")[1]; }
function mediaType(dataUrl) { return dataUrl.slice(5, dataUrl.indexOf(";")); }

/**
 * One assistant turn. history = [{role:"user"|"model", text}], newest last
 * (the last item is the pending user message). attachment (optional) =
 * { dataUrl } for images/PDFs or { text, name } for extracted office text.
 */
export async function assistantTurn({ history, snapshot, apiKey, attachment }) {
  if (!apiKey) throw new Error("Add your AI key in Settings first — the assistant runs on it.");

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

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM(snapshot) }] },
    contents,
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  });
  const NETWORK_MSG = "Couldn't reach the AI service. That's usually a weak signal, or a guest Wi-Fi that blocks AI sites (hospital networks often do). Switch to cellular and tap Try again — your message is saved.";
  // URL built outside the retry loop so a bad key surfaces its real error
  // instead of being misdiagnosed as a network problem.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // Phones drop requests mid-flight (weak signal, screen lock, guest Wi-Fi
  // that blocks AI endpoints) — retry the network hop before giving up, and
  // abort any attempt that silently stalls so the chat never locks up.
  let response;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      break;
    } catch {
      if (attempt >= 2) throw new Error(NETWORK_MSG);
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  if (!response.ok) {
    if (response.status === 429) throw new Error("The AI is rate-limited — give it a few seconds and try again.");
    throw new Error(`The assistant couldn't reach the AI (error ${response.status}).`);
  }
  let json;
  try { json = await response.json(); }
  catch { throw new Error(NETWORK_MSG); }
  let raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
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
