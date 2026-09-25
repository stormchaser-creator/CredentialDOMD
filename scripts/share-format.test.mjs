// Every outgoing-text formatter that had no test (tickets e8cc2a02, 821d2f76):
// the recipient never reads the sender's instructions, a share with no file
// carries the multi-line text, an SMS cut is never silent, and no outgoing
// text carries an em dash or a rule too wide for a phone. Synthetic records
// only; no network, no real messages.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  credentialLetter, credentialSharePayload, bundleShareText, veraPacketShareText, veraCoverNote, referencesShareTitle,
  followUpEmail, peerHeadsUp, cvPlainText, smsBody, smsCutNotice, SMS_BODY_MAX,
  alertTextBody, alertCutNotice, ALERT_TEXT_TAIL,
} from "../src/utils/shareText.js";
import { buildCvContent } from "../src/utils/cvContent.js";
import { normalizeMultilineNote, buildCredentialBlurb, buildCredentialText } from "../src/utils/helpers.js";
import { referenceSharePayload } from "../src/utils/referenceDraft.js";
import {
  invoiceCoverBlurb, invoiceCoverEmail, invoiceTextOnlyShare, invoiceCoverNotice, TEXT_RULE,
  expenseLineDetail, expenseReceiptLines, EXPENSE_INVOICE_TERMS,
} from "../src/utils/invoiceCover.js";
import { sendExpenseInvoiceFiles, copyInvoiceCover } from "../src/utils/expenseInvoiceSend.js";
import { attachedExpenseIds } from "../src/utils/receiptFiles.js";
import { invoicePdfFile, shareInvoicePdf } from "../src/utils/invoicePdf.js";
import {
  shareProbeText, shareProbePayload, shareProbePdfSource, SHARE_PROBE_SEPARATORS, SHARE_PROBE_TITLE,
} from "../src/utils/shareProbe.js";
import { customerReplyText } from "./ticket-agent-isolated.mjs";
import { ticketReplyEmail, isAutomatedReply, AUTOMATED_REPLY_LABEL } from "../supabase/functions/_shared/ticketReplyEmail.ts";

const EM_DASH = String.fromCodePoint(0x2014);
const root = fileURLToPath(new URL("..", import.meta.url));

// notifications.js resolves extensionless imports (Vite style), so it is
// bundled for node the way the render tests bundle components.
const bundled = await build({
  entryPoints: [`${root}src/utils/notifications.js`], bundle: true, platform: "node", format: "esm",
  write: false, define: { "import.meta.env": "{}" }, logLevel: "silent",
});
const notifications = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

const settings = { name: "Synthetic Physician", degreeType: "DO", npi: "9999999999", specialties: ["Surgery:Neurosurgery"] };
const license = {
  id: "lic-1", type: "Medical License", licenseNumber: "SYN-123", state: "CA", expirationDate: "2027-05-01",
  components: [{ name: "NPDB", scope: "National", status: "Clear", date: "2026-08-01" }],
};
const reference = { id: "ref-1", name: "Alice Example, MD", degree: "MD", specialty: "Neurosurgery", email: "a@example.test", phone: "202-555-0100" };
const docs = [{ name: "CA license.pdf" }, { name: "DEA certificate" }];
const invoice = {
  number: "INV-0012", physician: "Synthetic Physician, DO", npi: "9999999999", email: "doc@example.test",
  facility: "Example Regional Medical Center", periodStart: "2026-08-01", periodEnd: "2026-08-15", total: 3025,
};
const invoiceText = ["INVOICE INV-0012", TEXT_RULE, "Aug 1, 2026  On-call coverage", "   $1,500.00", TEXT_RULE, "TOTAL DUE: $3,025.00"].join("\n");

// -- normalizeMultilineNote --
test("a multi-line cover note keeps its lines, trimmed, blank lines dropped", () => {
  assert.equal(normalizeMultilineNote("  License attached.\n\n  DEA attached.  "), "License attached.\nDEA attached.");
});
test("a semicolon-joined run-on list is split onto lines", () => {
  assert.equal(normalizeMultilineNote("License attached; DEA attached; board certificate attached"),
    "License attached\nDEA attached\nboard certificate attached");
});
test("a single legitimate semicolon inside a sentence is left alone", () => {
  const sentence = "The DEA renewal is pending; I will send it when it arrives.";
  assert.equal(normalizeMultilineNote(sentence), sentence);
});
test("an empty note stays empty", () => {
  assert.equal(normalizeMultilineNote(""), "");
  assert.equal(normalizeMultilineNote(undefined), "");
});

