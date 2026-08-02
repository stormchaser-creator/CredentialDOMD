/**
 * Voice → structured work entry. The physician says what happened
 * ("took a transfer call at eight oh eight last night about a head bleed,
 * ten minutes") and the AI returns the fields for ONE log entry, which the
 * app shows PREFILLED for review — dictation never saves billing data
 * directly.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

const PROMPT = (transcript, todayISO, workTypes) => `You convert a physician's spoken description of
locum work into ONE JSON object for a time-log entry. Respond with JSON only, no fences.

TYPES: ${workTypes.join(", ")}
Use a listed type ONLY when the work plainly IS that type. When it is not a clean match, return a
short label in the physician's own words instead — a wrong type on an invoice is worse than a
custom one. In particular:
- "charting", "documentation", "notes", "note writing", "chart review", "Epic work" → return
  "Charting" (or their exact word). These are NOT "Sign-out": sign-out means handing patients
  off to another physician.
- "preop"/"postop" mean the visit, not the operation; the operation is a Procedure.
- A phone call about a patient is "Call"; a call accepting a transfer is "Transfer call".

TODAY is ${todayISO} (local). Interpret casual speech:
- "last night" / "yesterday evening" = yesterday's date; "this morning" = today.
- Times may be casual: "eight oh eight pm" = 20:08. If only a start and a length are
  given, return start + durationMin. If nothing about length, leave duration null.
- Consult convention: a consult bills 60 minutes flat unless they state otherwise.
- Calls and transfer calls are usually a few minutes; exact times matter more than length.

{"type": "...", "date": "YYYY-MM-DD", "start": "HH:MM 24h or null", "end": "HH:MM 24h or null",
 "durationMin": number or null,
 "billingNote": "clean clinical description for the INVOICE — no patient names or MRNs",
 "privateNote": "patient names/MRNs or anything they say is for their own records, else null"}

PATIENT IDENTIFIERS GO IN EXACTLY ONE PLACE. Everything except privateNote is uploaded and
must stay free of protected health information — that is what keeps this app outside HIPAA.
privateNote is the sole exception: it is stored only on the physician's own device and is never
uploaded, so a name or MRN he says aloud belongs there and nowhere else.
- billingNote, and every other field: clinical description only, never a name, MRN, date of
  birth, address or phone number. "ED consult, acute subdural" — not who the patient was.
- privateNote: the identifiers he actually said, so he can recognise the case later. Leave it
  null if he named no one.

Never invent times or dates they didn't say.

SPOKEN: ${transcript}`;

export async function parseWorkDictation(transcript, apiKey, workTypes) {
  if (!apiKey) throw new Error("Add your AI key in Settings first — dictation parsing runs on it.");
  const todayISO = new Date().toISOString().slice(0, 10);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: PROMPT(transcript, todayISO, workTypes) }] }],
      generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!response.ok) throw new Error(`Couldn't reach the AI (error ${response.status}) — the words were kept, check your connection and try again.`);
  const json = await response.json();
  let raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return {
    type: parsed.type || "Call",
    date: parsed.date || todayISO,
    start: parsed.start || "",
    end: parsed.end || "",
    durationMin: parsed.durationMin != null ? String(parsed.durationMin) : "",
    billingNote: parsed.billingNote || "",
    privateNote: parsed.privateNote || "",
  };
}
