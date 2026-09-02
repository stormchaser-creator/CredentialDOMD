// Unit-style checks for the dictation-to-RVU coder's deterministic parts
// (src/utils/cptCoderRules.js) and the CPT catalog they depend on. No network:
// postProcess() is fed the JSON shapes the model returns.
// Run: node scripts/cpt-coder.test.mjs   (pure node, no test runner)
import {
  normalizeDictation, normalizeCode, postProcess, BUNDLED_PAIRS, CODER_RULES, cranioplastyLooksSeparate, buildCatalog, catalogDesc, CATALOG_DESC_MAX,
  MICROSCOPE_MEDICARE_PAYABLE, MICROSCOPE_CPT_EXCLUDED,
} from "../src/utils/cptCoderRules.js";
import { CONSTRUCT_RULES } from "../src/constants/cptConstructs.js";
import { CPT_CODES, CPT_BY_CODE } from "../src/constants/cpt/index.js";
import { NEUROSURGERY_CODES } from "../src/constants/cpt/neurosurgery.js";
import { ADDITIONAL_CODES } from "../src/constants/cpt/additions.js";
import { RVU_DATA } from "../src/constants/cpt/rvuData.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const enc = (code, units = 1, why = "") => ({ code, units, why });
const run = (encounters, text = "", questions = []) => postProcess({ encounters, questions, confidence: "high" }, { text });
const codes = (r) => r.items.map(it => it.code);
const total = (r) => Math.round(r.items.reduce((s, it) => s + it.wRVU * it.units, 0) * 100) / 100;
const hasQ = (r, re) => r.questions.some(q => re.test(q));

// ── normalizeDictation: cranial additions ────────────────────────────────────
eq("sub occipital joins", normalizeDictation("sub occipital craniotomy"), "suboccipital craniotomy");
eq("sub-occipital joins", normalizeDictation("Sub-Occipital approach"), "suboccipital approach");
eq("retro sigmoid joins", normalizeDictation("retro sigmoid crani"), "retrosigmoid crani");
eq("post fossa expands", normalizeDictation("post fossa tumor"), "posterior fossa tumor");
eq("cranio plasty joins", normalizeDictation("titanium cranio plasty"), "titanium cranioplasty");
eq("e t v expands", normalizeDictation("did an e t v"), "did an ETV (endoscopic third ventriculostomy)");
eq("c.u.s.a expands", normalizeDictation("used the c.u.s.a and microscope"), "used the CUSA (ultrasonic aspirator) and microscope");
eq("plain suboccipital untouched", normalizeDictation("suboccipital craniectomy"), "suboccipital craniectomy");
eq("spine fixes still apply", normalizeDictation("L4-5 tea lift"), "L4-5 TLIF (transforaminal lumbar interbody fusion)");
ok("ETV regex does not eat other words", normalizeDictation("elevate the flap") === "elevate the flap");

// ── normalizeCode ────────────────────────────────────────────────────────────
eq("plus prefix", normalizeCode("+69990"), "69990");
eq("modifier suffix", normalizeCode("69990-80"), "69990");
eq("numeric", normalizeCode(61519), "61519");
eq("spaces", normalizeCode(" 22551 "), "22551");
eq("blank", normalizeCode(null), "");

// ── Input A from the reproduction: 61519 + 69990 + 62141 ─────────────────────
// Ground truth: 61519 (42.34) + 69990 (3.37) only; the same-session cranioplasty
// is integral to the craniotomy (NCCI Policy Manual Ch VIII Sec C.4).
const A = run(
  [enc("61519", 1, "infratentorial meningioma"), enc("69990", 1, "microscope"), enc("62141", 1, "titanium cranioplasty")],
  "suboccipital craniotomy for meningioma resection with microscope, ultrasound, CUSA and doppler with a titanium cranioplasty",
);
eq("A: cranioplasty removed", codes(A), ["61519", "69990"]);
eq("A: wRVU total 45.71", total(A), 45.71);
ok("A: cranioplasty question cites NCCI Ch VIII C.4", hasQ(A, /62141 removed/) && hasQ(A, /Ch VIII Sec C\.4/));
ok("A: cranioplasty question cites the PTP edit for 61519", hasQ(A, /PTP edit 61519\/62141/));
ok("A: cranioplasty question names the exception route", hasQ(A, /larger than the exposure/) && hasQ(A, /59\/XS/));
ok("A: 69990 kept with a Medicare-payable question", hasQ(A, /69990 kept with 61519/) && hasQ(A, /Pub 100-04 Ch 12 Sec 20\.4\.5/));
ok("A: ultrasound/CUSA/doppler surfaced as no-code", hasQ(A, /Ultrasound, CUSA or Doppler: no code emitted/));
ok("A: no modifier pre-selected on 69990 without navigation", !A.items.find(it => it.code === "69990").modifier);

