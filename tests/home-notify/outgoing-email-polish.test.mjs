import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reminderGreeting, reminderHeadline, reminderLabel } from "../../supabase/functions/_shared/reminderRows.mjs";
import { ackText } from "../../supabase/functions/_shared/requestFlow.ts";
import { withDegree, oneDegree } from "../../src/utils/outgoingText.js";
import { withDegree as edgeWithDegree, oneDegree as edgeOneDegree } from "../../supabase/functions/_shared/app/utils/outgoingText.js";
import { buildCvContent } from "../../src/utils/cvContent.js";
import { invoiceEmailSender } from "../../src/utils/invoiceEmail.js";

// Server emails a member or a credentialer reads, as the builders write them.
// Synthetic people only.

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("the reminder digest greets by first name, never by the mailbox name", () => {
  assert.equal(reminderGreeting("Dr. Jordan Rivera"), "Hi Jordan,");
  assert.equal(reminderGreeting("José Álvarez"), "Hi José,");
  assert.equal(reminderGreeting("Zoë Chen"), "Hi Zoë,");
  assert.equal(reminderGreeting("Jordan Rivera, MD"), "Hi Jordan,");
  assert.equal(reminderGreeting(""), "Hello,");
  assert.equal(reminderGreeting(null), "Hello,");
  const src = read("supabase/functions/send-reminders/index.ts");
  assert.match(src, /const text = `\$\{reminderGreeting\(p\.name\)\}\n/);
  assert.doesNotMatch(src, /email\.split\("@"\)/, "no mailbox-name fallback");
  assert.match(read("supabase/functions/send-invite/index.ts"), /return `\$\{reminderGreeting\(name\)\}\n/);
});

test("the backup email greets the same way", async () => {
  const lib = await import("../../supabase/functions/build-backup/lib.ts");
  assert.equal(lib.firstName("José Álvarez", "jalvarez7@example.test"), "José");
  assert.equal(lib.firstName("", "jordan.rivera+cdomd@example.test"), null);
  assert.equal(lib.greetingLine("José"), "Hi José,");
  assert.equal(lib.greetingLine(null), "Hello,");
  assert.equal(lib.BACKUP_PAGE_PATH, "More > Data & Backup", "the More menu's own label");
});

test("the reminder headline has no '0 coming up' clause", () => {
  assert.equal(reminderHeadline({ expired: 1 }), "1 expired");
  assert.equal(reminderHeadline({ expired: 2, soon: 1, later: 2 }), "2 expired, 3 coming up");
  assert.equal(reminderHeadline({ soon: 2 }), "2 due within 30 days");
  assert.equal(reminderHeadline({ later: 3 }), "3 coming up");
});

test("a privileges or insurance line names its hospital or carrier", () => {
  const priv = (facility) => ({ type: "Surgical Privileges", state: "ND", facility });
  assert.equal(reminderLabel(priv("Plainsview Regional Medical Center"), "Privileges", "Jordan A. Rivera, DO"), "Plainsview Regional Medical Center \u{B7} Surgical Privileges \u{B7} ND");
  assert.notEqual(reminderLabel(priv("Northbridge Community Hospital"), "Privileges", "x"), reminderLabel(priv("Plainsview Regional Medical Center"), "Privileges", "x"));
  assert.equal(reminderLabel({ type: "Professional Liability", provider: "Example Mutual" }, "Insurance", "x"), "Example Mutual \u{B7} Professional Liability");
  assert.equal(reminderLabel({ name: "Own label", type: "Surgical Privileges", facility: "X" }, "P", "y"), "Own label \u{B7} Surgical Privileges", "a display name still wins");
});

