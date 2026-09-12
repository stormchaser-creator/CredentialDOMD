// The request packet matcher (src/utils/requestPacket.js): a credentialer's
// email in, a packet proposal out, so the forward to docs@ is the last thing
// the physician types.
//
// The two requests at the top are the two real ones on file (names, numbers
// and addresses changed). Everything below runs against a catalogue built
// from a fixture shaped like the owner's own file: the section keys and type
// vocabulary are the ones the app actually stores. No licence numbers are
// invented; the matcher never reads them.
//
// scripts/request-packet-shared.test.mjs imports the fixtures from here and
// runs them through the Deno copy too, so this file only runs its checks
// when it is the script node was started with.
// Run: node scripts/request-packet.test.mjs
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  parseAsks, classifyAsk, describeEntry, matchAsk, catalogueFromRows, buildProposal, noteForSelection, KINDS, isReportKind,
} from "../src/utils/requestPacket.js";

export const NOW = "2026-09-11";
export const PHYSICIAN = { name: "Eric Whitney", degree: "DO" };

// ── Request 1: one line, no list, a map link and a disclaimer ────────────────
export const REQUEST_1 = {
  subject: "BOARD CERTIFICATE",
  fromName: "Marisol Castellano",
  fromAddr: "m.castellano@ruhealth.example",
  body: `Hello Dr Whitney

Can you please send me a copy of your board certificate.  Thank you
<https://www.google.com/maps/search/26520+Cactus+Ave+Ste+A2006?entry=gmail&source=g>

*Marisol Castellano *
*Neurosurgery Dept. *
26520 Cactus Ave Ste A2006
Moreno Valley, CA 92555
951-555-0146

RUHS Confidentiality Disclaimer
The information contained in this electronic message is intended only for the use of the individual or entity named above. If the reader of this message is not the intended recipient, you are hereby notified that any dissemination, distribution or copying of this communication is strictly prohibited. Please send documents to the sender by secure means.`,
};

// ── Request 2: a bulleted list, a PTO note, a signature and the thread below ─
export const REQUEST_2 = {
  subject: "RE: Requested docs",
  fromName: "Tonya Dombrowski",
  fromAddr: "tonya.dombrowski@weatherby.example",
  body: `jacob.rubin@weatherby.example>, nsyleaderswby <nsyleaderswby@mychg.example

Good afternoon,

Thank you! Please see below items needed for your credentialing process:

   - MPLT COI
   - MMR dose #2
   - TB form – This was sent via Docusign
   - Logs – 12-months. I have requested.

***Upcoming PTO: 08/07*

Thank you and have a great day!

Tonya Dombrowski
Sr. Medical Staff Coordinator, Hospital Privileging
Weatherby Healthcare
954-555-0100

*From:* Eric Whitney <stormchaser@elryx.com>
*Sent:* Wednesday, August 5, 2026 9:57 AM
*To:* Tonya Dombrowski
*Subject:* Re: Requested docs

Anything else pending? Please send me the notarized ID form.

On Wed, Aug 5, 2026 at 6:13 AM Tonya Dombrowski wrote:
Hello, Thank you! I do not need a hard copy of the notarized ID, the DEA and CSR were received.`,
};

// ── The owner's file, in the app's camelCase shape ───────────────────────────
export const RECORDS = {
  licenses: [
    { id: "lic-ca", type: "State Medical License (DO)", state: "CA", issuedDate: "2019-07-01", expirationDate: "2027-06-30" },
    { id: "lic-co", type: "State Medical License (DO)", state: "CO", issuedDate: "2024-01-01", expirationDate: "2026-12-31" },
    { id: "lic-nd", type: "State Medical License (DO)", state: "ND", issuedDate: "2023-01-01", expirationDate: "2025-12-31" },
    { id: "lic-dea-ca", type: "DEA Registration", state: "CA", expirationDate: "2028-03-31" },
    { id: "lic-dea-nd", type: "DEA Registration", state: "ND", expirationDate: "2026-01-31" },
    { id: "lic-board", type: "Board Certification (AOA)", name: "Neurological Surgery" },
    { id: "lic-bls", type: "BLS Certification", expirationDate: "2027-01-01" },
    { id: "lic-acls", type: "ACLS Certification", expirationDate: "2025-05-01" },
    { id: "lic-csr", type: "State Controlled Substance", state: "CA", expirationDate: "2027-02-01" },
    { id: "lic-dl", type: "Driver License", state: "CA", expirationDate: "2029-04-01" },
    { id: "lic-comlex", type: "COMLEX" },
    { id: "lic-fluoro", type: "Fluoroscopy Permit", state: "CA", expirationDate: "2027-06-30" },
  ],
  healthRecords: [
    { id: "hr-mmr1", category: "Vaccination", type: "MMR (Measles, Mumps, Rubella)", dateAdministered: "1986-03-02" },
    { id: "hr-mmr2", category: "Vaccination", type: "MMR (Measles, Mumps, Rubella)", dateAdministered: "1990-09-14" },
    { id: "hr-measles", category: "Titer / Immunity", type: "Measles (Rubeola) IgG", result: "Immune", dateAdministered: "2025-03-01" },
    { id: "hr-varicella", category: "Titer / Immunity", type: "Varicella Zoster IgG", result: "Immune", dateAdministered: "2025-03-01" },
    { id: "hr-hepb", category: "Titer / Immunity", type: "Hepatitis B Surface Antibody (HBsAb)", result: "Immune", dateAdministered: "2025-03-01" },
    { id: "hr-tb", category: "TB Test", type: "QuantiFERON-TB Gold", result: "Negative", dateAdministered: "2026-01-15", expirationDate: "2027-01-15" },
    { id: "hr-tb-old", category: "TB Test", type: "QuantiFERON-TB Gold", result: "Negative", dateAdministered: "2025-01-15", expirationDate: "2026-01-15" },
    { id: "hr-cxr", category: "TB Test", type: "Chest X-Ray", result: "No active disease", dateAdministered: "2024-06-01" },
    { id: "hr-ppd", category: "TB Test", type: "PPD (Tuberculin Skin Test)", result: "Negative", dateAdministered: "2025-06-01", expirationDate: "2026-06-01" },
    { id: "hr-tdap", category: "Vaccination", type: "Tdap (Tetanus, Diphtheria, Pertussis)", dateAdministered: "2021-05-01", expirationDate: "2031-05-01" },
    { id: "hr-flu", category: "Vaccination", type: "Influenza (Flu)", dateAdministered: "2025-10-01", expirationDate: "2026-10-01" },
    { id: "hr-covid", category: "Vaccination", type: "COVID-19", dateAdministered: "2021-02-01" },
    { id: "hr-drug", category: "Drug Screen", type: "9-Panel Urine", result: "Negative", dateAdministered: "2026-02-03" },
    { id: "hr-fit", category: "Fit Test", type: "N95 Respirator", dateAdministered: "2026-03-01", expirationDate: "2027-03-01" },
  ],
  insurance: [
    { id: "ins-coi", type: "Professional Liability", provider: "ProAssurance Specialty Insurance", effectiveDate: "2026-03-01", expirationDate: "2027-03-01" },
    { id: "ins-coi-old", type: "Professional Liability - Claims Made", provider: "ProAssurance Specialty Insurance", effectiveDate: "2025-03-01", expirationDate: "2026-03-01" },
    { id: "ins-tail", type: "Tail Coverage", provider: "Medical Protective" },
    { id: "ins-health", type: "Health Insurance (personal)", provider: "Blue Shield", expirationDate: "2026-12-31" },
  ],
  education: [
    { id: "edu-do", type: "Doctor of Osteopathic Medicine (DO)", institution: "Western University of Health Sciences", graduationDate: "2012-05-20" },
    { id: "edu-res", type: "Residency Certificate", name: "Neurological Surgery Residency", institution: "Riverside University Health System", graduationDate: "2019-06-30" },
    { id: "edu-fel", type: "Fellowship Certificate", name: "Skull Base Fellowship", institution: "Barrow Neurological Institute", graduationDate: "2020-06-30" },
    { id: "edu-bs", type: "Bachelor of Science (BS)", institution: "University of California", graduationDate: "2008-06-01" },
  ],
  screenings: [
    { id: "scr-bg", type: "Background Screening Report", agency: "ScoutLogic", reportDate: "2026-02-01" },
    { id: "scr-oig", type: "OIG / SAM Exclusion Check", agency: "Verisys", result: "No exclusions", reportDate: "2026-02-01" },
    { id: "scr-drug", type: "Drug Screen Report", agency: "Quest Diagnostics", result: "Negative", reportDate: "2026-02-03" },
    { id: "scr-fp", type: "Fingerprinting / Livescan", agency: "California DOJ", reportDate: "2026-02-05" },
  ],
  privileges: [
    { id: "priv-armc", type: "Hospital Privileges", facility: "Arrowhead Regional Medical Center", state: "CA", appointmentDate: "2025-10-01", expirationDate: "2027-09-30" },
  ],
  travelDocs: [
    { id: "td-passport", type: "Passport", provider: "US Department of State", expirationDate: "2031-01-01" },
    { id: "td-dl", type: "Driver's License", provider: "California DMV", expirationDate: "2029-04-01" },
  ],
  professionalPhotos: [{ id: "ph-1", name: "Headshot 2026", dateTaken: "2026-01-10" }],
  cme: [{ id: "cme-1", title: "Stroke update 2026", category: "AMA PRA Category 1", hours: 4, date: "2026-03-01", provider: "AANS" }],
  workHistory: [{ id: "wh-1", type: "Employment", position: "Neurosurgeon", employer: "ANMG", startDate: "2020-01-01" }],
  peerReferences: [{ id: "ref-1", name: "Jane Smith", degree: "MD", institution: "ARMC", relationship: "Colleague", email: "j@x.example", phone: "555-0100" }],
  malpracticeHistory: [{ id: "mal-1", outcome: "Dismissed", facility: "Memorial", state: "CA", dateFiled: "2021-01-01" }],
  locumContracts: [{ id: "lc-1", facility: "Rural Hospital", state: "ND" }],
  travelExpenses: [{ id: "te-1", category: "Lodging", vendor: "Marriott" }],
};