// 62140 and 62143 take the same route.
eq("62140 with 61519 removed", codes(run([enc("61519"), enc("62140")])), ["61519"]);
const A3 = run([enc("61519"), enc("62143")]);
eq("62143 with 61519 removed", codes(A3), ["61519"]);
ok("62143 question says later encounter", hasQ(A3, /62143 describes returning a flap or plate at a later encounter/));
ok("62143 question does not claim a PTP edit", !hasQ(A3, /PTP edit 61519\/62143/));
// Any craniotomy primary, not only the tumor family (the C.4 rule is generic).
eq("62141 with 61312 removed", codes(run([enc("61312"), enc("62141")])), ["61312"]);
ok("62141 with 61312 does not claim a PTP edit it cannot cite", !hasQ(run([enc("61312"), enc("62141")]), /PTP edit/));
// A staged cranioplasty dictated on its own is untouched.
eq("62143 alone stays", codes(run([enc("62143", 1, "replaced stored flap")], "cranioplasty, put back the bone flap from his craniectomy 3 months ago")), ["62143"]);
ok("62143 alone gets no bundling question", !hasQ(run([enc("62143")]), /removed/));

// ── Input D: navigation on the same claim → 59/XU route on 69990 ─────────────
const D = run([enc("61519"), enc("69990"), enc("62141"), enc("61781")], "with stealth navigation");
eq("D: codes", codes(D), ["61519", "69990", "61781"]);
eq("D: 69990 modifier 59 pre-selected", D.items.find(it => it.code === "69990").modifier, "59");
ok("D: question cites PTP 61781/69990 and Ch VIII C.8", hasQ(D, /PTP edit 61781\/69990/) && hasQ(D, /Ch VIII Sec C\.8/));
eq("D: wRVU total", total(D), 49.37);

// ── Input C / E: fully clean results pass through with only the microscope note ─
const C = run([enc("61512"), enc("69990"), enc("61781")], "right frontal craniotomy for meningioma with microscope and navigation");
eq("C: codes", codes(C), ["61512", "69990", "61781"]);
eq("C: total 43.24", total(C), 43.24);
const E = run([enc("61518"), enc("69990")], "posterior fossa craniotomy, resection of cerebellar metastasis, microscope");
eq("E: codes", codes(E), ["61518", "69990"]);
eq("E: total 42.26", total(E), 42.26);
ok("E: exactly one question (microscope note)", E.questions.length === 1 && /69990 kept with 61518/.test(E.questions[0]));

// ── 69990 with a primary Medicare does not pay it with: kept for CPT, questioned ─
const M = run([enc("63030"), enc("69990")], "L4-5 microdiscectomy with the microscope");
eq("63030 + 69990 kept", codes(M), ["63030", "69990"]);
ok("63030 + 69990 questioned as Medicare-bundled", hasQ(M, /Medicare bundles it into 63030/) && hasQ(M, /Ch VIII Sec F\.1/));

// ── 69990 with a CPT-excluded primary: removed ───────────────────────────────
const X = run([enc("22551"), enc("22845"), enc("22853"), enc("20931"), enc("69990")], "C5-6 ACDF with the microscope");
eq("ACDF drops 69990", codes(X), ["22551", "22845", "22853", "20931"]);
ok("ACDF 69990 question cites the CPT parenthetical", hasQ(X, /69990 removed: the CPT parenthetical under 69990 excludes it with 22551/));

