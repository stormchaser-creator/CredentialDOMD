// Exercise the real readers/callers with synthetic provider replies; no network,
// keys or customer records. Only the transport and unrelated PDF export are stubbed.
// Run: node --experimental-vm-modules scripts/gemini-client.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calls = [];
let result, rejected = null, finishReason = "STOP", opusReply, opusError, opusCalls = 0;
const api = {
  async geminiCall(model, body, key, options) {
    calls.push({ model, body, key, options });
    if (rejected) return rejected;
    const text = JSON.stringify(result), split = Math.floor(text.length / 2);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason, content: { parts: [
      { thought: true, text: 'Do not parse this thought: {"wrong":true}' },
      { text: text.slice(0, split) }, { thoughtSignature: "synthetic-signature" },
      { text: text.slice(split) },
    ] } }] }) };
  },
  proxyErrorMessage: response => response.proxyError ? response.message : null,
  anthropicAvailable: settings => !!settings.anthropicApiKey,
  anthropicClientFor: async () => ({ messages: { create: async () => {
    opusCalls++;
    if (opusError) throw opusError;
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(opusReply) }] };
  } } }),
  anthropicErrorMessage: error => error.proxyError ? error.message : null,
  anthropicSdk: () => null,
  AI_MESSAGES: { budget: "Synthetic budget reached" },
};
const context = vm.createContext({ console, AbortController, setTimeout, clearTimeout });
const modules = new Map();
const transport = new vm.SyntheticModule(Object.keys(api), function () {
  for (const [name, value] of Object.entries(api)) this.setExport(name, value);
}, { context });
const pdfExport = new vm.SyntheticModule(["academicYearOf", "caseWRVU"], function () {
  this.setExport("academicYearOf", () => "2026");
  this.setExport("caseWRVU", () => 0);
}, { context });
async function moduleFor(filename) {
  if (filename.endsWith("/aiClient.js")) return transport;
  if (filename.endsWith("/caseLogReport.js")) return pdfExport;
  if (!modules.has(filename)) {
    const source = await readFile(filename, "utf8");
    modules.set(filename, new vm.SourceTextModule(source, {
      context, identifier: filename,
      importModuleDynamically: async (specifier, referring) => {
        const child = await link(specifier, referring);
        if (child.status === "unlinked") await child.link(link);
        if (child.status === "linked") await child.evaluate();
        return child;
      },
    }));
  }
  return modules.get(filename);
}
async function link(specifier, referring) {
  assert(specifier.startsWith("."), `Unexpected dependency: ${specifier}`);
  let filename = path.resolve(path.dirname(referring.identifier), specifier);
  if (!path.extname(filename)) filename += ".js";
  return moduleFor(filename);
}
async function load(name) {
  const mod = await moduleFor(path.join(root, "src/utils", `${name}.js`));
  if (mod.status === "unlinked") await mod.link(link);
  if (mod.status === "linked") await mod.evaluate();
  return mod.namespace;
}
const doc = await load("documentScanner"), cv = await load("cvScan");
const cme = await load("cmeImport"), work = await load("workDictation");
const cases = await load("caseDictation"), lookup = await load("cptAILookup");
const coder = await load("cptCoder"), vera = await load("assistant");
const image = "data:image/png;base64,c3ludGhldGlj";
const pdf = "data:application/pdf;base64,c3ludGhldGlj";
const credential = { documentType: "cme", confidence: "high", extracted: { title: "Synthetic CME", hours: 2, date: "2026-09-15" } };
const cvReply = { publications: Array.from({ length: 60 }, (_, i) => ({ name: `Synthetic paper ${i + 1}`, year: "2026" })) };
const turn = settings => vera.assistantTurn({ history: [{ role: "user", text: "Show my license" }], snapshot: {}, settings });
const examples = [
  ["document image", () => doc.analyzeDocument(image, "MD", "personal-test-key"), credential, 8192, r => assert.equal(r.extracted.hours, 2)],
  ["document PDF", () => doc.analyzePDF(pdf, "MD", ""), credential, 8192, r => assert.equal(r.extracted.title, "Synthetic CME")],
  ["document text", () => doc.analyzeDocText("Synthetic text", "MD", ""), credential, 8192, r => assert.equal(r.documentType, "cme")],
  ["agreement text", () => doc.analyzeAgreementText("Synthetic contract", ""), { extracted: { facility: "Synthetic Hospital" } }, 8192, r => assert.equal(r.extracted.facility, "Synthetic Hospital")],
  ["agreement PDF", () => doc.analyzeAgreement(pdf, ""), { extracted: { hourlyRate: 250 } }, 8192, r => assert.equal(r.extracted.hourlyRate, 250)],
  ["statement PDF", () => doc.analyzeStatement(pdf, ""), { transactions: [{ merchant: "Synthetic Hotel", amount: 42 }] }, 16384, r => assert.equal(r[0].amount, 42)],
  ["statement categories", () => doc.categorizeStatementRows([{ merchant: "Synthetic Hotel", amount: 42 }], ["Lodging"], ""), { rows: [{ i: 0, category: "Lodging" }] }, 16384, r => assert.equal(r[0].category, "Lodging")],
  ["CV PDF", () => cv.analyzeCvPdf(pdf, "MD", ""), cvReply, 32768, r => assert.equal(r.publications.length, 60)],
  ["CV image", () => cv.analyzeCvImage(image, "MD", ""), cvReply, 32768, r => assert.equal(r.publications.length, 60)],
  ["CV text", () => cv.analyzeCvText("Synthetic CV", "MD", ""), cvReply, 32768, r => assert.equal(r.publications.length, 60)],
  ["CME text", () => cme.structureTranscriptWithAI({ text: "Synthetic transcript" }, "MD", ""), [{ title: "Synthetic CME", hours: 2, date: "2026-09-15", creditType: "AMA PRA Category 1" }], 8192, r => assert.equal(r[0].hours, 2)],
  ["CME PDF", () => cme.structureTranscriptWithAI({ pdfDataUrl: pdf }, "MD", ""), [{ title: "Synthetic CME", hours: 2, date: "2026-09-15" }], 8192, r => assert.equal(r[0].title, "Synthetic CME")],
  ["work dictation", () => work.parseWorkDictation("Transfer call ten minutes", "", ["Transfer call"]), { type: "Transfer call", durationMin: 10 }, 8192, r => assert.equal(r.durationMin, "10")],
  ["case dictation", () => cases.parseCaseDictation("Synthetic craniotomy", { coderModel: "gemini" }, ["Cranial"]), { title: "Synthetic craniotomy", category: "Cranial" }, 8192, r => assert.equal(r.category, "Cranial")],
  ["CPT lookup", () => lookup.aiCPTLookup("Synthetic procedure", [], ""), { codes: [{ code: "61312" }] }, 1000, r => assert.equal(r.codes[0].code, "61312")],
  ["CPT coding", () => coder.codeFromText("Craniotomy evacuation of subdural hematoma", { coderModel: "gemini" }), { encounters: [{ code: "61312", units: 1 }], confidence: "high" }, 4096, r => assert.equal(r.items[0].code, "61312")],
  ["Vera", () => turn({ assistantModel: "gemini", anthropicApiKey: "synthetic-opus-key" }), { reply: "Please review", actions: [{ kind: "create", section: "licenses", fields: { name: "Synthetic license" } }] }, 8192, r => assert.equal(r.actions[0].kind, "create")],
];

