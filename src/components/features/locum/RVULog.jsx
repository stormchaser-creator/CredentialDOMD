import { useState, useMemo, useRef, useCallback, useEffect, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import EmptyState from "../../shared/EmptyState";
import { TrashIcon } from "../../shared/Icons";
import { generateId, formatDate } from "../../../utils/helpers";
import { codeFromText } from "../../../utils/cptCoder";
import { searchCPT } from "../../../utils/cptSearch";

const localDate = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const rvuOf = (enc) => (enc.codes || []).reduce((s, c) => s + (c.wRVU || 0) * (c.units || 1), 0);

/**
 * RVU log — describe (or dictate) the day's work in plain language, the
 * AI maps it to CPT codes from the app's CMS-grounded catalog, the
 * physician reviews the chips, saves, and running wRVU totals accumulate.
 */
function RVULog() {
  const { data, addItem, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const contracts = data.locumContracts || [];
  const encounters = data.encounters || [];

  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [coding, setCoding] = useState(false);
  const [err, setErr] = useState(null);
  const [review, setReview] = useState(null); // { items, questions, confidence }
  const [date, setDate] = useState(localDate(new Date()));
  const [contractId, setContractId] = useState(contracts[0]?.id || "");
  const [manualQ, setManualQ] = useState("");
  const [manualResults, setManualResults] = useState([]);
  const recRef = useRef(null);

  // Never leave the microphone hot after leaving the tab
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* already stopped */ } }, []);

  // ── Dictation (Web Speech API; the keyboard mic works in the box too) ──
  const toggleMic = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setErr("This browser doesn't expose the microphone to apps — use the mic key on your keyboard instead.");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (ev) => {
      let chunk = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) chunk += ev.results[i][0].transcript;
      }
      if (chunk) setText(t => (t ? t + " " : "") + chunk.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = (ev) => {
      setListening(false);
      if (ev.error === "not-allowed") setErr("Microphone permission denied — allow it in Settings, or use the keyboard mic.");
    };
    recRef.current = rec;
    setErr(null);
    rec.start();
    setListening(true);
  }, [listening]);

  const runCoder = useCallback(async () => {
    setErr(null);
    setCoding(true);
    try {
      const result = await codeFromText(text, data.settings.apiKey);
      setReview(result);
    } catch (e2) {
      setErr(e2.message);
    }
    setCoding(false);
  }, [text, data.settings.apiKey]);

  const setUnits = (idx, delta) => setReview(r => ({
    ...r,
    items: r.items.map((it, i) => i === idx ? { ...it, units: Math.max(1, (it.units || 1) + delta) } : it),
  }));
  const removeItem = (idx) => setReview(r => ({ ...r, items: r.items.filter((_, i) => i !== idx) }));

  const manualSearch = useCallback(async (q) => {
    setManualQ(q);
    if (!q.trim()) { setManualResults([]); return; }
    const res = await searchCPT(q, { limit: 6 });
    setManualResults(res.results || res || []);
  }, []);
  const addManual = (c) => {
    setReview(r => ({
      items: [...(r?.items || []), { code: c.code, desc: c.shortDesc || c.cmsDesc || "", units: 1, wRVU: c.wRVU || 0, why: "added manually" }],
      questions: r?.questions || [], confidence: r?.confidence || "high",
    }));
    setManualQ(""); setManualResults([]);
  };

  const save = useCallback(() => {
    if (!review?.items?.length) return;
    addItem("encounters", {
      id: generateId(),
      createdAt: new Date().toISOString(),
      contractId: contractId || null,
      date,
      codes: review.items.map(({ code, desc, units, wRVU }) => ({ code, desc, units, wRVU })),
      note: "",
      spokenText: text,
    });
    setText(""); setReview(null);
  }, [review, contractId, date, text, addItem]);

  // ── Totals ──
  const totals = useMemo(() => {
    const today = localDate(new Date());
    const month = today.slice(0, 7);
    let t = 0, m = 0, all = 0;
    for (const e of encounters) {
      const r = rvuOf(e);
      all += r;
      if (e.date === today) t += r;
      if ((e.date || "").startsWith(month)) m += r;
    }
    return { today: t, month: m, all };
  }, [encounters]);

  const byDay = useMemo(() => {
    const map = {};
    for (const e of encounters) (map[e.date] = map[e.date] || []).push(e);
    return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30);
  }, [encounters]);

  const reviewTotal = (review?.items || []).reduce((s, it) => s + (it.wRVU || 0) * (it.units || 1), 0);
  const facilityOf = (cid) => contracts.find(x => x.id === cid)?.facility;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: T.text }}>RVU Log</h3>
        <div style={{ fontSize: 12, color: T.textMuted }}>Say what you did — the AI codes it, you approve it.</div>
      </div>

      {/* Totals */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[["Today", totals.today], ["This month", totals.month], ["All time", totals.all]].map(([lbl, v]) => (
          <div key={lbl} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{lbl}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>{v.toFixed(2)}</div>
            <div style={{ fontSize: 10, color: T.textDim }}>wRVU</div>
          </div>
        ))}
      </div>

      {/* Capture */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 14, marginBottom: 14, boxShadow: T.shadow1 }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'e.g. "New ED consult for acute subdural, high complexity, did a twist drill at the bedside. Two progress notes on the floor. Level 2 critical care 45 minutes on the ICU patient."'}
          style={{ ...iS, minHeight: 96, resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={toggleMic} style={{
            padding: "12px 16px", borderRadius: 12, border: listening ? "none" : `1px solid ${T.border}`,
            backgroundColor: listening ? "#ef4444" : "transparent", color: listening ? "#fff" : T.text,
            fontSize: 14, fontWeight: 700, cursor: "pointer",
          }}>{listening ? "◼ Stop" : "🎤 Dictate"}</button>
          <button onClick={runCoder} disabled={coding || !text.trim()} style={{
            flex: 1, padding: "12px", borderRadius: 12, border: "none",
            background: coding || !text.trim() ? T.border : "linear-gradient(135deg, #10b981, #059669)",
            color: "#fff", fontSize: 15, fontWeight: 800, cursor: coding ? "wait" : "pointer",
          }}>{coding ? "Coding…" : "Code it"}</button>
        </div>
        {err && <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: T.danger }}>{err}</div>}

        {/* Type a code directly — works with or without the AI coder */}
        <input value={manualQ} onChange={e => manualSearch(e.target.value)} inputMode="search"
          placeholder="Type a CPT code (e.g. 61312) or name to add it" style={{ ...iS, marginTop: 10 }} />
        {manualResults.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
            {manualResults.map(c => (
              <button key={c.code} onClick={() => addManual(c)} style={{ textAlign: "left", padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, fontSize: 13, cursor: "pointer" }}>
                <b>{c.code}</b> {c.shortDesc || c.cmsDesc} {c.wRVU ? `· ${c.wRVU} wRVU` : ""}
              </button>
            ))}
          </div>
        )}

        {/* Review chips */}
        {review && (
          <div style={{ marginTop: 12 }}>
            {review.questions?.length > 0 && (
              <div style={{ fontSize: 12, color: T.warning, fontWeight: 600, marginBottom: 8 }}>
                {review.questions.map((q, i) => <div key={i}>? {q}</div>)}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {review.items.map((it, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: T.text }}>
                      {it.code} <span style={{ fontWeight: 500, color: T.textMuted }}>{it.desc}</span>
                    </div>
                    <div style={{ fontSize: 11, color: T.textDim }}>{(it.wRVU || 0).toFixed(2)} wRVU × {it.units} {it.why && `· ${it.why}`}</div>
                  </div>
                  <button onClick={() => setUnits(i, -1)} style={{ padding: "4px 9px", borderRadius: 7, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 800, color: T.text, minWidth: 14, textAlign: "center" }}>{it.units}</span>
                  <button onClick={() => setUnits(i, 1)} style={{ padding: "4px 9px", borderRadius: 7, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>+</button>
                  <button onClick={() => removeItem(i)} style={{ padding: "4px 8px", borderRadius: 7, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontWeight: 800 }}>×</button>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...iS, minWidth: 0, flex: 1 }} />
              {contracts.length > 1 && (
                <select value={contractId} onChange={e => setContractId(e.target.value)} style={{ ...iS, appearance: "auto", minWidth: 0, flex: 1 }}>
                  {contracts.map(c => <option key={c.id} value={c.id}>{c.facility}</option>)}
                </select>
              )}
            </div>
            <button onClick={save} style={{
              width: "100%", marginTop: 10, padding: "14px", borderRadius: 12, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer",
            }}>Save — {reviewTotal.toFixed(2)} wRVU</button>
          </div>
        )}
      </div>

      {/* History */}
      {byDay.length === 0 ? (
        <EmptyState icon={"🧮"} title="No encounters logged"
          subtitle="Dictate or type what you did and the AI turns it into CPT codes with work RVUs." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {byDay.map(([day, list]) => (
            <div key={day}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>{formatDate(day)}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{list.reduce((s, e) => s + rvuOf(e), 0).toFixed(2)} wRVU</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {list.map(e => (
                  <div key={e.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 12px", boxShadow: T.shadow1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {(e.codes || []).map((c, i) => (
                          <div key={i} style={{ fontSize: 13, color: T.text }}>
                            <b>{c.code}</b>{c.units > 1 ? ` ×${c.units}` : ""} <span style={{ color: T.textMuted }}>{c.desc}</span>
                            <span style={{ color: T.textDim }}> · {((c.wRVU || 0) * (c.units || 1)).toFixed(2)}</span>
                          </div>
                        ))}
                        {facilityOf(e.contractId) && <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{facilityOf(e.contractId)}</div>}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 800, color: T.accent }}>{rvuOf(e).toFixed(2)}</span>
                        <button onClick={() => { if (window.confirm("Delete this encounter?")) deleteItem("encounters", e.id); }} style={{ padding: "4px 6px", borderRadius: 7, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>
        wRVU values from the CMS Physician Fee Schedule (CY2026 July release). AI-suggested codes
        are a documentation aid — you approve every code before it saves. Not billing advice.
      </div>
    </div>
  );
}

export default memo(RVULog);
