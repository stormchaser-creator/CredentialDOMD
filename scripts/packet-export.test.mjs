// Unit-style checks for src/utils/credentialExport.js: the packet's folder
// routing and the two numbers the Setup page's ending states out loud.
//
// Pins the three defects the ending depends on:
//   1. six sections had no folder and everything they held fell into
//      Other_Documents,
//   2. a "licenses:"-linked document went to Medical_Licenses whatever it
//      was, so DEA_Registration and Board_Certifications were folders the
//      ZIP created and never wrote into,
//   3. the writer read `.includes` off doc.fileData, a field nothing in the
//      app has ever written, so the export threw on every stored document.
//
// Run: node scripts/packet-export.test.mjs   (pure node, no runner)
import {
  FOLDER_MAP, PACKET_FOLDERS, categorizeDocument,
  packetDocuments, packetSummary, packetSummaryLine, packetPendingLine, generateCredentialZip,
} from "../src/utils/credentialExport.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const b64 = (s) => `data:application/pdf;base64,${Buffer.from(s).toString("base64")}`;

// A DO account, because the MD and DO license vocabularies differ and the
// router reads the record's own type.
const data = {
  licenses: [
    { id: "l1", type: "State Medical License (DO)", state: "CA", expirationDate: "2027-01-01" },
    { id: "l2", type: "DEA Registration", state: "CA", expirationDate: "2027-06-01" },
    { id: "l3", type: "Board Certification (AOA)", name: "Neurological Surgery" },
    { id: "l4", type: "Certification", name: "ACLS", expirationDate: "2027-02-02" },
  ],
  privileges: [{ id: "p1", facility: "Arrowhead", expirationDate: "2027-03-03" }],
  insurance: [{ id: "i1", type: "Malpractice", expirationDate: "2027-04-04" }],
  cme: [{ id: "c1", title: "Stroke update", hours: 2 }],
  education: [{ id: "e1", type: "Doctor of Osteopathic Medicine (DO)", institution: "PCOM" }],
  healthRecords: [{ id: "h1", name: "TB test" }],
  travelDocs: [{ id: "t1", type: "Passport", number: "X1" }],
  screenings: [{ id: "s1", type: "Background", agency: "ScoutLogic" }],
  professionalPhotos: [{ id: "ph1", name: "Headshot" }],
  workHistory: [{ id: "w1", employer: "ANMG", startDate: "2020-01-01" }],
  peerReferences: [{ id: "r1", name: "Jane Smith, MD", email: "j@x.com" }],
  malpracticeHistory: [{ id: "m1", description: "None" }],
  documents: [
    { id: "d1", name: "IMG_0269.jpeg", type: "image/jpeg", data: b64("a"), linkedTo: "licenses:l1" },
    { id: "d2", name: "IMG_0270.jpeg", type: "image/jpeg", data: b64("b"), linkedTo: "licenses:l2" },
    { id: "d3", name: "cert.pdf", type: "application/pdf", data: b64("c"), linkedTo: "licenses:l3" },
    { id: "d4", name: "acls.pdf", type: "application/pdf", data: b64("d"), linkedTo: "licenses:l4" },
    { id: "d5", name: "reappointment.pdf", type: "application/pdf", data: b64("e"), linkedTo: "privileges:p1" },
    { id: "d6", name: "coi.pdf", type: "application/pdf", data: b64("f"), linkedTo: "insurance:i1" },
    { id: "d7", name: "transcript.pdf", type: "application/pdf", data: b64("g"), linkedTo: "cme:c1" },
    { id: "d8", name: "diploma.pdf", type: "application/pdf", data: b64("h"), linkedTo: "education:e1" },
    { id: "d9", name: "tb.pdf", type: "application/pdf", data: b64("i"), linkedTo: "healthRecords:h1" },
    { id: "d10", name: "scan.pdf", type: "application/pdf", data: b64("j"), linkedTo: "travelDocs:t1" },
    { id: "d11", name: "report.pdf", type: "application/pdf", data: b64("k"), linkedTo: "screenings:s1" },
    { id: "d12", name: "headshot.png", type: "image/png", data: b64("l"), linkedTo: "professionalPhotos:ph1" },
    { id: "d13", name: "verification.pdf", type: "application/pdf", data: b64("m"), linkedTo: "workHistory:w1" },
    { id: "d14", name: "letter.pdf", type: "application/pdf", data: b64("n"), linkedTo: "peerReferences:r1" },
    { id: "d15", name: "closure.pdf", type: "application/pdf", data: b64("o"), linkedTo: "malpracticeHistory:m1" },
  ],
  settings: { name: "Eric Whitney", degreeType: "DO", apiKey: "SECRET" },
};

