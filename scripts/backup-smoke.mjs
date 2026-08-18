#!/usr/bin/env node
/**
 * backup-smoke: build the monthly backup ZIP from a fake dataset and check the
 * layout, without Supabase, Deno, Resend or a single byte of real data.
 *
 * It imports the REAL helpers from supabase/functions/build-backup/lib.ts.
 * Node 24 strips the types on import, so there is no second copy of the logic
 * to drift: the file this asserts against is the file the edge function runs.
 * The only thing stubbed is the part the helpers do not own, which is fetching
 * document bytes from storage.
 *
 *   node scripts/backup-smoke.mjs [--keep]
 *
 * --keep writes the ZIPs to /tmp so you can open them and read README.html.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.join(here, "..", "supabase", "functions", "build-backup", "lib.ts"));

const {
  SECTIONS, PART_CAP_BYTES, VAULT_NOTE,
  backupStoragePath, backupSubject, buildRecordIndex, countRecords,
  dataEntries, documentIndexCsv, firstName, planDocumentParts,
  prepareDocuments, renderEmailText, renderReadme,
} = lib;

const KEEP = process.argv.includes("--keep");
const AUTH_USER_ID = "user_2fakeClerkId";
const PERIOD = "2026-08";
const GENERATED_AT = "2026-08-17T13:00:00.000Z";

// ── A fake account ───────────────────────────────────────────────────────────

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  auth_user_id: AUTH_USER_ID,
  name: "Dr. Test Physician, MD",
  email: "test@example.com",
  npi: "1234567890",
  api_key: "SHOULD-NEVER-APPEAR",
  anthropic_api_key: "SHOULD-NEVER-APPEAR-EITHER",
};

const licenses = [
  { id: "aaaaaaa1-1111-4111-8111-111111111111", name: "Utah Medical License", type: "State license", state: "UT", expiration_date: "2027-01-31" },
  { id: "aaaaaaa2-1111-4111-8111-111111111111", name: "DEA Registration", type: "DEA", expiration_date: "2026-11-30", notes: 'Renewed, "paid in full", see receipt' },
];
const healthRecords = [
  { id: "bbbbbbb1-1111-4111-8111-111111111111", name: "TB Screening", expiration_date: "2026-12-01" },
];
const documents = [
  // Two files that resolve to the same name, to prove the (2) dedupe.
  { id: "ccccccc1-1111-4111-8111-111111111111", name: "scan.pdf", linked_to: "licenses:aaaaaaa2-1111-4111-8111-111111111111", storage_path: `${AUTH_USER_ID}/ccccccc1-1111-4111-8111-111111111111`, size_bytes: 40 * 1024 * 1024, uploaded_at: "2026-02-01T00:00:00Z" },
  { id: "ccccccc2-1111-4111-8111-111111111111", name: "scan.pdf", linked_to: "licenses:aaaaaaa2-1111-4111-8111-111111111111", storage_path: `${AUTH_USER_ID}/ccccccc2-1111-4111-8111-111111111111`, size_bytes: 45 * 1024 * 1024, uploaded_at: "2026-02-02T00:00:00Z" },
  // Unlinked, keeps its own name.
  { id: "ccccccc3-1111-4111-8111-111111111111", name: "cv.pdf", linked_to: null, storage_path: `${AUTH_USER_ID}/ccccccc3-1111-4111-8111-111111111111`, size_bytes: 50 * 1024 * 1024, uploaded_at: "2026-02-03T00:00:00Z" },
  // Points at another user's folder: must be skipped, never read.
  { id: "ccccccc4-1111-4111-8111-111111111111", name: "someone-elses.pdf", linked_to: null, storage_path: "user_2someoneElse/secret", size_bytes: 10, uploaded_at: "2026-02-04T00:00:00Z" },
  // Real row, storage object gone: must be counted as skipped, never dropped.
  { id: "ccccccc5-1111-4111-8111-111111111111", name: "missing.pdf", linked_to: "healthRecords:bbbbbbb1-1111-4111-8111-111111111111", storage_path: `${AUTH_USER_ID}/ccccccc5-1111-4111-8111-111111111111`, size_bytes: 1024, uploaded_at: "2026-02-05T00:00:00Z" },
];

const dataByTable = {};
for (const s of SECTIONS) dataByTable[s.table] = [];
dataByTable.licenses = licenses;
dataByTable.health_records = healthRecords;
dataByTable.documents = documents;

/** Stands in for storage.download. The one thing the helpers do not own. */
const STORAGE = new Map(
  documents
    .filter((d) => d.id !== "ccccccc5-1111-4111-8111-111111111111" && d.storage_path.startsWith(`${AUTH_USER_ID}/`))
    .map((d) => [d.storage_path, Buffer.alloc(Math.min(d.size_bytes, 4096), 7)]),
);