let passed = 0;
for (const [name, run, reply, ceiling, check] of examples) {
  result = reply;
  const before = calls.length;
  const value = await run();
  assert.equal(calls.length, before + 1, `${name}: one request`);
  const request = calls.at(-1);
  assert.equal(request.model, "models/gemini-3.8-flash:generateContent", name);
  assert.equal(request.body.generationConfig.maxOutputTokens, ceiling, name);
  assert.equal(request.body.generationConfig.responseMimeType, "application/json", name);
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, "LOW", name);
  assert.equal(request.body.generationConfig.thinkingConfig.includeThoughts, false, name);
  for (const forbidden of ["temperature", "topP", "topK", "candidateCount"]) assert(!(forbidden in request.body.generationConfig), name);
  assert(!("thinkingBudget" in request.body.generationConfig.thinkingConfig), name);
  check(value);
  // Even syntactically valid JSON must not pass a provider truncation marker.
  finishReason = "MAX_TOKENS";
  await assert.rejects(run, /reply was cut off/, `${name}: truncation`);
  finishReason = "STOP";
  passed += 2;
}
assert.equal(opusCalls, 0, "Explicit Gemini skips Anthropic even with a key");
assert.equal(calls[0].key, "personal-test-key", "Personal key forwarded unchanged");
assert.equal(calls[2].key, "", "Shared route remains selected by an empty key");
assert.equal(calls[2].body.contents[0].parts[0].inlineData.mimeType, "application/pdf");
passed += 4;

opusReply = { reply: "Synthetic Anthropic answer", actions: [] };
const beforeOpus = calls.length;
assert.equal((await turn({ assistantModel: "opus", anthropicApiKey: "synthetic-opus-key" })).reply, opusReply.reply);
assert.equal(calls.length, beforeOpus, "Explicit Anthropic does not also bill Gemini");
opusError = { proxyError: "budget", message: api.AI_MESSAGES.budget };
result = { reply: "Synthetic Gemini fallback", actions: [] };
assert.match((await turn({ assistantModel: "opus", anthropicApiKey: "synthetic-opus-key" })).reply, /Synthetic Gemini fallback/);
assert.equal(calls.length, beforeOpus + 1, "Budget refusal falls back exactly once");
passed += 4;

rejected = { ok: false, status: 429, proxyError: "accounting", message: "Synthetic accounting retry" };
const beforeReject = calls.length;
await assert.rejects(() => turn({}), /Synthetic accounting retry/);
assert.equal(calls.length, beforeReject + 1, "Proxy refusal never retries as another model");
passed += 2;
console.log(`${passed} Gemini client compatibility checks passed`);