// ── ZZZ add-on without a primary ─────────────────────────────────────────────
const Z = run([enc("69990")], "microscope");
eq("lone 69990 kept but flagged", Z.items.map(it => [it.code, it.flag]), [["69990", "add-on without a primary"]]);
ok("lone 69990 question", hasQ(Z, /69990 is an add-on \(ZZZ global\) with no primary procedure/));
const Z2 = run([enc("61781"), enc("22853")]);
eq("two add-ons, no primary: both flagged", Z2.items.filter(it => it.flag).length, 2);
ok("primary present: no add-on flag", !run([enc("61519"), enc("69990")]).items.some(it => it.flag));

// ── Unknown codes are surfaced, never silent ─────────────────────────────────
const U = run([enc("61519"), enc("76998", 1, "intraoperative ultrasound"), enc("99999")]);
eq("unknown codes not in items", codes(U), ["61519"]);
eq("dropped list", U.dropped.map(d => d.code), ["76998", "99999"]);
ok("unknown code question names the code and why", hasQ(U, /AI suggested 76998 \(intraoperative ultrasound\) which is not in the catalog; not added/));
ok("prompt-notation code resolves instead of dropping", codes(run([enc("61519"), enc("+69990")])).includes("69990"));
ok("modifier-suffixed code resolves instead of dropping", codes(run([enc("61519"), enc("69990-80")])).includes("69990"));
eq("all unknown: empty items, dropped filled", run([enc("00000")]).items.length, 0);

// ── Duplicate lines ──────────────────────────────────────────────────────────
const Dup = run([enc("61108", 1), enc("61108", 1)], "twist drill, two holes");
eq("primary listed twice merges to one line x1", Dup.items.map(it => [it.code, it.units]), [["61108", 1]]);
ok("duplicate primary questioned", hasQ(Dup, /61108 was listed 2 times/));
const DupAdd = run([enc("22551"), enc("22552", 1), enc("22552", 1)]);
eq("add-on listed twice sums units", DupAdd.items.find(it => it.code === "22552").units, 2);

// ── TLIF: decompression at the fused level is 63052/63053, not 63047/63048 ───
const T = run([enc("22633"), enc("22842"), enc("22853"), enc("63047", 1, "bilateral decompression L4-5")], "L4-5 TLIF with bilateral decompression");
eq("TLIF: 63047 → 63052", codes(T), ["22633", "22842", "22853", "63052"]);
ok("TLIF: question cites the 63052/63053 parenthetical", hasQ(T, /63052 replaces 63047/) && hasQ(T, /use 63052\/63053 with 22630, 22632, 22633, 22634/));
const T2 = run([enc("22633"), enc("22634"), enc("63047"), enc("63048")]);
eq("two-level TLIF: 63047/63048 → 63052/63053", codes(T2), ["22633", "22634", "63052", "63053"]);
const T3 = run([enc("22630"), enc("63030")]);
eq("PLIF: 63030 removed", codes(T3), ["22630"]);
ok("PLIF: 63030 question cites the descriptor", hasQ(T3, /22630 includes laminectomy and\/or discectomy to prepare the interspace/));
eq("posterolateral-only fusion keeps 63047", codes(run([enc("22612"), enc("63047")])), ["22612", "63047"]);
eq("lone 63047 untouched", codes(run([enc("63047"), enc("63048", 2)])), ["63047", "63048"]);

// ── Assistant-surgeon behavior preserved ─────────────────────────────────────
const As = run([enc("61519"), enc("69990")], "I was the assistant on a suboccipital meningioma");
eq("assistant: modifier 80 on both", As.items.map(it => it.modifier), ["80", "80"]);
ok("assistant: question added once", As.questions.filter(q => /Assistant-surgeon case/.test(q)).length === 1);
ok("assistant: desc annotated without em dash", As.items.every(it => /assistant surgeon/.test(it.desc) && !/—/.test(it.desc)));

