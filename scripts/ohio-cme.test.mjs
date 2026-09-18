// Synthetic Ohio applicability, per-license windows, assistant grounding and
// transcript regression checks. No network, provider calls or user records.
// Run: node --experimental-vm-modules scripts/ohio-cme.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { computeCompliance, complianceFor, standingScore } from "../src/utils/compliance.js";
import { OHIO_PAIN_CLINIC_FIELD, ohioCmeContext } from "../src/utils/conditionalCme.js";

let checks = 0;
const eq = (got, want, message) => { assert.deepEqual(JSON.parse(JSON.stringify(got)), want, message); checks++; };
const truth = (value, message) => { assert.ok(value, message); checks++; };
const entry = (hours, date, topics = [], category = "AMA PRA Category 1") => ({ hours, date, topics, category });
const base = [entry(49, "2026-02-01"), entry(1, "2026-02-02", ["Ethics"])];
const opts = answer => ({ licenseExpiration: "2027-01-31", topicApplicability: { [OHIO_PAIN_CLINIC_FIELD]: answer } });
const calculate = (answer, entries = base, extra = {}) => computeCompliance(entries, "OH", "MD", { ...opts(answer), ...extra });
for (const answer of [undefined, null, "", "Not sure", "false", "Yes, probably", 1]) {
  const c = calculate(answer);
  eq(c.assessmentStatus, "needs-confirmation", `Unknown answer ${answer} is neutral`);
  eq(c.topicResults.filter(t => t.topic === "Pain Management"), [], "Unknown applicability does not create a pain shortfall");
  eq(c.fullyCompliant, false, "Unknown applicability cannot silently certify all requirements");
  eq(c.conditionalTopics[0].applicability, "unknown", "Unknown condition stays visible");
}
for (const answer of [false, "No"]) {
  const c = calculate(answer);
  eq(c.fullyCompliant, true, "Explicit nonapplicability leaves base rules intact");
  eq(c.conditionalTopics[0].applicability, "not-applicable", "Selection remains visible");
}
for (const answer of [true, "Yes"]) {
  const c = calculate(answer);
  eq(c.assessmentStatus, "needs-hours", "Applicable missing pain hours are a real gap");
  eq(c.topicResults.find(t => t.topic === "Pain Management").required, 20, "Applicable mandate is 20h");
}
const painCredits = [
  entry(10, "2025-01-31", ["Pain Management"]), // inclusive cycle boundary
  entry(10, "2027-01-31", ["Pain Management"], "AOA Category 1-A"),
  entry(30, "2025-01-30", ["Pain Management"]), // just before cycle
  entry(30, "2027-02-01", ["Pain Management"]), // after cycle
  entry(30, "2026-06-01", ["Pain Management"], "AMA PRA Category 2"),
];
const applicable = calculate(true, [...base, ...painCredits]);
eq(applicable.topicResults.find(t => t.topic === "Pain Management").earned, 20, "Pain hours honor cycle boundaries and Category I");
eq(applicable.totalRequired, 50, "Conditional pain hours do not add 20 to general total");
const customCycle = calculate(true, [...base, ...painCredits], { cycleStart: "2026-01-01" });
eq(customCycle.topicResults.find(t => t.topic === "Pain Management").earned, 10, "Per-license cycle override still applies");
eq(customCycle.totalRequired, 50, "Cycle override preserves target");
const inapplicableGap = calculate(false, []);
eq(inapplicableGap.assessmentStatus, "needs-hours", "Nonapplicability does not exempt general CME");
const data = {
  settings: { degreeType: "MD" },
  licenses: [
    { id: "oh-later", type: "Medical License", state: "OH", expirationDate: "2099-01-31", customFields: { [OHIO_PAIN_CLINIC_FIELD]: "Yes" } },
    { id: "oh-sooner", type: "Medical License", state: "OH", expirationDate: "2098-01-31", cmeCycleStart: "2097-01-01", customFields: { [OHIO_PAIN_CLINIC_FIELD]: "No", "Other field": "preserved" } },
  ],
  cme: [entry(50, "2097-06-01", ["Ethics"])],
};
const frozen = JSON.stringify(data);
const perLicense = complianceFor(data, "OH");
eq(perLicense.conditionalTopics[0].applicability, "not-applicable", "Selection comes from the license anchoring the current cycle");
eq(perLicense.windowSource, "custom", "License's cycle start is preserved");
eq(JSON.stringify(data), frozen, "Calculation does not mutate user records");
const context = ohioCmeContext(calculate(undefined));
eq(context.painClinicRule.applicability, "unknown", "Ohio context preserves unknown");
eq(context.painClinicRule.checkedOn, "2026-09-18", "Checked date is frozen");
eq(context.painClinicRule.url, "https://codes.ohio.gov/ohio-administrative-code/rule-4731-29-01", "Context cites the actual pain-clinic rule");
truth(context.painClinicRule.appliesTo.includes("own or provide care"), "Owners and treating physicians both covered");
truth(context.instruction.includes("Do not say every Ohio physician"), "Context rejects blanket applicability");
truth(context.generalRule.dutyToReport.includes("generic Ethics tag alone"), "Pilot does not overstate duty-to-report evidence");
eq(ohioCmeContext(computeCompliance([], "CA", "MD")), null, "Pilot doesn't claim other jurisdictions verified");
const pending = calculate(undefined); pending.daysLeft = 20;
const standing = standingScore({ stateComps: [{ st: "OH", comp: pending }] });
eq(standing.needsAction[0].item.needsConfirmation, true, "Home action identifies confirmation, not missing pain hours");