// -- SMS cut --
test("a short SMS body is untouched and not flagged", () => {
  assert.deepEqual(smsBody("Hello there"), { text: "Hello there", truncated: false });
  assert.equal(smsBody("x".repeat(SMS_BODY_MAX)).truncated, false);
});
test("a long SMS body is cut at a word boundary and flagged", () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const { text, truncated } = smsBody(words);
  assert.equal(truncated, true);
  assert.ok(text.length <= SMS_BODY_MAX);
  assert.ok(words.startsWith(text));
  assert.match(words.slice(text.length, text.length + 1), /\s/, "the cut must fall between words");
});
test("the SMS cut lands on a line break and leaves no trailing whitespace", () => {
  assert.equal(smsBody(`${"a".repeat(1390)}\n${"b".repeat(30)}`).text, "a".repeat(1390));
  assert.equal(smsBody(`${"a".repeat(1390)}   \n${"b".repeat(30)}`).text, "a".repeat(1390));
});
test("an SMS body with no space is hard-cut at the limit", () => {
  assert.equal(smsBody("y".repeat(2000)).text.length, SMS_BODY_MAX);
});
test("the sender is told about a cut, and about the clipboard only when it holds the text", () => {
  assert.match(smsCutNotice(true), /shortened/i);
  assert.match(smsCutNotice(true), /clipboard/);
  assert.doesNotMatch(smsCutNotice(false), /clipboard/);
});

test("composeText reports the cut and copies the full text only when asked", async () => {
  const opened = [], copied = [];
  const saved = { window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  globalThis.window = { open: (url) => opened.push(url) };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { userAgent: "iPhone", clipboard: { writeText: async (t) => { copied.push(t); } } },
  });
  try {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const cut = notifications.composeText("(555) 123-4567", long, { copyFullOnCut: true });
    assert.equal(cut.truncated, true);
    assert.equal(await cut.copied, true);
    assert.deepEqual(copied, [long]);
    assert.ok(opened[0].startsWith("sms:5551234567&body="));
    assert.equal(decodeURIComponent(opened[0].split("&body=")[1]), smsBody(long).text);

    const quiet = notifications.composeText("5551234567", long);
    assert.equal(quiet.truncated, true, "a cut is always reported to the caller");
    assert.equal(await quiet.copied, false, "without copyFullOnCut the clipboard is left alone");
    assert.equal(copied.length, 1);

    const short = notifications.composeText("5551234567", "Short note", { copyFullOnCut: true });
    assert.equal(short.truncated, false);
    assert.equal(await short.copied, false);
    assert.equal(copied.length, 1);
  } finally {
    globalThis.window = saved.window;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
});

// -- Credential send --
test("a credential letter only claims attachments when they really travel with it", () => {
  const plain = credentialLetter(license, "licenses", settings);
  assert.match(plain, /^To whom it may concern,\n\nPlease find the credential verification for Synthetic Physician, DO below\.\n\n/);
  assert.doesNotMatch(plain, /attached/i);
  assert.match(credentialLetter(license, "licenses", settings, { attached: true }), /with supporting documentation attached\./);
  assert.match(credentialLetter(license, "licenses", settings, { note: "  Per your request.  " }), /\n\nPer your request\.\n\n/);
  assert.equal(credentialLetter(reference, "peerReferences", settings, { note: "Hello" }),
    `Hello\n\n${buildCredentialText(reference, "peerReferences", settings)}`);
});
test("a share with files carries the blurb; a share with no file carries the multi-line letter", () => {
  const letter = credentialLetter(license, "licenses", settings);
  const blurb = buildCredentialBlurb(license, "licenses", settings, true, "");
  const withFile = credentialSharePayload({ files: ["file"], subject: "S", blurb, letter });
  assert.deepEqual(withFile, { files: ["file"], title: "S", text: blurb });
  const textOnly = credentialSharePayload({ files: [], subject: "S", blurb, letter });
  assert.deepEqual(textOnly, { title: "S", text: letter });
  assert.ok(textOnly.text.includes("\n"), "text-only shares keep their line breaks");
});
test("the credential blurb speaks to the recipient only", () => {
  for (const hasDocs of [true, false]) {
    const blurb = buildCredentialBlurb(license, "licenses", settings, hasDocs, "");
    assert.doesNotMatch(blurb, /clipboard|sender/i);
    assert.ok(!blurb.includes(EM_DASH));
  }
});
test("search components are listed without an em dash", () => {
  const text = buildCredentialText(license, "licenses", settings);
  assert.ok(text.includes("- NPDB, National, Clear (Aug 1, 2026)"), text);
});
test("the credential summary line and missing dates carry no dash placeholder", () => {
  const text = buildCredentialText(license, "licenses", settings);
  assert.ok(text.split("\n").includes("Medical License, CA"), text);
  assert.doesNotMatch(text, /Issued:/, "a missing issue date is left out, not sent as a dash");
  assert.match(text, /Expires: May 1, 2027/);
  assert.doesNotMatch(buildCredentialBlurb(license, "licenses", settings, false, ""), /Issued/);
});

