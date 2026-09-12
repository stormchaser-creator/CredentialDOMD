// The request packet matcher exists twice: src/utils/requestPacket.js for the
// app and supabase/functions/_shared/requestPacket.ts for the inbound edge
// function, which builds the proposal the moment a forwarded request lands.
// Two matchers that drift are two different answers to "what is about to be
// sent", and the physician would only find out from the credentialer. So the
// same requests, asks and catalogue go through both here, and the proposals
// must be identical to the byte.
//
// Fixtures come from scripts/request-packet.test.mjs, which only runs its
// own checks when it is the entry script.
// Run: node scripts/request-packet-shared.test.mjs
import * as client from "../src/utils/requestPacket.js";
import * as server from "../supabase/functions/_shared/requestPacket.ts";
import { REQUEST_1, REQUEST_2, REQUESTS, RECORDS, DOCS, DOCS_WITH_FLUORO, PHYSICIAN, PHYSICIAN_NO_NAME, NOW } from "./request-packet.test.mjs";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};
const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };

// ── Same exports, same constants ────────────────────────────────────────────
const CONTRACT = ["parseAsks", "classifyAsk", "describeEntry", "matchAsk", "catalogueFromRows", "buildProposal", "noteForSelection"];
eq("both copies export the contract", CONTRACT.map((k) => [typeof client[k], typeof server[k]]), CONTRACT.map(() => ["function", "function"]));
eq("same export surface", Object.keys(server).sort(), Object.keys(client).sort());
eq("same kinds in the same order", server.KINDS, client.KINDS);
eq("same proposal version", server.PROPOSAL_VERSION, client.PROPOSAL_VERSION);
eq("same report kinds", client.KINDS.map(server.isReportKind), client.KINDS.map(client.isReportKind));

// ── The catalogue ───────────────────────────────────────────────────────────
const clientCat = client.catalogueFromRows(DOCS, RECORDS);
const serverCat = server.catalogueFromRows(DOCS, RECORDS);
eq("the server builds the catalogue the app builds", serverCat, clientCat);
ok("and it is not empty", clientCat.length > 40);
for (const e of clientCat) eq(`describeEntry agrees on ${e.id}`, server.describeEntry(e), client.describeEntry(e));

// ── The two real requests and the synthetic ones ────────────────────────────
const requests = { REQUEST_1, REQUEST_2, ...REQUESTS };
for (const [name, r] of Object.entries(requests)) {
  const a = client.buildProposal(r, clientCat, PHYSICIAN, NOW);
  const b = server.buildProposal(r, serverCat, PHYSICIAN, NOW);
  eq(`${name}: JSON-identical proposal`, b, a);
  eq(`${name}: same asks`, server.parseAsks(r.body, r.subject), client.parseAsks(r.body, r.subject));
  eq(`${name}: same note with no physician name`, server.buildProposal(r, serverCat, PHYSICIAN_NO_NAME, NOW).coverNote, client.buildProposal(r, clientCat, PHYSICIAN_NO_NAME, NOW).coverNote);
  // The note for a trimmed packet: everything ticked, the first document
  // only, nothing, and a Set instead of an array.
  for (const [label, sel] of [["all", a.docIds], ["first", a.docIds.slice(0, 1)], ["none", []], ["null", null], ["set", new Set(a.docIds.slice(1))]]) {
    eq(`${name}: same trimmed note (${label})`, server.noteForSelection(b, sel, PHYSICIAN, r.fromName), client.noteForSelection(a, sel, PHYSICIAN, r.fromName));
  }
  ok(`${name}: ticking everything returns the stored note in both copies`,
    client.noteForSelection(a, a.docIds, PHYSICIAN, r.fromName) === a.coverNote && server.noteForSelection(b, b.docIds, PHYSICIAN, r.fromName) === b.coverNote);
}
{
  const clientFluoro = client.catalogueFromRows(DOCS_WITH_FLUORO, RECORDS);
  const serverFluoro = server.catalogueFromRows(DOCS_WITH_FLUORO, RECORDS);
  eq("the fluoroscopy catalogue agrees", serverFluoro, clientFluoro);
  for (const a of ["Copy of fluoroscopy license", "X-ray supervisor permit", "State license", "all state licenses"]) {
    eq(`matchAsk agrees on "${a}" with the permit on file`, server.matchAsk(server.classifyAsk(a), serverFluoro, NOW), client.matchAsk(client.classifyAsk(a), clientFluoro, NOW));
  }
}
ok("the real requests actually attach something (the parity is not two empties)",
  client.buildProposal(REQUEST_1, clientCat, PHYSICIAN, NOW).docIds.length === 1
  && client.buildProposal(REQUEST_2, clientCat, PHYSICIAN, NOW).docIds.length === 5);