// ── Model questions preserved, deduped ───────────────────────────────────────
const Q = run([enc("61519")], "", ["Was it really a meningioma?", "Was it really a meningioma?"]);
eq("model questions kept once", Q.questions.filter(q => /really a meningioma/.test(q)).length, 1);
eq("confidence passed through", Q.confidence, "high");
eq("default confidence", postProcess({ encounters: [enc("61519")] }).confidence, "medium");

// ── Every question string is free of em dashes ───────────────────────────────
const allQ = [A, A3, D, C, E, M, X, Z, Z2, U, Dup, T, T2, T3, As].flatMap(r => r.questions);
ok("no em dashes in generated questions", allQ.every(q => !/—/.test(q)), allQ.filter(q => /—/.test(q)).join(" | "));
ok("no em dashes in CODER_RULES / CONSTRUCT_RULES", !/—/.test(CODER_RULES) && !/—/.test(CONSTRUCT_RULES));

// ── BUNDLED_PAIRS shape: every rule is cited and well-formed ─────────────────
for (const r of BUNDLED_PAIRS) {
  ok(`pair ${r.id} has predicates + action`, typeof r.primary === "function" && typeof r.addon === "function" && ["remove", "replace", "modifier"].includes(r.action));
  ok(`pair ${r.id} question mentions a source`, /NCCI|CPT|Pub 100-04|PTP|descriptor/.test(r.question("61519", "62141", { desc: "x" }, "63052")));
}
ok("Medicare 69990 list covers 61519 and 63081", MICROSCOPE_MEDICARE_PAYABLE.some(([lo, hi]) => 61519 >= lo && 61519 <= hi) && MICROSCOPE_MEDICARE_PAYABLE.some(([lo, hi]) => 63081 >= lo && 63081 <= hi));
ok("CPT 69990 exclusion covers 22551 and 61548", MICROSCOPE_CPT_EXCLUDED.some(([lo, hi]) => 22551 >= lo && 22551 <= (hi ?? lo)) && MICROSCOPE_CPT_EXCLUDED.some(([lo, hi]) => 61548 >= lo && 61548 <= (hi ?? lo)));

// ── Catalog sanity ───────────────────────────────────────────────────────────
const balanced = (s) => { let d = 0; for (const ch of s) { if (ch === "(") d++; else if (ch === ")") { d--; if (d < 0) return false; } } return d === 0; };
const cleanEnd = (s) => /[A-Za-z0-9)\].+%]$/.test(s.trim());
const badDesc = [];
for (const c of CPT_CODES) {
  for (const field of ["shortDesc", "fullDesc"]) {
    const d = c[field];
    if (!d) continue;
    if (!balanced(d) || !cleanEnd(d) || /\s(a|an|the|of|or|and|to|for|with|w\/|per|under|over)$/i.test(d)) badDesc.push(`${c.code}.${field}: ${JSON.stringify(d)}`);
  }
}
eq("no shortDesc/fullDesc ends mid-phrase or with a dangling parenthesis", badDesc, []);
const previouslyTruncated = ["99236", "99418", "61215", "61020", "20660", "13160", "22310", "63052", "63650", "69990", "22854", "22859", "20930", "22858"];
ok("previously truncated entries now complete", previouslyTruncated.every(c => CPT_BY_CODE[c] && cleanEnd(CPT_BY_CODE[c].shortDesc) && balanced(CPT_BY_CODE[c].shortDesc)));
ok("69990 shortDesc is a whole sentence for the model", /^Microsurgical technique, operating microscope \(ZZZ add-on\)$/.test(CPT_BY_CODE["69990"].shortDesc));

// Every curated code exists in rvuData (the PFS-derived table) unless it is a
// code CMS deleted (excluded everywhere) or a known no-PFS-row entry.
const DELETED = new Set(["61440", "61470", "61480", "99241", "49585"]);
const noRvu = [...NEUROSURGERY_CODES, ...ADDITIONAL_CODES].map(c => c.code).filter(c => !DELETED.has(c) && !RVU_DATA[c]);
eq("every neurosurgery/additions code has a CY2026 PFS row in rvuData", noRvu, []);

