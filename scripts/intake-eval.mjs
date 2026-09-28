#!/usr/bin/env node
/**
 * intake-eval: how well the understanding step reads real mail.
 *
 *   node scripts/intake-eval.mjs [corpus-dir] [--mode stub|rules|model] [--json]
 *
 * The corpus is a directory of cases, one JSON file each, and it is PRIVATE:
 * real forwarded mail belongs to the owner and to the people who wrote it,
 * and this repository is public. The default directory is
 *   ~/Library/Application Support/CredentialDOMD/intake-eval/
 * and the script refuses any directory inside the repository except the
 * synthetic cases the tests use (scripts/fixtures/intake/understanding/).
 * scripts/intake-eval-seed.mjs builds a private corpus from the owner's own
 * last 30 days of mail; nothing it writes is ever committed.
 *
 * A case:
 *   {
 *     "id": "short-name",
 *     "about": "what this case is, for the person reading the corpus (optional)",
 *     "subject": "the forwarded email's subject",
 *     "from": { "name": "the original sender", "address": "who@where.example" },
 *     "note": "the physician's own words above the forward (optional)",
 *     "body": "the sender's message, with any quoted history under it",
 *     "attachments": [{ "name": "file.pdf", "scan": <the scanner's result, or null> }],
 *     "expected": { "intent": "request|delivery|informational|mixed",
 *                   "asks": [{ "kind": "<requestPacket KINDS>" }],
 *                   "roles": ["<a role per attachment>"],
 *                   "records": [{ "section": "insurance", "fields": { "coveragePerClaim": "1000000", ... } }] },
 *     "onFile": { "<section>": [<the physician's records the model may name>] } (optional),
 *     "agencies": ["<agency names on the physician's contracts, for the rules>"] (optional),
 *     "physicianName": "<the physician's name, so a fact about another doctor is dropped>" (optional),
 *     "modelReply": <a recorded model reply, optional, replayed in stub mode>
 *   }
 * A case with no "expected", or with "labelled": false, is read and shown
 * but not scored: seeded cases wait for the owner to label them.
 *
 * Modes:
 *   stub   (default) each case's recorded modelReply goes through the host's
 *          own check (verifyUnderstanding), so a stored reply is scored the
 *          way production would act on it; a case without one is read by the
 *          rules. No network.
 *   rules  the fallback alone, as when the model call fails or times out.
 *   model  one live call per case with the Anthropic SDK, the same request
 *          email-inbound sends (claude-opus-5 at effort low). Uses
 *          ANTHROPIC_API_KEY or an `ant auth login` profile, never the shared
 *          key. It costs money: at list price roughly $0.02 to $0.10 a case.
 *
 * What it prints: the intent, whether the email is a request at all (the
 * number the 2026-09-28 incident got wrong), ask precision and recall by
 * kind, asks invented on emails that asked for nothing, attachment roles,
 * and the facts an informational email states (records[], after the host's
 * own check, intakeFacts.mjs verifyRecords): how many expected fields were
 * read with the expected value, and how many were read that no one expected.
 */
import { readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildUnderstandingRequest, readModelReply, verifyUnderstanding, rulesUnderstanding, rulesWithFacts, splitForward,
} from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { corpusIndex, existingForModel, attachmentText } from "../supabase/functions/_shared/intakeFacts.mjs";
import { classifyAsk } from "../supabase/functions/_shared/requestPacket.ts";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SYNTHETIC_DIR = resolve(REPO, "scripts/fixtures/intake/understanding");
export const DEFAULT_CORPUS = join(homedir(), "Library", "Application Support", "CredentialDOMD", "intake-eval");

/**
 * May this directory be read as a corpus? Anywhere outside the repository,
 * or the synthetic cases inside it. A real corpus inside a public
 * repository is one `git add .` from being published.
 */