// -- Document packet and Vera packet --
test("the packet blurb lists the files and never mentions the clipboard", () => {
  const { title, letter, blurb } = bundleShareText(settings, docs, new Date("2026-09-25T12:00:00"));
  assert.equal(title, "Credential packet: Synthetic Physician, DO (2 documents)");
  assert.equal(blurb, "Credential packet for Synthetic Physician, DO (NPI 9999999999), 2 documents attached: 1. CA license.pdf. 2. DEA certificate. Sent via CredentialDOMD.");
  assert.match(letter, /\n  1\. CA license\.pdf\n  2\. DEA certificate\n/);
  assert.equal(bundleShareText({}, [{ name: "One" }]).title, "Credential packet: Physician (1 document)");
});
test("the Vera packet note and blurb read as lines and sentences", () => {
  const { title, note, blurb } = veraPacketShareText("License attached; DEA attached; please confirm receipt");
  assert.equal(title, "Credential packet");
  assert.equal(note, "License attached\nDEA attached\nplease confirm receipt\n\nSent from CredentialDOMD");
  assert.equal(blurb, "Credential packet: License attached. DEA attached. please confirm receipt. Sent from CredentialDOMD.");
  assert.equal(veraPacketShareText("").note, "Credential documents enclosed.\n\nSent from CredentialDOMD");
});

// -- References, follow-up, peer heads-up --
test("the multi-reference share carries the multi-line list under a plain title", () => {
  const { full } = referenceSharePayload([reference, { ...reference, id: "ref-2", name: "Brenda Example" }]);
  assert.ok(full.includes("\n\n"));
  assert.equal(referencesShareTitle(settings, 2), "Peer references: Synthetic Physician, DO (2)");
});
test("a follow-up email puts an address in To: and never greets it", () => {
  const byAddress = followUpEmail({ label: "CA Medical License", expirationDate: "2027-05-01", recipient: "office@example.test" });
  assert.equal(byAddress.to, "office@example.test");
  assert.ok(byAddress.body.startsWith("Hello,\n\n"));
  assert.doesNotMatch(byAddress.body, /example\.test/);
  const byName = followUpEmail({ label: "CA Medical License", expirationDate: "2027-05-01", recipient: "Dana", note: "Called on Monday." });
  assert.equal(byName.to, "");
  assert.equal(byName.body, "Hi Dana,\n\nFollowing up on CA Medical License, which expires May 1, 2027.\n\nCalled on Monday.");
  assert.equal(followUpEmail({ label: "Privileges" }).body, "Hello,\n\nFollowing up on Privileges.");
  assert.equal(followUpEmail({ label: `Medical License ${EM_DASH} CA` }).subject, "Following up: Medical License, CA");
});
test("the peer heads-up addresses the colleague by last name", () => {
  const h = peerHeadsUp(settings, { name: "Jane Smith, MD" });
  assert.equal(h.emailSubject, "Upcoming Reference Request from Synthetic Physician");
  assert.ok(h.emailBody.startsWith("Dear Dr. Smith,\n\n"));
  assert.ok(h.emailBody.endsWith("With sincere gratitude,\nSynthetic Physician, DO"));
  assert.ok(peerHeadsUp({}, {}).emailBody.startsWith("Dear Dr. Colleague,"));
});

// -- Plain-text CV --
test("the plain-text CV uses the phone-safe rule and no em dash", () => {
  const text = cvPlainText([
    { type: "header", name: "Synthetic Physician, DO", email: "doc@example.test", specialties: ["Surgery:Neurosurgery"], fullDegree: "Doctor of Osteopathic Medicine" },
    { type: "section", title: "Licenses", items: [{ primary: "California", secondary: "Medical License", date: "2020" }] },
  ], "9/25/2026");
  const lines = text.split("\n");
  assert.ok(lines.includes("  Doctor of Osteopathic Medicine, Neurosurgery"));
  assert.ok(lines.includes("  California  [2020]"));
  assert.ok(!/={10,}/.test(text), "no 60-wide '=' rule");
  for (const l of lines.filter((l) => /^-+$/.test(l))) assert.ok(l.length <= 32, `rule too wide: ${l.length}`);
  assert.equal(lines.at(-1), "Generated by CredentialDOMD | 9/25/2026");
});

// -- Alerts --
test("the alert message lists items without an em dash", () => {
  const soonDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const msg = notifications.buildNotificationMessage({ settings: { name: "Synthetic Physician", degreeType: "DO", notifyFreqDays: 7 } }, {
    expired: [{ id: "a", type: "Medical License", state: "CA", expirationDate: "2026-01-01" }],
    soon: [{ id: "b", type: "DEA Registration", expirationDate: soonDate }],
    cmeIssues: [], effectiveFreqDays: 7,
  });
  assert.ok(!msg.body.includes(EM_DASH), msg.body);
  assert.match(msg.body, /: expired Jan 1, 2026/);
  assert.match(msg.body, /\(10 days\) URGENT/);
});

