import { useState, useRef, useEffect, memo } from "react";

/**
 * One-tap dictation — appends finalized speech to any text field via
 * onText(chunk). Same engine as the RVU voice capture. Red square while
 * listening; tap again to stop. Cleans up on unmount so the mic never
 * stays hot after navigating away.
 */
function DictateButton({ onText, T }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* stopped */ } }, []);

  const toggle = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      onText("");
      alert("Dictation isn't available in this browser — use the mic key on your keyboard instead.");
      return;
    }
    if (listening) { recRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (ev) => {
      let chunk = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) chunk += ev.results[i][0].transcript;
      }
      if (chunk.trim()) onText(chunk.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  return (
    <button onClick={toggle} title="Dictate" style={{
      padding: "10px 12px", borderRadius: 10, flexShrink: 0, alignSelf: "flex-start",
      border: listening ? "none" : `1px solid ${T.border}`,
      backgroundColor: listening ? "#ef4444" : "transparent",
      color: listening ? "#fff" : T.text, fontSize: 15, cursor: "pointer",
    }}>{listening ? "◼" : "🎤"}</button>
  );
}

export default memo(DictateButton);
