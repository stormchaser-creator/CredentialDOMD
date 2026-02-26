// CPT Code AI-Assisted Lookup via Gemini API

const GEMINI_MODEL = "gemini-2.0-flash";

const SYSTEM_PROMPT = `You are a CPT code lookup assistant for physicians. Given a procedure description, return the most relevant CPT codes. Return ONLY valid JSON (no markdown, no backticks, no explanation outside the JSON).

Return format: { "codes": [{ "code": "61312", "description": "Brief description of what this code covers", "confidence": "high"|"medium"|"low", "reasoning": "Why this code matches the query" }], "notes": "Optional billing notes or disambiguation guidance" }

Rules:
- Return 1-5 most relevant CPT codes
- Order by relevance (most relevant first)
- Include confidence level for each
- If the description is ambiguous, include alternatives with explanations
- Only suggest real, valid CPT codes
- Be precise about supratentorial vs infratentorial, simple vs complex distinctions
- Consider approach (anterior, posterior, lateral) when specified`;

export async function aiCPTLookup(query, nearbyMatches, apiKey) {
  if (!apiKey) {
    throw new Error("No API key configured. Add your Gemini API key in Settings.");
  }

  const nearbyContext = nearbyMatches.length > 0
    ? `\n\nLocal search found these possible matches (may or may not be relevant):\n${nearbyMatches.map(m => `- ${m.code}: ${m.fullDesc || m.shortDesc || ""}`).join("\n")}`
    : "";

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        parts: [{ text: `Find CPT codes for this procedure: "${query}"${nearbyContext}` }],
      }],
      generationConfig: { maxOutputTokens: 1000 },
    }),
  });

  if (!response.ok) {
    const status = response.status;
    if (status === 403) throw new Error("Invalid API key. Check your key in Settings.");
    if (status === 429) throw new Error("Rate limited. Please wait a moment and try again.");
    if (status === 400) throw new Error("Request could not be processed. Try rephrasing your query.");
    if (status >= 500) throw new Error("AI service temporarily unavailable. Try again later.");
    throw new Error("CPT lookup failed. Please try again.");
  }

  const json = await response.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // Clean any markdown wrapping
  const clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("AI returned an unexpected format. Please try again.");
  }
}