// -- Invoice text-only share and the sender notice --
test("an invoice shared with no file carries the letter and the itemized invoice", () => {
  const body = invoiceTextOnlyShare(invoice, invoiceText);
  assert.ok(body.startsWith("Hello,\n\nBelow is invoice INV-0012"));
  assert.ok(body.endsWith(invoiceText));
  assert.doesNotMatch(body, /clipboard/i);
  assert.doesNotMatch(body, /attached/i);
});
test("every invoice send method tells the sender where the cover letter is, or nothing", () => {
  assert.match(invoiceCoverNotice("share+cover"), /clipboard/);
  assert.match(invoiceCoverNotice("download+cover"), /downloaded/);
  assert.equal(invoiceCoverNotice("share"), null);
  assert.equal(invoiceCoverNotice("share-text+cover"), null, "the text-only share already carried the letter");
  assert.equal(invoiceCoverNotice(null), null);
});

// -- One sweep: no outgoing builder emits an em dash or a sender instruction --
test("no outgoing text carries an em dash, and recipient text never mentions the clipboard", () => {
  const expense = { ...invoice, kind: "expenses", receipts: 2 };
  const recipientFacing = [
    credentialLetter(license, "licenses", settings), credentialLetter(license, "licenses", settings, { attached: true }),
    credentialLetter(reference, "peerReferences", settings, { note: "Hi" }),
    buildCredentialBlurb(license, "licenses", settings, true, "Note"), buildCredentialBlurb(reference, "peerReferences", settings, true, ""),
    ...Object.values(bundleShareText(settings, docs)), ...Object.values(veraPacketShareText("a; b; c")),
    referencesShareTitle(settings, 3), ...Object.values(referenceSharePayload([reference])),
    ...Object.values(followUpEmail({ label: "X", recipient: "a@b.test" })), ...Object.values(peerHeadsUp(settings, reference)),
    cvPlainText([{ type: "header", name: "N", specialties: ["A:B"], fullDegree: "MD" }]),
    invoiceCoverBlurb(invoice), invoiceCoverEmail(invoice), invoiceCoverBlurb(expense), invoiceCoverEmail(expense),
    invoiceTextOnlyShare(invoice, invoiceText),
  ];
  for (const text of recipientFacing) {
    assert.ok(!String(text).includes(EM_DASH), `em dash in: ${text}`);
    assert.doesNotMatch(String(text), /clipboard/i, `sender instruction in: ${text}`);
  }
});
test("no recipient-facing string in the app source tells the recipient about a clipboard", () => {
  for (const file of ["src/utils/helpers.js", "src/utils/invoicePdf.js", "src/components/features/DocumentsSection.jsx", "src/utils/shareText.js"]) {
    const src = readFileSync(`${root}${file}`, "utf8");
    assert.doesNotMatch(src, /sender's clipboard|clipboard for pasting/, file);
  }
});

// -- Newline probe --
test("the probe body carries every candidate separator, each labelled", () => {
  const text = shareProbeText();
  for (const { id, label, sep } of SHARE_PROBE_SEPARATORS) {
    assert.ok(text.includes(`Test ${id} BEFORE (${label}).${sep}Test ${id} AFTER.`), `missing test ${id}`);
  }
  for (const sep of ["\n\n", "\r\n\r\n", String.fromCodePoint(0x2028), String.fromCodePoint(0x2029), "<br><br>"]) {
    assert.ok(SHARE_PROBE_SEPARATORS.some((s) => s.sep === sep), `separator not probed: ${JSON.stringify(sep)}`);
  }
  assert.ok(text.startsWith("Subject from body."));
  assert.ok(!text.includes(EM_DASH));
});
test("the probe runs with a file and as text only, under the same title", () => {
  const withFile = shareProbePayload({ withFile: true });
  const textOnly = shareProbePayload();
  assert.equal(withFile.title, SHARE_PROBE_TITLE);
  assert.equal(textOnly.title, SHARE_PROBE_TITLE);
  assert.equal(withFile.text, textOnly.text);
  assert.equal(withFile.files.length, 1);
  assert.equal(withFile.files[0].type, "application/pdf");
  assert.equal(textOnly.files, undefined);
});
test("the probe PDF is well formed: every xref offset lands on its object", () => {
  const pdf = shareProbePdfSource();
  assert.ok(pdf.startsWith("%PDF-1.4\n") && pdf.endsWith("%%EOF\n"));
  assert.match(pdf, /^[\x20-\x7e\n]*$/, "ASCII only, so string offsets are byte offsets");
  const startxref = Number(pdf.match(/startxref\n(\d+)\n/)[1]);
  assert.ok(pdf.slice(startxref).startsWith("xref\n"));
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((o, i) => assert.ok(pdf.slice(o).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1}`));
});
test("no raw line-separator character sits in the probe source", () => {
  const src = readFileSync(`${root}src/utils/shareProbe.js`, "utf8");
  assert.ok(!src.includes(String.fromCodePoint(0x2028)) && !src.includes(String.fromCodePoint(0x2029)));
});

// -- Ticket replies --
test("the host strips em dashes from an automated reply and keeps numeric ranges", () => {
  assert.equal(customerReplyText("Fixed the share text \u{2014} it now keeps breaks."), "Fixed the share text, it now keeps breaks.");
  assert.equal(customerReplyText("Three paths\u{2014}share, mailto, SMS\u{2014}were checked."), "Three paths, share, mailto, SMS, were checked.");
  assert.equal(customerReplyText("\u{2014} reported in the app"), "reported in the app");
  assert.equal(customerReplyText("Open 9\u{2013}5 weekdays"), "Open 9\u{2013}5 weekdays");
  assert.equal(customerReplyText("It works \u{2014}."), "It works.");
  assert.equal(customerReplyText("Line one \u{2014}\nLine two"), "Line one\nLine two");
  assert.equal(customerReplyText(`${AUTOMATED_REPLY_LABEL}\n\n${AUTOMATED_REPLY_LABEL}\n\nHello`), "Hello");
});
test("a spaced en dash range and the rest of the reply are left exactly as written", () => {
  // An en dash is a range, not a sentence dash: turning it into a comma made
  // "Aug 1 - Aug 15" read as a two-item list in a customer reply.
  for (const text of [
    "Invoices covering Aug 1 \u{2013} Aug 15 now show each day.",
    "Your CV now reads (2020 \u{2013} current).",
    "Done \u{2013} thanks",
    "See line 97, :126 for the check.",
    "Fixed, (see Help).",
  ]) assert.equal(customerReplyText(text), text);
});
test("an automated reply email is from and signed CredentialDOMD Support, never Eric", () => {
  const automated = ticketReplyEmail(`${AUTOMATED_REPLY_LABEL}\n\nThe share text now keeps its breaks.`, false);
  assert.equal(automated.automated, true);
  assert.equal(automated.from, "CredentialDOMD Support <whit@credentialdomd.com>");
  assert.doesNotMatch(automated.text, /Eric/);
  assert.match(automated.text, /\n\nCredentialDOMD Support\n\n--\n/);
  const human = ticketReplyEmail("Thanks, looking at it now.", true);
  assert.equal(human.automated, false);
  assert.equal(human.from, "Eric Whitney, DO <whit@credentialdomd.com>");
  assert.match(human.text, /A file is attached/);
  assert.match(human.text, /\n\nEric\n\n--\nEric Whitney, DO\n/);
  assert.equal(isAutomatedReply(`  ${AUTOMATED_REPLY_LABEL}\n\nx`), true);
  assert.equal(isAutomatedReply("CredentialDOMD Support is great"), false);
});
test("the automated label the email checks is the label the host writes", () => {
  const broker = readFileSync(`${root}scripts/ticket-agent-isolated.mjs`, "utf8");
  assert.ok(broker.includes(`const labeledReply = \`${AUTOMATED_REPLY_LABEL}\\n\\n`), "label drift between broker and email");
});

