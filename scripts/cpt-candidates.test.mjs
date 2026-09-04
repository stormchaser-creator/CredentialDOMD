// The codes the coder is allowed to see, and the head and neck family that
// was missing from it.
//
// The bug this suite exists for: a physician dictated a vagal paraganglioma
// resection and the catalogue held no code for it, not one. The coder's
// choices were to return nothing or to reach for the nearest neighbour, and
// the nearest neighbour was a brachial plexus code.
// Run: node scripts/cpt-candidates.test.mjs
import {
  tokens, stem, searchTerms, mergeCatalog, candidateCodes, candidateBlock,
  catalogLine, TERM_EXPANSIONS,
} from "../src/utils/cptCandidates.js";
import { CPT_BY_CODE, CURATED_BY_CODE } from "../src/constants/cpt/index.js";
import { CMS_ALL } from "../src/constants/cpt/cmsAll.js";
import { buildCatalog } from "../src/utils/cptCoderRules.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};
const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };

// ── The codes that were missing ────────────────────────────────────────────
// Each of these is a real operation a neurosurgeon bills and none of them
// existed in the catalogue before. The wRVU is CMS CY2026 PFS, July release.
const MUST_EXIST = [
  ["64790", 11.80, "nerve sheath tumor, major peripheral nerve"],
  ["64792", 15.46, "extensive nerve sheath tumor"],
  ["64784", 10.35, "neuroma, major peripheral nerve"],
  ["21554", 10.85, "deep neck tumor, 5 cm or greater"],
  ["21556", 7.47, "deep neck tumor, under 5 cm"],
  ["21557", 14.38, "radical neck soft tissue, under 5 cm"],
  ["21558", 21.04, "radical neck soft tissue, 5 cm or greater"],
  ["60600", 24.46, "carotid body tumor"],
  ["60605", 31.16, "carotid body tumor with carotid resection"],
  ["61605", 31.76, "parapharyngeal, extradural"],
  ["61606", 41.00, "parapharyngeal, intradural"],
  ["61615", 34.88, "jugular foramen, extradural"],
  ["61616", 45.57, "jugular foramen, intradural"],
  ["61595", 32.90, "transtemporal approach"],
  ["61597", 39.80, "transcondylar approach"],
  ["69554", 35.07, "extended aural glomus"],
  ["38724", 23.35, "modified radical neck dissection"],
];
for (const [code, wRVU, what] of MUST_EXIST) {
  const e = CPT_BY_CODE[code];
  ok(`${code} exists (${what})`, !!e);
  if (e) eq(`${code} carries the CMS work RVU`, e.wRVU, wRVU);
}

// The pairs CMS prints identically. Getting these the wrong way round is 9 to
// 10 work RVU and a claim that does not match the operative note, so the
// descriptors have to say which is which.
for (const [extradural, intradural] of [["61600", "61601"], ["61605", "61606"], ["61607", "61608"], ["61615", "61616"]]) {
  ok(`${extradural} says extradural`, /extradural/i.test(CPT_BY_CODE[extradural].fullDesc));
  ok(`${intradural} says intradural`, /intradural/i.test(CPT_BY_CODE[intradural].fullDesc));
  ok(`${extradural} is worth less than ${intradural}`, CPT_BY_CODE[extradural].wRVU < CPT_BY_CODE[intradural].wRVU);
}

// 60600 is the code everyone reaches for. Its own entry has to say why it may
// not apply, because the descriptor is the whole argument.
ok("60600 names the carotid body as the structure",
  /carotid body/i.test(CPT_BY_CODE["60600"].fullDesc));
ok("and says a vagal paraganglioma is not it",
  /vagal|glomus vagale/i.test(CPT_BY_CODE["60600"].fullDesc));

// ── The cached block the model always sees ─────────────────────────────────
{
  const lines = buildCatalog().split("\n");
  const codes = new Set(lines.map((l) => l.split("|")[0]));
  for (const [code] of MUST_EXIST) ok(`${code} is in the cached catalog`, codes.has(code));
  ok("the cached catalog stays small enough to cache cheaply", buildCatalog().length < 45000,
    `${buildCatalog().length} chars`);
}

// ── Tokenising ─────────────────────────────────────────────────────────────
eq("stop words and short words go", tokens("I did the case with a tumor"), ["tumor"]);
eq("a stem folds the verb to the noun", [stem("resected"), stem("resection"), stem("tumors")], ["res", "res", "tumor"]);
ok("the same stem for both forms", stem("resected") === stem("resection"));