// Every 5-digit CPT the prompt names must be selectable, or the model's pick vanishes.
const RULE_TEXT = CODER_RULES + CONSTRUCT_RULES;
const EM_RANGES_OK = (n) => n >= 99202 && n <= 99499; // E/M families are named as ranges; the catalog holds them
const ruleCodes = [...new Set((RULE_TEXT.match(/\b\d{5}\b/g) || []))].filter(c => !EM_RANGES_OK(parseInt(c, 10)));
const missingFromCatalog = ruleCodes.filter(c => !CPT_BY_CODE[c]);
eq("every procedure code named in the prompt is in the catalog", missingFromCatalog, []);
ok("prompt names the codes the review found missing", ["22846", "22843", "22844", "61782", "63046", "63052", "63053", "62201"].every(c => RULE_TEXT.includes(c) && CPT_BY_CODE[c]));

// 76998 is deliberately NOT in the catalog (global code is PFS status C, 0.00 wRVU;
// the -26 component needs a retained image and written interpretation).
ok("76998 deliberately absent", !CPT_BY_CODE["76998"]);

// Compartment / pathology labels the review found swapped, checked against the
// CMS short descriptors that ship in rvuData.js.
const sd = (c) => (CPT_BY_CODE[c]?.shortDesc || "") + " " + (CPT_BY_CODE[c]?.fullDesc || "");
ok("61312 = extradural or subdural (CMS 'Crnec/crnot sttl xdrl/sdrl')", /extradural/i.test(sd("61312")) && /subdural/i.test(sd("61312")) && /xdrl\/sdrl/.test(RVU_DATA["61312"].desc));
ok("61313 = intracerebral (CMS 'Crnec/crnot sttl icere')", /intracerebral/i.test(sd("61313")) && !/subdural/i.test(sd("61313")) && /icere/.test(RVU_DATA["61313"].desc));
ok("61140 = biopsy (CMS 'Burr hole/treph bx brain/les')", /biopsy/i.test(sd("61140")) && !/hematoma/i.test(sd("61140")) && /bx/.test(RVU_DATA["61140"].desc));
ok("61154 = extradural/subdural hematoma (CMS 'Burr hole w/evac&/drg hmtma')", /subdural/i.test(sd("61154")) && !/intracerebral/i.test(sd("61154")));
ok("61156 = intracerebral (CMS 'Burr hol aspir hmtm/cst icer')", /intracerebral/i.test(sd("61156")) && !/infratentorial/i.test(sd("61156")) && /icer/.test(RVU_DATA["61156"].desc));
ok("62200 is the open ventriculocisternostomy, not ETV", !/endoscopic third ventriculostomy|ETV/.test(CPT_BY_CODE["62200"].shortDesc) && /Establish brain cavity shunt/.test(RVU_DATA["62200"].desc));
ok("62201 = ETV (CMS 'Brain cavity shunt w/scope')", /endoscopic/i.test(sd("62201")) && /w\/scope/.test(RVU_DATA["62201"].desc) && CPT_BY_CODE["62201"].wRVU === 15.64);
ok("61322/61323 = decompressive w/o / with lobectomy", /without lobectomy/i.test(sd("61322")) && /with lobectomy/i.test(sd("61323")) && /w\/o lobec/.test(RVU_DATA["61322"].desc));
ok("61519 shortDesc says posterior fossa meningioma", /posterior fossa/.test(sd("61519")) && /meningioma/.test(sd("61519")));
ok("61518 shortDesc excludes meningioma", /NOT meningioma/.test(CPT_BY_CODE["61518"].shortDesc));
ok("61151/61250/61253/62142 added with PFS wRVU", CPT_BY_CODE["61151"]?.wRVU === 13.15 && CPT_BY_CODE["61250"]?.wRVU === 11.2 && CPT_BY_CODE["61253"]?.wRVU === 13.15 && CPT_BY_CODE["62142"]?.wRVU === 11.53);
ok("22846/22843/22844/61782/63046 added with PFS wRVU", CPT_BY_CODE["22846"]?.wRVU === 12.09 && CPT_BY_CODE["22843"]?.wRVU === 13.1 && CPT_BY_CODE["22844"]?.wRVU === 16.01 && CPT_BY_CODE["61782"]?.wRVU === 3.1 && CPT_BY_CODE["63046"]?.wRVU === 16.82);

