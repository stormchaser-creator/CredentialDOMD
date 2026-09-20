// Synthetic records only; intercept both provider transports (no network).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildReferenceDraft, buildReferenceText, buildAssistantHistory, archivedReferenceActions, referenceSelection, resolveReferenceSelection, referenceSharePayload, referenceSentences } from "../src/utils/referenceDraft.js";
import { buildCredentialText, buildCredentialBlurb, buildEmailSubject, mailtoHref } from "../src/utils/helpers.js";

const refs = ["Alice Example", "Brenda Example", "Chris Example", "Excluded One", "Excluded Two"].map((name, i) => ({
  id: `ref-${i}`, name, degree: "MD", specialty: "Neurosurgery", institution: "Example Clinic",
  relationship: "Colleague", knownSince: "2020-01", email: `ref${i}@example.test`, phone: `202-555-010${i}`,
  notes: "PRIVATE-NOTE", customFields: { secret: "PRIVATE-EXTRA" },
}));
const action = { kind: "draft_references", referenceIds: ["ref-0", "ref-1", "ref-2", "ref-3", "ref-0"], excludedReferenceIds: ["ref-3", "ref-4"] };
const draft = buildReferenceDraft(refs, action);
assert.deepEqual(draft.selected.map(r => r.id), ["ref-0", "ref-1", "ref-2"]);
for (const ref of refs.slice(0, 3)) for (const key of ["name", "email", "phone", "institution", "relationship"]) assert.ok(draft.text.includes(ref[key]));
for (const ref of refs.slice(3)) assert.ok(!draft.text.includes(ref.name) && !draft.text.includes(ref.email));
assert.ok(draft.text.includes("\n\n"));
assert.ok(!/PRIVATE|NPI|clipboard|CREDENTIAL VERIFICATION/.test(draft.text));
const bulk = referenceSharePayload(draft.selected);
assert.equal(bulk.full, draft.text);
for (const ref of draft.selected) assert.ok(bulk.text.includes(ref.email) && bulk.text.includes(ref.phone));
for (const ref of refs.slice(3)) assert.ok(!bulk.text.includes(ref.email));
assert.ok(!/PRIVATE|NPI|clipboard/.test(bulk.text));
assert.equal(buildReferenceDraft(refs, { referenceIds: [] }).text, "");
assert.deepEqual(buildReferenceDraft(refs.slice(1), action).unavailableIds, ["ref-0"]);
assert.equal(buildReferenceDraft([{ ...refs[0], phone: "" }], { referenceIds: ["ref-0"] }).missingContacts.length, 1);
assert.deepEqual(referenceSelection({ referenceIds: [null, {}, 1, "ref-1", "ref-1"], excludedReferenceIds: ["ref-1"] }).referenceIds, []);
assert.equal(buildReferenceText({ name: "Alice Example, MD", degree: "MD", email: "" }), "Alice Example, MD");

const settings = { name: "Synthetic Physician", degreeType: "DO", npi: "9999999999", apiKey: "PRIVATE-KEY" };
assert.equal(buildCredentialText(refs[0], "peerReferences", settings), buildReferenceText(refs[0]));
assert.equal(buildCredentialBlurb(refs[0], "peerReferences", settings, false, ""), referenceSentences(refs[0]));
assert.ok(!buildCredentialBlurb(refs[0], "peerReferences", settings, false, "").includes("; "));
assert.ok(buildCredentialBlurb(refs[0], "peerReferences", settings, true, "Hello").includes("Hello Alice"));
assert.equal(buildEmailSubject(refs[0], "peerReferences", settings), "Professional reference: Alice Example");
const mail = new URL(mailtoHref("", "Professional references", draft.text));
assert.equal(mail.searchParams.get("body").replace(/\r\n/g, "\n"), draft.text);
assert.ok(buildCredentialText({ type: "Medical License", licenseNumber: "SYN-123", state: "CA" }, "licenses", settings).includes("License #: SYN-123"));