export function corpusAllowed(dir) {
  const real = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  const repo = existsSync(REPO) ? realpathSync(REPO) : REPO;
  const synthetic = existsSync(SYNTHETIC_DIR) ? realpathSync(SYNTHETIC_DIR) : SYNTHETIC_DIR;
  if (real === synthetic) return true;
  return !(real === repo || real.startsWith(repo + sep));
}

/** Every *.json case in a directory, sorted by file name. */
export function loadCases(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return { file: f, ...c, id: c.id || f.replace(/\.json$/, "") };
  });
}

/**
 * The email as email-inbound receives it: the physician's note, then a Gmail
 * forwarding header, then the sender's message. parseForwarded reads this
 * shape; the tests deliver exactly this text.
 */
export function composeForward(c) {
  const from = c.from?.name ? `${c.from.name} <${c.from.address}>` : String(c.from?.address || "unknown@unknown.example");
  return [
    String(c.note || "").trim(),
    c.note ? "" : null,
    "---------- Forwarded message ---------",
    `From: ${from}`,
    "Date: Mon, Sep 28, 2026 at 9:00 AM",
    `Subject: ${c.subject || ""}`,
    "To: Rowan Testa <rowan.testa@clinic.example>",
    "",
    String(c.body || ""),
  ].filter((l) => l !== null).join("\n").replace(/^\n+/, "");
}

/** The inputs the understanding step takes, from one case. */
export function caseInput(c) {
  const rawText = composeForward(c);
  const bodyAt = rawText.indexOf("\n\n", rawText.indexOf("---------- Forwarded message"));
  const forwardedBody = bodyAt >= 0 ? rawText.slice(bodyAt + 2) : String(c.body || "");
  const attachments = (Array.isArray(c.attachments) ? c.attachments : []).map((a) => ({ name: a.name, scan: a.scan ?? null }));
  return { rawText, forwardedBody, subject: String(c.subject || ""), from: c.from || {}, attachments };
}

/**
 * What a fact in this case may rest on, as email-inbound builds it: the
 * subject, the note, the message, the history and each attachment's words;
 * the records on file the model may name by ref; the physician's name.
 */
export function factsFor(c) {
  const input = caseInput(c);
  const parts = splitForward(input.rawText, input.forwardedBody);
  return {
    parts,
    onFile: existingForModel(c.onFile || {}),
    facts: {
      corpus: corpusIndex([input.subject, parts.note, parts.message, parts.history, ...input.attachments.map((a) => attachmentText(a.scan))]),
      refs: existingForModel(c.onFile || {}).refs,
      physicianName: String(c.physicianName || ""),
    },
  };
}

/** The rules' reading of a case (the fallback), with the one fact the rules can read. */
export function readByRules(c, why = "evaluation") {
  const input = caseInput(c);
  const { parts, facts } = factsFor(c);
  const agencies = [...(Array.isArray(c.agencies) ? c.agencies : []), ...((c.onFile?.locumContracts || []).map((x) => x.agency).filter(Boolean))];
  return rulesWithFacts(rulesUnderstanding({
    subject: input.subject, body: input.forwardedBody, attachmentNames: input.attachments.map((a) => a.name),
    attachmentCount: input.attachments.length, forwarded: true, why,
  }), { message: [parts.note, parts.message].filter(Boolean).join("\n\n"), subject: input.subject, agencies, facts });
}

/** A model reply (recorded or live) through the host's own check, as production acts on it. */
export function readFromReply(c, message) {
  const input = caseInput(c);
  const read = readModelReply(message);
  if (!read.ok) return readByRules(c, read.why);
  const { parts, facts } = factsFor(c);
  const reading = verifyUnderstanding(read.value, { subject: input.subject, parts, attachmentCount: input.attachments.length, facts });
  return reading.needsRules ? readByRules(c, "the reading's asks were not the email's own words") : reading;
}