// ── Asks, one at a time ─────────────────────────────────────────────────────
const asks = [
  "Copy of your current DEA", "every DEA", "DEA controlled substance registration", "CSR", "Board certificate", "ABMS", "AOA",
  "State license", "medical license", "copy of your Colorado license", "CA license", "MD license", "West Virginia license",
  "all state licenses", "Diploma", "Residency certificate", "fellowship certificate", "MPLT COI", "COI", "Malpractice",
  "certificate of insurance", "liability", "claims history", "MMR dose #2", "Hep B", "varicella", "Tdap", "TB form", "PPD",
  "quantiferon", "chest x-ray", "flu", "covid", "drug screen", "urine", "titers", "immunizations", "vaccination record",
  "background check", "OIG", "SAM", "exclusion", "Photo ID", "government ID", "driver's license", "Passport", "headshot", "photo",
  "CV", "curriculum vitae", "resume", "NPI", "Logs 12-months", "case logs", "procedure log", "privileges", "reappointment letter",
  "delineation", "BLS", "ACLS", "ATLS", "references", "peer references", "work history", "employment verification", "ECFMG",
  "USMLE", "COMLEX", "CME", "continuing education", "fit test", "N95", "W-9", "health insurance card", "passport photo",
  "photo of your passport", "Hep B surface antibody and titer", "TB form – This was sent via Docusign", "Logs \u2014 12 months",
  "1) Updated CV (sent via Docusign)", "[ ] Signed attestation", "Please provide proof of immunity to varicella", "",
  "Colorado and North Dakota licenses", "Medical license for CO and ND", "Colorado and California DEA",
  "Copy of your DEA and CSR for the state of Colorado", "Life support cards (BLS/ACLS)", "Immunization records: MMR, Varicella, Hep B, Tdap",
  "Residency diploma", "Residency certificate or diploma", "Livescan", "Fingerprint clearance", "Signed attestation form (attached)",
  // States in capitals beside capitalised words, in parentheses, after a preposition; the codes that are degrees.
  "Copy of your ND DEA", "DEA (ND)", "License (CA)", "CO License", "in ND", "For CO", "MD license", "MD license for CO", "nd dea", "DEA (MD)", "ID card", "id card",
  // Bare "ID" is an identifier; the qualified forms are a photo ID.
  "CAQH ID and password", "Tax ID (W-9)", "Medicaid ID", "government issued ID", "Valid ID", "Notarized ID form", "Valid driver's license", "Legible copy of your DEA",
  // The fluoroscopy permit and the asks it must never take from state_license, or the other way round.
  "Copy of fluoroscopy license", "Fluoroscopy permit", "X-ray supervisor permit", "radiation permit", "Radiology license", "State license",
  // A word inside a kind that picks one document.
  "Tail coverage certificate", "Claims-made COI", "Occurrence policy COI", "Chest x-ray report", "CXR", "PPD", "TB skin test", "TST", "IGRA", "T-spot", "TB test",
  "Hep B surface antibody", "HBsAb", "all tail coverage", "every chest x-ray",
];
for (const a of asks) {
  eq(`classifyAsk agrees on "${a}"`, server.classifyAsk(a), client.classifyAsk(a));
  eq(`matchAsk agrees on "${a}"`, server.matchAsk(server.classifyAsk(a), serverCat, NOW), client.matchAsk(client.classifyAsk(a), clientCat, NOW));
}
const bodies = [
  "- DEA\n- CSR\nFrom: me\n- board certificate",
  "DEA and CSR please",
  "Hi Dr. Whitney, can you send your DEA, CSR and board certificate?\n\nThanks,\nT",
  "Still missing:\n- Immunizations:\n   o MMR\n   o Varicella titer\n- OIG / SAM\n- BLS/ACLS",
  "CAUTION: external sender, do not click links.\n\n1. Copy of ID\n2. Passport\n\n> quoted\n> - DEA",
  "Confidentiality Notice: if you are not the intended recipient, do not copy. Please send documents.",
  "- Life support cards (BLS/ACLS)\n- Immunization records: MMR, Varicella, Hep B, Tdap\n- Colorado and North Dakota licenses\n- Copy of your DEA and CSR for the state of Colorado\n- Residency diploma\n- Livescan",
  "- Signed attestation form (attached)\n- W-9\n- Licenses - Colorado, North Dakota",
  // One-line bodies the rules cannot name, and a sign-off name under one.
  "CAQH ID", "Tax ID", "DEA and CSR please\nTonya", "Hi Dr. Whitney,\nCAQH ID\nThanks",
  "", null, undefined,
];
for (const b of bodies) eq(`parseAsks agrees on ${String(JSON.stringify(b)).slice(0, 50)}`, server.parseAsks(b, "Re: Fwd: docs"), client.parseAsks(b, "Re: Fwd: docs"));