const messages = [
  { role: "user", text: "Prepare my references, excluding Excluded One." },
  { role: "model", text: "Review your reference draft below.", actions: [{ ...action, draftText: draft.text, records: refs }] },
  { role: "user", text: "Exclude Excluded Two as well." },
];
const history = buildAssistantHistory(messages);
const restored = archivedReferenceActions(messages[1].actions);
assert.deepEqual(restored[0].excludedReferenceIds, ["ref-3", "ref-4"]);
assert.deepEqual(Object.keys(restored[0]).sort(), ["excludedReferenceIds", "kind", "referenceIds"]);
assert.ok(history[1].text.includes('"excludedReferenceIds":["ref-3","ref-4"]'));
assert.ok(!JSON.stringify(history).includes("example.test"));
assert.ok(!JSON.stringify(restored).includes("202-555"));
assert.equal(buildAssistantHistory([{ role: "user", text: "failed", failed: true }]).length, 0);
const continued = resolveReferenceSelection({ referenceIds: refs.map(r => r.id), excludedReferenceIds: ["ref-4"] }, { excludedReferenceIds: ["ref-3"] });
assert.deepEqual(continued.referenceIds, ["ref-0", "ref-1", "ref-2"]);
assert.deepEqual(resolveReferenceSelection({ referenceIds: ["ref-3"], restoreReferenceIds: ["ref-3"] }, continued).referenceIds, ["ref-3"]);
const longHistory = buildAssistantHistory([...messages, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: "Other question" })), { role: "user", text: "Prepare the references again" }]);
assert.ok(longHistory.slice(-14).at(-1).text.includes('"excludedReferenceIds":["ref-3","ref-4"]'));
const dismissed = archivedReferenceActions([{ ...action, dismissed: true }]);
assert.equal(dismissed[0].dismissed, true);
assert.ok(buildAssistantHistory([{ role: "model", text: "Draft", actions: dismissed }, { role: "user", text: "Try again" }]).at(-1).text.includes('"ref-4"'));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = vm.createContext({ console, URL, Date, AbortController, setTimeout, clearTimeout });
const modules = new Map();
const captured = [];
const response = JSON.stringify({ reply: "Review your reference draft below.", actions: [action] });
const exports = {
  geminiCall: async (_url, body) => { captured.push(body); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: response }] } }] }) }; },
  proxyErrorMessage: () => null, anthropicAvailable: () => true,
  anthropicClientFor: async () => ({ messages: { create: async body => { captured.push(body); return { stop_reason: "end_turn", content: [{ type: "text", text: response }] }; } } }),
  anthropicErrorMessage: () => null, anthropicSdk: () => null, AI_MESSAGES: {},
};
const transport = new vm.SyntheticModule(Object.keys(exports), function () {
  for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
}, { context: sandbox });
async function load(filename) {
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
  return load(filename);
}
const mod = await load(path.join(root, "src/utils/assistant.js"));
await mod.link(linker); await mod.evaluate();
const snapshot = mod.namespace.buildSnapshot({ settings, peerReferences: refs });
const prompt = mod.namespace.systemBlocks(snapshot).join("\n");
assert.ok(prompt.includes("draft_references") && prompt.includes("intentionally absent"));
assert.ok(!prompt.includes("snapshot below is their entire database"));
for (const provider of ["gemini", "opus"]) {
  const result = await mod.namespace.assistantTurn({ history, snapshot, settings: { assistantModel: provider } });
  assert.equal(result.actions[0].kind, "draft_references");
  const payload = JSON.stringify(captured.at(-1));
  for (const forbidden of ["example.test", "202-555", "PRIVATE-NOTE", "PRIVATE-EXTRA", "PRIVATE-KEY"]) assert.ok(!payload.includes(forbidden), `${provider} leaked ${forbidden}`);
  assert.ok(payload.includes("excludedReferenceIds"));
}
assert.equal(captured.length, 2);
console.log("Reference draft checks passed: exact local contacts, exclusions, stale/missing records, share/email formatting, archive IDs, and both provider payloads.");