/** The request email-inbound would send for this case. */
export function requestFor(c, corrections = []) {
  const input = caseInput(c);
  return buildUnderstandingRequest({
    subject: input.subject, sender: input.from, ...splitForward(input.rawText, input.forwardedBody),
    attachments: input.attachments, corrections, records: factsFor(c).onFile.lines,
  });
}

/** A recorded reply as the Messages API would have returned it. */
export const asMessage = (reply) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] });

/** How each mode reads a case. `client` is an Anthropic SDK client, for mode "model". */
export function readerFor(mode, client = null) {
  if (mode === "rules") return async (c) => readByRules(c);
  if (mode === "model") {
    return async (c) => {
      try {
        return readFromReply(c, await client.messages.create(requestFor(c)));
      } catch (e) {
        return readByRules(c, `model call failed: ${e?.constructor?.name || "error"}${typeof e?.status === "number" ? ` ${e.status}` : ""}`);
      }
    };
  }
  return async (c) => (c.modelReply ? readFromReply(c, asMessage(c.modelReply)) : readByRules(c, "no recorded reply"));
}

const isRequest = (intent) => intent === "request" || intent === "mixed";
const kindOf = (a) => (a && a.kind) || classifyAsk(a?.quote || "").kind;

/** Scores for one case; null when it is not labelled. */
export function scoreCase(c, reading) {
  const exp = c.expected;
  if (!exp || c.labelled === false) return null;
  const want = (exp.asks || []).map((a) => a.kind);
  const got = (reading.asks || []).map(kindOf);
  const left = [...want];
  let hit = 0;
  for (const k of got) {
    const i = left.indexOf(k);
    if (i >= 0) { hit++; left.splice(i, 1); }
  }
  const roles = Array.isArray(exp.roles) && reading.method === "model"
    ? exp.roles.map((r, i) => (reading.attachments || []).find((a) => a.index === i)?.role === r)
    : [];
  // Facts, field by field: an expected field read with the expected value is
  // a hit; any field read on a case that expects no records is invented.
  const wantRecords = Array.isArray(exp.records) ? exp.records : [];
  const gotRecords = Array.isArray(reading.records) ? reading.records : [];
  let factsWanted = 0, factsHit = 0;
  for (const w of wantRecords) {
    const fields = Object.entries(w.fields || {});
    factsWanted += fields.length;
    const best = Math.max(0, ...gotRecords.filter((g) => g.section === w.section)
      .map((g) => fields.filter(([k, v]) => String(g.fields?.[k] ?? "") === String(v)).length));
    factsHit += best;
  }
  const factsGot = gotRecords.reduce((n, g) => n + Object.keys(g.fields || {}).length, 0);
  return {
    intent: reading.intent === exp.intent,
    request: isRequest(reading.intent) === isRequest(exp.intent),
    asksWanted: want.length,
    asksGot: got.length,
    asksHit: hit,
    invented: want.length === 0 ? got.length : 0,
    rolesRight: roles.filter(Boolean).length,
    rolesTotal: roles.length,
    factsWanted,
    factsHit,
    factsGot,
    factsInvented: wantRecords.length === 0 ? factsGot : 0,
  };
}