// ── The six sections that had no folder ──
const folderOf = (id) => categorizeDocument(data.documents.find((d) => d.id === id), data);
eq("travel doc lands in Travel_and_IDs", folderOf("d10"), "Travel_and_IDs");
eq("screening lands in Screenings", folderOf("d11"), "Screenings");
eq("headshot lands in Professional_Photo", folderOf("d12"), "Professional_Photo");
eq("work history lands in Work_History", folderOf("d13"), "Work_History");
eq("peer reference lands in Peer_References", folderOf("d14"), "Peer_References");
eq("malpractice lands in Malpractice_History", folderOf("d15"), "Malpractice_History");
ok("nothing linked falls to Other_Documents",
  data.documents.every((d) => categorizeDocument(d, data) !== "Other_Documents"));

// ── A licenses: link resolves against its record ──
eq("medical license stays in Medical_Licenses", folderOf("d1"), "Medical_Licenses");
eq("DEA card reaches DEA_Registration", folderOf("d2"), "DEA_Registration");
eq("board certificate reaches Board_Certifications", folderOf("d3"), "Board_Certifications");
eq("a course certification stays with the licenses", folderOf("d4"), "Medical_Licenses");
// MD vocabulary too: hardcoding the DO strings would strand the other half.
const md = { licenses: [{ id: "x", type: "Board Certification (ABMS)" }] };
eq("ABMS board certificate routes the same as AOA",
  categorizeDocument({ name: "c.pdf", linkedTo: "licenses:x" }, md), "Board_Certifications");

// ── The record is gone, so the filename is all that is left ──
eq("orphan link falls back to the filename",
  categorizeDocument({ name: "DEA renewal.pdf", linkedTo: "licenses:gone" }, data), "DEA_Registration");
eq("orphan link with a mute filename stays with the licenses",
  categorizeDocument({ name: "scan1.pdf", linkedTo: "licenses:gone" }, data), "Medical_Licenses");
// "dea" as a word, not a substring: "idea" and "dealer" are not registrations.
eq("an unlinked file is not filed by a substring",
  categorizeDocument({ name: "idea notes.pdf" }, {}), "Other_Documents");
eq("an unlinked license is still read", categorizeDocument({ name: "CA license.pdf" }, {}), "Medical_Licenses");
eq("an unlinked DEA card is still read", categorizeDocument({ name: "DEA card.pdf" }, {}), "DEA_Registration");

// ── Every folder the router can return is a folder the ZIP creates ──
const reachable = new Set([
  ...Object.values(FOLDER_MAP), "DEA_Registration", "Board_Certifications", "Other_Documents",
]);
ok("every routed folder exists in the ZIP",
  [...reachable].every((f) => PACKET_FOLDERS.includes(f)),
  [...reachable].filter((f) => !PACKET_FOLDERS.includes(f)).join(", "));
ok("the ZIP creates no folder nothing can reach",
  PACKET_FOLDERS.every((f) => reachable.has(f)),
  PACKET_FOLDERS.filter((f) => !reachable.has(f)).join(", "));

// ── The packet, and the sentence about it ──
eq("the packet is the linked documents", packetDocuments(data).length, 15);
eq("the packet is ordered by folder", packetDocuments(data)[0].id, "d1");
const summary = packetSummary(data);
// One row per credential record: 4 licenses, 1 each of privileges,
// insurance, cme, education, health, travel, screening, photo, work,
// reference and malpractice.
eq("line items count the summary rows", summary.lineItems, 15);
eq("documents count the linked files", summary.documents, 15);
eq("the ending sentence", packetSummaryLine(summary),
  "15 line items. 15 documents, each one linked to the record it proves.");