// The ground-truth wRVUs for the reproduction case, straight from the catalog.
eq("wRVU 61519/61518/61512", [CPT_BY_CODE["61519"].wRVU, CPT_BY_CODE["61518"].wRVU, CPT_BY_CODE["61512"].wRVU], [42.34, 38.89, 36.21]);
eq("wRVU 62140/62141/62143/69990/61781", [62140, 62141, 62143, 69990, 61781].map(c => CPT_BY_CODE[String(c)].wRVU), [14.19, 15.67, 13.8, 3.37, 3.66]);
eq("69990 global ZZZ status R", [CPT_BY_CODE["69990"].globalDays, CPT_BY_CODE["69990"].status], ["ZZZ", "R"]);


// ── Separate cranioplasty is KEPT, not deleted (gate finding S1) ────────────
// A defect from a prior encounter at a different site is the NCCI Ch VIII C.4
// exception; the pass must keep 62141, pre-select XS, and explain the
// documentation. Deleting it cost 15.67 wRVU on every run before this.
{
  const enc2 = (code, units, why) => ({ code, units, why });
  const r = postProcess({ encounters: [enc2("61512", 1, "right frontal meningioma"), enc2("69990", 1, "microscope"), enc2("62141", 1, "titanium cranioplasty")], questions: [], confidence: "high" },
    { text: "right frontal craniotomy for convexity meningioma with microscope; also titanium cranioplasty of a 6 cm left parietal defect from a decompressive craniectomy two months ago, separate incision" });
  const c = r.items.map(i => i.code);
  ok("separate cranioplasty kept", c.includes("62141"), c.join(","));
  eq("separate cranioplasty pre-selects XS", r.items.find(i => i.code === "62141")?.modifier, "XS");
  ok("separate cranioplasty question names Ch VIII C.4 and the diameter rule", r.questions.some(q => /kept with 61512/.test(q) && /Ch VIII Sec C\.4/.test(q) && /diameter/.test(q)));
  ok("separate cranioplasty wRVU intact", Math.abs(r.items.reduce((s, i) => s + i.wRVU * i.units, 0) - (36.21 + 3.37 + 15.67)) < 0.001);

  // Same codes, no separateness words: still removed (the original A behavior).
  const r2 = postProcess({ encounters: [enc2("61519", 1, ""), enc2("69990", 1, ""), enc2("62141", 1, "")], questions: [], confidence: "high" },
    { text: "suboccipital craniotomy for meningioma resection with microscope and a titanium cranioplasty" });
  ok("same-session cranioplasty still removed", !r2.items.some(i => i.code === "62141"));

  // Each signal fires on its own.
  for (const t of ["staged cranioplasty", "cranioplasty for a pre-existing defect", "separate incision cranioplasty", "defect measuring 6 cm", "larger than the exposure", "replaced the bone flap that was removed"]) {
    ok(`separateness signal: "${t}"`, cranioplastyLooksSeparate(t));
  }
  ok("no signal on the plain case", !cranioplastyLooksSeparate("suboccipital craniotomy for meningioma with titanium cranioplasty"));
}

// ── Mutually exclusive pairs are flagged, never resolved ──────────────────────
{
  const enc2 = (code) => ({ code, units: 1, why: "" });
  const r = postProcess({ encounters: [enc2("61519"), enc2("61518")], questions: [], confidence: "high" }, { text: "posterior fossa tumor" });
  ok("61518+61519 both kept", r.items.length === 2);
  ok("61518+61519 flagged mutually exclusive", r.questions.some(q => /61518 and 61519 are mutually exclusive/.test(q)));
  const r3 = postProcess({ encounters: [enc2("62140"), enc2("62141"), enc2("61512")], questions: [], confidence: "high" }, { text: "prior defect 6 cm staged cranioplasty" });
  ok("62140+62141 flagged", r3.questions.some(q => /62140 and 62141 are mutually exclusive/.test(q)));
}

