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
  credentialLetter, credentialSharePayload, bundleShareText, veraPacketShareText, referencesShareTitle,
  followUpEmail, peerHeadsUp, cvPlainText, smsBody, smsCutNotice, SMS_BODY_MAX,
} from "../src/utils/shareText.js";
import { normalizeMultilineNote, buildCredentialBlurb, buildCredentialText } from "../src/utils/helpers.js";
import { referenceSharePayload } from "../src/utils/referenceDraft.js";
import {
  invoiceCoverBlurb, invoiceCoverEmail, invoiceTextOnlyShare, invoiceCoverNotice, TEXT_RULE,
} from "../src/utils/invoiceCover.js";
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
    assert.equal(quiet.truncated, true);
    assert.equal(await quiet.copied, false, "the alert screens do not overwrite the clipboard");
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
  assert.equal(customerReplyText("Done \u{2013} thanks"), "Done, thanks");
  assert.equal(customerReplyText("It works \u{2014}."), "It works.");
  assert.equal(customerReplyText(`${AUTOMATED_REPLY_LABEL}\n\n${AUTOMATED_REPLY_LABEL}\n\nHello`), "Hello");
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