// -- Alert digest as a text message (review finding: silent cut on the alert screens) --
const manyAlerts = (n) => {
  const soonDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const states = ["CA", "ND", "CO", "TX", "NV", "AZ", "OR", "WA"];
  return notifications.buildNotificationMessage({ settings: { name: "Synthetic Physician", degreeType: "DO", notifyFreqDays: 7 } }, {
    expired: [{ id: "x0", type: "Medical License", state: "CA", expirationDate: "2026-01-01" }],
    soon: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: `Hospital Privileges ${i + 1}`, state: states[i % states.length], expirationDate: soonDate })),
    cmeIssues: [{ state: "ND", issues: ["30/60 total hrs", "Ethics: 0/2 hrs"] }], effectiveFreqDays: 7,
  });
};
test("an alert digest that fits one text is sent whole", () => {
  const msg = manyAlerts(3);
  assert.ok(msg.body.length < SMS_BODY_MAX);
  assert.deepEqual(alertTextBody(msg.body), { text: msg.body, truncated: false });
});
test("a long alert digest is cut before an item and says the rest is in the app", () => {
  const msg = manyAlerts(24);
  assert.ok(msg.body.length > SMS_BODY_MAX, `fixture must overflow: ${msg.body.length}`);
  const { text, truncated } = alertTextBody(msg.body);
  assert.equal(truncated, true);
  assert.ok(text.length <= SMS_BODY_MAX, `too long: ${text.length}`);
  assert.ok(text.endsWith(`\n\n${ALERT_TEXT_TAIL}`));
  const kept = text.slice(0, -ALERT_TEXT_TAIL.length).trimEnd();
  assert.ok(msg.body.startsWith(kept), "the kept part is the digest's own opening");
  // Every item that made it keeps its State line: the cut never falls
  // between an item and the lines indented under it.
  const next = msg.body.slice(kept.length).replace(/^\n+/, "");
  assert.doesNotMatch(next, /^ {4}/, "cut inside an item");
  assert.ok(!text.includes(EM_DASH));
});
test("the alert screens' Text path reports the cut and puts the full digest on the clipboard", async () => {
  const opened = [], copied = [], notices = [];
  const saved = { window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  globalThis.window = { open: (url) => opened.push(url) };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { userAgent: "iPhone", clipboard: { writeText: async (t) => { copied.push(t); } } },
  });
  try {
    const msg = manyAlerts(24);
    const cut = notifications.textAlert("(555) 123-4567", msg.body, (n) => notices.push(n));
    assert.equal(cut.truncated, true);
    assert.equal(await cut.copied, true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(copied, [msg.body], "the full digest, not the cut one");
    assert.deepEqual(notices, [alertCutNotice(true)]);
    const sent = decodeURIComponent(opened[0].split("&body=")[1]);
    assert.equal(sent, alertTextBody(msg.body).text);
    assert.ok(sent.endsWith(ALERT_TEXT_TAIL));

    const short = notifications.textAlert("5551234567", manyAlerts(2).body, (n) => notices.push(n));
    assert.equal(short.truncated, false);
    await new Promise((r) => setImmediate(r));
    assert.equal(copied.length, 1, "a digest that fits never touches the clipboard");
    assert.equal(notices.length, 1, "and says nothing");
  } finally {
    globalThis.window = saved.window;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
});
test("the alert cut notice names the clipboard only when it holds the digest", () => {
  assert.match(alertCutNotice(true), /shortened/);
  assert.match(alertCutNotice(true), /clipboard/);
  assert.doesNotMatch(alertCutNotice(false), /clipboard|Copy/, "the alert screens have no Copy button");
});
test("no alert screen calls composeText directly, so none can cut silently", () => {
  for (const file of ["src/components/pages/NotificationCenter.jsx", "src/components/pages/NotificationBanner.jsx", "src/components/pages/SettingsSection.jsx"]) {
    const src = readFileSync(`${root}${file}`, "utf8");
    assert.doesNotMatch(src, /composeText\(/, file);
    assert.match(src, /textAlert\(s\.phone, msg\.body, /, file);
  }
});

// -- Vera's cover note (review finding: the model's em dashes reached the recipient) --
test("Vera's packet note, blurb and Reply-by-email seed carry no em dash", () => {
  const raw = `Enclosed: DEA and CA license ${EM_DASH} both current.\n${EM_DASH} Board certificate attached\nPlease confirm receipt ${EM_DASH}`;
  const { note, blurb } = veraPacketShareText(raw);
  for (const text of [note, blurb, veraCoverNote(raw)]) assert.ok(!text.includes(EM_DASH), text);
  assert.equal(veraCoverNote(raw), "Enclosed: DEA and CA license, both current.\nBoard certificate attached\nPlease confirm receipt");
  assert.equal(blurb, "Credential packet: Enclosed: DEA and CA license, both current. Board certificate attached. Please confirm receipt. Sent from CredentialDOMD.");
  const src = readFileSync(`${root}src/components/features/AssistantSection.jsx`, "utf8");
  assert.match(src, /note: veraCoverNote\(a\.coverNote\)/, "Reply by email seeds the cleaned note");
});

// -- CV work history (review finding: position and city joined by an em dash) --
test("the CV work-history line joins position and place with a comma", () => {
  const content = buildCvContent({
    settings: { name: "Synthetic Physician", degreeType: "DO" },
    licenses: [], cme: [], privileges: [], insurance: [], education: [], publications: [], memberships: [], peerReferences: [],
    workHistory: [{ id: "w1", employer: "Example Regional Medical Center", position: "Attending Neurosurgeon", city: "Chico", state: "CA", startDate: "2020-07-15", current: "Yes" }],
  });
  const text = cvPlainText(content, "9/25/2026");
  assert.ok(text.split("\n").includes("    Attending Neurosurgeon, Chico, CA"), text);
  assert.ok(!text.includes(EM_DASH), "no em dash anywhere in the CV text");
  for (const section of content) for (const item of section.items || []) {
    for (const v of [item.primary, item.secondary, item.detail]) assert.ok(!String(v || "").includes(EM_DASH), String(v));
  }
});

// -- A credential's private notes (review finding: text-only share sent them) --
test("a credential's own notes never go out in the letter or the preview", () => {
  const withNotes = { ...license, notes: "board portal login jroe, fee paid on AmEx" };
  const text = buildCredentialText(withNotes, "licenses", settings);
  assert.doesNotMatch(text, /Notes:|jroe|AmEx/);
  for (const out of [
    credentialLetter(withNotes, "licenses", settings), credentialLetter(withNotes, "licenses", settings, { attached: true }),
    credentialSharePayload({ files: [], subject: "S", blurb: "", letter: credentialLetter(withNotes, "licenses", settings) }).text,
    buildCredentialBlurb(withNotes, "licenses", settings, false, ""),
  ]) assert.doesNotMatch(out, /jroe|AmEx/);
  assert.match(credentialLetter(withNotes, "licenses", settings, { note: "Per your request." }), /Per your request\./,
    "the per-send Note still goes out");
});

// -- Expense invoice receipts (review findings: a PDF or clipboard claiming receipts that did not go) --
const expenseInv = () => ({
  number: "EXP-0003", kind: "expenses", physician: "Synthetic Physician, DO", npi: "9999999999", email: "doc@example.test",
  facility: "Example Locums Agency", periodStart: "2026-08-01", periodEnd: "2026-08-03", terms: EXPENSE_INVOICE_TERMS, total: 740,
  lines: [
    { date: "2026-08-01", label: "Airfare: Example Air", detail: expenseLineDetail("", 1), amount: 400, expenseId: "e1" },
    { date: "2026-08-02", label: "Lodging: Example Inn", detail: expenseLineDetail("late checkout", 2), amount: 300, expenseId: "e2" },
    { date: "2026-08-03", label: "Parking", detail: expenseLineDetail("", 0), amount: 40, expenseId: "e3" },
  ],
});
const RECEIPT_CLAIM = /receipts? (?:is |are )?attached/i;
test("an expense line says attached only for receipts in this send", () => {
  assert.equal(expenseLineDetail("", 1), `receipt on file`);
  assert.equal(expenseLineDetail("late checkout", 2), `late checkout \u{b7} receipts on file`);
  assert.equal(expenseLineDetail("", 0), "no receipt");
  const lines = expenseInv().lines;
  const some = expenseReceiptLines(lines, new Set(["e2"]));
  assert.deepEqual(some.map((l) => l.detail), ["receipt on file", "late checkout \u{b7} receipts attached", "no receipt"]);
  assert.deepEqual(expenseReceiptLines(some).map((l) => l.detail), ["receipt on file", "late checkout \u{b7} receipts on file", "no receipt"]);
  // Lines saved before they carried expenseId: attached only when every receipt is.
  const legacy = [{ detail: "receipt attached" }, { detail: "Uber \u{b7} receipts attached" }];
  assert.deepEqual(expenseReceiptLines(legacy).map((l) => l.detail), ["receipt on file", "Uber \u{b7} receipts on file"]);
  assert.deepEqual(expenseReceiptLines(legacy, new Set(), { allAttached: true }).map((l) => l.detail), ["receipt attached", "Uber \u{b7} receipts attached"]);
  // A note that merely mentions a receipt is never rewritten.
  assert.deepEqual(expenseReceiptLines([{ detail: "receipt attached to email later \u{b7} no receipt" }])[0].detail, "receipt attached to email later \u{b7} no receipt");
  assert.doesNotMatch(EXPENSE_INVOICE_TERMS, /receipt/i);
});
test("an expense counts as attached only when all its receipts are in hand", () => {
  const docs = [
    { id: "d1", linkedTo: "travelExpenses:e1" }, { id: "d2", linkedTo: "travelExpenses:e2" },
    { id: "d3", linkedTo: "travelExpenses:e2" }, { id: "d4", linkedTo: "licenses:x" },
  ];
  assert.deepEqual([...attachedExpenseIds(docs, [])].sort(), ["e1", "e2"]);
  assert.deepEqual([...attachedExpenseIds(docs, [{ id: "d3" }])], ["e1"]);
  assert.deepEqual([...attachedExpenseIds([], null)], []);
});

// A fake share sheet: `accept(files)` decides canShare, share rejects or
// resolves per `outcome`, and every clipboard write is kept.
const fakeNav = ({ accept = () => true, outcome = () => "ok", clipboardFails = false } = {}) => {
  const log = { shares: [], clipboard: [], canShare: [] };
  return {
    log,
    clipboard: { writeText: async (t) => { if (clipboardFails) throw Error("NotAllowedError"); log.clipboard.push(t); } },
    canShare: ({ files }) => { log.canShare.push(files.length); return accept(files); },
    share: async (payload) => {
      log.shares.push(payload);
      const o = outcome(payload);
      if (o === "abort") throw Object.assign(Error("cancel"), { name: "AbortError" });
      if (o === "fail") throw Object.assign(Error("too large"), { name: "NotAllowedError" });
    },
  };
};
// The text runs of a jsPDF file, one per line, for readable failures.
const pdfText = async (file) => [...(await file.text()).matchAll(/\((.*)\) Tj/g)].map((m) => m[1]).join("\n");
const receiptFile = (name) => new File([new TextEncoder().encode("RECEIPT")], name, { type: "image/jpeg" });

test("when the OS refuses the bundle, the invoice goes alone and nothing claims the receipts", async () => {
  const nav = fakeNav({ accept: (files) => files.length === 1 });
  const downloads = [];
  const files = [receiptFile("air.jpg"), receiptFile("inn-1.jpg"), receiptFile("inn-2.jpg")];
  const sent = await sendExpenseInvoiceFiles({
    inv: expenseInv(), files, attachedExpenseIds: new Set(["e1", "e2"]), nav, pdfFor: invoicePdfFile, download: (f) => downloads.push(f),
  });
  assert.equal(sent.how, "share");
  assert.equal(sent.droppedForSize, 3);
  assert.deepEqual(nav.log.canShare, [4, 1]);
  assert.equal(nav.log.shares.length, 1);
  const [only] = nav.log.shares;
  assert.equal(only.files.length, 1);
  assert.doesNotMatch(only.text, RECEIPT_CLAIM, "share text of the invoice-alone send");
  const pdf = await pdfText(only.files[0]);
  assert.doesNotMatch(pdf, /receipts? attached/, "the PDF that went alone");
  assert.match(pdf, /receipt on file/);
  assert.ok(sent.lines.every((l) => !/attached/.test(l.detail)), "the recorded lines match what went");
  // Written before the share: never a count it could not take back.
  assert.equal(nav.log.clipboard.length, 1);
  assert.doesNotMatch(nav.log.clipboard[0], RECEIPT_CLAIM);
  assert.match(nav.log.clipboard[0], /reimbursable travel expenses/);
  assert.equal(downloads.length, 0);
});
test("a bundle that goes whole counts its receipts in the share text and the PDF, never on the clipboard", async () => {
  const nav = fakeNav();
  const files = [receiptFile("air.jpg"), receiptFile("inn-1.jpg")];
  // e2 has two receipts but only one resolved, so only e1 is fully attached.
  const sent = await sendExpenseInvoiceFiles({
    inv: expenseInv(), files, attachedExpenseIds: new Set(["e1"]), nav, pdfFor: invoicePdfFile, download: () => assert.fail("no download"),
  });
  assert.deepEqual({ how: sent.how, droppedForSize: sent.droppedForSize, coverCopied: sent.coverCopied }, { how: "share", droppedForSize: 0, coverCopied: true });
  const [share] = nav.log.shares;
  assert.equal(share.files.length, 3);
  assert.match(share.text, /2 receipts are attached\./);
  const pdf = await pdfText(share.files[0]);
  assert.match(pdf, /^receipt attached$/m);
  assert.match(pdf, /late checkout . receipts on file/);
  assert.doesNotMatch(pdf, /per agreement; receipts attached/);
  assert.doesNotMatch(nav.log.clipboard[0], RECEIPT_CLAIM);
});
test("a cancelled share records nothing, and no share support means a download of everything", async () => {
  const cancelled = await sendExpenseInvoiceFiles({
    inv: expenseInv(), files: [receiptFile("a.jpg")], attachedExpenseIds: new Set(["e1"]),
    nav: fakeNav({ outcome: () => "abort" }), pdfFor: invoicePdfFile, download: () => assert.fail("no download"),
  });
  assert.equal(cancelled, null);
  const downloads = [];
  const noFiles = fakeNav({ accept: () => false });
  const down = await sendExpenseInvoiceFiles({
    inv: expenseInv(), files: [receiptFile("a.jpg")], attachedExpenseIds: new Set(["e1"]),
    nav: noFiles, pdfFor: invoicePdfFile, download: (f) => downloads.push(f),
  });
  assert.equal(down.how, "download");
  assert.equal(downloads[0].length, 2, "invoice and receipt land together");
  assert.equal(down.coverCopied, true);
  const failedClipboard = await copyInvoiceCover(expenseInv(), fakeNav({ clipboardFails: true }).clipboard);
  assert.equal(failedClipboard, false);
});

// -- The PDF download fallback says where the cover letter is (review finding) --
test("a PDF send that falls back to a download reports the cover letter on the clipboard", async () => {
  const saved = {
    window: globalThis.window, document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  const clicks = [];
  globalThis.window = { navigator: {}, matchMedia: () => ({ matches: false }) };
  globalThis.document = { createElement: () => ({ click() { clicks.push(this.download); } }) };
  const setNav = (clipboardOk) => Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => { if (!clipboardOk) throw Error("denied"); } } },
  });
  try {
    setNav(true);
    const how = await shareInvoicePdf(invoice, "Invoice INV-0012", "");
    assert.equal(how, "download+cover");
    assert.deepEqual(clicks, ["INV-0012.pdf"]);
    assert.match(invoiceCoverNotice(how), /downloaded\. The cover letter is on your clipboard/);
    setNav(false);
    assert.equal(await shareInvoicePdf(invoice, "Invoice INV-0012", ""), "download", "no clipboard, no claim");
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
});