// ── Primary first, so the case log is never titled by an add-on ───────────────
{
  const enc2 = (code) => ({ code, units: 1, why: "" });
  const r = postProcess({ encounters: [enc2("69990"), enc2("61781"), enc2("61512")], questions: [], confidence: "high" }, { text: "frontal meningioma microscope navigation" });
  eq("primary sorted first", r.items[0].code, "61512");
  ok("add-ons after the primary", r.items.slice(1).every(i => ["69990", "61781"].includes(i.code)));
}

// ── Cardiac: combined CABG + Cox-Maze + LAA clip + endoscopic vein harvest, ──
// TEE, intraoperative cardioversion, modifier 22 (ticket 63cf43b7) ───────────
{
  const dictation = "Coronary Artery Bypass Grafting times 2 (left internal mammary artery to left anterior descending artery, reverse SV graft to obtuse marginal artery), external cardioversion for ventricular arrest, modified Cox 4 Maze procedure with the encompass clamp, with intraoperative transesophageal echocardiogram, left lower extremity endoscopic vein harvest, ligation of left atrial appendage with 40mm Atricure Clip, modifier 22";
  const Card = run(
    [
      enc("33533", 1, "LIMA to LAD arterial graft"),
      enc("33517", 1, "reverse SVG to OM, combined with the arterial graft"),
      enc("33259", 1, "modified Cox-Maze IV with the Encompass clamp, extensive lesion set, on bypass, at time of CABG"),
      enc("33267", 1, "LAA exclusion, open, 40mm AtriCure clip"),
      enc("33508", 1, "left lower extremity endoscopic vein harvest"),
    ],
    dictation,
  );
  eq("Card: codes", codes(Card), ["33533", "33267", "33517", "33259", "33508"]);
  eq("Card: wRVU total 68.56", total(Card), 68.56);
  ok("Card: modifier 22 pre-selected on the highest-wRVU primary (33533)", Card.items.find(it => it.code === "33533")?.modifier === "22");
  ok("Card: modifier 22 not applied elsewhere", Card.items.filter(it => it.modifier === "22").length === 1);
  ok("Card: modifier-22 question cites CPT Appendix A", hasQ(Card, /Modifier 22 pre-selected on 33533/) && hasQ(Card, /CPT Appendix A/));
  ok("Card: TEE gets no code and a question instead", !codes(Card).includes("93312") && hasQ(Card, /Intraoperative TEE: no code emitted/));
  ok("Card: cardioversion gets no code and a question instead", !codes(Card).includes("92960") && hasQ(Card, /Intraoperative cardioversion or defibrillation/) && hasQ(Card, /Ch 12 Sec 40\.1/));
  ok("Card: no em dashes in questions", Card.questions.every(q => !/—/.test(q)));

  // Arterial-only two-graft CABG is untouched by the TEE/cardioversion/22 rules.
  const plain = run([enc("33534", 1, "two arterial grafts")], "CABG x2, both arterial");
  eq("plain two-arterial CABG: no modifier 22, no TEE/cardioversion questions", [plain.items[0].modifier, plain.questions.length], [undefined, 0]);
}

// ── The catalog line the model reads: word boundary, no orphaned "(" ─────────
{
  const lines = buildCatalog().split("\n");
  const bad = lines.filter(l => { const d = l.split("|")[1] || ""; const o = d.lastIndexOf("("); return (o !== -1 && d.indexOf(")", o) === -1) || /[A-Za-z]-$/.test(d); });
  ok("no catalog description ends in an orphaned parenthesis or a broken word", bad.length === 0, bad.slice(0, 5).join(" ;; "));
  ok("catalog descriptions fit the cap", lines.every(l => (l.split("|")[1] || "").length <= CATALOG_DESC_MAX));
  eq("catalogDesc drops an orphan paren", catalogDesc("Laminectomy at fused level, single (add-on that runs on and on and on and on and on and on and on and on"), "Laminectomy at fused level, single");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
