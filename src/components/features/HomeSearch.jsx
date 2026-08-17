import { useMemo, useState, useRef, useEffect } from "react";
import { useApp } from "../../context/AppContext";
import { describeItem } from "../../utils/helpers";

/**
 * HomeSearch: one box at the top of Home that finds anything you have
 * entered (licenses, privileges, CME, documents, contracts, invoices, cases,
 * expenses, people...) and hands anything else to Vera.
 *
 * Results are grouped by section; tapping one navigates to that record.
 * The last row is always "Ask Vera", which opens the assistant with the
 * text as the first question.
 */

// Section key -> where it lives in the app + label. Order = display order.
const SECTIONS = [
  { key: "licenses", label: "Licenses & certs", tab: "credentials", sub: "licenses" },
  { key: "privileges", label: "Privileges", tab: "credentials", sub: "privileges" },
  { key: "cme", label: "CME", tab: "credentials", sub: "cme" },
  { key: "insurance", label: "Insurance", tab: "credentials", sub: "insurance" },
  { key: "healthRecords", label: "Health records", tab: "credentials", sub: "healthRecords" },
  { key: "screenings", label: "Screenings", tab: "credentials", sub: "screenings" },
  { key: "education", label: "Education", tab: "credentials", sub: "education" },
  { key: "workHistory", label: "Work history", tab: "credentials", sub: "workHistory" },
  { key: "peerReferences", label: "References", tab: "credentials", sub: "peerReferences" },
  { key: "memberships", label: "Memberships", tab: "credentials", sub: "memberships" },
  { key: "malpracticeHistory", label: "Malpractice", tab: "credentials", sub: "malpracticeHistory" },
  { key: "publications", label: "Publications", tab: "credentials", sub: "publications" },
  { key: "travelDocs", label: "Travel documents", tab: "credentials", sub: "travelDocs" },
  { key: "caseLogs", label: "Cases", tab: "credentials", sub: "caseLogs" },
  { key: "documents", label: "Documents", tab: "documents", sub: null },
  { key: "locumContracts", label: "Contracts", tab: "locum", sub: "contracts" },
  { key: "invoices", label: "Invoices", tab: "locum", sub: "invoices" },
  { key: "workLog", label: "Work log", tab: "locum", sub: "work" },
  { key: "encounters", label: "RVU entries", tab: "locum", sub: "rvus" },
  { key: "travelExpenses", label: "Expenses", tab: "locum", sub: "expenses" },
  { key: "deductibles", label: "Deductions", tab: "more", sub: "finance" },
  { key: "taskNotes", label: "To-do", tab: "locum", sub: "todo" },
];

// Fields worth matching on, beyond whatever describeItem prints.
const TEXT_FIELDS = ["name", "type", "title", "facility", "state", "city", "provider", "institution", "issuer", "issuingAuthority",
  "licenseNumber", "number", "policyNumber", "notes", "description", "category", "topics", "vendor", "merchant", "payer", "agency",
  "invoiceNumber", "contact", "email", "phone", "portalUrl", "loginUsername", "specialty", "role", "procedure", "cptCodes", "codes",
  "subject", "text", "label", "degree", "school", "employer", "position", "journal", "authors", "location", "billTo", "billToLabel"];

function itemText(item) {
  const parts = [];
  for (const k of TEXT_FIELDS) {
    const v = item[k];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) parts.push(v.map(x => (typeof x === "object" ? Object.values(x).join(" ") : String(x))).join(" "));
    else if (typeof v === "object") parts.push(Object.values(v).filter(x => typeof x !== "object").join(" "));
    else parts.push(String(v));
  }
  return parts.join(" ").toLowerCase();
}

function tokens(q) {
  return q.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
}

