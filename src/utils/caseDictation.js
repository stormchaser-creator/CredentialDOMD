/**
 * Voice → a surgical case-log draft. The surgeon says what they did
 * ("right craniotomy for SDH evacuation today at Eisenhower, primary
 * surgeon") and the AI returns fields for ONE case, which the app opens
 * PREFILLED for review — dictation never saves a case directly.
 */

import { CONSTRUCT_RULES } from "../constants/cptConstructs.js";
import { geminiCall, proxyErrorMessage, anthropicAvailable, anthropicClientFor } from "./aiClient.js";

const GEMINI_MODEL = "gemini-2.5-flash";
const OPUS_MODEL = "claude-opus-5";
const OPUS_JSON_ONLY = "Reply with the JSON object only: no prose before or after it, no markdown fences, no internal or system XML tags. The first character of your reply is { and the last is }.";

// The prompt in three pieces so the Gemini path can stay byte-for-byte what
// shipped while the Opus path caches the big fixed part. scripts/
// case-dictation.test.mjs pins the Gemini prompt's hash.
const HEADER = `You convert a NEUROSURGEON's spoken
description of an operative case into ONE JSON object for their surgical case log.
Respond with JSON only, no fences.`;

const perCase = (todayISO, categories) => `TODAY is ${todayISO} (local). "yesterday", "last night", "Tuesday" resolve against it.
If no date is spoken, use today.

CATEGORIES (pick the closest): ${categories.join(", ")}`;

const RULES_AND_TEMPLATE = `${CONSTRUCT_RULES}

NO PATIENT IDENTIFIERS. This app deliberately holds NO protected health information, which is
what keeps it outside HIPAA. Never write a patient name, medical record number, date of birth,
address, or phone number into any field you return. If the source material contains them, omit
them silently and describe the case clinically instead ("ED consult, acute subdural"). If the
user asks you to store a patient identifier, decline and tell them the private note on a work
entry stays on their own device and is the right place for it.

CPT: suggest the standard code(s) for the procedure described — primary code first,
clearly implied add-ons only (navigation +61781 only if stealth/navigation is said,
microscope +69990 only if microdissection is said). Codes you are not confident of:
leave out — the surgeon picks from the code search on the form. NEVER invent codes
for things merely mentioned. No E/M codes on operative cases. Routine postop care of
their own patient is bundled (90-day global) — if they describe a postop visit rather
than an operation, say so in "notes" and give no code.

{"date": "YYYY-MM-DD",
 "category": "...",
 "title": "procedure in the surgeon's own words, cleaned",
 "facility": "hospital if spoken, else null",
 "role": "Primary Surgeon" | "Co-Surgeon" | "Teaching/Supervising" | "First Assist" | "Observer",
 "attending": "name if they say who they operated with, else null",
 "cptCodes": "comma-separated codes or empty string",
 "complication": "if one is described, else null",
 "notes": "clinical context worth keeping — indication, findings, plan; NO patient names or MRNs"}

Role defaults to "Primary Surgeon" for an attending describing their own case.
Patient identifiers NEVER go in any field.`;

/** The Gemini prompt, unchanged from the day it shipped. */
export const geminiPrompt = (transcript, todayISO, categories) => `${HEADER}

${perCase(todayISO, categories)}


${RULES_AND_TEMPLATE}

SPOKEN: ${transcript}`;

/**
 * Opus: the header, the construct rules and the fixed template are one
 * system block cached across dictations (about 4,800 tokens); the user
 * message carries only what changes per case.
 */
export const OPUS_SYSTEM = `${HEADER}

${RULES_AND_TEMPLATE}`;

export const opusUserMessage = (transcript, todayISO, categories) => `${perCase(todayISO, categories)}

SPOKEN: ${transcript}`;

// settings = { apiKey, anthropicApiKey, coderModel } (the older string form
// means "Gemini, this key"). Routing policy: a case-log draft reasons over the
// construct rules and assigns CPT, so it rides the same model as the RVU coder
// ("Code RVUs with" in Settings: Opus unless the physician picks Gemini). Any
// Opus failure falls through to Gemini so the words are never lost.
export async function parseCaseDictation(transcript, apiKeyOrSettings, categories) {
  const settings = apiKeyOrSettings && typeof apiKeyOrSettings === "object"
    ? apiKeyOrSettings
    : { apiKey: apiKeyOrSettings || "" };
  const todayISO = new Date().toISOString().slice(0, 10);

  let raw = null;
  if ((settings.coderModel || "opus") === "opus" && anthropicAvailable(settings)) {
    try { raw = await withOpus(transcript, todayISO, categories, settings); } catch { raw = null; }
  }
  if (raw == null) raw = await withGemini(geminiPrompt(transcript, todayISO, categories), settings.apiKey);

  raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return {
    date: parsed.date || todayISO,
    category: parsed.category || "",
    title: parsed.title || transcript.slice(0, 200),
    facility: parsed.facility || "",
    role: parsed.role || "Primary Surgeon",
    attending: parsed.attending || "",
    cptCodes: parsed.cptCodes || "",
    complication: parsed.complication || "",
    notes: parsed.notes || "",
  };
}

// The Gemini request, unchanged from the day it shipped.
async function withGemini(prompt, apiKey) {
  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);
  if (!response.ok) {
    const why = proxyErrorMessage(response);
    if (why) throw new Error(`${why} The words were kept.`);
    throw new Error(`Couldn't reach the AI (error ${response.status}). The words were kept, try again.`);
  }
  const json = await response.json();
  return json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
}

// Same rules on Claude Opus (own key or the shared key via ai-proxy), with
// the fixed part cached so only the date, categories and transcript re-bill.
// Thinking off, as on the RVU coder: Opus 5 rejects `temperature`, and a
// hidden chain is what varies between runs.
async function withOpus(transcript, todayISO, categories, settings) {
  const client = await anthropicClientFor(settings);
  const response = await client.messages.create({
    model: OPUS_MODEL,
    max_tokens: 4096,
    thinking: { type: "disabled" },
    system: [
      { type: "text", text: OPUS_SYSTEM },
      // The breakpoint sits on the last fixed block so both cache together.
      { type: "text", text: OPUS_JSON_ONLY, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: opusUserMessage(transcript, todayISO, categories) }],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`Claude stopped: ${response.stop_reason}`);
  return response.content.filter(b => b.type === "text").map(b => b.text).join("");
}