// ── The same build the edge function does ────────────────────────────────────

const recordCount = countRecords(dataByTable);
const sectionCounts = SECTIONS.map((s) => ({ label: s.label, table: s.table, count: dataByTable[s.table].length }));
const recordIndex = buildRecordIndex(dataByTable);
const prepared = prepareDocuments(documents, AUTH_USER_ID, recordIndex, undefined);
const planned = planDocumentParts(prepared.items, PART_CAP_BYTES);
const parts = planned.length;

const built = [];
for (let i = 0; i < parts; i++) {
  const partNo = i + 1;
  const zip = new JSZip();
  const failures = [];

  if (i === 0) {
    for (const e of dataEntries(profile, dataByTable, { period: PERIOD, generatedAt: GENERATED_AT, part: partNo, parts })) {
      zip.file(e.path, e.text);
    }
  }

  const included = [];
  let sourceBytes = 0;
  for (const doc of planned[i]) {
    const bytes = STORAGE.get(doc.path);
    if (!bytes || bytes.length === 0) {
      failures.push({ name: doc.originalName, reason: "the file could not be read from storage" });
      continue;
    }
    zip.file(`documents/${doc.fileName}`, bytes, { compression: "STORE" });
    included.push(doc);
    sourceBytes += bytes.length;
  }

  zip.file("documents/index.csv", documentIndexCsv(included));
  const skipped = i === 0 ? [...prepared.skipped, ...failures] : failures;
  zip.file("README.html", renderReadme({
    period: PERIOD, generatedAt: GENERATED_AT, part: partNo, parts,
    physicianName: profile.name, recordCount, sectionCounts,
    documentCount: included.length, totalDocumentCount: prepared.items.length,
    documentBytes: sourceBytes, skipped, hasData: i === 0,
  }));

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  built.push({ partNo, zip: await JSZip.loadAsync(buf), buf, included, skipped, path: backupStoragePath(AUTH_USER_ID, PERIOD, partNo, parts) });
}

// ── Assertions ───────────────────────────────────────────────────────────────

// Queued, not run inline: half of these are async, and a rejected promise
// caught by a synchronous try block is a test that always passes.
const queued = [];
const check = (name, fn) => queued.push([name, fn]);

const one = built[0];
const names = (b) => Object.keys(b.zip.files).filter((n) => !b.zip.files[n].dir);
const all = built.flatMap(names);

check("README.html is in every part", () => {
  for (const b of built) assert.ok(names(b).includes("README.html"), `part ${b.partNo} has no README.html`);
});

check("data/backup.json exists", () => {
  assert.ok(names(one).includes("data/backup.json"));
});

check("data/licenses.csv exists", () => {
  assert.ok(names(one).includes("data/licenses.csv"));
});

check("documents/index.csv is in every part", () => {
  for (const b of built) assert.ok(names(b).includes("documents/index.csv"), `part ${b.partNo} has no index`);
});

check("only non-empty sections get a CSV", () => {
  const csvs = names(one).filter((n) => n.startsWith("data/") && n.endsWith(".csv")).sort();
  assert.deepEqual(csvs, ["data/documents.csv", "data/health_records.csv", "data/licenses.csv"]);
});