const pdf = "application/pdf", jpg = "image/jpeg";
const doc = (id, name, type, linkedTo, uploadedAt) => ({ id, name, type, linkedTo, uploadedAt });
export const DOCS = [
  doc("doc-lic-ca", "CA license.pdf", pdf, "licenses:lic-ca", "2025-07-01T10:00:00Z"),
  doc("doc-lic-co", "CO license.pdf", pdf, "licenses:lic-co", "2025-01-05T10:00:00Z"),
  doc("doc-lic-nd", "ND license.pdf", pdf, "licenses:lic-nd", "2024-01-05T10:00:00Z"),
  doc("doc-dea-ca", "DEA CA.pdf", pdf, "licenses:lic-dea-ca", "2025-04-01T10:00:00Z"),
  doc("doc-dea-nd", "DEA ND.pdf", pdf, "licenses:lic-dea-nd", "2023-02-01T10:00:00Z"),
  doc("doc-board", "AOA certificate.pdf", pdf, "licenses:lic-board", "2024-11-01T10:00:00Z"),
  doc("doc-bls", "BLS card.jpg", jpg, "licenses:lic-bls", "2025-01-10T10:00:00Z"),
  doc("doc-acls", "ACLS card.jpg", jpg, "licenses:lic-acls", "2023-05-10T10:00:00Z"),
  doc("doc-csr", "CA CSR.pdf", pdf, "licenses:lic-csr", "2025-02-10T10:00:00Z"),
  doc("doc-lic-dl", "IMG_0269.jpeg", jpg, "licenses:lic-dl", "2025-04-20T10:00:00Z"),
  doc("doc-comlex", "COMLEX transcript.pdf", pdf, "licenses:lic-comlex", "2012-06-01T10:00:00Z"),
  doc("doc-mmr1", "MMR dose 1.pdf", pdf, "healthRecords:hr-mmr1", "2025-05-01T10:00:00Z"),
  doc("doc-mmr2", "MMR dose 2.pdf", pdf, "healthRecords:hr-mmr2", "2025-06-01T10:00:00Z"),
  doc("doc-measles", "Measles IgG.pdf", pdf, "healthRecords:hr-measles", "2025-03-02T10:00:00Z"),
  doc("doc-varicella", "Varicella IgG.pdf", pdf, "healthRecords:hr-varicella", "2025-03-02T10:00:00Z"),
  doc("doc-hepb", "HBsAb.pdf", pdf, "healthRecords:hr-hepb", "2025-03-02T10:00:00Z"),
  doc("doc-tb", "QuantiFERON 2026.pdf", pdf, "healthRecords:hr-tb", "2026-01-16T10:00:00Z"),
  doc("doc-tb-old", "QuantiFERON 2025.pdf", pdf, "healthRecords:hr-tb-old", "2025-01-16T10:00:00Z"),
  doc("doc-cxr", "CXR report.pdf", pdf, "healthRecords:hr-cxr", "2024-06-02T10:00:00Z"),
  doc("doc-ppd", "PPD 2025.pdf", pdf, "healthRecords:hr-ppd", "2025-06-02T10:00:00Z"),
  doc("doc-tdap", "Tdap.pdf", pdf, "healthRecords:hr-tdap", "2021-05-02T10:00:00Z"),
  doc("doc-flu", "Flu 2025.pdf", pdf, "healthRecords:hr-flu", "2025-10-02T10:00:00Z"),
  doc("doc-covid", "COVID card.jpg", jpg, "healthRecords:hr-covid", "2021-02-02T10:00:00Z"),
  doc("doc-drug", "Drug screen.pdf", pdf, "healthRecords:hr-drug", "2026-02-04T10:00:00Z"),
  doc("doc-fit", "N95 fit test.pdf", pdf, "healthRecords:hr-fit", "2026-03-02T10:00:00Z"),
  doc("doc-coi", "COI 2026-2027.pdf", pdf, "insurance:ins-coi", "2026-03-02T10:00:00Z"),
  doc("doc-coi-old", "COI 2025-2026.pdf", pdf, "insurance:ins-coi-old", "2025-03-02T10:00:00Z"),
  doc("doc-tail", "Tail.pdf", pdf, "insurance:ins-tail", "2024-03-02T10:00:00Z"),
  doc("doc-health-ins", "Blue Shield card.jpg", jpg, "insurance:ins-health", "2026-01-02T10:00:00Z"),
  doc("doc-diploma", "Diploma.pdf", pdf, "education:edu-do", "2024-01-02T10:00:00Z"),
  doc("doc-res", "Residency certificate.pdf", pdf, "education:edu-res", "2024-01-02T10:00:00Z"),
  doc("doc-fel", "Fellowship certificate.pdf", pdf, "education:edu-fel", "2024-01-02T10:00:00Z"),
  doc("doc-bs", "BS diploma.pdf", pdf, "education:edu-bs", "2024-01-02T10:00:00Z"),
  doc("doc-bg", "Background report.pdf", pdf, "screenings:scr-bg", "2026-02-02T10:00:00Z"),
  doc("doc-oig", "OIG SAM check.pdf", pdf, "screenings:scr-oig", "2026-02-02T10:00:00Z"),
  doc("doc-scr-drug", "Quest drug screen.pdf", pdf, "screenings:scr-drug", "2026-02-04T10:00:00Z"),
  doc("doc-fp", "Livescan.pdf", pdf, "screenings:scr-fp", "2026-02-06T10:00:00Z"),
  doc("doc-priv", "ARMC reappointment letter.pdf", pdf, "privileges:priv-armc", "2025-10-02T10:00:00Z"),
  doc("doc-passport", "Passport.jpg", jpg, "travelDocs:td-passport", "2025-04-21T10:00:00Z"),
  doc("doc-td-dl", "Driver license.jpg", jpg, "travelDocs:td-dl", "2025-04-22T10:00:00Z"),
  doc("doc-photo", "headshot.png", "image/png", "professionalPhotos:ph-1", "2026-01-11T10:00:00Z"),
  doc("doc-cme", "Stroke update certificate.pdf", pdf, "cme:cme-1", "2026-03-02T10:00:00Z"),
  doc("doc-wh", "ANMG verification.pdf", pdf, "workHistory:wh-1", "2025-01-02T10:00:00Z"),
  doc("doc-ref", "Smith letter.pdf", pdf, "peerReferences:ref-1", "2025-01-02T10:00:00Z"),
  doc("doc-mal", "Closure.pdf", pdf, "malpracticeHistory:mal-1", "2025-01-02T10:00:00Z"),
  doc("doc-contract", "ND locum agreement license terms.pdf", pdf, "locumContracts:lc-1", "2026-05-02T10:00:00Z"),
  doc("doc-receipt", "Marriott receipt.pdf", pdf, "travelExpenses:te-1", "2026-05-03T10:00:00Z"),
  doc("doc-cv", "Eric Whitney CV 2026.pdf", pdf, null, "2026-04-01T10:00:00Z"),
  doc("doc-img", "IMG_4412.jpeg", jpg, null, "2026-04-02T10:00:00Z"),
  { id: "doc-checklist", name: "Credentialing checklist.pdf", type: "request-attachment-inbox", mimeType: pdf, linkedTo: null, uploadedAt: "2026-08-05T10:00:00Z" },
  doc("doc-orphan", "DEA renewal.pdf", pdf, "licenses:gone", "2026-01-02T10:00:00Z"),
];

export const CATALOGUE = catalogueFromRows(DOCS, RECORDS);

// The fluoroscopy permit record has no document in DOCS (one test relies on
// that to show a record without a file stays out of the catalogue), so the
// file that answers a fluoroscopy ask lives in this second set.
export const DOCS_WITH_FLUORO = [...DOCS, doc("doc-fluoro", "Fluoro permit.pdf", pdf, "licenses:lic-fluoro", "2025-07-02T10:00:00Z")];
export const CATALOGUE_WITH_FLUORO = catalogueFromRows(DOCS_WITH_FLUORO, RECORDS);

// A physician whose profile has a degree but no name yet.
export const PHYSICIAN_NO_NAME = { name: "", degree: "DO" };

const isMain = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

