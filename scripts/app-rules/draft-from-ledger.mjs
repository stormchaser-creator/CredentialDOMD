#!/usr/bin/env node
// One-time helper (DESIGN 2.1): drafts a canonical state file from the
// research ledger, for a person to curate. Not part of the build, and never
// trusted on its own: the generator (scripts/generate-app-rules.mjs) decides
// what is verified, and anything a draft gets wrong degrades to "not yet
// verified", never to a number.
//
//   node scripts/app-rules/draft-from-ledger.mjs TX            print the TX draft
//   node scripts/app-rules/draft-from-ledger.mjs --all DIR     write every draft to DIR
//
// What it fills: the boards, scalar fields that a verified fact under a known
// alias backs (DESIGN 2.6), and every topic mandate the research summarised,
// marked "status": "unverified" with a TODO so nothing reaches the app until
// a person links it to its fact. It never writes into data/app-rules/states.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { factUsable } from "../generate-app-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEDGER = path.join(ROOT, "data/app-rules/ledger");

// Canonical field -> ledger field names the research used (DESIGN 2.6).
export const ALIASES = {
  "pa.total": ["pa.ce.hoursPerCycle", "ce.hoursPerCycle", "ce.hoursPerYear"],
  "pa.cycle": ["pa.licence.renewalCycleYears", "licence.renewalCycleYears"],
  "pa.categoryMin": ["pa.ce.categoryRules", "ce.categoryRules"],
  "pa.inLieu": ["pa.ce.acceptsNccpaCertificationInLieu", "ce.acceptsNccpaCertificationInLieu"],
  "pa.certRequired": ["pa.ce.nccpaCertificationRequiredForRenewal", "ce.nccpaCertificationRequiredForRenewal"],
  "pa.csr": ["pa.prescribing.stateCsRegistrationRequired", "prescribing.stateCsRegistrationRequired"],
  "rn.total": ["np.rn.ceHoursPerCycle", "rn.ceHoursPerCycle", "np.rn.ce", "rn.ce"],
  "rn.cycle": ["np.rn.renewalCycleYears", "rn.renewalCycleYears", "np.rn.renewalCycle"],
  "rn.nlc": ["np.rn.nlcCompactMember", "rn.nlcCompactMember", "np.rn.nlc", "rn.nlc", "rn.nlcCompact"],
  "aprn.total": ["np.aprn.ceHoursPerCycle", "aprn.ceHoursPerCycle", "np.aprn.ce"],
  "aprn.cycle": ["np.aprn.renewalCycleYears", "aprn.renewalCycleYears"],
  "aprn.pharmacology": ["np.aprn.pharmacologyHoursPerCycle", "aprn.pharmacologyHoursPerCycle", "np.prescribing.pharmacologyCeForPrescribers"],
  "aprn.certRequired": ["np.aprn.nationalCertificationRequired", "aprn.nationalCertificationRequired"],
  "np.csr": ["np.prescribing.stateCsRegistrationRequired", "prescribing.stateCsRegistrationRequired"],
};

const factFor = (facts, key) => {
  for (const id of ALIASES[key] || []) {
    const f = facts.find((x) => x.field === id && factUsable(x));
    if (f) return f;
  }
  return null;
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v) => (v === true || v === false ? v : null);

function scalar(facts, key, value) {
  const f = factFor(facts, key);
  if (!f || value == null) return undefined;
  return { value, fact: f.field };
}

function topics(summary) {
  // A draft topic is unverified with a generic tag until a person picks the
  // topic and links its fact; the TODO key says so. The generator shows it as
  // "not yet verified" with the board link, never as a number.
  return (summary?.topicMandates || []).map((t) => ({
    topic: "General / No Specific Topic",
    TODO: "pick the topic tag, link the ledger fact, set hours and period",
    hours: null,
    status: "unverified",
    unverifiedItem: String(t.topic || "Topic requirement").replace(/\d+\s*(contact )?(hours?|credits?)/gi, "").trim(),
    research: { topic: t.topic, hours: t.hours ?? null, period: t.period ?? null, appliesTo: t.appliesTo ?? null },
  }));
}

