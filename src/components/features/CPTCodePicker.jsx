import { useState, useRef, useEffect, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { SearchIcon } from "../shared/Icons";
import { searchCPT } from "../../utils/cptSearch";
import { aiCPTLookup } from "../../utils/cptAILookup";

function CPTCodePicker({ value, onChange }) {
  const { data, theme: T } = useApp();
  const iS = useInputStyle();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [confidence, setConfidence] = useState("none");
  const [showDropdown, setShowDropdown] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResults, setAiResults] = useState(null);
  const [aiError, setAiError] = useState(null);

  const wrapRef = useRef(null);
  const debounceRef = useRef(null);

  // Parse selected codes from comma-separated string
  const selectedCodes = (value || "").split(",").map(s => s.trim()).filter(Boolean);

  // Debounced search
  const handleSearch = useCallback((q) => {
    setQuery(q);
    setAiResults(null);
    setAiError(null);

    clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      setConfidence("none");
      setShowDropdown(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const { results: r, confidence: c } = await searchCPT(q);
      setResults(r);
      setConfidence(c);
      setShowDropdown(true);
    }, 200);
  }, []);

  // Select a code
  const selectCode = useCallback((code) => {
    const current = new Set(selectedCodes);
    if (!current.has(code)) {
      current.add(code);
      onChange([...current].join(", "));
    }
    setQuery("");
    setResults([]);
    setShowDropdown(false);
  }, [selectedCodes, onChange]);

  // Remove a code
  const removeCode = useCallback((code) => {
    onChange(selectedCodes.filter(c => c !== code).join(", "));
  }, [selectedCodes, onChange]);

  // AI fallback
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

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const chipStyle = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "3px 10px", borderRadius: 8,
    backgroundColor: T.accentDim, color: T.accent,
    fontSize: 13, fontWeight: 600, fontFamily: "monospace",
  };

  const chipRemoveStyle = {
    background: "none", border: "none", color: T.accent,
    cursor: "pointer", padding: 0, fontSize: 15, fontWeight: 700,
    lineHeight: 1, marginLeft: 2,
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      {/* Selected codes chips */}
      {selectedCodes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {selectedCodes.map(code => (
            <span key={code} style={chipStyle}>
              {code}
              <button type="button" onClick={() => removeCode(code)} style={chipRemoveStyle}>&times;</button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div style={{ position: "relative" }}>
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
          onFocus={() => { if (results.length) setShowDropdown(true); }}
          placeholder="Search CPT codes (e.g. 'suboccipital crani' or '61343')"
          style={{ ...iS, paddingLeft: 36 }}
        />
      </div>

      {/* Results dropdown */}
      {showDropdown && (results.length > 0 || aiResults) && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50,
          backgroundColor: T.card, border: `1px solid ${T.border}`,
          borderRadius: 10, marginTop: 4, maxHeight: 300, overflowY: "auto",
          boxShadow: T.shadow3,
        }}>
          {/* Confidence indicator */}
          {confidence !== "none" && (
            <div style={{
              padding: "6px 12px", fontSize: 11, fontWeight: 700,
              color: confidence === "high" ? T.success : confidence === "medium" ? T.warning : T.danger,
              borderBottom: `1px solid ${T.border}`,
              textTransform: "uppercase", letterSpacing: 0.5,
            }}>
              {confidence === "high" ? "Strong matches" : confidence === "medium" ? "Possible matches" : "Low confidence \u2014 try AI lookup below"}
            </div>
          )}

          {/* Local results */}
          {results.map(r => (
            <button
              type="button"
              key={r.code}
              onClick={() => selectCode(r.code)}
              style={{
                display: "flex", alignItems: "flex-start", gap: 10, width: "100%",
                padding: "10px 12px", border: "none",
                borderBottom: `1px solid ${T.border}`,
                backgroundColor: selectedCodes.includes(r.code) ? T.accentDim : "transparent",
                cursor: "pointer", textAlign: "left", color: T.text,
              }}
            >
              <span style={{
                fontWeight: 700, fontSize: 14, color: T.accent,
                fontFamily: "monospace", minWidth: 52, flexShrink: 0,
              }}>{r.code}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>
                  {r.fullDesc || r.shortDesc}
                </div>
                {r.subcategory && (
                  <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
                    {r.category}{r.subcategory ? ` \u203A ${r.subcategory}` : ""}
                  </div>
                )}
              </div>
              {r.wRVU != null && (
                <span style={{
                  fontSize: 11, fontWeight: 700, color: T.success || "#22c55e",
                  fontFamily: "monospace", flexShrink: 0, whiteSpace: "nowrap",
                }}>{r.wRVU.toFixed(2)} wRVU</span>
              )}
            </button>
          ))}

          {/* AI results section */}
          {aiResults && aiResults.length > 0 && (
            <>
              <div style={{
                padding: "6px 12px", fontSize: 11, fontWeight: 700,
                color: T.share, backgroundColor: T.shareDim,
                borderBottom: `1px solid ${T.border}`,
                textTransform: "uppercase", letterSpacing: 0.5,
              }}>
                AI-Suggested Codes
              </div>
              {aiResults.map(r => (
                <button
                  type="button"
                  key={r.code}
                  onClick={() => selectCode(r.code)}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10, width: "100%",
                    padding: "10px 12px", border: "none",
                    borderBottom: `1px solid ${T.border}`,
                    backgroundColor: selectedCodes.includes(r.code) ? T.shareDim : "transparent",
                    cursor: "pointer", textAlign: "left", color: T.text,
                  }}
                >
                  <span style={{
                    fontWeight: 700, fontSize: 14, color: T.share,
                    fontFamily: "monospace", minWidth: 52, flexShrink: 0,
                  }}>{r.code}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>
                      {r.description}
                    </div>
                    {r.reasoning && (
                      <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
                        {r.reasoning}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </>
          )}

          {/* AI lookup button */}
          {!aiResults && query.length > 3 && (
            <button
              type="button"
              onClick={handleAILookup}
              disabled={aiLoading}
              style={{
                width: "100%", padding: "10px 12px", border: "none",
                backgroundColor: T.shareDim, color: T.share,
                cursor: aiLoading ? "wait" : "pointer",
                fontSize: 13, fontWeight: 600, textAlign: "center",
              }}
            >
              {aiLoading ? "Searching with AI..." : "\u2728 Ask AI to find CPT codes"}
            </button>
          )}

          {/* AI error */}
          {aiError && (
            <div style={{
              padding: "8px 12px", fontSize: 12, color: T.danger,
              backgroundColor: T.dangerDim,
            }}>
              {aiError}
            </div>
          )}
        </div>
      )}

      {/* No results message */}
      {showDropdown && results.length === 0 && !aiResults && query.length > 0 && query.length <= 3 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50,
          backgroundColor: T.card, border: `1px solid ${T.border}`,
          borderRadius: 10, marginTop: 4, padding: "12px",
          boxShadow: T.shadow3, color: T.textDim, fontSize: 13, textAlign: "center",
        }}>
          Keep typing to search...
        </div>
      )}
    </div>
  );
}

export default memo(CPTCodePicker);
