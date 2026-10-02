// PA and NP members on invoices (feat/np-pa, owner decision D-2): every send
// site spreads invoiceSenderFields, so a first send, an emailed send and a
// resend all say "physician assistant services", "nurse practitioner
// services" or "clinical services", and the no-name "Clinician" placeholder
// is hidden exactly as "Physician" is. MD and DO are unchanged. Synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { invoiceSenderFields, physicianLabel } from "../../src/utils/invoiceArgs.js";
import { senderName, invoiceSubject, invoiceCoverBlurb } from "../../src/utils/invoiceCover.js";
import { invoiceFileName } from "../../src/utils/invoiceEmail.js";
import { invoiceFileName as edgeFileName } from "../../supabase/functions/_shared/app/utils/invoiceEmail.js";

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const inv = (settings) => ({ number: "2026-0001", facility: "Synthetic Hospital", email: "synthetic@example.test", lines: [], total: 100, ...invoiceSenderFields(settings) });

test("every send site spreads invoiceSenderFields inside the function that builds its arguments", () => {
  assert.match(read("src/components/features/locum/DutyLog.jsx"), /const dutyArgsFor[\s\S]{0,400}\.\.\.invoiceSenderFields\(s\)/);
  assert.match(read("src/components/features/locum/WorkLog.jsx"), /const pdfArgsFor[\s\S]{0,400}\.\.\.invoiceSenderFields\(s\)/);
  assert.match(read("src/components/features/locum/Expenses.jsx"), /kind: "expenses"[\s\S]{0,200}\.\.\.invoiceSenderFields\(s\)/);
  // The read-only archive keeps its own MD/DO label (archiveSenderFields).
  assert.match(read("src/components/features/ReadOnlyRecords.jsx"), /\.\.\.archiveSenderFields\(data\.settings \|\| \{\}\)/);
  assert.match(read("src/utils/invoiceArgs.js"), /\.\.\.invoiceSenderFields\(s\),\n\s+npi: s\.npi, email: s\.email, phone: s\.phone,/);
});

test("the cover names the member's own services; MD and DO keep physician services", () => {
  assert.match(invoiceCoverBlurb(inv({ degreeType: "PA" })), /for physician assistant services at Synthetic Hospital/);
  assert.match(invoiceCoverBlurb(inv({ degreeType: "NP" })), /for nurse practitioner services at Synthetic Hospital/);
  assert.match(invoiceCoverBlurb(inv({ degreeType: "" })), /for clinical services at Synthetic Hospital/);
  for (const d of ["MD", "DO"]) assert.match(invoiceCoverBlurb(inv({ degreeType: d })), /for physician services at Synthetic Hospital/);
});

test("with no name, neither placeholder is ever a sender: subject, file name and sign-off fall back to the email", () => {
  for (const degreeType of ["MD", "DO", "PA", "NP", ""]) {
    const i = inv({ degreeType });
    assert.ok(["Physician", "Clinician"].includes(physicianLabel({ degreeType })));
    assert.equal(senderName(i), "", degreeType);
    assert.equal(invoiceSubject(i), "Invoice 2026-0001 for Synthetic Hospital", degreeType);
    assert.equal(invoiceFileName(i), "Invoice 2026-0001.pdf", degreeType);
    assert.equal(edgeFileName(i), "Invoice 2026-0001.pdf", degreeType);
    assert.doesNotMatch(invoiceCoverBlurb(i), /Clinician|Thank you, Physician/, degreeType);
  }
  const named = inv({ name: "Pat Example", degreeType: "PA" });
  assert.equal(invoiceSubject(named), "Invoice 2026-0001 from Pat Example, PA for Synthetic Hospital");
  assert.equal(invoiceFileName(named), "Invoice 2026-0001 from Pat Example, PA.pdf");
});
