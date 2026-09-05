// Which case-log category a dictated case lands in.
//
// Every dictated case used to file as "Other", because the RVU log wrote
// `caseCategory || "Other"` and caseCategory is a dropdown nobody touches
// mid-dictation. A career case log is only worth keeping if the categories
// are real: it is what a fellowship application, a privileges packet and the
// board case log all read.
// Run: node scripts/case-category.test.mjs
import { categoryForCode, categoryForCase, producibleCategories } from "../src/utils/caseCategory.js";
import { CASE_CATEGORIES } from "../src/constants/credentialTypes.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (got === want) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };
const c = (code, wRVU) => ({ code, wRVU, units: 1 });

// ── Never write a category the picker cannot show ─────────────────────────
{
  const strays = producibleCategories().filter((x) => !CASE_CATEGORIES.includes(x));
  ok("every category this can produce is one the form offers", strays.length === 0, strays.join(" | "));
}

// ── The pairs CPT puts side by side and the log keeps apart ───────────────
eq("extradural or subdural hematoma is trauma", categoryForCode("61312"), "Cranial: Trauma/Other");
eq("intracerebral is its own category", categoryForCode("61313"), "Cranial: Evacuation of Intraparenchymal Hematoma");
eq("infratentorial extradural is trauma", categoryForCode("61314"), "Cranial: Trauma/Other");
eq("infratentorial intracerebral is not", categoryForCode("61315"), "Cranial: Evacuation of Intraparenchymal Hematoma");
eq("a decompressive craniectomy is not lumped into trauma", categoryForCode("61322"), "Cranial: Decompressive Hemicraniectomy");
eq("a sellar case inside the tumor range", categoryForCode("61548"), "Cranial: Tumor Sellar/Parasellar");
eq("a convexity tumor is tumor general", categoryForCode("61510"), "Cranial: Tumor General");
eq("endovascular inside the vascular numbering", categoryForCode("61624"), "Cranial: Vascular Endovascular");
eq("and open vascular around it", categoryForCode("61697"), "Cranial: Vascular Open");

// ── Spine splits by approach, and the codes carry it ──────────────────────
eq("an ACDF is anterior cervical", categoryForCode("22551"), "Spinal: Anterior Cervical");
eq("a posterior cervical laminectomy", categoryForCode("63045"), "Spinal: Posterior Cervical");
eq("a lumbar discectomy", categoryForCode("63030"), "Spinal: Lumbar Laminectomy/Laminotomy");
eq("a TLIF is thoracolumbar fusion", categoryForCode("22633"), "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion");
eq("a spinal cord stimulator", categoryForCode("63650"), "Spinal: Stimulation/Lesion/Pump/Other");

// ── The family that started this ──────────────────────────────────────────
eq("a nerve sheath tumor is peripheral nerve", categoryForCode("64790"), "Peripheral Nerve");
eq("so is a deep neck tumor", categoryForCode("21556"), "Peripheral Nerve");
eq("so is a carotid body tumor", categoryForCode("60600"), "Peripheral Nerve");
eq("a skull base parapharyngeal resection is cranial tumor", categoryForCode("61605"), "Cranial: Tumor General");

// ── Add-ons decide nothing ────────────────────────────────────────────────
for (const code of ["69990", "61781", "22842", "22853", "20930", "63052"]) {
  eq(`${code} on its own decides nothing`, categoryForCode(code), "");
}
eq("an E/M code decides nothing", categoryForCode("99232"), "");
eq("a code outside every range decides nothing", categoryForCode("11042"), "");
eq("rubbish decides nothing", categoryForCode("abc"), "");
eq("empty decides nothing", categoryForCode(""), "");

// ── A whole case, where the primary is the one that pays most ─────────────
eq("the resection decides, not the approach dictated first",
  categoryForCase([c("61595", 32.9), c("61605", 31.76)]), "Cranial: Tumor General");
eq("instrumentation never outvotes the fusion",
  categoryForCase([c("22633", 26.0), c("22842", 12.0), c("22853", 5.0)]),
  "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion");
eq("the microscope never outvotes the tumor",
  categoryForCase([c("64790", 11.8), c("69990", 3.37)]), "Peripheral Nerve");
eq("an add-on alone leaves it blank rather than guessing",
  categoryForCase([c("69990", 3.37)]), "");
eq("a rounding day leaves it blank", categoryForCase([c("99232", 1.4)]), "");
eq("no codes leaves it blank", categoryForCase([]), "");
eq("a non-array does not throw", categoryForCase(null), "");

// Determinism: same codes, same answer, whatever order they arrive in.
{
  const a = categoryForCase([c("22551", 24), c("22845", 12), c("20930", 0)]);
  const b = categoryForCase([c("20930", 0), c("22845", 12), c("22551", 24)]);
  eq("order does not change the answer", a, b);
  eq("and the answer is the fusion", a, "Spinal: Anterior Cervical");
}
{
  // A tie on work RVU resolves to the lower code number, every time.
  const t1 = categoryForCase([c("63030", 12), c("63045", 12)]);
  const t2 = categoryForCase([c("63045", 12), c("63030", 12)]);
  eq("a tie is broken the same way both times", t1, t2);
}

// ── Words only where the codes are genuinely ambiguous ────────────────────
eq("a cervical decompression dictated as anterior moves",
  categoryForCase([c("63020", 14.5)], "C5-6 anterior cervical discectomy with fusion"),
  "Spinal: Anterior Cervical");
eq("and stays posterior when nothing says otherwise",
  categoryForCase([c("63020", 14.5)], "cervical laminoforaminotomy"),
  "Spinal: Posterior Cervical");
eq("a pituitary word moves a tumor case to sellar",
  categoryForCase([c("61510", 37)], "resection of a large pituitary macroadenoma"),
  "Cranial: Tumor Sellar/Parasellar");
eq("but words never move a case whose code already settled it",
  categoryForCase([c("22633", 26)], "pituitary"),
  "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion");

// ── Bedside and ICU ───────────────────────────────────────────────────────
eq("an EVD", categoryForCode("61107"), "EVD/Transdural Monitor Placement");
eq("a lumbar drain", categoryForCode("62272"), "Lumbar/Other Puncture/Drain Placement");
eq("an arterial line", categoryForCode("36620"), "Arterial Line Placement");
eq("a shunt", categoryForCode("62223"), "Cranial: CSF Diversion/ETV/Other");

// ── House rules ───────────────────────────────────────────────────────────
ok("no em dash in any category this produces",
  producibleCategories().every((x) => !x.includes("—")));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