eq("one of each reads as one", packetSummaryLine({ lineItems: 1, documents: 1 }),
  "1 line item. 1 document, linked to the record it proves.");
eq("no documents yet says so, and claims nothing", packetSummaryLine({ lineItems: 4, documents: 0 }),
  "4 line items. No documents are attached to them yet.");
ok("no em dash in the ending", !packetSummaryLine(summary).includes("—"));

// A file sitting in Files unattached, and a link pointing at a record that
// was deleted, are both in the ZIP and neither is described as proof.
const loose = {
  ...data,
  documents: [
    ...data.documents,
    { id: "u1", name: "scan.pdf", type: "application/pdf", data: b64("z") },
    { id: "u2", name: "old.pdf", type: "application/pdf", data: b64("y"), linkedTo: "licenses:deleted" },
  ],
};
eq("an unattached file is not counted as proof", packetSummary(loose).documents, 15);
// The shape saveData writes: bytes stripped, storagePath kept, re-fetched one
// file at a time after load. This is a normal document on a second device and
// in the window after any sign-in, and counting it as absent made the ending
// state something false about the physician's own file.
const cached = { ...data, documents: [{ id: "n1", name: "x.pdf", type: "application/pdf", linkedTo: "licenses:l1", storagePath: "u/1" }] };
const cachedSum = packetSummary(cached);
eq("a document whose bytes are still in Storage is still linked", cachedSum.documents, 1);
eq("but it is not on this device yet", cachedSum.onDevice, 0);
eq("the sentence counts what is linked", packetSummaryLine(cachedSum),
  "15 line items. 1 document, linked to the record it proves.");
eq("and the second line says where the rest of it is", packetPendingLine(cachedSum),
  "1 of them is still coming back from your account on this device. Download once it lands and the file carries everything.");
eq("two pending read as two", packetPendingLine({ documents: 3, onDevice: 1 }),
  "2 of them are still coming back from your account on this device. Download once they land and the file carries everything.");
eq("nothing pending says nothing", packetPendingLine(summary), null);
eq("everything on device counts as everything", summary.onDevice, 15);
ok("no em dash in the pending line", !packetPendingLine(cachedSum).includes("\u2014"));
// The ZIP writer still only writes the bytes it holds.
eq("the ZIP writer takes the bytes test", packetDocuments(cached, { withBytes: true }).length, 0);

// ── The ZIP itself ──
const zip = await generateCredentialZip(loose);
ok("the ZIP is written at all", zip && zip.size > 0, String(zip && zip.size));

// Two photographs off the same phone share a filename. Neither may be lost.
const collide = {
  licenses: data.licenses,
  documents: [
    { id: "a", name: "IMG_0269.jpeg", type: "image/jpeg", data: b64("1"), linkedTo: "licenses:l1" },
    { id: "b", name: "IMG_0269.jpeg", type: "image/jpeg", data: b64("2"), linkedTo: "licenses:l1" },
  ],
  settings: {},
};
const collideZip = await generateCredentialZip(collide);
ok("a duplicate filename does not drop a file", collideZip.size > zip.size * 0);
{
  // Read the entry names back out of the archive rather than trusting size.
  const JSZip = (await import("jszip")).default;
  const read = await JSZip.loadAsync(await collideZip.arrayBuffer());
  const names = Object.keys(read.files).filter((n) => n.includes("IMG_0269"));
  eq("both copies are written under distinct names", names.length, 2);
  ok("the extension is not doubled", names.every((n) => !n.includes(".jpeg.jpg")), names.join(", "));

  const full = await JSZip.loadAsync(await zip.arrayBuffer());
  const entries = Object.keys(full.files);
  ok("the DEA folder holds the DEA card",
    entries.some((n) => n.includes("DEA_Registration/IMG_0270")), entries.join("\n"));
  ok("the board folder holds the certificate",
    entries.some((n) => n.includes("Board_Certifications/cert.pdf")));
  ok("the summary spreadsheet is in the ZIP",
    entries.some((n) => n.endsWith("credentials_summary.xlsx")));
  const backup = await full.file("CredentialDOMD_Export/credentialdomd_backup.json").async("string");
  ok("the backup carries no API key", !backup.includes("SECRET"));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
