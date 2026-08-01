import { useState, useRef, useEffect, memo } from "react";
import { useApp } from "../../context/AppContext";
import { parseCaseDictation } from "../../utils/caseDictation";

/**
 * One mic for the case log: dictate the whole case ("right crani for SDH
 * evacuation at Eisenhower today, no complications"), the AI builds the
 * entry, and the add form opens prefilled for review. Nothing saves until
 * the surgeon taps Save.
 */
function CaseDictate({ categories, onDraft }) {
  const { data, theme: T } = useApp();
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const recRef = useRef(null);
  const textRef = useRef("");

  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* stopped */ } }, []);

  const begin = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setErr("Dictation isn't available in this browser — use the mic key on your keyboard in the form instead."); return; }
    setErr(null); textRef.current = ""; setTranscript("");
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";
    rec.onresult = (ev) => {
      let finals = "", interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) finals += ev.results[i][0].transcript;
        else interim += ev.results[i][0].transcript;
      }
      textRef.current = finals;
      setTranscript((finals + " " + interim).trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  const finish = async () => {
    try { recRef.current?.stop(); } catch { /* stopped */ }
    setListening(false);
    const words = (textRef.current || transcript || "").trim();
    if (!words) { setErr("Didn't catch anything — try again."); return; }
    setBusy(true); setErr(null);
    try {
      const draft = await parseCaseDictation(words, data.settings.apiKey, categories);
      setTranscript("");
      onDraft(draft);
    } catch (e2) {
      // The words survive a parse failure — they become the title as-is
      setErr(e2.message);
      onDraft({ title: words, date: new Date().toISOString().slice(0, 10), role: "Primary Surgeon" });
      setTranscript("");
    }
    setBusy(false);
  };

  return (
    <div style={{ marginBottom: 10 }}>
      {!listening && !busy && (
        <button onClick={begin} style={{
          width: "100%", padding: "12px", borderRadius: 12,
          border: `1px dashed ${T.accent}`, backgroundColor: "transparent",
          color: T.accent, fontSize: 14, fontWeight: 700, cursor: "pointer",
        }}>🎤 Dictate a case</button>
      )}
      {listening && (
        <div style={{ backgroundColor: T.card, border: `1px solid #ef4444`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#ef4444", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Listening…</div>
          <div style={{ fontSize: 14, color: T.text, minHeight: 20, lineHeight: 1.5 }}>{transcript || "Say the case — procedure, side, date, hospital, who with, any complication."}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={finish} style={{
              flex: 1, padding: "11px", borderRadius: 10, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer",
            }}>Done — build the case</button>
            <button onClick={() => { try { recRef.current?.stop(); } catch { /* stopped */ } setListening(false); setTranscript(""); }} style={{
              padding: "11px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>Cancel</button>
          </div>
        </div>
      )}
      {busy && (
        <div style={{ padding: "12px", borderRadius: 12, backgroundColor: T.card, border: `1px solid ${T.border}`, fontSize: 13, fontWeight: 700, color: T.textMuted, textAlign: "center" }}>
          Building the case…
        </div>
      )}
      {err && <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 600, color: T.danger }}>{err}</div>}
    </div>
  );
}

export default memo(CaseDictate);