// ── Synthetic requests, shared with the parity test ─────────────────────────
export const REQUESTS = {
  outlookNumbered: {
    subject: "Credentialing packet",
    fromName: "Castellano, Marisol",
    fromAddr: "m.castellano@ruhealth.example",
    body: `CAUTION: This email originated from outside of the organization. Do not click links or open attachments unless you recognize the sender.

Dr. Whitney,

We need the following to complete your file:

1. Copy of your current DEA
2) Copies of your state licenses (all of them)
3. Updated CV
4. Signed attestation form (sent via Docusign)
[ ] Please provide your current ACLS card
• Attach your Hep B titer
* Passport photo

Thanks,
Marisol

-----Original Message-----
From: Eric Whitney
Sent: Monday
Subject: Re: Credentialing packet

Please send me the notarized ID form.`,
  },
  sentenceOnly: {
    subject: "Fwd: Re: Quick question",
    fromName: "Dr. Tonya Dombrowski",
    fromAddr: "tonya@weatherby.example",
    body: `Hi Dr. Whitney, could you send over your malpractice COI and your driver's license when you get a chance?

Thank you so much!

On Tue, Sep 1, 2026 at 8:00 AM Eric Whitney <stormchaser@elryx.com> wrote:
> Happy to. Which documents?`,
  },
  nothingOnFile: {
    subject: "Documents",
    fromName: "RUHS Medical Staff Office",
    fromAddr: "medstaff@ruhealth.example",
    body: `Please send:
- NPI letter
- Peer references
- Case logs for the last 24 months
- Colorado DEA`,
  },
  subjectOnly: { subject: "Re: Fwd: DEA certificate", fromName: "", fromAddr: "x@y.example", body: "" },
  empty: { subject: "", fromName: null, fromAddr: "x@y.example", body: "   \n\n  " },
  emDashes: {
    subject: "Re: docs \u2014 today",
    fromName: "Marisol \u2014 RUHS",
    fromAddr: "m@ruhealth.example",
    body: "- TB form \u2014 sent via Docusign\n- Logs \u2014 12 months\n- W-9 \u2014 signed",
  },
  heading: {
    subject: "Immunizations",
    fromName: "Tonya Dombrowski, CPCS",
    fromAddr: "t@weatherby.example",
    body: `Still missing:
- Immunizations:
   o MMR
   o Varicella titer
- Hep B surface antibody and titer
- OIG / SAM
- BLS/ACLS
- Residency and fellowship certificates`,
  },
  gmailQuote: {
    subject: "Re: privileges",
    fromName: "Marisol Castellano",
    fromAddr: "m@ruhealth.example",
    body: `Please forward your reappointment letter and a headshot.

Regards,
Marisol

> On Aug 1, 2026, Eric Whitney wrote:
> - DEA
> - CSR`,
  },
  // The compound lines that once lost a state, a card or a vaccine: two
  // states in one item, a state written once for two items, a parenthesised
  // pair, a colon-separated list, a "diploma" that is a training
  // certificate, a Livescan, and a form the rules cannot name.
  compounds: {
    subject: "Colorado file",
    fromName: "Kyle Ortega",
    fromAddr: "k.ortega@penrose.example",
    body: `Dr. Whitney,

For the Colorado file we need the following.

- Colorado and North Dakota licenses
- Colorado and California DEA
- Copy of your DEA and CSR for the state of Colorado
- Life support cards (BLS/ACLS)
- Immunization records: MMR, Varicella, Hep B, Tdap
- Residency diploma
- Livescan
- Signed attestation form (attached)

Thanks,
Kyle`,
  },
};

