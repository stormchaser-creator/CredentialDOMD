import { useState, useMemo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import { STATES, STATE_NAMES } from "../../../constants/states";
import { generateId } from "../../../utils/helpers";
import { lookupNPI, findProvidersByName, extractLicensesFromNPI } from "../../../utils/npiLookup";
import { splitName, mergeNpiLicenses, additionalStatesAfterImport, degreeFromCredential, licenseKey } from "../../../utils/npiImport";

/**
 * The registry lookup and import, in one place.
 *
 * Three surfaces used to reimplement this: the old blocking wizard, the
 * Licenses page's own "Import from NPI" banner, and now the setup board.
 * They are all this component, so the name search, the match list and the
 * dedupe rules can only ever behave one way.
 *
 * The NPI number is optional: most physicians do not know theirs, so a blank
 * field searches the registry by the name on file and the physician picks
 * their own row. Nothing is ever auto-picked.
 *
 * Props:
 *  - onImported(count, licenses): fired after new licenses are written
 *  - autoRun: run the lookup once on mount when an NPI is already on file
 */
export default function NpiPanel({ onImported, dense = false }) {
  const { data, updateSettings, addItem, theme: T } = useApp();
  const iS = useInputStyle();
  const s = data.settings || {};

  const [npi, setNpi] = useState(s.npi || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [matches, setMatches] = useState(null);
  const [msg, setMsg] = useState("");    // a problem, in red
  const [note, setNote] = useState("");  // context, muted
  const [searchState, setSearchState] = useState(s.primaryState || "");
  const [imported, setImported] = useState(0);

  const npiLicenses = useMemo(() => (result ? extractLicensesFromNPI(result) : []), [result]);
  // What an import would actually add. Same key the merge uses, so a
  // hand-typed "35.123456" is never offered again as the registry's "35123456".
  const fresh = useMemo(() => {
    const have = new Set((data.licenses || []).map((l) => licenseKey(l?.state, l?.licenseNumber)));
    return npiLicenses.filter((nl) => !have.has(licenseKey(nl.state, nl.licenseNumber)));
  }, [npiLicenses, data.licenses]);

  const lookupByNumber = async (clean) => {
    const r = await lookupNPI(clean);
    if (!r) { setMsg("No provider found for that NPI. Check the digits, or clear the field to search by name."); return; }
    setNpi(clean);
    setResult(r);
    const patch = { npi: clean };
    const deg = degreeFromCredential(r.credential);
    if (deg && !s.degreeType) patch.degreeType = deg;
    updateSettings(patch);
  };

  const lookup = async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setMsg("The registry needs a connection. Add the license by hand for now.");
      return;
    }
    const clean = npi.replace(/\D/g, "");
    setBusy(true); setMsg(""); setNote(""); setResult(null); setMatches(null);
    try {
      if (clean.length === 10) { await lookupByNumber(clean); return; }
      const { firstName, lastName } = splitName(s.name);
      if (!firstName && !lastName) { setMsg("Add your name in About you, or type your 10-digit NPI."); return; }
      const { results, note: searchNote } = await findProvidersByName({ firstName, lastName, state: searchState || undefined });
      if (!results.length) {
        setMsg("The registry did not find you. Add a license by hand, or photograph the card.");
        return;
      }
      setMatches(results);
      const partial = clean.length ? `${clean.length} digits is not a whole NPI, so we searched by name instead. ` : "";
      setNote(`${partial}${searchNote}`.trim());
    } catch {
      setMsg("The registry did not answer. Enter your NPI by hand, or come back to this one.");
    } finally { setBusy(false); }
  };

  const pickMatch = async (m) => {
    setMatches(null); setNote(""); setMsg(""); setBusy(true);
    try { await lookupByNumber(m.npi); }
    catch { setMsg("The registry did not answer. Enter your NPI by hand, or come back to this one."); }
    finally { setBusy(false); }
  };

  const runImport = () => {
    if (!result) return;
    const rows = extractLicensesFromNPI(result);
    const newOnes = mergeNpiLicenses(data.licenses, rows, { degreeType: s.degreeType, makeId: generateId });
    for (const lic of newOnes) addItem("licenses", lic);
    const extras = additionalStatesAfterImport(s.additionalStates, s.primaryState, rows);
    if (extras.join("|") !== (s.additionalStates || []).join("|")) updateSettings({ additionalStates: extras });
    setImported(newOnes.length);
    onImported?.(newOnes.length, newOnes);
  };

  const label = { fontSize: 12, fontWeight: 700, color: T.textMuted };
  const primaryBtn = {
    width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
    backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer",
  };

  return (
    <div>
      {!dense && (
        <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 10 }}>
          Your NPI record carries your name, your degree, and every state license number the federal registry has on file. If you do not know the number, leave it blank and search by name.
        </div>
      )}
      <label style={label}>NPI (10 digits, optional)</label>
      <div style={{ display: "flex", gap: 8, margin: "4px 0 6px" }}>
        <input
          value={npi}
          onChange={(e) => { setNpi(e.target.value.replace(/\D/g, "").slice(0, 10)); setMatches(null); }}
          placeholder="Blank searches by name"
          inputMode="numeric"
          maxLength={10}
          style={{ ...iS, flex: 1 }}
        />
        <button onClick={lookup} disabled={busy} style={{
          padding: "0 16px", borderRadius: 10, border: "none", backgroundColor: T.accent,
          color: "#fff", fontWeight: 800, cursor: busy ? "wait" : "pointer",
          opacity: busy ? 0.7 : 1, whiteSpace: "nowrap",
        }}>{busy ? "Looking up..." : "Look up"}</button>
      </div>

      {npi.length !== 10 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.textMuted, marginBottom: 8 }}>
          <span style={{ whiteSpace: "nowrap" }}>Search by name in</span>
          <select value={searchState} onChange={(e) => setSearchState(e.target.value)} style={{ ...iS, flex: 1, padding: "6px 10px", fontSize: 13, appearance: "auto" }}>
            <option value="">any state</option>
            {STATES.map((st) => <option key={st} value={st}>{STATE_NAMES?.[st] || st} ({st})</option>)}
          </select>
        </div>
      )}

      {msg && <div style={{ fontSize: 13, color: T.danger, marginBottom: 8, lineHeight: 1.5 }}>{msg}</div>}
      {note && <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 8 }}>{note}</div>}

      {matches && matches.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            {matches.length} match{matches.length === 1 ? "" : "es"}. Tap yourself.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 300, overflowY: "auto" }}>
            {matches.map((m) => (
              <button key={m.npi} onClick={() => pickMatch(m)} style={{
                display: "flex", alignItems: "flex-start", gap: 10, width: "100%", textAlign: "left",
                padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: 10,
                backgroundColor: T.input, color: T.text, cursor: "pointer",
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{m.name}{m.credential ? `, ${m.credential}` : ""}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 1 }}>{m.specialty || "No specialty listed"}</div>
                  <div style={{ fontSize: 12, color: T.textDim, marginTop: 1 }}>{[m.city, m.state].filter(Boolean).join(", ") || "No location listed"}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, backgroundColor: T.accentGlow, padding: "3px 8px", borderRadius: 8, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{m.npi}</div>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 6 }}>Not here? Try another state above, or type the NPI if you have it.</div>
        </div>
      )}

      {result && (
        <div style={{ border: `1px solid ${T.accent}`, backgroundColor: T.accentDim, borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{result.firstName} {result.lastName}{result.credential ? `, ${result.credential}` : ""}</div>
          <div style={{ fontSize: 13, color: T.textMuted }}>
            {result.specialty?.description || "Specialty on file"}{result.address?.city ? ` · ${result.address.city}, ${result.address.state}` : ""} · NPI {result.npi}
          </div>
          {npiLicenses.length > 0 ? (
            <>
              <div style={{ fontSize: 13, marginTop: 8, fontWeight: 700 }}>
                {npiLicenses.length} license{npiLicenses.length === 1 ? "" : "s"} on the registry: {npiLicenses.map((l) => l.state).join(", ")}.
              </div>
              {npiLicenses.map((l, i) => (
                <div key={i} style={{ fontSize: 13, color: T.text }}>{l.state} · {l.licenseNumber}{l.description ? ` · ${l.description}` : ""}</div>
              ))}
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 8, lineHeight: 1.5 }}>
              The registry lists no license numbers for you. It only carries what was reported to NPPES, so this is common. Photograph your primary license instead and the app reads it.
            </div>
          )}
        </div>
      )}

      {result && npiLicenses.length > 0 && (
        fresh.length > 0
          ? <button onClick={runImport} style={primaryBtn}>Import {fresh.length} license{fresh.length === 1 ? "" : "s"}</button>
          : <div style={{ fontSize: 13, color: T.textMuted, fontWeight: 600 }}>
              All {npiLicenses.length} registry license{npiLicenses.length === 1 ? " is" : "s are"} already on file.
            </div>
      )}
      {imported > 0 && (
        <div style={{ fontSize: 13, color: T.success, fontWeight: 700, marginTop: 8 }}>
          {imported} license{imported === 1 ? "" : "s"} imported.
        </div>
      )}
    </div>
  );
}