// Load actual assistant and transcript modules. Stub network transport only;
// pure calculations and source data are the production modules.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = vm.createContext({ console, Date, AbortController, setTimeout, clearTimeout });
const modules = new Map();
const transportNames = ["geminiCall", "proxyErrorMessage", "anthropicAvailable", "anthropicClientFor", "anthropicErrorMessage", "anthropicSdk", "AI_MESSAGES"];
const transport = new vm.SyntheticModule(transportNames, function () {
  for (const name of transportNames) this.setExport(name, name === "AI_MESSAGES" ? {} : () => { throw new Error("No provider call is allowed in this test"); });
}, { context: sandbox });
async function loadModule(filename) {
  if (filename.endsWith("/aiClient.js")) return transport;
  if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(await readFile(filename, "utf8"), { context: sandbox, identifier: filename }));
  return modules.get(filename);
}
async function linker(specifier, parent) {
  if (!specifier.startsWith(".")) {
    if (!modules.has(specifier)) {
      const real = await import(specifier);
      modules.set(specifier, new vm.SyntheticModule(Object.keys(real), function () {
        for (const key of Object.keys(real)) this.setExport(key, real[key]);
      }, { context: sandbox }));
    }
    return modules.get(specifier);
  }
  let filename = path.resolve(path.dirname(parent.identifier), specifier);
  if (!path.extname(filename)) filename += ".js";
  return loadModule(filename);
}
async function load(name) {
  const mod = await loadModule(path.join(root, "src/utils", name + ".js"));
  if (mod.status === "unlinked") await mod.link(linker);
  if (mod.status === "linked") await mod.evaluate();
  return mod.namespace;
}
const assistant = await load("assistant");
const unknownData = { ...data, licenses: [{ ...data.licenses[1], customFields: {} }] };
const snapshot = assistant.buildSnapshot(unknownData, ["OH"]);
eq(snapshot.cmeSummary.byState.OH.verifiedRuleContext.painClinicRule.applicability, "unknown", "Actual assistant snapshot includes conditional source context");
eq(snapshot.cmeSummary.byState.OH.unmetTopics, [], "Actual assistant receives no invented Ohio pain deficit");
truth(assistant.systemBlocks(snapshot).join("\n").includes("not a 20-hour shortfall"), "Both provider system paths use the deterministic guard");
const transcript = await load("cmeTranscriptPdf");
const unknownRows = transcript.stateRequirementRows(transcript.stateTranscriptModel(unknownData, "OH"));
const unknownRow = unknownRows.find(r => r.name === "Pain Management (conditional)");
eq(unknownRow.status, "Confirm applicability", "Transcript has a neutral unresolved row");
eq(unknownRow.met, null, "Transcript does not mark unknown as failed or passed");
const noRows = transcript.stateRequirementRows(transcript.stateTranscriptModel(data, "OH"));
eq(noRows.find(r => r.name === "Pain Management (conditional)").status, "Not applicable (selected)", "Transcript records explicit nonapplicability");
const rendered = transcript.buildTranscriptPdf(transcript.stateTranscriptModel(unknownData, "OH"), { today: new Date("2026-09-18T12:00:00Z") });
truth(rendered.getNumberOfPages() > 0 && rendered.output("arraybuffer").byteLength > 1000, "Actual PDF renderer accepts neutral conditional rows");
console.log(`${checks} Ohio CME checks passed`);