test("the degree is printed once in the acknowledgement, the From line and the invoice sender", () => {
  assert.equal(withDegree("Jordan Rivera, DO", "DO"), "Jordan Rivera, DO");
  assert.equal(withDegree("Jordan Rivera DO", "DO"), "Jordan Rivera DO");
  assert.equal(withDegree("Jordan Rivera D.O.", "DO"), "Jordan Rivera D.O.");
  assert.equal(withDegree("Jordan Rivera", "DO"), "Jordan Rivera, DO");
  assert.equal(withDegree("Kevin Do", "MD"), "Kevin Do, MD");
  assert.equal(withDegree("Ann Do", "DO"), "Ann Do, DO", "a surname that spells the degree is not the degree");
  assert.equal(withDegree("Ann Do", "D.O."), "Ann Do, D.O.");
  assert.equal(withDegree("Ann Do, DO", "DO"), "Ann Do, DO");
  assert.equal(withDegree("Ann Do DO", "DO"), "Ann Do DO");
  assert.equal(withDegree("Jordan Rivera, do", "DO"), "Jordan Rivera, do", "after a comma the degree reads as typed");
  assert.equal(withDegree("Jordan Rivera,DO", "DO"), "Jordan Rivera,DO");
  assert.equal(edgeWithDegree("Ann Do", "DO"), "Ann Do, DO", "the edge copy agrees");
  assert.equal(invoiceEmailSender({ name: "Ann Do", degree: "DO", email: "a@example.test" }).fromName, "Ann Do, DO via CredentialDOMD");
  const ack = ackText({ requesterName: "Casey Example", physicianName: "Jordan Rivera, DO", degree: "DO", askCount: 1, receivedAtIso: "2026-09-11T17:03:12.000Z" });
  assert.ok(ack.endsWith("Regards,\nJordan Rivera, DO"), ack);
  assert.equal(invoiceEmailSender({ name: "Jordan Rivera, DO", degree: "DO", email: "j@example.test" }).fromName, "Jordan Rivera, DO via CredentialDOMD");
  for (const f of ["supabase/functions/email-inbound/index.ts", "supabase/functions/send-packet-email/index.ts"]) {
    assert.match(read(f), /const display = name \? `\$\{withDegree\(name, degree\)\} via CredentialDOMD`/, f);
  }
  assert.match(read("supabase/functions/send-packet-email/index.ts"), /const displayName = name \? withDegree\(name, degree\) : physEmail;/, "the footer names the physician as the From line does");
});

// The space rule accepted only all-capital or dotted words as a degree, so a
// CV reference typed "Casey Example PhD" with PhD read "Casey Example PhD,
// PhD" (and PA-C, PsyD, PharmD, MBChB, "md" the same).
test("a degree typed after the name with a space prints once, whatever its shape", () => {
  const once = [
    ["Casey Example PhD", "PhD"], ["Pat Sample PA-C", "PA-C"], ["Jane Smith PsyD", "PsyD"],
    ["Jane Smith PharmD", "PharmD"], ["Jane Smith MBChB", "MBChB"], ["Jane Smith md", "md"],
    ["Jordan Rivera DO", "DO"], ["Jordan Rivera D.O.", "DO"], ["Jordan Rivera MD", "M.D."],
    ["Casey Example, PhD", "PhD"], ["Pat Sample, PA-C", "PA-C"], ["Jordan Rivera, do", "DO"],
  ];
  for (const [name, degree] of once) {
    assert.equal(withDegree(name, degree), name, `${name} + ${degree}`);
    assert.equal(edgeWithDegree(name, degree), name, `edge: ${name} + ${degree}`);
  }
  assert.equal(withDegree("Ann Do", "DO"), "Ann Do, DO", "a surname that spells a degree still gets it");
  assert.equal(withDegree("Ann Do", "do"), "Ann Do, do");
  assert.equal(withDegree("Casey Example", "PhD"), "Casey Example, PhD");
  assert.equal(withDegree("Jordan Rivera MD", "DO"), "Jordan Rivera MD, DO", "a different degree is added");
  assert.equal(oneDegree("Casey Example PhD, PhD"), "Casey Example PhD");
  assert.equal(oneDegree("Pat Sample PA-C, PA-C"), "Pat Sample PA-C");
  assert.equal(edgeOneDegree("Jane Smith PsyD, PsyD"), "Jane Smith PsyD");
  assert.equal(oneDegree("Ann Do, DO"), "Ann Do, DO");
  const cv = buildCvContent({
    settings: { name: "Jordan Rivera", degreeType: "DO" },
    peerReferences: [
      { name: "Casey Example PhD", degree: "PhD" }, { name: "Pat Sample PA-C", degree: "PA-C" },
      { name: "Lee Sample", degree: "MD" }, { name: "Ann Do", degree: "DO" },
    ],
  });
  const refs = cv.find((x) => x.title === "Professional References").items.map((i) => i.primary);
  assert.deepEqual(refs, ["Casey Example PhD", "Pat Sample PA-C", "Lee Sample, MD", "Ann Do, DO"]);
});

test("emails and pages name menu items that exist", () => {
  const app = read("src/App.jsx");
  assert.match(app, />Get help</, "the More menu item the welcome email names");
  assert.match(read("supabase/functions/forwarding-address/lib.ts"), /More &gt; Profile &amp; settings &gt; Email/);
  assert.doesNotMatch(read("supabase/functions/forwarding-address/lib.ts"), /More &gt; Settings &gt;/);
  assert.doesNotMatch(read("supabase/functions/email-inbound/index.ts"), /More > Settings > Email/);
  assert.match(read("supabase/functions/send-reminders/index.ts"), /reminders are on in More > Profile & settings\./);
});

test("the forwarding pages wrap an address only where it must", () => {
  const lib = read("supabase/functions/forwarding-address/lib.ts");
  assert.doesNotMatch(lib, /word-break:\s*break-all/);
  assert.match(lib, /\.addr \{[^}]*overflow-wrap:anywhere/);
});