check("filenames are deduped with a (2) suffix", () => {
  const docs = all.filter((n) => n.startsWith("documents/") && n !== "documents/index.csv");
  assert.ok(docs.includes("DEA Registration - scan.pdf".replace(/^/, "documents/")), `missing first scan, got ${docs.join(", ")}`);
  assert.ok(docs.includes("documents/DEA Registration - scan (2).pdf"), `missing deduped scan, got ${docs.join(", ")}`);
  assert.equal(new Set(docs).size, docs.length, "duplicate entry names inside the archive");
});

check("an unlinked document keeps its own name", () => {
  assert.ok(all.includes("documents/cv.pdf"));
});

check("a document outside the user's folder is never read", () => {
  assert.ok(!all.some((n) => n.includes("someone-elses")), "a foreign path made it into the archive");
  assert.ok(prepared.skipped.some((s) => s.name === "someone-elses.pdf"), "the foreign path was not reported");
});

check("a document whose file is gone is counted, not dropped", () => {
  const skippedNames = built.flatMap((b) => b.skipped.map((s) => s.name));
  assert.ok(skippedNames.includes("missing.pdf"), "the missing file was not reported");
  assert.ok(!all.some((n) => n.includes("missing.pdf")), "the missing file appeared anyway");
});

check("every skipped file is named in a README", async () => {
  // Synchronous check against the source, since README text is rendered above.
  const html = renderReadme({
    period: PERIOD, generatedAt: GENERATED_AT, part: 1, parts,
    physicianName: profile.name, recordCount, sectionCounts,
    documentCount: 0, totalDocumentCount: prepared.items.length, documentBytes: 0,
    skipped: [...prepared.skipped, { name: "missing.pdf", reason: "the file could not be read from storage" }],
    hasData: true,
  });
  assert.ok(html.includes("missing.pdf"));
  assert.ok(html.includes("someone-elses.pdf"));
});

check("the archive names the private vault as excluded", async () => {
  const html = await one.zip.file("README.html").async("string");
  assert.ok(html.includes("private vault"), "README does not mention the private vault");
  assert.ok(html.includes("AI keys"), "README does not mention the AI keys");
});

check("no AI key reaches backup.json", async () => {
  const text = await one.zip.file("data/backup.json").async("string");
  assert.ok(!text.includes("SHOULD-NEVER-APPEAR"), "an AI key was written into the snapshot");
  const snap = JSON.parse(text);
  assert.equal(snap.format, "credentialdomd-backup");
  assert.equal(snap.record_count, recordCount);
  assert.equal(snap.data.licenses.length, 2);
  assert.equal(snap.table_map.health_records, "healthRecords");
  assert.ok(!("api_key" in snap.profile) && !("anthropic_api_key" in snap.profile));
});

check("licenses.csv has a header row and one line per record", async () => {
  const csv = await one.zip.file("data/licenses.csv").async("string");
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines.length, 3, `expected header plus 2 rows, got ${lines.length}`);
  assert.ok(lines[0].startsWith("id,name,type"), `unexpected header: ${lines[0]}`);
  assert.ok(csv.includes('"Renewed, ""paid in full"", see receipt"'), "quotes and commas are not escaped");
});

check("index.csv lists the files in that part", async () => {
  const csv = await one.zip.file("documents/index.csv").async("string");
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "file,original name,linked record,uploaded date,size (bytes)");
  assert.equal(lines.length, one.included.length + 1);
});

check("135 MB of scans split into parts under the cap", () => {
  assert.ok(parts >= 2, `expected a multi-part plan, got ${parts}`);
  for (const p of planned) {
    const total = p.reduce((n, d) => n + d.size, 0);
    assert.ok(total <= PART_CAP_BYTES || p.length === 1, `a part holds ${total} bytes, over the cap`);
  }
});

check("part names say which part they are", () => {
  assert.equal(built[0].path, `${AUTH_USER_ID}/${PERIOD}/CredentialDOMD-backup-${PERIOD}-part-1.zip`);
  assert.equal(backupStoragePath(AUTH_USER_ID, PERIOD, 1, 1), `${AUTH_USER_ID}/${PERIOD}/CredentialDOMD-backup-${PERIOD}.zip`);
});