export default function HomeSearch({ onOpen, onAskVera }) {
  const { data, theme: T } = useApp();
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!focus) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setFocus(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc, { passive: true });
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("touchstart", onDoc); };
  }, [focus]);

  const results = useMemo(() => {
    const toks = tokens(q);
    if (!toks.length) return [];
    const out = [];
    for (const sec of SECTIONS) {
      const items = data[sec.key] || [];
      const hits = [];
      for (const it of items) {
        if (!it || it.deleted) continue;
        const label = (() => { try { return describeItem(it, data.settings?.name, sec.key); } catch { return it.name || it.title || ""; } })();
        const hay = `${label} ${itemText(it)}`.toLowerCase();
        if (toks.every(t => hay.includes(t))) {
          const sub = [it.state, it.facility, it.provider, it.expirationDate && `exp ${it.expirationDate}`, it.date, it.total != null && `$${it.total}`]
            .filter(Boolean).join(" · ");
          hits.push({ id: it.id, label: label || "(untitled)", sub });
        }
        if (hits.length >= 6) break;
      }
      if (hits.length) out.push({ sec, hits, total: items.filter(it => it && !it.deleted).length });
    }
    return out;
  }, [q, data]);

  const show = focus && q.trim().length >= 2;
  const totalHits = results.reduce((n, g) => n + g.hits.length, 0);

  return (
    <div ref={boxRef} style={{ position: "relative", marginBottom: 14, zIndex: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, backgroundColor: T.card, border: `1px solid ${focus ? T.accent : T.border}`, borderRadius: 14, padding: "10px 12px", boxShadow: T.shadow1 }}>
        <span style={{ fontSize: 16, color: T.textMuted }}>{"\u{1F50D}"}</span>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onKeyDown={e => {
            if (e.key === "Escape") { setFocus(false); e.currentTarget.blur(); }
            if (e.key === "Enter" && q.trim()) {
              const first = results[0]?.hits[0];
              if (first && totalHits === 1) { onOpen(results[0].sec, first.id); setQ(""); setFocus(false); }
              else { onAskVera(q.trim()); setQ(""); setFocus(false); }
            }
          }}
          placeholder="Search everything, or ask Vera"
          autoCapitalize="none"
          autoCorrect="off"
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: T.text, fontSize: 15, minWidth: 0 }}
        />
        {q && (
          <button onClick={() => { setQ(""); }} style={{ border: "none", background: "transparent", color: T.textDim, fontSize: 18, cursor: "pointer", lineHeight: 1 }}>{"×"}</button>
        )}
      </div>

      {show && (
        <div style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, boxShadow: T.shadow2 || "0 12px 32px rgba(0,0,0,0.25)", maxHeight: "60vh", overflowY: "auto", padding: 6 }}>
          {results.map(g => (
            <div key={g.sec.key} style={{ padding: "4px 4px 6px" }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: T.textMuted, padding: "6px 8px 2px" }}>{g.sec.label}</div>
              {g.hits.map(h => (
                <div key={h.id} onClick={() => { onOpen(g.sec, h.id); setQ(""); setFocus(false); }} style={{ padding: "8px 8px", borderRadius: 10, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.backgroundColor = T.input} onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.label}</div>
                  {h.sub && <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.sub}</div>}
                </div>
              ))}
              {g.hits.length >= 6 && <div style={{ fontSize: 11.5, color: T.textDim, padding: "2px 8px" }}>Showing the first 6. Refine the search or open {g.sec.label}.</div>}
            </div>
          ))}
          {results.length === 0 && (
            <div style={{ fontSize: 13, color: T.textMuted, padding: "10px 12px" }}>Nothing in your records matches "{q.trim()}".</div>
          )}
          <div onClick={() => { onAskVera(q.trim()); setQ(""); setFocus(false); }} style={{ margin: 4, padding: "10px 12px", borderRadius: 10, cursor: "pointer", backgroundColor: T.accentDim, border: `1px solid ${T.accent}`, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>{"\u{1F4AC}"}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>Ask Vera: <span style={{ fontWeight: 500 }}>"{q.trim()}"</span></div>
              <div style={{ fontSize: 11.5, color: T.textMuted }}>Questions about your records, rules, packets, billing. Enter also asks Vera when there is not exactly one match.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
