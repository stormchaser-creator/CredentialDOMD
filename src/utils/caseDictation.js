/**
 * Voice → a surgical case-log draft. The surgeon says what they did
 * ("right craniotomy for SDH evacuation today at Eisenhower, primary
 * surgeon") and the AI returns fields for ONE case, which the app opens
 * PREFILLED for review — dictation never saves a case directly.
 */

import { CONSTRUCT_RULES } from "../constants/cptConstructs";

const GEMINI_MODEL = "gemini-2.5-flash";

const PROMPT = (transcript, todayISO, categories) => `You convert a NEUROSURGEON's spoken
description of an operative case into ONE JSON object for their surgical case log.
Respond with JSON only, no fences.

TODAY is ${todayISO} (local). "yesterday", "last night", "Tuesday" resolve against it.
If no date is spoken, use today.

CATEGORIES (pick the closest): ${categories.join(", ")}


${CONSTRUCT_RULES}

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
Patient identifiers NEVER go in any field.

SPOKEN: ${transcript}`;

export async function parseCaseDictation(transcript, apiKey, categories) {
  if (!apiKey) throw new Error("Add your AI key in Settings first — dictation parsing runs on it.");
  const todayISO = new Date().toISOString().slice(0, 10);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: PROMPT(transcript, todayISO, categories) }] }],
      generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!response.ok) throw new Error(`Couldn't reach the AI (error ${response.status}) — the words were kept, try again.`);
  const json = await response.json();
  let raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
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
