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

TYPES (pick the closest; if none fits, use a short label of your own): ${workTypes.join(", ")}

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

Never invent times or dates they didn't say. Patient identifiers ALWAYS go in privateNote,
never billingNote.

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
