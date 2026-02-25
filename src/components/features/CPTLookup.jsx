import { useState, useRef, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { SearchIcon } from "../shared/Icons";
import { searchCPT } from "../../utils/cptSearch";
import { aiCPTLookup } from "../../utils/cptAILookup";

function CPTLookup() {
  const { data, theme: T } = useApp();
  const iS = useInputStyle();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [confidence, setConfidence] = useState("none");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResults, setAiResults] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [expanded, setExpanded] = useState(null);

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
    const apiKey = data.settings?.apiKey;
    if (!apiKey) {
      setAiError("Add your API key in Settings to use AI-assisted lookup.");
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const result = await aiCPTLookup(query, results.slice(0, 5), apiKey);
      setAiResults(result.codes || []);
    } catch (err) {
      setAiError(err.message);
    }
    setAiLoading(false);
  }, [query, results, data.settings?.apiKey]);

  const copyCode = useCallback((code) => {
    navigator.clipboard?.writeText(code);
    setExpanded(prev => prev === code ? null : code);
  }, []);

  const hasResults = results.length > 0 || (aiResults && aiResults.length > 0);

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>CPT Lookup</h2>
      <p style={{ fontSize: 13, color: T.textDim, margin: "0 0 16px" }}>
        Search by procedure name, keyword, or code number.
      </p>

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
          value={query}
          onChange={e => handleSearch(e.target.value)}
          placeholder="e.g. 'suboccipital crani' or '61343'"
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
          {confidence === "high" ? "Strong matches" : confidence === "medium" ? "Possible matches" : "Low confidence \u2014 try AI lookup"}
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
            {expanded === r.code && (
              <div style={{ fontSize: 11, color: T.accent, marginTop: 4, fontWeight: 600 }}>
                Copied to clipboard
              </div>
            )}
          </div>
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
                {expanded === r.code && (
                  <div style={{ fontSize: 11, color: T.share, marginTop: 4, fontWeight: 600 }}>
                    Copied to clipboard
                  </div>
                )}
              </div>
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
