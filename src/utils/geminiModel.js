// One model and request policy for document readers, dictation and Vera.
// Gemini 3.8 supports LOW/MEDIUM/HIGH thinking, but not MINIMAL or off.
// Omit deprecated sampling parameters; let the model use its defaults.
// https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
// https://ai.google.dev/api/generate-content#thinkingconfig
export const GEMINI_MODEL = "gemini-3.8-flash";

export function geminiJsonConfig(maxOutputTokens = 8192) {
  return {
    maxOutputTokens,
    responseMimeType: "application/json",
    thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false },
  };
}

// Thinking consumes the output allowance too. Never accept a partial record
// merely because its text happens to parse as JSON at the cutoff.
export function geminiResponseText(response) {
  const candidate = response?.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error("The AI reply was cut off. Try a smaller document or a shorter request.");
  }
  return (candidate?.content?.parts || [])
    .filter(part => part.thought !== true && typeof part.text === "string")
    .map(part => part.text)
    .join("");
}
