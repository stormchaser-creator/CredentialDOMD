// CPT Code AI-Assisted Lookup via Claude API
// Follows the same pattern as documentScanner.js

export async function aiCPTLookup(query, nearbyMatches, apiKey) {
  if (!apiKey) {
    throw new Error("No API key configured. Add your Anthropic API key in Settings.");
  }

  const nearbyContext = nearbyMatches.length > 0
    ? `\n\nLocal search found these possible matches (may or may not be relevant):\n${nearbyMatches.map(m => `- ${m.code}: ${m.fullDesc || m.shortDesc || ""}`).join("\n")}`
    : "";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1000,
      system: `You are a CPT code lookup assistant for physicians. Given a procedure description, return the most relevant CPT codes. Return ONLY valid JSON (no markdown, no backticks, no explanation outside the JSON).

Return format: { "codes": [{ "code": "61312", "description": "Brief description of what this code covers", "confidence": "high"|"medium"|"low", "reasoning": "Why this code matches the query" }], "notes": "Optional billing notes or disambiguation guidance" }

Rules:
- Return 1-5 most relevant CPT codes
- Order by relevance (most relevant first)
- Include confidence level for each
- If the description is ambiguous, include alternatives with explanations
- Only suggest real, valid CPT codes
- Be precise about supratentorial vs infratentorial, simple vs complex distinctions
- Consider approach (anterior, posterior, lateral) when specified`,
      messages: [{
        role: "user",
        content: `Find CPT codes for this procedure: "${query}"${nearbyContext}`,
      }],
    }),
  });

  if (!response.ok) {
    const status = response.status;
    if (status === 401) throw new Error("Invalid API key. Check your key in Settings.");
    if (status === 429) throw new Error("Rate limited. Please wait a moment and try again.");
    if (status === 400) throw new Error("Request could not be processed. Try rephrasing your query.");
    if (status >= 500) throw new Error("AI service temporarily unavailable. Try again later.");
    throw new Error("CPT lookup failed. Please try again.");
  }

  const json = await response.json();
  const text = json.content?.map(b => b.text || "").join("") || "";

  // Clean any markdown wrapping
  const clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("AI returned an unexpected format. Please try again.");
  }
}
