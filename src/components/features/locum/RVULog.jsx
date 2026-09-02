import { useState, useMemo, useRef, useCallback, useEffect, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import EmptyState from "../../shared/EmptyState";
import { TrashIcon } from "../../shared/Icons";
import { generateId, formatDate } from "../../../utils/helpers";
import { contractsForDate, contractIdForDate, termLabel, coversDate, selectableContracts } from "../../../utils/contractsForDate";
import { codeFromText, parseDictatedDate } from "../../../utils/cptCoder";
import { searchCPT } from "../../../utils/cptSearch";
import { Modal, Field } from "../../shared";
import { CPT_DESCS } from "../../../constants/cptDescs";
import { CASE_CATEGORY_GROUPS } from "../../../constants/credentialTypes";

const localDate = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const rvuOf = (enc) => (enc.codes || []).reduce((s, c) => s + (c.wRVU || 0) * (c.units || 1), 0);
// Assistant-at-surgery modifiers — appended by the physician, not the AI coder
// (billing decides which applies; the app just needs to carry it on the code).
const ASSIST_MODIFIERS = [
  { value: "", label: "No modifier" },
  { value: "80", label: "80 · Assistant surgeon" },
  { value: "81", label: "81 · Minimum assistant surgeon" },
  { value: "82", label: "82 · Assistant (no qualified resident available)" },
  // NCCI routes the coder's bundling pass names: 59/XU on 69990 when navigation
  // is on the same claim (NCCI Ch VIII Sec C.8); 59/XS on a cranioplasty that
  // repairs a defect larger than the exposure (NCCI Ch VIII Sec C.4, C.5).
  { value: "59", label: "59 · Distinct procedural service" },
  { value: "XS", label: "XS · Separate structure" },
  { value: "XU", label: "XU · Unusual non-overlapping service" },
];

/**
 * RVU log — describe (or dictate) the day's work in plain language, the
 * AI maps it to CPT codes from the app's CMS-grounded catalog, the
 * physician reviews the chips, saves, and running wRVU totals accumulate.
 */
function RVULog() {
  const { data, addItem, editItem, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const contracts = data.locumContracts || [];
  const encounters = data.encounters || [];

  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [coding, setCoding] = useState(false);
  const [err, setErr] = useState(null);
  const [review, setReview] = useState(null); // { items, questions, confidence }
  const [date, setDate] = useState(localDate(new Date()));
  // The contract defaults to WHERE THE SURGEON IS — the contract whose
  // coverage period contains the entry date. contracts[0] as a default
  // silently mis-attributed weeks of RVUs to the wrong facility.
  const coveringContract = useCallback((d) => contractIdForDate(contracts, d), [contracts]);
  // What the surgeon explicitly picked, if anything. The contract actually
  // used is derived below, never stored, so it can't go stale against the date.
  const [pickedId, setPickedId] = useState("");
  // The agreement in force on the entry date wins. A pick only holds while its
  // own term still covers that date: a contract picked once used to stay
  // selected as the date changed, so August work silently landed on an October
  // agreement and the case log froze that wrong facility.
  const contractId = useMemo(() => {
    const cov = coveringContract(date);
    if (pickedId && contracts.some(c => c.id === pickedId && coversDate(c, date))) return pickedId;
    if (cov) return cov;
    return pickedId || contracts[0]?.id || "";
  }, [pickedId, contracts, date, coveringContract]);
  const setContractId = setPickedId;
  // True when the chosen agreement's term does not include the entry date.
  const selectedOutOfTerm = useMemo(() => {
    const c = contracts.find(x => x.id === contractId);
    return !!(c && !coversDate(c, date));
  }, [contracts, contractId, date]);
  const [saveNote, setSaveNote] = useState(null); // what the last save did
  const [viewEnc, setViewEnc] = useState(null);   // encounter opened for detail/edit
  // The category the surgeon picks for an operative case before it lands in
  // the career case log — left blank ("Other") silently mis-tagged real
  // trauma/tumor cases and required a second trip to Case Logs to fix.
  const [caseCategory, setCaseCategory] = useState("");
  const surgicalPreview = useMemo(() => {
    if (!review?.items) return [];
    return review.items.filter(({ code }) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n >= 10000 && n < 70000;
    });
  }, [review]);
  const [encDraft, setEncDraft] = useState(null); // its editable copy
  const [encQ, setEncQ] = useState("");           // code search inside the modal
  const [encResults, setEncResults] = useState([]);
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
      // "for yesterday…" in the dictation sets the entry date
      const spoken = parseDictatedDate(text);
      if (spoken) setDate(spoken);
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
  const setModifier = (idx, modifier) => setReview(r => ({
    ...r,
    items: r.items.map((it, i) => i === idx ? { ...it, modifier } : it),
  }));

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
    const encId = generateId();
    addItem("encounters", {
      id: encId,
      createdAt: new Date().toISOString(),
      contractId: contractId || null,
      date,
      codes: review.items.map(({ code, desc, units, wRVU, modifier }) => ({ code, desc, units, wRVU, modifier: modifier || "" })),
      note: "",
      spokenText: text,
    });
    // Surgery-section CPTs (1xxxx-6xxxx) are cases, not rounding — they land
    // in the career case log automatically, missing role/category, and the
    // home dashboard nags until the surgeon completes them.
    const surgical = review.items.filter(({ code }) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n >= 10000 && n < 70000;
    });
    if (surgical.length) {
      const wRvu = surgical.reduce((s2, c) => s2 + (c.wRVU || 0) * (c.units || 1), 0);
      addItem("caseLogs", {
        id: generateId(),
        date,
        title: surgical[0].desc || `CPT ${surgical[0].code}`,
        category: caseCategory || "Other",
        cptCodes: surgical.map(c => {
          const base = c.modifier ? `${c.code}-${c.modifier}` : c.code;
          return (c.units || 1) > 1 ? `${base} x${c.units}` : base;
        }).join(", "),
        wRvu: Math.round(wRvu * 100) / 100,
        facility: contracts.find(c2 => c2.id === contractId)?.facility || "",
        source: "RVU log",
        customFields: { "From RVU entry": encId },
      });
    }
    setSaveNote(surgical.length
      ? { text: `Saved. ${surgical.length} operative code${surgical.length === 1 ? "" : "s"} also went to your case log.`, encId: null }
      : { text: "Saved to the RVU log. These are evaluation and management codes, so nothing went to the career case log.", encId, date, codes: review.items, cid: contractId });
    setTimeout(() => setSaveNote(n => (n && n.encId === encId ? null : n)), 12000);
    setText(""); setReview(null); setCaseCategory("");
  }, [review, contractId, date, text, addItem, contracts, caseCategory]);

  // Consults and rounding are not operative cases, so they never land in the
  // career case log on their own. When one should (a bedside procedure, a case
  // coded only by its E/M) this puts it there without retyping.
  const addToCaseLog = useCallback((info) => {
    if (!info) return;
    const wRvu = (info.codes || []).reduce((s2, c) => s2 + (c.wRVU || 0) * (c.units || 1), 0);
    addItem("caseLogs", {
      id: generateId(),
      date: info.date,
      title: (info.codes || [])[0]?.desc || "Case from RVU log",
      category: caseCategory || "Other",
      cptCodes: (info.codes || []).map(c => (c.modifier ? `${c.code}-${c.modifier}` : c.code)).join(", "),
      wRvu: Math.round(wRvu * 100) / 100,
      facility: contracts.find(c2 => c2.id === info.cid)?.facility || "",
      source: "RVU log",
      customFields: { "From RVU entry": info.encId },
    });
    setSaveNote({ text: "Added to your case log.", encId: null });
    setCaseCategory("");
    setTimeout(() => setSaveNote(null), 8000);
  }, [addItem, contracts, caseCategory]);

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

  // History filters — the log is only useful as a list if you can slice it:
  // by assignment, by period, by code. Totals recompute for the slice.
  const [fltContract, setFltContract] = useState("all");
  const [fltPeriod, setFltPeriod] = useState("30d");
  const [fltCode, setFltCode] = useState("");
  const filtered = useMemo(() => {
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
    const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = `${lm.getFullYear()}-${pad(lm.getMonth() + 1)}`;
    const inPeriod = (d) => {
      if (!d) return fltPeriod === "all";
      if (fltPeriod === "all") return true;
      if (fltPeriod === "month") return d.startsWith(thisMonth);
      if (fltPeriod === "lastMonth") return d.startsWith(lastMonth);
      if (fltPeriod === "year") return d.startsWith(String(now.getFullYear()));
      return d >= daysAgo(fltPeriod === "7d" ? 7 : fltPeriod === "90d" ? 90 : 30);
    };
    const q = fltCode.trim().toLowerCase();
    return encounters.filter(e =>
      (fltContract === "all" || e.contractId === fltContract)
      && inPeriod(e.date)
      && (!q
        || (e.codes || []).some(c => String(c.code).toLowerCase().includes(q) || String(c.desc || "").toLowerCase().includes(q))
        || String(e.text || "").toLowerCase().includes(q))
    );
  }, [encounters, fltContract, fltPeriod, fltCode]);
  const fltTotal = useMemo(() => filtered.reduce((s, e) => s + rvuOf(e), 0), [filtered]);
  const fltDays = useMemo(() => new Set(filtered.map(e => e.date).filter(Boolean)).size, [filtered]);

  const byDay = useMemo(() => {
    const map = {};
    for (const e of filtered) (map[e.date] = map[e.date] || []).push(e);
    return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 90);
  }, [filtered]);

  const reviewTotal = (review?.items || []).reduce((s, it) => s + (it.wRVU || 0) * (it.units || 1), 0);
  const facilityOf = (cid) => { const c = contracts.find(x => x.id === cid); return c ? (c.shortName || c.facility) : undefined; };

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
                    <div style={{ fontSize: 11, color: T.textDim }}>{(it.wRVU || 0).toFixed(2)} wRVU × {it.units} {it.why && `· ${it.why}`}{it.flag && <span style={{ color: T.warning, fontWeight: 700 }}> · {it.flag}</span>}</div>
                  </div>
                  <select value={it.modifier || ""} onChange={e => setModifier(i, e.target.value)}
                    style={{ ...iS, appearance: "auto", width: "auto", flexShrink: 0, padding: "4px 6px", fontSize: 11.5 }}
                    title="Assistant surgeon modifier">
                    {ASSIST_MODIFIERS.map(m => <option key={m.value} value={m.value}>{m.value ? `Mod ${m.value}` : "No modifier"}</option>)}
                  </select>
                  <button onClick={() => setUnits(i, -1)} style={{ padding: "4px 9px", borderRadius: 7, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 800, color: T.text, minWidth: 14, textAlign: "center" }}>{it.units}</span>
                  <button onClick={() => setUnits(i, 1)} style={{ padding: "4px 9px", borderRadius: 7, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>+</button>
                  <button onClick={() => removeItem(i)} style={{ padding: "4px 8px", borderRadius: 7, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontWeight: 800 }}>×</button>
                </div>
              ))}
            </div>

            {surgicalPreview.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <label style={{ fontSize: 11.5, fontWeight: 700, color: T.textMuted, display: "block", marginBottom: 4 }}>
                  Case log category — {surgicalPreview.length} operative code{surgicalPreview.length === 1 ? "" : "s"} will land here
                </label>
                <select value={caseCategory} onChange={e => setCaseCategory(e.target.value)} style={{ ...iS, appearance: "auto" }}>
                  <option value="">Other (pick one to skip fixing it later)</option>
                  {CASE_CATEGORY_GROUPS.map(g => (
                    <optgroup key={g.header} label={g.header}>
                      {g.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...iS, minWidth: 0, flex: 1 }} />
              {contracts.length > 1 && (
                <select value={contractId} onChange={e => setContractId(e.target.value)} style={{ ...iS, appearance: "auto", minWidth: 0, flex: 1 }}>
                  {(() => {
                    const { covering, rest } = contractsForDate(selectableContracts(contracts, contractId), date);
                    const lbl = (c) => `${c.shortName || c.facility}${termLabel(c) ? ` · ${termLabel(c)}` : ""}`;
                    return (<>
                      {covering.map(c => <option key={c.id} value={c.id}>{lbl(c)}</option>)}
                      {rest.map(c => <option key={c.id} value={c.id}>{lbl(c)} (not scheduled then)</option>)}
                    </>);
                  })()}
                </select>
              )}
            </div>
            {selectedOutOfTerm && (
              <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, backgroundColor: T.dangerDim, color: T.danger, fontSize: 12, fontWeight: 600 }}>
                Heads up: {facilityOf(contractId) || "this agreement"}'s term does not include {formatDate(date)}. Pick the agreement you actually worked under so the case lands at the right facility.
              </div>
            )}
            <button onClick={save} style={{
              width: "100%", marginTop: 10, padding: "14px", borderRadius: 12, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer",
            }}>Save — {reviewTotal.toFixed(2)} wRVU</button>
          </div>
        )}
        {saveNote && (
          <div style={{ marginTop: 10, padding: "11px 13px", borderRadius: 12, backgroundColor: T.accentDim, border: `1px solid ${T.accent}` }}>
            <div style={{ fontSize: 13, color: T.text, lineHeight: 1.45 }}>{saveNote.text}</div>
            {saveNote.encId && (
              <select value={caseCategory} onChange={e => setCaseCategory(e.target.value)}
                style={{ ...iS, appearance: "auto", marginTop: 8 }}>
                <option value="">Other (pick one to skip fixing it later)</option>
                {CASE_CATEGORY_GROUPS.map(g => (
                  <optgroup key={g.header} label={g.header}>
                    {g.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
            {saveNote.encId && (
              <button onClick={() => addToCaseLog(saveNote)} style={{
                marginTop: 8, padding: "9px 14px", borderRadius: 10, border: `1px solid ${T.accent}`,
                backgroundColor: "transparent", color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>Add it to my case log anyway</button>
            )}
          </div>
        )}
      </div>

      {/* Filters — assignment chips, period, code search, sliced totals */}
      {encounters.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
            {[{ id: "all", label: "All" }, ...contracts.filter(c => encounters.some(e => e.contractId === c.id)).map(c => ({ id: c.id, label: c.shortName || (c.facility || "Contract").split(" ").slice(0, 2).join(" ") }))].map(ch => (
              <button key={ch.id} onClick={() => setFltContract(ch.id)} style={{
                padding: "6px 12px", borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
                border: `1px solid ${fltContract === ch.id ? T.accent : T.border}`,
                backgroundColor: fltContract === ch.id ? T.accentDim || "rgba(16,185,129,0.14)" : "transparent",
                color: fltContract === ch.id ? T.accent : T.textMuted,
              }}>{ch.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <select value={fltPeriod} onChange={e => setFltPeriod(e.target.value)} style={{ ...iS, appearance: "auto", minWidth: 0, flex: "0 0 auto", width: "auto" }}>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
              <option value="month">This month</option>
              <option value="lastMonth">Last month</option>
              <option value="year">This year</option>
              <option value="all">All time</option>
            </select>
            <input value={fltCode} onChange={e => setFltCode(e.target.value)} placeholder="Filter by code or description" style={{ ...iS, minWidth: 0, flex: 1 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 8, padding: "8px 12px", borderRadius: 10, backgroundColor: T.input }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: T.textMuted }}>
              {filtered.length} encounter{filtered.length === 1 ? "" : "s"} · {fltDays} day{fltDays === 1 ? "" : "s"}
            </span>
            <span style={{ fontSize: 15, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>{fltTotal.toFixed(2)} wRVU</span>
          </div>
        </div>
      )}

      {/* History */}
      {byDay.length === 0 ? (
        encounters.length > 0 ? (
          <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "24px 0" }}>
            No encounters match these filters.
          </div>
        ) : (
        <EmptyState icon={"🧮"} title="No encounters logged"
          subtitle="Dictate or type what you did and the AI turns it into CPT codes with work RVUs." />
        )
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
                  <div key={e.id} role="button" tabIndex={0}
                    onClick={() => { setViewEnc(e); setEncDraft({ ...e, codes: (e.codes || []).map(c => ({ ...c })) }); setEncQ(""); setEncResults([]); }}
                    onKeyDown={ev => { if (ev.key === "Enter") { setViewEnc(e); setEncDraft({ ...e, codes: (e.codes || []).map(c => ({ ...c })) }); } }}
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 12px", boxShadow: T.shadow1, cursor: "pointer", textAlign: "left" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {(e.codes || []).map((c, i) => (
                          <div key={i} style={{ fontSize: 13, color: T.text }}>
                            <b>{c.code}{c.modifier && `-${c.modifier}`}</b>{c.units > 1 ? ` ×${c.units}` : ""} <span style={{ color: T.textMuted }}>{c.desc}</span>
                            <span style={{ color: T.textDim }}> · {((c.wRVU || 0) * (c.units || 1)).toFixed(2)}</span>
                          </div>
                        ))}
                        {facilityOf(e.contractId) && <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{facilityOf(e.contractId)}</div>}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 800, color: T.accent }}>{rvuOf(e).toFixed(2)}</span>
                        <button onClick={(ev) => { ev.stopPropagation(); if (window.confirm("Delete this encounter?")) deleteItem("encounters", e.id); }} style={{ padding: "4px 6px", borderRadius: 7, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tap an encounter → see everything in it and edit it in place */}
      <Modal open={!!viewEnc} onClose={() => { setViewEnc(null); setEncDraft(null); }} title="Encounter">
        {encDraft && (
          <>
            <Field label="Date"><input type="date" value={encDraft.date || ""} onChange={ev => setEncDraft(d => ({ ...d, date: ev.target.value }))} style={iS} /></Field>
            {contracts.length > 0 && (
              <Field label="Facility / contract">
                <select value={encDraft.contractId || ""} onChange={ev => setEncDraft(d => ({ ...d, contractId: ev.target.value || null }))} style={{ ...iS, appearance: "auto" }}>
                  <option value="">— none —</option>
                  {selectableContracts(contracts, encDraft.contractId).map(c => <option key={c.id} value={c.id}>{c.shortName || c.facility}</option>)}
                </select>
              </Field>
            )}

            <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 6px" }}>
              What was billed
            </div>
            {(encDraft.codes || []).map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 13.5, fontWeight: 800, fontFamily: "monospace", color: T.accent, minWidth: 52, flexShrink: 0 }}>{c.code}</span>
                <span style={{ fontSize: 12.5, color: T.text, flex: 1, minWidth: 0 }}>{c.desc || CPT_DESCS[c.code]?.d || "—"}</span>
                <select value={c.modifier || ""} onChange={ev => setEncDraft(d => ({ ...d, codes: d.codes.map((x, j) => j === i ? { ...x, modifier: ev.target.value } : x) }))}
                  style={{ ...iS, appearance: "auto", width: "auto", flexShrink: 0, padding: "3px 6px", fontSize: 11.5 }}
                  title="Assistant surgeon modifier">
                  {ASSIST_MODIFIERS.map(m => <option key={m.value} value={m.value}>{m.value ? `Mod ${m.value}` : "No modifier"}</option>)}
                </select>
                <button onClick={() => setEncDraft(d => ({ ...d, codes: d.codes.map((x, j) => j === i ? { ...x, units: Math.max(1, (x.units || 1) - 1) } : x) }))}
                  style={{ padding: "3px 8px", borderRadius: 7, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>−</button>
                <span style={{ fontSize: 13, fontWeight: 800, color: T.text, minWidth: 14, textAlign: "center" }}>{c.units || 1}</span>
                <button onClick={() => setEncDraft(d => ({ ...d, codes: d.codes.map((x, j) => j === i ? { ...x, units: (x.units || 1) + 1 } : x) }))}
                  style={{ padding: "3px 8px", borderRadius: 7, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>+</button>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#22c55e", fontVariantNumeric: "tabular-nums", minWidth: 44, textAlign: "right" }}>
                  {(((c.wRVU || CPT_DESCS[c.code]?.w) || 0) * (c.units || 1)).toFixed(2)}
                </span>
                <button onClick={() => setEncDraft(d => ({ ...d, codes: d.codes.filter((_, j) => j !== i) }))}
                  style={{ padding: "3px 7px", borderRadius: 7, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontWeight: 800 }}>×</button>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5, fontWeight: 800 }}>
              <span style={{ color: T.textMuted }}>Encounter total</span>
              <span style={{ color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>
                {(encDraft.codes || []).reduce((t, c) => t + ((c.wRVU || CPT_DESCS[c.code]?.w || 0) * (c.units || 1)), 0).toFixed(2)} wRVU
              </span>
            </div>

            <input value={encQ} inputMode="search" placeholder="Add a code — type a number or a name"
              onChange={async ev => {
                setEncQ(ev.target.value);
                if (!ev.target.value.trim()) { setEncResults([]); return; }
                const r = await searchCPT(ev.target.value, { limit: 6 });
                setEncResults(r.results || r || []);
              }} style={{ ...iS, marginTop: 6 }} />
            {encResults.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                {encResults.map(c => (
                  <button key={c.code} onClick={() => {
                    setEncDraft(d => ({ ...d, codes: [...(d.codes || []), { code: c.code, desc: c.shortDesc || c.cmsDesc || "", units: 1, wRVU: c.wRVU || 0 }] }));
                    setEncQ(""); setEncResults([]);
                  }} style={{ textAlign: "left", padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, fontSize: 12.5, cursor: "pointer" }}>
                    <b>{c.code}</b> {c.shortDesc || c.cmsDesc} {c.wRVU ? `· ${c.wRVU} wRVU` : ""}
                  </button>
                ))}
              </div>
            )}

            <Field label="Note"><textarea value={encDraft.note || ""} onChange={ev => setEncDraft(d => ({ ...d, note: ev.target.value }))} style={{ ...iS, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} /></Field>
            {encDraft.spokenText && (
              <div style={{ marginTop: 6, padding: "9px 11px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>What you dictated</div>
                <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>{encDraft.spokenText}</div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => {
                editItem("encounters", { ...encDraft, codes: (encDraft.codes || []).map(c => ({ code: c.code, desc: c.desc, units: c.units || 1, wRVU: c.wRVU ?? CPT_DESCS[c.code]?.w ?? 0, modifier: c.modifier || "" })) });
                // A case log born from this RVU entry froze its facility at
                // creation, so re-tagging the entry to another agreement used
                // to leave the case at the old hospital. Move the linked case
                // to the new agreement's facility (and date) so the two agree.
                if (viewEnc && encDraft.contractId !== viewEnc.contractId) {
                  const newFacility = contracts.find(c => c.id === encDraft.contractId)?.facility || "";
                  for (const cl of (data.caseLogs || [])) {
                    if (cl?.customFields?.["From RVU entry"] === encDraft.id) {
                      editItem("caseLogs", { ...cl, facility: newFacility, date: encDraft.date || cl.date });
                    }
                  }
                }
                setViewEnc(null); setEncDraft(null);
              }} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>Save changes</button>
              <button onClick={() => { setViewEnc(null); setEncDraft(null); }} style={{ padding: "12px 18px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
            </div>
          </>
        )}
      </Modal>

      <div style={{ marginTop: 14, fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>
        wRVU values from the CMS Physician Fee Schedule (CY2026 July release). AI-suggested codes
        are a documentation aid — you approve every code before it saves. Not billing advice.
      </div>
    </div>
  );
}

export default memo(RVULog);
