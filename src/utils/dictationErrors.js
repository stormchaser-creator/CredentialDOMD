// What a failed dictation says, from the Web Speech API's error code
// (SpeechRecognitionErrorEvent.error). Every mic button in the app reads it
// the same way: a denied microphone, or the iOS home-screen app's
// "service-not-allowed", used to turn the button back with no message and
// no transcript. "aborted" is the user stopping dictation and says nothing;
// a code not listed here says nothing either.

const MESSAGES = {
  "not-allowed": "Microphone access is off for this app. Allow it in Settings, or use the mic key on your keyboard.",
  "service-not-allowed": "Dictation isn't available here. Use the mic key on your keyboard.",
  "audio-capture": "No microphone found. Use the mic key on your keyboard.",
  "network": "Dictation needs a connection. Try again, or use the mic key on your keyboard.",
  "no-speech": "Didn't hear anything. Tap the mic and try again.",
};

/** The line to show for a speech error code, or "" when there is nothing to say. */
export function dictationErrorText(code) {
  return (typeof code === "string" && Object.hasOwn(MESSAGES, code)) ? MESSAGES[code] : "";
}

/** Said when the browser refuses to start listening at all. */
export const DICTATION_START_FAILED = "Dictation could not start. Tap the mic again, or use the mic key on your keyboard.";