export function draftState(st) {
  const ledger = JSON.parse(readFileSync(path.join(LEDGER, `${st}.json`), "utf8"));
  const paFacts = ledger.pa?.facts || [];
  const npFacts = ledger.np?.facts || [];
  const pa = ledger.pa || {};
  const rn = ledger.np?.rn || {};
  const aprn = ledger.np?.aprn || {};

  const paTotal = num(pa.ce?.hoursPerCycle);
  const paCertReq = bool(pa.ce?.nccpaCertificationRequiredForRenewal);
  const paMode = paTotal > 0 ? "hours" : paTotal === 0 ? "none" : paCertReq ? "certification" : "unverified";
  const paCycle = scalar(paFacts, "pa.cycle", num(pa.licence?.renewalCycleYears));

  const draft = {
    state: st,
    researchedAt: ledger.researchedAt || "2026-10",
    verifiedAt: ledger.verifiedAt || "2026-10",
    pa: {
      board: { name: pa.board?.name || null, url: pa.board?.url || null },
      license: { cycleYears: paCycle },
      ce: {
        mode: paMode, windowRule: "license",
        cycleYears: paCycle,
        total: scalar(paFacts, "pa.total", paTotal),
        ...(bool(pa.ce?.acceptsNccpaCertificationInLieu) && factFor(paFacts, "pa.inLieu")
          ? { certificationInLieu: { bodies: ["NCCPA"], covers: ["total", "categoryMin"], fact: factFor(paFacts, "pa.inLieu").field } } : {}),
      },
      certificationRequired: scalar(paFacts, "pa.certRequired", paCertReq),
      topics: topics(pa.ce),
      prescribing: { stateCsRegistration: scalar(paFacts, "pa.csr", bool(pa.prescribing?.stateCsRegistrationRequired)) },
      research: { categoryRules: pa.ce?.categoryRules ?? null, practice: pa.practice ?? null },
      unverified: [],
    },
    np: {
      board: { name: ledger.np?.board?.name || null, url: ledger.np?.board?.url || null },
      rn: {
        nlc: scalar(npFacts, "rn.nlc", bool(rn.nlcCompactMember ?? rn.nlc ?? rn.nlcCompact)),
        ce: {
          mode: num(rn.ceHoursPerCycle) > 0 ? "hours" : num(rn.ceHoursPerCycle) === 0 ? "none" : "unverified", windowRule: "license",
          cycleYears: scalar(npFacts, "rn.cycle", num(rn.renewalCycleYears)),
          total: scalar(npFacts, "rn.total", num(rn.ceHoursPerCycle)),
        },
        topics: topics(rn),
        unverified: [],
      },
      aprn: {
        ce: {
          mode: num(aprn.ceHoursPerCycle) > 0 ? "hours" : num(aprn.ceHoursPerCycle) === 0 ? "none" : "unverified", windowRule: "license",
          cycleYears: scalar(npFacts, "aprn.cycle", num(aprn.renewalCycleYears)),
          total: scalar(npFacts, "aprn.total", num(aprn.ceHoursPerCycle)),
        },
        certificationRequired: scalar(npFacts, "aprn.certRequired", bool(aprn.nationalCertificationRequired)),
        topics: [
          ...(num(aprn.pharmacologyHoursPerCycle) > 0 && factFor(npFacts, "aprn.pharmacology")
            ? [{ topic: "Pharmacology", hours: null, status: "unverified", unverifiedItem: "Pharmacology hours", measure: "pharmacology",
                TODO: "set hours, condition (prescribers?) and whether they are additional", research: { hours: num(aprn.pharmacologyHoursPerCycle), fact: factFor(npFacts, "aprn.pharmacology").field } }] : []),
          ...topics(aprn),
        ],
        unverified: [],
      },
      prescribing: { stateCsRegistration: scalar(npFacts, "np.csr", bool(ledger.np?.prescribing?.stateCsRegistrationRequired)) },
      research: { practice: ledger.np?.practice ?? null },
      unverified: [],
    },
  };
  return JSON.parse(JSON.stringify(draft)); // drops undefined fields
}

if (process.argv[1]?.endsWith("draft-from-ledger.mjs")) {
  const args = process.argv.slice(2);
  if (args[0] === "--all") {
    const out = args[1];
    if (!out) { console.error("usage: draft-from-ledger.mjs --all DIR"); process.exit(2); }
    if (path.resolve(out).startsWith(path.join(ROOT, "data/app-rules/states"))) { console.error("drafts never go into data/app-rules/states"); process.exit(2); }
    mkdirSync(out, { recursive: true });
    for (const f of readdirSync(LEDGER).filter((n) => /^[A-Z]{2}\.json$/.test(n))) {
      writeFileSync(path.join(out, f), JSON.stringify(draftState(f.slice(0, 2)), null, 2) + "\n");
    }
    console.log(`drafts written to ${out}`);
  } else if (/^[A-Z]{2}$/.test(args[0] || "")) {
    console.log(JSON.stringify(draftState(args[0]), null, 2));
  } else {
    console.error("usage: draft-from-ledger.mjs ST | --all DIR");
    process.exit(2);
  }
}