check("the email says what is inside, when the link dies, and what is missing", () => {
  const text = renderEmailText({
    greetingName: firstName(profile.name, profile.email),
    period: PERIOD, recordCount, sectionCount: 3,
    documentCount: 3, documentBytes: 135 * 1024 * 1024,
    links: built.map((b, i) => ({ part: i + 1, parts, url: `https://example.test/${i + 1}`, bytes: b.buf.length })),
    expiresAt: "2026-09-21T13:00:00.000Z",
    skippedCount: 2,
  });
  assert.ok(text.startsWith("Test,"), `greeting is wrong: ${text.slice(0, 20)}`);
  assert.ok(text.includes("September 21, 2026"), "no expiry date");
  assert.ok(text.includes("More > Settings > Data and Backup"), "no path to a fresh link");
  assert.ok(text.includes(VAULT_NOTE), "the vault sentence is missing");
  assert.ok(text.includes("turn Monthly backup off"), "no way to opt out");
  assert.ok(/Part 1 of 2/.test(text) && /Part 2 of 2/.test(text), "the parts are not both linked");
  assert.equal(backupSubject(PERIOD), "Your CredentialDOMD backup for August 2026");
});

check("a part that failed to build is not passed off as complete", () => {
  const whole = renderEmailText({
    greetingName: "Test", period: PERIOD, recordCount, sectionCount: 3,
    documentCount: 3, documentBytes: 1024,
    links: [{ part: 1, parts: 2, url: "https://example.test/1", bytes: 10 }],
    expiresAt: "2026-09-21T13:00:00.000Z", skippedCount: 0, missingParts: 0,
  });
  const partial = renderEmailText({
    greetingName: "Test", period: PERIOD, recordCount, sectionCount: 3,
    documentCount: 3, documentBytes: 1024,
    links: [{ part: 1, parts: 2, url: "https://example.test/1", bytes: 10 }],
    expiresAt: "2026-09-21T13:00:00.000Z", skippedCount: 0, missingParts: 1,
  });
  assert.ok(whole.includes("Your complete CredentialDOMD backup"), "the whole-archive wording changed");
  assert.ok(!partial.includes("Your complete CredentialDOMD backup"), "an incomplete archive is still called complete");
  assert.ok(partial.includes("did not finish building"), "the missing part is not mentioned");
});

check("no em dash in anything a physician reads", async () => {
  const emailText = renderEmailText({
    greetingName: "Test", period: PERIOD, recordCount, sectionCount: 3,
    documentCount: 3, documentBytes: 1024, links: [{ part: 1, parts: 1, url: "https://example.test/1", bytes: 10 }],
    expiresAt: "2026-09-21T13:00:00.000Z", skippedCount: 0,
  });
  const readme = await one.zip.file("README.html").async("string");
  for (const [what, text] of [["email", emailText], ["README.html", readme], ["subject", backupSubject(PERIOD)]]) {
    assert.ok(!/[—–]/.test(text), `${what} contains an em dash or en dash`);
  }
});

// ── Report ───────────────────────────────────────────────────────────────────

const checks = [];
for (const [name, fn] of queued) {
  try { await fn(); checks.push(`  ok    ${name}`); }
  catch (e) { checks.push(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

console.log(`backup smoke: ${parts} part(s), ${recordCount} records, ${prepared.items.length} documents, ${prepared.skipped.length} skipped before download\n`);
for (const b of built) {
  console.log(`  part ${b.partNo}: ${b.path}`);
  for (const n of names(b).sort()) console.log(`      ${n}`);
}
console.log("");
console.log(checks.join("\n"));

if (KEEP) {
  for (const b of built) {
    const out = path.join("/tmp", path.basename(b.path));
    fs.writeFileSync(out, b.buf);
    console.log(`\nwrote ${out}`);
  }
}

console.log(process.exitCode ? "\nbackup smoke FAILED" : "\nbackup smoke passed");