// ── The clock and the edges ─────────────────────────────────────────────────
for (const when of ["2025-06-01", "2026-02-15", "2027-12-31", new Date("2026-09-11T12:00:00Z")]) {
  eq(`expiry ordering agrees at ${JSON.stringify(when)}`,
    server.matchAsk({ kind: "state_license", state: null, all: true }, serverCat, when).map((e) => e.id),
    client.matchAsk({ kind: "state_license", state: null, all: true }, clientCat, when).map((e) => e.id));
}
eq("null inputs agree", [server.matchAsk(null, null), server.describeEntry(null), server.buildProposal(null, null, null, NOW), server.noteForSelection(null, null, null, null)],
  [client.matchAsk(null, null), client.describeEntry(null), client.buildProposal(null, null, null, NOW), client.noteForSelection(null, null, null, null)]);
eq("a thin stored proposal agrees", server.noteForSelection({ items: [{ ask: "DEA", status: "found", docIds: ["a"] }, { ask: "x", status: "weird" }, null] }, ["a"], PHYSICIAN, "Sam"),
  client.noteForSelection({ items: [{ ask: "DEA", status: "found", docIds: ["a"] }, { ask: "x", status: "weird" }, null] }, ["a"], PHYSICIAN, "Sam"));
eq("snake_case rows agree", server.catalogueFromRows([{ id: "d", name: "x.pdf", linked_to: "licenses:l", uploaded_at: "2026-01-01" }], { licenses: [{ id: "l", type: "DEA Registration", state: "Colorado", expiration_date: "2027-01-01" }] }),
  client.catalogueFromRows([{ id: "d", name: "x.pdf", linked_to: "licenses:l", uploaded_at: "2026-01-01" }], { licenses: [{ id: "l", type: "DEA Registration", state: "Colorado", expiration_date: "2027-01-01" }] }));

// ── House rules ─────────────────────────────────────────────────────────────
const everything = Object.values(requests).map((r) => JSON.stringify(server.buildProposal(r, serverCat, PHYSICIAN, NOW))).join("\n");
ok("no em dash in anything the server copy produces", !everything.includes("\u2014"));
ok("no em dash in either source file", await (async () => {
  const fs = await import("node:fs");
  return ["../src/utils/requestPacket.js", "../supabase/functions/_shared/requestPacket.ts"]
    .every((p) => !fs.readFileSync(new URL(p, import.meta.url), "utf8").includes("\u2014"));
})());
ok("the server copy imports nothing (node could not have loaded it otherwise)",
  !(await import("node:fs")).readFileSync(new URL("../supabase/functions/_shared/requestPacket.ts", import.meta.url), "utf8").match(/^\s*import\s/m));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