/** Read and score every case; returns { rows, totals }. */
export async function runEval(cases, read) {
  const rows = [];
  for (const c of cases) {
    const reading = await read(c);
    rows.push({ id: c.id, reading, score: scoreCase(c, reading) });
  }
  const scored = rows.filter((r) => r.score);
  const sum = (k) => scored.reduce((n, r) => n + (typeof r.score[k] === "boolean" ? Number(r.score[k]) : r.score[k]), 0);
  const totals = {
    cases: rows.length,
    scored: scored.length,
    intent: sum("intent"),
    request: sum("request"),
    asksWanted: sum("asksWanted"),
    asksGot: sum("asksGot"),
    asksHit: sum("asksHit"),
    invented: sum("invented"),
    rolesRight: sum("rolesRight"),
    rolesTotal: sum("rolesTotal"),
    factsWanted: sum("factsWanted"),
    factsHit: sum("factsHit"),
    factsGot: sum("factsGot"),
    factsInvented: sum("factsInvented"),
    byModel: rows.filter((r) => r.reading.method === "model").length,
  };
  return { rows, totals };
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");

/** The report, as plain lines. */
export function formatReport({ rows, totals }, mode) {
  const out = [`intake-eval, mode ${mode}: ${totals.cases} case${totals.cases === 1 ? "" : "s"}, ${totals.scored} labelled, ${totals.byModel} read by the model`];
  for (const r of rows) {
    const s = r.score;
    const how = r.reading.method === "model" ? `model ${r.reading.confidence}` : `rules${r.reading.why ? ` (${r.reading.why})` : ""}`;
    const asks = (r.reading.asks || []).map(kindOf).join(", ") || "none";
    const facts = !s || (!s.factsWanted && !s.factsGot) ? "" : s.factsInvented ? `${s.factsInvented} FACTS INVENTED` : `facts ${s.factsHit}/${s.factsWanted} (read ${s.factsGot})`;
    const verdict = !s ? "unlabelled" : [s.intent ? "intent ok" : "INTENT WRONG", s.asksHit === s.asksWanted && s.asksGot === s.asksWanted ? "asks ok" : `asks ${s.asksHit}/${s.asksWanted} (read ${s.asksGot})`, s.invented ? `${s.invented} INVENTED` : "", facts].filter(Boolean).join(", ");
    out.push(`  ${r.id}: ${r.reading.intent} by ${how}; asks: ${asks}; ${verdict}`);
  }
  out.push(
    `intent: ${totals.intent}/${totals.scored} (${pct(totals.intent, totals.scored)})`,
    `request or not: ${totals.request}/${totals.scored} (${pct(totals.request, totals.scored)})`,
    `asks: precision ${pct(totals.asksHit, totals.asksGot)}, recall ${pct(totals.asksHit, totals.asksWanted)} (${totals.asksHit} right of ${totals.asksGot} read, ${totals.asksWanted} expected)`,
    `asks invented on emails that asked for nothing: ${totals.invented}`,
    `attachment roles: ${totals.rolesTotal ? `${totals.rolesRight}/${totals.rolesTotal} (${pct(totals.rolesRight, totals.rolesTotal)})` : "n/a"}`,
    `facts to enter: ${totals.factsWanted ? `${totals.factsHit}/${totals.factsWanted} expected fields read right (${pct(totals.factsHit, totals.factsWanted)}), ${totals.factsGot} read` : "n/a"}`,
    `facts read from emails that state none to enter: ${totals.factsInvented}`,
  );
  return out.join("\n");
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const mode = flag("--mode") || "stub";
  const asJson = args.includes("--json");
  const dir = resolve(args.filter((a) => !a.startsWith("--"))[0] || DEFAULT_CORPUS);
  if (!["stub", "rules", "model"].includes(mode)) { console.error(`Unknown mode ${mode}: use stub, rules or model.`); return 2; }
  if (!corpusAllowed(dir)) {
    console.error(`Refusing ${dir}: a real corpus must live outside this repository (it is public). Default: ${DEFAULT_CORPUS}`);
    return 2;
  }
  if (!existsSync(dir)) {
    console.error(`No corpus at ${dir}. Seed one with: node scripts/intake-eval-seed.mjs (or pass ${SYNTHETIC_DIR} for the synthetic cases).`);
    return 2;
  }
  let client = null;
  if (mode === "model") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ maxRetries: 1, timeout: 60_000 });
  }
  const cases = loadCases(dir);
  const result = await runEval(cases, readerFor(mode, client));
  console.log(asJson ? JSON.stringify(result, null, 2) : formatReport(result, mode));
  return 0;
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main(process.argv).then((code) => process.exit(code), (e) => { console.error(e?.message || e); process.exit(1); });

export { main };
