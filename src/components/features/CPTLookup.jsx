import { useState, useRef, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { SearchIcon } from "../shared/Icons";
import { generateId, copyToClipboard } from "../../utils/helpers";
import { searchCPT } from "../../utils/cptSearch";
import { aiCPTLookup } from "../../utils/cptAILookup";
import { catalogWRVU } from "../../utils/cptCatalog";
import { aiAvailable, describeAiStatus } from "../../utils/aiClient";
import { pickableContracts } from "../../utils/contractsForDate";
import { credentialOnlyMembership } from "../../utils/limitedLaunchAccess";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy";
import { inlineLinkTap } from "../shared/actionButton";

// Local calendar date — a UTC slice would file late-evening work on tomorrow
const localDay = (d) => {
  const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return p.toISOString().slice(0, 10);
};

function CPTLookup() {
  const { data, addItem, theme: T, limitedLaunch, practiceReadOnly } = useApp();
  // "+ Bill it" writes an RVU encounter, a Practice record. Where the server
  // answered that Practice is read-only (a Credential-only membership, or one
  // that lapsed) the button could only be refused, with a message about a
  // record that does not exist; the page says why instead. A check still in
  // progress keeps the button, as the Practice tab keeps its screens.
  const billingClosed = !!limitedLaunch?.enabled && !!practiceReadOnly;
  const credentialOnly = billingClosed && credentialOnlyMembership(limitedLaunch?.access);
  const iS = useInputStyle();
  const [logged, setLogged] = useState(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [confidence, setConfidence] = useState("none");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResults, setAiResults] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  // What the last copy of `expanded` came to: { code, ok } (ok null while it
  // runs). A browser that refuses clipboard access (permission denied, an
  // insecure context) rejects the write: said on the row, never an
  // unhandled rejection or a "Copied" that is not true.
  const [copied, setCopied] = useState(null);

  const debounceRef = useRef(null);

  const handleSearch = useCallback((q) => {
    setQuery(q);
    setAiResults(null);
    setAiError(null);
    setExpanded(null);

    clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      setConfidence("none");
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const { results: r, confidence: c } = await searchCPT(q, { limit: 25 });
      setResults(r);
      setConfidence(c);
    }, 200);
  }, []);

  const handleAILookup = useCallback(async () => {
    // Own key when present; otherwise the shared key via ai-proxy.
    const apiKey = data.settings?.apiKey;
    if (!aiAvailable(data.settings)) {
      setAiError(describeAiStatus(data.settings));
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const result = await aiCPTLookup(query, results.slice(0, 5), apiKey);
      // The AI names a code and what it covers, never its work RVU, so
      // "+ Bill it" on its row logged the code at 0 wRVU. Each code carries
      // the catalog's figure, the one its search result shows; a figure the
      // AI offered of its own is never billed, and a code no catalog lists
      // carries none.
      const codes = await Promise.all((result.codes || []).map(async (r) => {
        const { wRVU: _aiFigure, ...row } = r || {};
        const wRVU = await catalogWRVU(row.code);
        return wRVU == null ? row : { ...row, wRVU };
      }));
      setAiResults(codes);
    } catch (err) {
      setAiError(err.message);
    }
    setAiLoading(false);
  }, [query, results, data.settings]);

  const copyCode = useCallback((code) => {
    setExpanded(prev => prev === code ? null : code);
    setCopied({ code, ok: null });
    const settle = (ok) => setCopied(prev => (prev?.code === code && prev.ok === null ? { code, ok } : prev));
    let copying;
    try { copying = copyToClipboard(code); } catch { copying = Promise.resolve(false); }
    Promise.resolve(copying).then((ok) => settle(ok === true), () => settle(false));
  }, []);
  // The line under an open row: copied, or why not.
  const copyNote = (code, color) => {
    if (expanded !== code || copied?.code !== code || copied.ok === null) return null;
    return copied.ok
      ? <div style={{ fontSize: 11, color, marginTop: 4, fontWeight: 600 }}>Copied to clipboard</div>
      : <div role="alert" style={{ fontSize: 11, color: T.danger, marginTop: 4, fontWeight: 600 }}>Copy failed. This browser did not allow copying; select the code to copy it.</div>;
  };

  // Looking a code up and billing it are the same errand — log it straight
  // into the RVU ledger instead of making him retype it on the Locum tab.
  const logToBilling = useCallback((c) => {
    // Only a single CURRENT agreement is assumed: an archived or long-ended
    // one no longer counts toward "there is only one".
    const contracts = pickableContracts(data.locumContracts, null);
    // Refused (membership being re-checked): no "logged" tick; addItem has said why.
    const logged = addItem("encounters", {
      id: generateId(),
      createdAt: new Date().toISOString(),
      contractId: contracts.length === 1 ? contracts[0].id : null,
      date: localDay(new Date()),
      codes: [{
        code: c.code,
        desc: c.shortDesc || c.fullDesc || c.cmsDesc || "",
        units: 1,
        wRVU: c.wRVU || 0,
      }],
      note: "",
      spokenText: "",
    });
    if (logged === false) return;
    setLogged(c.code);
    setTimeout(() => setLogged(l => (l === c.code ? null : l)), 2600);
  }, [addItem, data.locumContracts]);

  const LogButton = ({ c }) => (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); logToBilling(c); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); logToBilling(c); } }}
      style={{
        display: "inline-block", flexShrink: 0, alignSelf: "center", padding: "8px 12px", borderRadius: 10,
        border: `1px solid ${logged === c.code ? "transparent" : T.accent}`,
        backgroundColor: logged === c.code ? (T.successDim || "rgba(34,197,94,0.12)") : "transparent",
        color: logged === c.code ? (T.success || "#22c55e") : T.accent,
        fontSize: 12.5, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
      }}
    >{logged === c.code ? "\u2713 Logged" : "+ Bill it"}</span>
  );

  const hasResults = results.length > 0 || (aiResults && aiResults.length > 0);

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>CPT Lookup</h2>
      <p style={{ fontSize: 13, color: T.textDim, margin: "0 0 16px" }}>
        Search by procedure name, keyword, or code number.
      </p>

      {billingClosed && (
        <div role="note" style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 13, lineHeight: 1.5,
          color: T.textMuted, backgroundColor: T.input, border: `1px solid ${T.border}`, marginBottom: 12,
        }}>
          {credentialOnly
            ? "Billing a code to your RVU log is part of Practice, and your Credential membership does not include it. You can still search and copy codes here."
            : "Billing a code to your RVU log is part of Practice, which is read-only on this account. You can still search and copy codes here."}
          {credentialOnly && <>
            {" "}<a href="mailto:support@credentialdomd.com" style={{ color: T.accent, ...inlineLinkTap }}>Contact support about adding Practice</a>. {MEMBERSHIP_COPY.practiceSupportReview}
          </>}
        </div>
      )}

      {/* Search input */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <span style={{
          position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
          color: T.textDim, pointerEvents: "none", display: "flex",
        }}>
          <SearchIcon />
        </span>
        <input
          type="text"
          aria-label="Search CPT codes"
          value={query}
          onChange={e => handleSearch(e.target.value)}
          placeholder="e.g. 'suboccipital crani' or '61343'"
          data-desk-search=""
          style={{ ...iS, paddingLeft: 36 }}
        />
      </div>

      {/* AI button */}
      {query.length > 3 && !aiResults && (
        <button
          onClick={handleAILookup}
          disabled={aiLoading}
          style={{
            width: "100%", padding: "12px", borderRadius: 12, border: "none",
            backgroundColor: T.shareDim, color: T.share,
            cursor: aiLoading ? "wait" : "pointer",
            fontSize: 14, fontWeight: 600, textAlign: "center",
            marginBottom: 12,
          }}
        >
          {aiLoading ? "Searching with AI..." : "\u2728 Ask AI to find CPT codes"}
        </button>
      )}

      {/* AI error */}
      {aiError && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 13, color: T.danger,
          backgroundColor: T.dangerDim, marginBottom: 12,
        }}>
          {aiError}
        </div>
      )}

      {/* Confidence indicator */}
      {confidence !== "none" && results.length > 0 && (
        <div style={{
          padding: "8px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700,
          color: confidence === "high" ? T.success : confidence === "medium" ? T.warning : T.danger,
          backgroundColor: confidence === "high" ? (T.successDim || "rgba(34,197,94,0.1)") : confidence === "medium" ? T.warningDim : T.dangerDim,
          marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5,
        }}>
          {confidence === "high" ? "Strong matches" : confidence === "medium" ? "Possible matches" : "Low confidence: try AI lookup"}
          {` \u00b7 ${results.length} result${results.length !== 1 ? "s" : ""}`}
        </div>
      )}

      {/* Results list */}
      {results.map(r => (
        <button
          type="button"
          key={r.code}
          onClick={() => copyCode(r.code)}
          style={{
            display: "flex", alignItems: "flex-start", gap: 12, width: "100%",
            padding: "12px 14px", border: `1px solid ${T.border}`,
            borderRadius: 12, marginBottom: 6,
            backgroundColor: expanded === r.code ? T.accentDim : T.card,
            cursor: "pointer", textAlign: "left", color: T.text,
            boxShadow: T.shadow1,
          }}
        >
          <span style={{
            fontWeight: 700, fontSize: 15, color: T.accent,
            fontFamily: "monospace", minWidth: 52, flexShrink: 0,
          }}>{r.code}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, color: T.text, fontWeight: 500 }}>
              {r.fullDesc || r.shortDesc}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
              {r.subcategory && (
                <span style={{ fontSize: 11, color: T.textDim }}>
                  {r.category}{r.subcategory ? ` \u203A ${r.subcategory}` : ""}
                </span>
              )}
              {r.wRVU != null && (
                <span style={{
                  fontSize: 11, fontWeight: 700, color: T.success || "#22c55e",
                  fontFamily: "monospace",
                  backgroundColor: T.successDim || "rgba(34,197,94,0.1)",
                  padding: "1px 6px", borderRadius: 4,
                }}>{r.wRVU.toFixed(2)} wRVU</span>
              )}
              {r.totalRVU != null && (
                <span style={{
                  fontSize: 11, fontWeight: 600, color: T.textDim,
                  fontFamily: "monospace",
                }}>{r.totalRVU.toFixed(2)} total</span>
              )}
            </div>
            {copyNote(r.code, T.accent)}
          </div>
          {!billingClosed && <LogButton c={r} />}
        </button>
      ))}

      {/* AI results */}
      {aiResults && aiResults.length > 0 && (
        <>
          <div style={{
            padding: "8px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700,
            color: T.share, backgroundColor: T.shareDim,
            marginBottom: 8, marginTop: 8,
            textTransform: "uppercase", letterSpacing: 0.5,
          }}>
            AI-Suggested Codes
          </div>
          {aiResults.map(r => (
            <button
              type="button"
              key={r.code}
              onClick={() => copyCode(r.code)}
              style={{
                display: "flex", alignItems: "flex-start", gap: 12, width: "100%",
                padding: "12px 14px", border: `1px solid ${T.border}`,
                borderRadius: 12, marginBottom: 6,
                backgroundColor: expanded === r.code ? T.shareDim : T.card,
                cursor: "pointer", textAlign: "left", color: T.text,
                boxShadow: T.shadow1,
              }}
            >
              <span style={{
                fontWeight: 700, fontSize: 15, color: T.share,
                fontFamily: "monospace", minWidth: 52, flexShrink: 0,
              }}>{r.code}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, color: T.text, fontWeight: 500 }}>
                  {r.description}
                </div>
                {r.reasoning && (
                  <div style={{ fontSize: 11, color: T.textDim, marginTop: 3 }}>
                    {r.reasoning}
                  </div>
                )}
                {typeof r.wRVU === "number" && (
                  <div style={{ marginTop: 3 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: T.success || "#22c55e",
                      fontFamily: "monospace",
                      backgroundColor: T.successDim || "rgba(34,197,94,0.1)",
                      padding: "1px 6px", borderRadius: 4,
                    }}>{r.wRVU.toFixed(2)} wRVU</span>
                  </div>
                )}
                {copyNote(r.code, T.share)}
              </div>
              {!billingClosed && <LogButton c={{ ...r, shortDesc: r.description }} />}
            </button>
          ))}
        </>
      )}

      {/* Empty state */}
      {query.length > 0 && !hasResults && confidence === "none" && !aiLoading && (
        <div style={{
          textAlign: "center", padding: "32px 16px", color: T.textDim, fontSize: 14,
        }}>
          {query.length <= 2 ? "Keep typing to search..." : "No results found. Try AI lookup above."}
        </div>
      )}

      {/* Help text when empty */}
      {query.length === 0 && (
        <div style={{
          textAlign: "center", padding: "40px 20px", color: T.textDim,
        }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>{"\ud83d\udd0d"}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 6 }}>Search CPT Codes</div>
          <div style={{ fontSize: 13 }}>
            Type a procedure name like "suboccipital craniectomy" or enter a code number like "61343".
            Tap any result to copy the code.
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(CPTLookup);