if (isMain) {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
  };
  const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };
  const ids = (ask, cat = CATALOGUE) => matchAsk(classifyAsk(ask), cat, NOW).map((e) => e.id);
  const kindOf = (ask) => classifyAsk(ask).kind;

  // ── Request 1, end to end ─────────────────────────────────────────────────
  {
    const asks = parseAsks(REQUEST_1.body, REQUEST_1.subject);
    eq("R1: one ask, the sentence, cleaned to the item", asks, ["board certificate"]);
    eq("R1: it is a board certificate", classifyAsk(asks[0]), { kind: "board_cert", state: null, all: false, focus: null });
    eq("R1: matched to the AOA certificate", ids(asks[0]), ["doc-board"]);
    const p = buildProposal(REQUEST_1, CATALOGUE, PHYSICIAN, NOW);
    eq("R1: proposal shape", Object.keys(p), ["v", "method", "items", "docIds", "missing", "coverNote"]);
    eq("R1: version and method", [p.v, p.method], [1, "rules"]);
    eq("R1: one found item with its label", p.items,
      [{ ask: "board certificate", kind: "board_cert", status: "found", docIds: ["doc-board"], labels: ["Board Certification (AOA)"] }]);
    eq("R1: docIds and nothing missing", [p.docIds, p.missing], [["doc-board"], []]);
    eq("R1: the cover note", p.coverNote,
      "Hello Marisol,\n\nAttached are the documents you asked for:\n- Board Certification (AOA)\n\nRegards,\nEric Whitney, DO");
    ok("R1: the disclaimer's 'send documents' sentence is not an ask", !asks.some((a) => /sender|secure/i.test(a)));
  }

  // ── Request 2, end to end ─────────────────────────────────────────────────
  {
    const asks = parseAsks(REQUEST_2.body, REQUEST_2.subject);
    eq("R2: four asks, notes and commentary stripped", asks, ["MPLT COI", "MMR dose #2", "TB form", "Logs 12-months"]);
    eq("R2: kinds", asks.map(kindOf), ["coi_malpractice", "mmr", "tb", "case_logs"]);
    const p = buildProposal(REQUEST_2, CATALOGUE, PHYSICIAN, NOW);
    eq("R2: statuses", p.items.map((i) => i.status), ["found", "found", "found", "report"]);
    eq("R2: the COI is the unexpired one", p.items[0].docIds, ["doc-coi"]);
    eq("R2: its label", p.items[0].labels, ["Professional Liability COI, ProAssurance Specialty Insurance"]);
    eq("R2: MMR is a series: both doses and the titer", p.items[1].docIds, ["doc-mmr2", "doc-mmr1", "doc-measles"]);
    eq("R2: MMR labels", p.items[1].labels,
      ["MMR (Measles, Mumps, Rubella) vaccination", "MMR (Measles, Mumps, Rubella) vaccination", "Measles (Rubeola) IgG titer, Immune"]);
    eq("R2: TB is the current QuantiFERON, not last year's", p.items[2].docIds, ["doc-tb"]);
    eq("R2: TB label", p.items[2].labels, ["QuantiFERON-TB Gold, Negative"]);
    eq("R2: case logs are a report, not a file", [p.items[3].status, p.items[3].docIds], ["report", []]);
    eq("R2: docIds unique in item order", p.docIds, ["doc-coi", "doc-mmr2", "doc-mmr1", "doc-measles", "doc-tb"]);
    eq("R2: missing lists the report", p.missing, ["Logs 12-months"]);
    eq("R2: the cover note", p.coverNote, [
      "Hello Tonya,", "",
      "Attached are the documents you asked for:",
      "- Professional Liability COI, ProAssurance Specialty Insurance",
      "- MMR (Measles, Mumps, Rubella) vaccination",
      "- MMR (Measles, Mumps, Rubella) vaccination",
      "- Measles (Rubeola) IgG titer, Immune",
      "- QuantiFERON-TB Gold, Negative", "",
      "These will follow separately:",
      "- Logs 12-months", "",
      "Regards,", "Eric Whitney, DO",
    ].join("\n"));
    ok("R2: the quoted history produced no ask (notarized ID, DEA, CSR are old news)",
      !asks.some((a) => /notarized|\bid\b|dea|csr|anything/i.test(a)), asks.join(" | "));
    ok("R2: the PTO note and the signature title produced no ask", !asks.some((a) => /pto|privileging|coordinator/i.test(a)));
    // Only one MMR dose on file: the proposal still attaches what exists.
    const oneDose = CATALOGUE.filter((e) => e.id !== "doc-mmr1" && e.id !== "doc-measles");
    eq("R2: one dose on file still attaches that dose", ids("MMR dose #2", oneDose), ["doc-mmr2"]);
  }

  // ── Classification, one ask at a time ─────────────────────────────────────
  const table = [
    ["Copy of your current DEA", "dea"], ["every DEA", "dea"], ["DEA controlled substance registration", "dea"],
    ["CSR", "csr"], ["State controlled substance license", "csr"],
    ["Board certificate", "board_cert"], ["board certification", "board_cert"], ["ABMS", "board_cert"], ["AOA certificate", "board_cert"],
    ["State license", "state_license"], ["medical license", "state_license"], ["California license", "state_license"],
    ["Diploma", "diploma"], ["medical school diploma", "diploma"], ["Residency certificate", "residency_cert"],
    ["Residency diploma", "residency_cert"], ["Residency certificate or diploma", "residency_cert"], ["Fellowship diploma", "fellowship_cert"],
    ["fellowship certificate", "fellowship_cert"], ["MPLT COI", "coi_malpractice"], ["COI", "coi_malpractice"],
    ["Malpractice", "coi_malpractice"], ["certificate of insurance", "coi_malpractice"], ["liability coverage", "coi_malpractice"],
    ["claims history", "coi_malpractice"], ["MMR dose #2", "mmr"], ["measles titer", "mmr"], ["rubella IgG", "mmr"],
    ["Hep B", "hep_b"], ["hepatitis b surface antibody", "hep_b"], ["varicella", "varicella"], ["chickenpox titer", "varicella"],
    ["Tdap", "tdap"], ["tetanus", "tdap"], ["TB form", "tb"], ["PPD", "tb"], ["quantiferon", "tb"], ["chest x-ray", "tb"],
    ["flu shot", "flu"], ["influenza vaccine", "flu"], ["covid vaccine card", "covid"], ["drug screen", "drug_screen"],
    ["urine drug test", "drug_screen"], ["titers", "titers"], ["immunizations", "immunizations"], ["vaccination record", "immunizations"],
    ["immunization record", "immunizations"], ["background check", "background"], ["background screening", "background"],
    ["Fingerprint clearance", "fingerprint"], ["Fingerprints", "fingerprint"], ["Livescan", "fingerprint"], ["Live scan receipt", "fingerprint"],
    ["OIG", "oig"], ["SAM", "oig"], ["exclusion check", "oig"], ["Photo ID", "photo_id"], ["government ID", "photo_id"],
    ["driver's license", "photo_id"], ["Passport", "passport"], ["headshot", "headshot"], ["photo", "headshot"],
    ["CV", "cv"], ["curriculum vitae", "cv"], ["resume", "cv"], ["NPI", "npi"], ["Logs 12-months", "case_logs"],
    ["case logs", "case_logs"], ["procedure log", "case_logs"], ["privileges", "privileges"], ["reappointment letter", "privileges"],
    ["delineation of privileges", "privileges"], ["BLS", "bls"], ["ACLS card", "acls"], ["ATLS", "atls"],
    ["references", "references"], ["peer references", "references"], ["work history", "work_history"],
    ["employment verification", "work_history"], ["ECFMG", "ecfmg"], ["USMLE", "usmle"], ["COMLEX", "usmle"],
    ["CME", "cme"], ["continuing education", "cme"], ["fit test", "fit_test"], ["N95", "fit_test"],
    ["W-9", "unknown"], ["signed attestation", "unknown"], ["health insurance card", "unknown"], ["medical school transcript", "unknown"],
    // "ID" on its own is an identifier, not a photo ID: these three once
    // each sent the driver's licence.
    ["CAQH ID and password", "unknown"], ["Tax ID (W-9)", "unknown"], ["Medicaid ID", "unknown"], ["I.D.", "unknown"],
    ["government issued ID", "photo_id"], ["government-issued ID", "photo_id"], ["state issued ID", "photo_id"], ["ID card", "photo_id"],
    ["photo I.D.", "photo_id"], ["valid ID", "photo_id"], ["legible ID", "photo_id"], ["notarized ID", "photo_id"], ["identification card", "photo_id"],
    ["Valid driver's license", "photo_id"], ["Legible copy of your DEA", "dea"],
    // A fluoroscopy permit is a licence that is not the medical licence.
    ["Copy of fluoroscopy license", "fluoroscopy"], ["Fluoroscopy permit", "fluoroscopy"], ["Fluoroscopy supervisor and operator permit", "fluoroscopy"],
    ["X-ray supervisor permit", "fluoroscopy"], ["xray license", "fluoroscopy"], ["radiation permit", "fluoroscopy"], ["Radiology license", "fluoroscopy"],
    ["Chest x-ray", "tb"], ["state license", "state_license"],
  ];
  for (const [ask, kind] of table) eq(`classify "${ask}"`, kindOf(ask), kind);
  ok("every kind the classifier names is in KINDS", table.every(([, k]) => KINDS.includes(k)));
  eq("the report kinds", KINDS.filter(isReportKind), ["case_logs", "cv", "references", "work_history", "npi"].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b)));

  // ── State and the all flag ────────────────────────────────────────────────
  eq("Colorado is read as CO", classifyAsk("copy of your Colorado license"), { kind: "state_license", state: "CO", all: false, focus: null });
  eq("a capital code beside a licence word counts", classifyAsk("CA license").state, "CA");
  eq("MD is a degree, not Maryland", classifyAsk("MD license").state, null);
  eq("West Virginia is not Virginia", classifyAsk("West Virginia license").state, "WV");
  eq("Washington DC is DC", classifyAsk("Washington, D.C. license").state, "DC");
  eq("all state licenses", classifyAsk("all state licenses"), { kind: "state_license", state: null, all: true, focus: null });
  eq("every DEA", classifyAsk("every DEA").all, true);
  eq("a plain DEA is not all", classifyAsk("DEA").all, false);
  // The code lookahead once knew "dea" but not "DEA", so "Copy of your ND
  // DEA" read no state and the California DEA went out for North Dakota.
  eq("a capital code before a capitalised licence word counts", classifyAsk("Copy of your ND DEA"), { kind: "dea", state: "ND", all: false, focus: null });
  eq("the words around the code may be in any case", [classifyAsk("CO License").state, classifyAsk("ND State Medical License").state, classifyAsk("CA DEA Registration").state], ["CO", "ND", "CA"]);
  eq("the code itself must be in capitals", [classifyAsk("nd dea").state, classifyAsk("co license").state, classifyAsk("for co").state], [null, null, null]);
  eq("the parenthesised form counts", [classifyAsk("DEA (ND)").state, classifyAsk("License (CA)").state, classifyAsk("Licenses (CO)").state, classifyAsk("CSR (CO)").state], ["ND", "CA", "CO", "CO"]);
  eq("a preposition before the code counts", [classifyAsk("in ND").state, classifyAsk("for CO").state, classifyAsk("state of CA").state, classifyAsk("For CO").state], ["ND", "CO", "CA", "CO"]);
  eq("MD, DO and ID are never states, in any position", [classifyAsk("MD license").state, classifyAsk("DO license").state, classifyAsk("DEA (MD)").state, classifyAsk("in ID").state, classifyAsk("ID card").state, classifyAsk("id card").state], [null, null, null, null, null, null]);
  eq("a degree before the licence word does not hide a state after it", classifyAsk("MD license for CO").state, "CO");
  eq("a code that is not a state is not a state", [classifyAsk("US DEA").state, classifyAsk("NP license").state], [null, null]);

  // ── Matching: state filter, expiry order, all, series ─────────────────────
  eq("the Colorado licence, not CA or ND", ids("copy of your Colorado license"), ["doc-lic-co"]);
  eq("a Colorado DEA is not on file, so nothing (not the CA one)", ids("Colorado DEA"), []);
  eq("an ND DEA ask gets the expired ND DEA, not the live California one", [ids("Copy of your ND DEA"), ids("DEA (ND)"), ids("ND DEA Registration")], [["doc-dea-nd"], ["doc-dea-nd"], ["doc-dea-nd"]]);
  eq("License (CA) is the California licence", ids("License (CA)"), ["doc-lic-ca"]);
  eq("all state licences: unexpired first, later expiration first, expired last",
    ids("all state licenses"), ["doc-lic-ca", "doc-lic-co", "doc-lic-nd"]);
  eq("every DEA: the live one, then the expired one", ids("every DEA"), ["doc-dea-ca", "doc-dea-nd"]);
  eq("a single DEA is the live one", ids("DEA"), ["doc-dea-ca"]);
  eq("the COI is the current policy", ids("COI"), ["doc-coi"]);
  eq("TB is this year's QuantiFERON", ids("TB"), ["doc-tb"]);
  eq("an expired ACLS is still offered when it is all there is", ids("ACLS"), ["doc-acls"]);
  // An expired pick is still the pick, and the label says so: the checklist
  // once ticked "DEA Registration, ND" and the note opened "Attached are the
  // documents you asked for:" over a registration that had lapsed in
  // January, and the credentialer wrote back.
  {
    const labelsFor = (body) => buildProposal({ subject: "docs", fromName: "Sam", fromAddr: "s@x.example", body }, CATALOGUE, PHYSICIAN, NOW).items.map((i) => i.labels);
    eq("the expired ND DEA is labelled expired, with the date", labelsFor("- Copy of your ND DEA"), [["DEA Registration, ND, expired 2026-01-31"]]);
    eq("the expired PPD is labelled expired", labelsFor("- PPD"), [["PPD (Tuberculin Skin Test), Negative, expired 2026-06-01"]]);
    eq("the expired ND licence is labelled expired", labelsFor("- North Dakota license"), [["State Medical License (DO), ND, expired 2025-12-31"]]);
    eq("a live document carries no date", labelsFor("- DEA\n- CA license"), [["DEA Registration, CA"], ["State Medical License (DO), CA"]]);
    eq("a record with no expiration carries no date", labelsFor("- Board certificate"), [["Board Certification (AOA)"]]);
    eq("the date is judged against `now`: the ND DEA was live in 2025", buildProposal({ subject: "docs", fromName: "Sam", fromAddr: "s@x.example", body: "- Copy of your ND DEA" }, CATALOGUE, PHYSICIAN, "2025-12-01").items[0].labels, ["DEA Registration, ND"]);
    const p = buildProposal({ subject: "docs", fromName: "Sam", fromAddr: "s@x.example", body: "- Copy of your ND DEA\n- PPD" }, CATALOGUE, PHYSICIAN, NOW);
    ok("the cover note carries the expiry beside each attached document", p.coverNote.includes("Attached are the documents you asked for:\n- DEA Registration, ND, expired 2026-01-31\n- PPD (Tuberculin Skin Test), Negative, expired 2026-06-01"));
    eq("a trimmed note keeps the expiry too", noteForSelection(p, ["doc-dea-nd"], PHYSICIAN, "Sam"),
      "Hello Sam,\n\nAttached are the documents you asked for:\n- DEA Registration, ND, expired 2026-01-31\n\nNot enclosed this time:\n- PPD\n\nRegards,\nEric Whitney, DO");
    ok("all state licences: only the lapsed one is dated", (() => {
      const l = labelsFor("- all state licenses")[0];
      return l[0] === "State Medical License (DO), CA" && l[1] === "State Medical License (DO), CO" && l[2] === "State Medical License (DO), ND, expired 2025-12-31";
    })());
  }
  eq("MMR returns the series", ids("MMR"), ["doc-mmr2", "doc-mmr1", "doc-measles"]);
  eq("titers returns every titer", ids("titers").sort(), ["doc-hepb", "doc-measles", "doc-varicella"]);
  eq("immunizations returns every vaccination and titer", ids("immunizations").length, 8);
  eq("Hep B returns one record", ids("Hep B"), ["doc-hepb"]);
  eq("a drug screen prefers the health record but knows the screening report",
    [ids("drug screen"), matchAsk({ kind: "drug_screen", state: null, all: true }, CATALOGUE, NOW).map((e) => e.id)],
    [["doc-drug"], ["doc-drug", "doc-scr-drug"]]);
  eq("background check is the background report, not the Livescan", ids("background check"), ["doc-bg"]);
  eq("Livescan is the Livescan record, not the background report", [ids("Livescan"), ids("Fingerprint clearance"), ids("Fingerprints")], [["doc-fp"], ["doc-fp"], ["doc-fp"]]);
  eq("fingerprints fall back to the background report when no Livescan is on file", ids("Livescan", CATALOGUE.filter((e) => e.id !== "doc-fp")), ["doc-bg"]);
  eq("a residency diploma is the residency certificate, not the medical-school diploma", [ids("Residency diploma"), ids("Residency certificate or diploma")], [["doc-res"], ["doc-res"]]);
  eq("health insurance is never a malpractice match", ids("malpractice").includes("doc-health-ins"), false);
  eq("the diploma is the DO degree, not the BS", ids("diploma"), ["doc-diploma"]);
  eq("photo ID: the travel-docs licence first", ids("photo ID"), ["doc-td-dl"]);
  eq("photo ID: then the licences-section driver licence", ids("photo ID", CATALOGUE.filter((e) => e.id !== "doc-td-dl")), ["doc-lic-dl"]);
  eq("photo ID: then the passport", ids("photo ID", CATALOGUE.filter((e) => e.id !== "doc-td-dl" && e.id !== "doc-lic-dl")), ["doc-passport"]);
  eq("CV is found by filename on an unlinked document", ids("CV"), ["doc-cv"]);
  eq("CV without one on file matches nothing", ids("CV", CATALOGUE.filter((e) => e.id !== "doc-cv")), []);
  eq("NPI, references and case logs never match a document", [ids("NPI"), ids("references"), ids("case logs")], [[], [], []]);
  eq("a record without a document is not in the catalogue", CATALOGUE.some((e) => /fluoro/i.test(e.recType || "")), false);
  // A fluoroscopy ask once fell through to state_license and mailed the
  // medical licence. With the permit on file it goes; without it, nothing
  // does, and in particular not the medical licence.
  eq("fluoroscopy: the permit when it is on file", ids("Copy of fluoroscopy license", CATALOGUE_WITH_FLUORO), ["doc-fluoro"]);
  eq("fluoroscopy: its label", matchAsk(classifyAsk("fluoroscopy permit"), CATALOGUE_WITH_FLUORO, NOW).map(describeEntry), ["Fluoroscopy Permit, CA"]);
  eq("fluoroscopy: nothing when no permit is on file, and never the medical licence", [ids("Copy of fluoroscopy license"), ids("X-ray supervisor permit"), ids("radiology license")], [[], [], []]);
  ok("fluoroscopy sits before state_license in KINDS", KINDS.indexOf("fluoroscopy") >= 0 && KINDS.indexOf("fluoroscopy") < KINDS.indexOf("state_license"));
  {
    const p = buildProposal({ subject: "Fluoro", fromName: "Kim", fromAddr: "k@x.example", body: "- Copy of fluoroscopy license\n- State license" }, CATALOGUE, PHYSICIAN, NOW);
    eq("fluoroscopy in a proposal: missing, with the medical licence attached only for the licence ask",
      p.items.map((i) => [i.kind, i.status, i.docIds]), [["fluoroscopy", "missing", []], ["state_license", "found", ["doc-lic-ca"]]]);
    ok("fluoroscopy in a proposal: the note says it is not on file, not that it is attached and not that it will follow", p.coverNote.includes("Not on file:\n- fluoroscopy license") && !p.coverNote.includes("follow"));
  }
  // A word inside a broad kind picks the document that carries it. The COI
  // bucket ranks the current policy first, so "tail coverage" kept sending
  // the current COI; the TB bucket ranks this year's QuantiFERON first, so
  // "chest x-ray" sent that. Without the word, the newest unexpired wins as
  // before; when nothing on file carries the word, the bucket stands in.
  eq("tail coverage is the tail certificate, not the current COI", ids("Tail coverage certificate"), ["doc-tail"]);
  eq("COI is still the current policy", ids("COI"), ["doc-coi"]);
  eq("claims-made names the claims-made policy even though it has expired", ids("Claims-made COI"), ["doc-coi-old"]);
  eq("an occurrence policy is not on file, so the bucket's best stands in", ids("Occurrence policy COI"), ["doc-coi"]);
  eq("chest x-ray is the film, not the QuantiFERON", [ids("Chest x-ray report"), ids("CXR")], [["doc-cxr"], ["doc-cxr"]]);
  eq("PPD is the PPD, expired or not", [ids("PPD"), ids("TB skin test"), ids("TST")], [["doc-ppd"], ["doc-ppd"], ["doc-ppd"]]);
  eq("QuantiFERON is this year's QuantiFERON", [ids("QuantiFERON"), ids("IGRA"), ids("T-spot")], [["doc-tb"], ["doc-tb"], ["doc-tb"]]);
  eq("TB test carries no word, so the newest unexpired wins as before", [ids("TB test"), ids("TB form"), ids("TB")], [["doc-tb"], ["doc-tb"], ["doc-tb"]]);
  eq("PPD with only QuantiFERONs on file still gets the QuantiFERON", ids("PPD", CATALOGUE.filter((e) => e.id !== "doc-ppd")), ["doc-tb"]);
  eq("the focus is on the classification", [classifyAsk("Tail coverage certificate").focus, classifyAsk("Chest x-ray report").focus, classifyAsk("PPD").focus, classifyAsk("COI").focus, classifyAsk("Hep B surface antibody").focus], ["tail", "chest_xray", "ppd", null, "hbsab"]);
  {
    const hepDose = catalogueFromRows(
      [...DOCS, doc("doc-hepb-dose", "Hep B dose 3.pdf", pdf, "healthRecords:hr-hepb-dose", "2026-05-02T10:00:00Z")],
      { ...RECORDS, healthRecords: [...RECORDS.healthRecords, { id: "hr-hepb-dose", category: "Vaccination", type: "Hepatitis B", dateAdministered: "2026-05-01", expirationDate: "2036-05-01" }] });
    eq("Hep B surface antibody is the titer, not the newer dose", [ids("Hep B surface antibody", hepDose), ids("HBsAb", hepDose), ids("Hep B", hepDose)], [["doc-hepb"], ["doc-hepb"], ["doc-hepb-dose"]]);
  }
  eq("the focus does not narrow a series or an 'all' ask", [ids("all tail coverage").length, ids("every chest x-ray").length], [3, 4]);
  eq("an unknown ask matches nothing", ids("signed attestation"), []);
  eq("CME is only attached when CME is asked for", [ids("CME"), ids("certificate").includes("doc-cme")], [["doc-cme"], false]);
  ok("a locum contract or a receipt is never attached, whatever its name",
    ["license", "all state licenses", "every DEA", "contract", "receipt", "agreement"].every((a) => !ids(a).some((id) => id === "doc-contract" || id === "doc-receipt")));
  {
    const planted = [
      { id: "x1", section: "travelExpenses", recType: "DEA Registration", category: null, state: "CA", name: null, provider: null, result: null, fileName: "DEA.pdf", mime: null, expiration: null, uploadedAt: null },
      { id: "x2", section: "locumContracts", recType: "State Medical License (DO)", category: null, state: "CA", name: null, provider: null, result: null, fileName: "lic.pdf", mime: null, expiration: null, uploadedAt: null },
      { id: "x3", section: "cme", recType: "Board Certification (AOA)", category: null, state: null, name: null, provider: null, result: null, fileName: "b.pdf", mime: null, expiration: null, uploadedAt: null },
    ];
    eq("planted entries in the forbidden sections never come back", [ids("DEA", planted), ids("CA license", planted), ids("board certificate", planted)], [[], [], []]);
  }
  eq("a null catalogue is an empty one", matchAsk(classifyAsk("DEA"), null, NOW), []);
  ok("the clock defaults to today when none is passed", matchAsk(classifyAsk("DEA"), CATALOGUE).length === 1);

  // ── The catalogue ─────────────────────────────────────────────────────────
  const snake = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
  const snakeRecords = Object.fromEntries(Object.entries(RECORDS).map(([k, rows]) => [k, rows.map(snake)]));
  const snakeDocs = DOCS.map((d) => ({ id: d.id, name: d.name, mime_type: d.mimeType || (d.type && d.type.includes("/") ? d.type : null), linked_to: d.linkedTo, uploaded_at: d.uploadedAt }));
  eq("snake_case rows build the same catalogue as the app's camelCase", catalogueFromRows(snakeDocs, snakeRecords), CATALOGUE);
  eq("one entry per document", CATALOGUE.length, DOCS.length);
  eq("entry shape", Object.keys(CATALOGUE[0]),
    ["id", "section", "recType", "category", "state", "name", "provider", "result", "fileName", "mime", "expiration", "uploadedAt"]);
  eq("a linked licence carries its record", CATALOGUE.find((e) => e.id === "doc-dea-nd"),
    { id: "doc-dea-nd", section: "licenses", recType: "DEA Registration", category: null, state: "ND", name: null, provider: null, result: null,
      fileName: "DEA ND.pdf", mime: "application/pdf", expiration: "2026-01-31", uploadedAt: "2023-02-01T10:00:00Z" });
  eq("an orphan link is unlinked, typed from the filename", [CATALOGUE.find((e) => e.id === "doc-orphan").section, CATALOGUE.find((e) => e.id === "doc-orphan").recType], ["", "DEA renewal"]);
  eq("an inbox attachment keeps its real MIME type", CATALOGUE.find((e) => e.id === "doc-checklist").mime, "application/pdf");
  eq("a state typed in full is stored as a code", catalogueFromRows([{ id: "d", name: "x.pdf", linked_to: "licenses:l" }], { licenses: [{ id: "l", type: "DEA Registration", state: "Colorado" }] })[0].state, "CO");
  eq("no docs, no entries", [catalogueFromRows(null, RECORDS), catalogueFromRows([], null)], [[], []]);

  // ── describeEntry ─────────────────────────────────────────────────────────
  const entry = (id) => CATALOGUE.find((e) => e.id === id);
  eq("board certificate label", describeEntry(entry("doc-board")), "Board Certification (AOA)");
  eq("DEA label carries the state", describeEntry(entry("doc-dea-nd")), "DEA Registration, ND");
  eq("vaccination label", describeEntry(entry("doc-mmr1")), "MMR (Measles, Mumps, Rubella) vaccination");
  eq("TB label carries the result", describeEntry(entry("doc-tb")), "QuantiFERON-TB Gold, Negative");
  eq("COI label carries the carrier", describeEntry(entry("doc-coi")), "Professional Liability COI, ProAssurance Specialty Insurance");
  eq("titer label", describeEntry(entry("doc-varicella")), "Varicella Zoster IgG titer, Immune");
  eq("fit test label", describeEntry(entry("doc-fit")), "N95 Respirator fit test");
  eq("privileges label carries the facility", describeEntry(entry("doc-priv")), "Hospital Privileges, Arrowhead Regional Medical Center");
  eq("an unlinked document is its filename", describeEntry(entry("doc-cv")), "Eric Whitney CV 2026.pdf");
  eq("a CME entry is its title", describeEntry(entry("doc-cme")), "Stroke update 2026");
  eq("null is empty", describeEntry(null), "");
  eq("an em dash typed into a record does not reach the note",
    describeEntry({ ...entry("doc-coi"), recType: "Professional Liability \u2014 Occurrence" }), "Professional Liability, Occurrence COI, ProAssurance Specialty Insurance");

  // ── parseAsks: noise, markers, structure ──────────────────────────────────
  eq("Outlook numbering, checkboxes, bullets, notes and phrasing all survive",
    parseAsks(REQUESTS.outlookNumbered.body),
    ["DEA", "state licenses (all of them)", "CV", "attestation form", "ACLS card", "Hep B titer", "Passport photo"]);
  ok("the external-sender banner is skipped, not cut to", parseAsks(REQUESTS.outlookNumbered.body).length === 7);
  ok("-----Original Message----- ends the reading", !parseAsks(REQUESTS.outlookNumbered.body).some((a) => /notarized/i.test(a)));
  eq("a sentence with no list becomes the asks, split on 'and'", parseAsks(REQUESTS.sentenceOnly.body), ["malpractice COI", "driver's license"]);
  ok("'On <date> ... wrote:' ends the reading", !parseAsks(REQUESTS.sentenceOnly.body).some((a) => /which|happy/i.test(a)));
  eq("a chevron-quoted block ends the reading", parseAsks(REQUESTS.gmailQuote.body), ["reappointment letter", "headshot"]);
  eq("a bare From: line ends the reading", parseAsks("- DEA\nFrom: Eric Whitney\n- CSR"), ["DEA"]);
  eq("a *From:* line ends the reading", parseAsks("- DEA\n*From:* Eric Whitney\n- CSR"), ["DEA"]);
  eq("a heading over sub-bullets is not an ask; same-kind and generic-word compounds stay whole",
    parseAsks(REQUESTS.heading.body),
    ["MMR", "Varicella titer", "Hep B surface antibody and titer", "OIG / SAM", "BLS", "ACLS", "Residency", "fellowship certificates"]);
  eq("a Thanks! above the list is not the sign-off", parseAsks("Thanks!\n\nPlease send:\n- DEA\n- CSR\n\nThanks,\nT"), ["DEA", "CSR"]);
  eq("a disclaimer with 'copy' in it is not an ask",
    parseAsks("Hi,\n\nConfidentiality Notice: if you are not the intended recipient, any copying or distribution is prohibited. Please send this to the sender."), []);
  eq("nothing in the body falls back to the subject, prefixes peeled", parseAsks("", "Re: Fwd: DEA certificate"), ["DEA certificate"]);
  eq("a body of one short line is the ask", parseAsks("DEA and CSR please"), ["DEA", "CSR"]);
  // A one-line body the rules cannot name is still the ask. "CAQH ID" under
  // the subject "Re: Items needed for credentialing" once fell through to the
  // subject, and the proposal, the physician's summary and the cover note
  // all said "for credentialing"; the same line inside a bulleted list
  // survived. The one unknown line still dropped is a bare sign-off name,
  // with or without a greeting above it.
  eq("a one-line body of unknown kind is the ask, not the subject", [parseAsks("CAQH ID", "Re: Items needed for credentialing"), parseAsks("Tax ID", "RE: Requested docs")], [["CAQH ID"], ["Tax ID"]]);
  eq("the same lines in a list read the same", parseAsks("- CAQH ID\n- Tax ID"), ["CAQH ID", "Tax ID"]);
  eq("a bare sign-off name under a short message is not an ask",
    [parseAsks("DEA and CSR please\nTonya", "Re: docs"), parseAsks("CAQH ID\nTara Domalewski, CPCS"), parseAsks("Hi Dr. Whitney,\nCAQH ID\nThanks"), parseAsks("Good morning Dr. Whitney:\nTax ID")],
    [["DEA", "CSR"], ["CAQH ID"], ["CAQH ID"], ["Tax ID"]]);
  eq("a one-line unknown body that is only a name still falls back to the subject", parseAsks("Tonya", "Re: DEA certificate"), ["DEA certificate"]);
  {
    const p = buildProposal({ subject: "Re: Items needed for credentialing", fromName: "Sam Reyes", fromAddr: "s@x.example", body: "CAQH ID" }, CATALOGUE, PHYSICIAN, NOW);
    eq("a one-line unknown body: the proposal item is the body line", p.items.map((i) => [i.ask, i.kind, i.status]), [["CAQH ID", "unknown", "missing"]]);
    ok("and the note asks about it by name, not by the subject", p.coverNote.includes("what you meant by:\n- CAQH ID") && !p.coverNote.includes("credentialing"));
  }
  eq("a signature title in a long body is not an ask",
    parseAsks("Hello,\n\nPer our call, nothing further is needed.\n\nTonya\nSr. Medical Staff Coordinator, Hospital Privileging\n954-555-0100\n"), []);
  eq("a line with a link or an email is never an ask", parseAsks("- https://forms.example/tb\n- tonya@weatherby.example\n- TB form"), ["TB form"]);
  eq("duplicates collapse", parseAsks("- DEA\n- dea\n- Copy of DEA"), ["DEA"]);
  eq("MMR (Measles, Mumps, Rubella) is one ask", parseAsks("- MMR (Measles, Mumps, Rubella)"), ["MMR (Measles, Mumps, Rubella)"]);
  eq("Board certificate (ABMS) is one ask", parseAsks("- Board certificate (ABMS)"), ["Board certificate (ABMS)"]);
  eq("a parenthesised pair of cards is two asks", parseAsks("- Life support cards (BLS/ACLS)"), ["BLS", "ACLS"]);
  eq("a colon-separated list of vaccines is the list, however long",
    [parseAsks("- Immunization records: MMR, Varicella, Hep B, Tdap"), parseAsks("- Immunizations: MMR, Varicella, Hep B")],
    [["MMR", "Varicella", "Hep B", "Tdap"], ["MMR", "Varicella", "Hep B"]]);
  eq("two states in one line are two asks, the bare state borrowing the sibling's shape",
    [parseAsks("- Colorado and North Dakota licenses"), parseAsks("- Medical license for CO and ND"), parseAsks("- Colorado and California DEA")],
    [["Colorado licenses", "North Dakota licenses"], ["Medical license for CO", "Medical license for ND"], ["Colorado DEA", "California DEA"]]);
  eq("a state written once for two items is carried into both",
    [parseAsks("- Copy of your DEA and CSR for the state of Colorado"), parseAsks("- DEA and CSR for Colorado")],
    [["DEA for the state of Colorado", "CSR for the state of Colorado"], ["DEA for Colorado", "CSR for Colorado"]]);
  eq("a bare state with no sibling to borrow from stays one ask", parseAsks("- DEA and Colorado"), ["DEA and Colorado"]);
  eq("same-kind compounds still stay whole", [parseAsks("- OIG / SAM"), parseAsks("- Hep B surface antibody and titer")], [["OIG / SAM"], ["Hep B surface antibody and titer"]]);
  eq("Needed: X is X", parseAsks("- Needed: DEA"), ["DEA"]);
  eq("a trailing 'if applicable' goes", parseAsks("- Fellowship certificate, if applicable"), ["Fellowship certificate"]);
  eq("valid, legible and notarized come off the front unless an ID word follows",
    [parseAsks("- Valid driver's license"), parseAsks("- Legible copy of your DEA"), parseAsks("- Valid ID"), parseAsks("- Notarized ID form"), parseAsks("- Valid photo ID")],
    [["driver's license"], ["DEA"], ["Valid ID"], ["Notarized ID form"], ["photo ID"]]);
  eq("null text is no asks", parseAsks(null), []);

  // ── The cover note ────────────────────────────────────────────────────────
  {
    const p = buildProposal(REQUESTS.nothingOnFile, CATALOGUE, PHYSICIAN, NOW);
    eq("nothing found: statuses", p.items.map((i) => [i.kind, i.status]), [["npi", "report"], ["references", "report"], ["case_logs", "report"], ["dea", "missing"]]);
    // The note promises only what the app can produce. A report (NPI,
    // references, case logs) follows separately because the app exports it;
    // a document not on file is stated as a fact and no more. This note goes
    // out on one tap, unread, and "they will follow separately" over a
    // Livescan receipt the physician never had brought the credentialer back
    // two weeks later asking where it was.
    eq("nothing found: the reports follow, the DEA is not on file and not promised, and an office is 'there'", p.coverNote,
      "Hello there,\n\nThese will follow separately:\n- NPI letter\n- Peer references\n- Case logs for the last 24 months\n\nI do not have these on file:\n- Colorado DEA\n\nRegards,\nEric Whitney, DO");
    eq("nothing found: docIds empty, missing is every ask", [p.docIds, p.missing.length], [[], 4]);
  }
  {
    const p = buildProposal(REQUESTS.outlookNumbered, CATALOGUE, PHYSICIAN, NOW);
    eq("surname-first From is greeted by first name", p.coverNote.split("\n")[0], "Hello Marisol,");
    eq("'all of them' attaches every state licence", p.items[1].docIds, ["doc-lic-ca", "doc-lic-co", "doc-lic-nd"]);
    eq("the missing block lists only what is not attached", p.missing, ["attestation form"]);
    ok("the note attaches first, then asks about what it could not name, and promises nothing for it",
      p.coverNote.indexOf("Attached are the documents you asked for:") < p.coverNote.indexOf("I could not tell from your email what you meant by:\n- attestation form\nReply with details and I will send what is needed.")
      && !p.coverNote.includes("follow separately"));
  }
  {
    const p = buildProposal(REQUESTS.compounds, CATALOGUE, PHYSICIAN, NOW);
    eq("compounds: every ask, split the way the credentialer meant it", p.items.map((i) => [i.ask, i.kind, i.status, i.docIds]), [
      ["Colorado licenses", "state_license", "found", ["doc-lic-co"]],
      ["North Dakota licenses", "state_license", "found", ["doc-lic-nd"]],
      ["Colorado DEA", "dea", "missing", []],
      ["California DEA", "dea", "found", ["doc-dea-ca"]],
      ["DEA for the state of Colorado", "dea", "missing", []],
      ["CSR for the state of Colorado", "csr", "missing", []],
      ["BLS", "bls", "found", ["doc-bls"]],
      ["ACLS", "acls", "found", ["doc-acls"]],
      ["MMR", "mmr", "found", ["doc-mmr2", "doc-mmr1", "doc-measles"]],
      ["Varicella", "varicella", "found", ["doc-varicella"]],
      ["Hep B", "hep_b", "found", ["doc-hepb"]],
      ["Tdap", "tdap", "found", ["doc-tdap"]],
      ["Residency diploma", "residency_cert", "found", ["doc-res"]],
      ["Livescan", "fingerprint", "found", ["doc-fp"]],
      ["attestation form", "unknown", "missing", []],
    ]);
    ok("compounds: the flu and COVID records the credentialer did not ask for are not in the packet", !p.docIds.includes("doc-flu") && !p.docIds.includes("doc-covid"));
    ok("compounds: the Colorado asks are listed as not on file, and the California DEA is attached only for the California ask",
      p.coverNote.includes("Not on file:\n- Colorado DEA\n- DEA for the state of Colorado\n- CSR for the state of Colorado")
      && !p.coverNote.includes("follow") && p.docIds.filter((id) => id === "doc-dea-ca").length === 1);
    ok("compounds: the unnamed form is asked about, not promised",
      p.coverNote.includes("I could not tell from your email what you meant by:\n- attestation form") && !p.missing.includes("Colorado licenses"));
  }
  {
    const p = buildProposal({ subject: "Forms", fromName: "Sam", fromAddr: "s@x.example", body: "- Signed attestation form (attached)\n- W-9" }, CATALOGUE, PHYSICIAN, NOW);
    eq("nothing but unnamed asks: the note asks, and neither the attached nor the follow-separately block appears", p.coverNote,
      "Hello Sam,\n\nI could not tell from your email what you meant by:\n- attestation form\n- W-9\nReply with details and I will send what is needed.\n\nRegards,\nEric Whitney, DO");
    eq("but they still count as missing for the app", p.missing, ["attestation form", "W-9"]);
  }
  eq("Dr. is dropped from the greeting", buildProposal(REQUESTS.sentenceOnly, CATALOGUE, PHYSICIAN, NOW).coverNote.split("\n")[0], "Hello Tonya,");
  eq("credentials after the name are dropped", buildProposal(REQUESTS.heading, CATALOGUE, PHYSICIAN, NOW).coverNote.split("\n")[0], "Hello Tonya,");
  eq("no name is 'there'", buildProposal(REQUESTS.subjectOnly, CATALOGUE, PHYSICIAN, NOW).coverNote.split("\n")[0], "Hello there,");
  eq("a shouted name is calmed", buildProposal({ ...REQUEST_1, fromName: "MARISOL CASTELLANO" }, CATALOGUE, PHYSICIAN, NOW).coverNote.split("\n")[0], "Hello Marisol,");
  eq("no degree, no comma", buildProposal(REQUEST_1, CATALOGUE, { name: "Eric Whitney", degree: "" }, NOW).coverNote.split("\n").pop(), "Eric Whitney");
  // A note with no name under it once ended "Regards," over a blank line,
  // or over a bare "DO": a letter nobody signed. Both lines go together.
  eq("no physician at all: the note ends on its last line, with no dangling Regards",
    buildProposal(REQUEST_1, CATALOGUE, null, NOW).coverNote, "Hello Marisol,\n\nAttached are the documents you asked for:\n- Board Certification (AOA)");
  eq("a degree without a name is not a sign-off either", buildProposal(REQUEST_1, CATALOGUE, PHYSICIAN_NO_NAME, NOW).coverNote.split("\n").slice(-2), ["Attached are the documents you asked for:", "- Board Certification (AOA)"]);
  ok("no name: 'Regards,' appears nowhere", !buildProposal(REQUEST_2, CATALOGUE, PHYSICIAN_NO_NAME, NOW).coverNote.includes("Regards"));
  eq("with a name the sign-off is unchanged", buildProposal(REQUEST_1, CATALOGUE, PHYSICIAN, NOW).coverNote.split("\n").slice(-3), ["", "Regards,", "Eric Whitney, DO"]);
  eq("the subject alone makes a proposal", buildProposal(REQUESTS.subjectOnly, CATALOGUE, PHYSICIAN, NOW).items.map((i) => [i.ask, i.kind, i.docIds]), [["DEA certificate", "dea", ["doc-dea-ca"]]]);
  {
    const p = buildProposal(REQUESTS.empty, CATALOGUE, PHYSICIAN, NOW);
    eq("an empty request has no items and an honest note", [p.items, p.docIds, p.missing], [[], [], []]);
    ok("and asks the requester to say what they need", p.coverNote.includes("Reply with what you need"));
  }
  eq("the snake_case row shape is accepted too",
    buildProposal({ subject: REQUEST_1.subject, body_text: REQUEST_1.body, from_name: REQUEST_1.fromName }, CATALOGUE, PHYSICIAN, NOW).coverNote,
    buildProposal(REQUEST_1, CATALOGUE, PHYSICIAN, NOW).coverNote);
  ok("the note ends without a footer: send-packet-email adds its own", !buildProposal(REQUEST_2, CATALOGUE, PHYSICIAN, NOW).coverNote.includes("CredentialDOMD"));

  // ── noteForSelection: the note for what was actually ticked ───────────────
  // The detail view lets the physician drop a document before sending. The
  // stored note then said "Attached are the documents you asked for" over a
  // licence that was no longer in the packet.
  {
    const two = buildProposal({ subject: "DEA and license", fromName: "Kyle Ortega", fromAddr: "k@penrose.example", body: "- DEA\n- Colorado license" }, CATALOGUE, PHYSICIAN, NOW);
    eq("two-doc proposal: two found items", two.items.map((i) => [i.ask, i.status, i.docIds]), [["DEA", "found", ["doc-dea-ca"]], ["Colorado license", "found", ["doc-lic-co"]]]);
    eq("untick one: the note lists one and names the other as not enclosed", noteForSelection(two, ["doc-dea-ca"], PHYSICIAN, "Kyle Ortega"),
      "Hello Kyle,\n\nAttached are the documents you asked for:\n- DEA Registration, CA\n\nNot enclosed this time:\n- Colorado license\n\nRegards,\nEric Whitney, DO");
    eq("untick both: the not-enclosed block alone, nothing promised", noteForSelection(two, [], PHYSICIAN, "Kyle Ortega"),
      "Hello Kyle,\n\nNot enclosed this time:\n- DEA\n- Colorado license\n\nRegards,\nEric Whitney, DO");
    eq("null selection means nothing attached", noteForSelection(two, null, PHYSICIAN, "Kyle Ortega"), noteForSelection(two, [], PHYSICIAN, "Kyle Ortega"));
    eq("a Set works as the selection", noteForSelection(two, new Set(["doc-lic-co"]), PHYSICIAN, "Kyle Ortega"),
      "Hello Kyle,\n\nAttached are the documents you asked for:\n- State Medical License (DO), CO\n\nNot enclosed this time:\n- DEA\n\nRegards,\nEric Whitney, DO");
    eq("ids not in the proposal change nothing", noteForSelection(two, ["doc-dea-ca", "doc-cv", "nope"], PHYSICIAN, "Kyle Ortega"), noteForSelection(two, ["doc-dea-ca"], PHYSICIAN, "Kyle Ortega"));
    ok("the not-enclosed block promises nothing", !noteForSelection(two, [], PHYSICIAN, "Kyle Ortega").includes("follow"));
    eq("no name: the trimmed note ends without a sign-off too", noteForSelection(two, ["doc-dea-ca"], PHYSICIAN_NO_NAME, "Kyle Ortega"),
      "Hello Kyle,\n\nAttached are the documents you asked for:\n- DEA Registration, CA\n\nNot enclosed this time:\n- Colorado license");
  }
  for (const [name, r] of Object.entries({ REQUEST_1, REQUEST_2, ...REQUESTS })) {
    const p = buildProposal(r, CATALOGUE, PHYSICIAN, NOW);
    eq(`${name}: ticking everything gives back the stored note byte for byte`, noteForSelection(p, p.docIds, PHYSICIAN, r.fromName), p.coverNote);
    eq(`${name}: the same through a Set`, noteForSelection(p, new Set(p.docIds), PHYSICIAN, r.fromName), p.coverNote);
  }
  {
    const p = buildProposal(REQUEST_2, CATALOGUE, PHYSICIAN, NOW);
    eq("unticking one dose of a series keeps the ask: two of three listed, nothing held",
      noteForSelection(p, p.docIds.filter((id) => id !== "doc-mmr1"), PHYSICIAN, REQUEST_2.fromName), [
        "Hello Tonya,", "",
        "Attached are the documents you asked for:",
        "- Professional Liability COI, ProAssurance Specialty Insurance",
        "- MMR (Measles, Mumps, Rubella) vaccination",
        "- Measles (Rubeola) IgG titer, Immune",
        "- QuantiFERON-TB Gold, Negative", "",
        "These will follow separately:",
        "- Logs 12-months", "",
        "Regards,", "Eric Whitney, DO",
      ].join("\n"));
    eq("unticking every TB document holds that ask; the report still follows separately, word for word",
      noteForSelection(p, ["doc-coi", "doc-mmr2", "doc-mmr1", "doc-measles"], PHYSICIAN, REQUEST_2.fromName), [
        "Hello Tonya,", "",
        "Attached are the documents you asked for:",
        "- Professional Liability COI, ProAssurance Specialty Insurance",
        "- MMR (Measles, Mumps, Rubella) vaccination",
        "- MMR (Measles, Mumps, Rubella) vaccination",
        "- Measles (Rubeola) IgG titer, Immune", "",
        "Not enclosed this time:",
        "- TB form", "",
        "These will follow separately:",
        "- Logs 12-months", "",
        "Regards,", "Eric Whitney, DO",
      ].join("\n"));
    eq("nothing ticked: the missing block reads as buildProposal writes it when nothing is attached",
      noteForSelection(p, [], PHYSICIAN, REQUEST_2.fromName), [
        "Hello Tonya,", "",
        "Not enclosed this time:",
        "- MPLT COI", "- MMR dose #2", "- TB form", "",
        "These will follow separately:",
        "- Logs 12-months", "",
        "Regards,", "Eric Whitney, DO",
      ].join("\n"));
  }
  {
    const p = buildProposal(REQUESTS.compounds, CATALOGUE, PHYSICIAN, NOW);
    const note = noteForSelection(p, p.docIds.filter((id) => id !== "doc-bls" && id !== "doc-acls"), PHYSICIAN, REQUESTS.compounds.fromName);
    ok("the unknown ask still reads as buildProposal wrote it, after the held and missing blocks",
      note.includes("Not enclosed this time:\n- BLS\n- ACLS\n\nNot on file:\n- Colorado DEA\n- DEA for the state of Colorado\n- CSR for the state of Colorado\n\nI could not tell from your email what you meant by:\n- attestation form\nReply with details and I will send what is needed.\n\nRegards,\nEric Whitney, DO"));
    ok("and the held cards are not in the attached list", !note.includes("- BLS Certification") && !note.includes("- ACLS Certification"));
  }
  {
    const p = buildProposal(REQUESTS.empty, CATALOGUE, PHYSICIAN, NOW);
    eq("an empty proposal reads the same either way", noteForSelection(p, [], PHYSICIAN, null), p.coverNote);
    eq("no proposal at all is the empty note", noteForSelection(null, null, PHYSICIAN, "Sam"), "Hello Sam,\n\nI did not find a list of documents in your request. Reply with what you need and I will send it.\n\nRegards,\nEric Whitney, DO");
    eq("a stored proposal with thin items does not crash",
      noteForSelection({ items: [{ ask: "DEA", status: "found", docIds: ["a"] }, { ask: "x", status: "weird" }, null] }, ["a"], PHYSICIAN, "Sam"),
      "Hello Sam,\n\nAttached are the documents you asked for:\n- Document\n\nI could not tell from your email what you meant by:\n- x\nReply with details and I will send what is needed.\n\nRegards,\nEric Whitney, DO");
    ok("no em dash in a trimmed note from em-dashed input", !noteForSelection(buildProposal(REQUESTS.emDashes, CATALOGUE, PHYSICIAN, NOW), [], PHYSICIAN, "Marisol \u2014 RUHS").includes("\u2014"));
  }

  // ── House rules: no em dash in anything the module can produce ───────────
  {
    const produced = [];
    for (const r of [REQUEST_1, REQUEST_2, ...Object.values(REQUESTS)]) produced.push(JSON.stringify(buildProposal(r, CATALOGUE, PHYSICIAN, NOW)));
    for (const e of CATALOGUE) produced.push(describeEntry(e));
    produced.push(JSON.stringify(parseAsks("- TB \u2014 sent\n- Logs \u2014 12 months")));
    produced.push(JSON.stringify(classifyAsk("DEA \u2014 Colorado")));
    ok("no em dash in any proposal, label or ask, even from em-dashed input", produced.every((s) => !s.includes("\u2014")), produced.filter((s) => s.includes("\u2014")).join("\n"));
    const p = buildProposal(REQUESTS.emDashes, CATALOGUE, PHYSICIAN, NOW);
    eq("em-dashed items are read as notes and asks", p.items.map((i) => [i.ask, i.kind]), [["TB form", "tb"], ["Logs 12 months", "case_logs"], ["W-9", "unknown"]]);
    eq("an em-dashed From name is still a first name", p.coverNote.split("\n")[0], "Hello Marisol,");
  }
  ok("no em dash in this file or the module source",
    !(await import("node:fs")).readFileSync(new URL("../src/utils/requestPacket.js", import.meta.url), "utf8").includes("\u2014")
    && !(await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8").includes("\u2014"));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