// The expansions exist because the fee schedule never prints these words.
ok("paraganglioma reaches the words CPT actually uses",
  searchTerms("paraganglioma").includes(stem("carotid")));
ok("glomus vagale reaches carotid body and neck",
  ["carotid", "body", "neck"].every((w) => searchTerms("glomus vagale").includes(stem(w))));
ok("vagal reaches vagus", searchTerms("vagal tumor").includes(stem("vagus")));
ok("every expansion target is a real word, not a code",
  Object.values(TERM_EXPANSIONS).flat().every((w) => /^[a-z]+$/.test(w)));

// ── Merging ────────────────────────────────────────────────────────────────
{
  const full = mergeCatalog(CURATED_BY_CODE, CMS_ALL);
  ok("the whole fee schedule is there", Object.keys(full).length > 9000);
  eq("a curated descriptor beats the CMS short one",
    full["61605"].fullDesc.includes("parapharyngeal"), true);
  eq("but the RVU still comes from CMS", full["61605"].wRVU, 31.76);
  eq("a code nobody curated still carries its CMS descriptor and RVU",
    [full["43651"].shortDesc, full["43651"].wRVU], [CMS_ALL["43651"].d, CMS_ALL["43651"].w]);
  ok("curated entries are flagged", full["61605"].curated === true && full["43651"].curated === false);
  eq("an empty CMS table degrades to the curated set alone",
    Object.keys(mergeCatalog(CURATED_BY_CODE, {})).length, Object.keys(CURATED_BY_CODE).length);
}

// ── The shortlist ──────────────────────────────────────────────────────────
{
  const full = mergeCatalog(CURATED_BY_CODE, CMS_ALL);
  const cached = new Set(Object.keys(CPT_BY_CODE));
  const list = candidateCodes("I resected a paraganglioma vagal nerve tumor in the neck", full, { exclude: cached });

  ok("nothing already in the cached block is sent twice",
    list.every((e) => !cached.has(e.code)));
  ok("the shortlist stays short", list.length <= 120);
  ok("and it is not empty for a dictation with rare words in it", list.length > 0);
  ok("every entry on it is vagus, nerve or neck related",
    list.every((e) => /nerve|vagus|neck|cranial/i.test(`${e.shortDesc} ${e.fullDesc || ""}`)),
    list.filter((e) => !/nerve|vagus|neck|cranial/i.test(`${e.shortDesc} ${e.fullDesc || ""}`)).map((e) => e.code).join(", "));

  // Rarity weighting: without it a transurethral resection of the bladder neck
  // outranked a real match, because "resection" and "neck" scored the same as
  // "paraganglioma".
  const bladder = list.findIndex((e) => e.code === "52500");
  ok("a bladder neck resection never leads the list on a neck tumor",
    bladder === -1 || bladder > 2, `position ${bladder}`);

  eq("no dictation words means no shortlist", candidateCodes("", full).length, 0);
  eq("a null catalog does not throw", candidateCodes("tumor resection", null).length, 0);
}

// ── The block that goes in the message ─────────────────────────────────────
{
  const full = mergeCatalog(CURATED_BY_CODE, CMS_ALL);
  const list = candidateCodes("vagus nerve tumor neck", full, { exclude: new Set(Object.keys(CPT_BY_CODE)) });
  const block = candidateBlock(list);
  ok("the block names itself so the model knows it may use these", /ADDITIONAL CANDIDATE CODES/.test(block));
  ok("and says a code belongs to the work, not to a specialty", /not to a specialty/.test(block));
  ok("no em dash in it", !block.includes("—"));
  eq("an empty list produces no block", candidateBlock([]), "");
  eq("one line is code, description, work RVU",
    catalogLine({ code: "21556", fullDesc: "Excision, tumor", wRVU: 7.47 }), "21556|Excision, tumor|7.47");
  ok("a long descriptor is trimmed rather than sent whole",
    catalogLine({ code: "1", fullDesc: "x".repeat(400), wRVU: 1 }).length < 240);
}

// ── House rules ────────────────────────────────────────────────────────────
ok("no em dash in any curated descriptor we added",
  MUST_EXIST.every(([c]) => !`${CPT_BY_CODE[c].shortDesc}${CPT_BY_CODE[c].fullDesc}`.includes("—")));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
