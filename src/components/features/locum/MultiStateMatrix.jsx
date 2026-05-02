/**
 * MultiStateMatrix — Locum tier flagship.
 *
 * One screen, every state you hold a license in. For each state:
 *   - License # + expiration + days remaining
 *   - DEA registration status (if same state)
 *   - CME compliance: hours logged / hours required + topic gaps
 *   - Hospital privileges (count + earliest reappointment)
 *   - One-tap link to renewal-cycle source
 *
 * Replaces the click-through-each-state pattern in Solo. Built specifically
 * for physicians with 2+ active state licenses (the canonical locum workflow).
 */

import { useMemo } from "react";
import { useApp } from "../../../context/AppContext";
import { computeCompliance } from "../../../utils/compliance";
import { STATE_REQS } from "../../../constants/stateRequirements";
import { STATES } from "../../../constants/states";

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const ms = new Date(dateStr).getTime() - Date.now();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function statusColor(days, T) {
  if (days == null) return T.textDim;
  if (days < 0) return "#ef4444";   // expired
  if (days <= 30) return "#f97316"; // urgent
  if (days <= 90) return "#eab308"; // warning
  return T.success || "#10b981";    // healthy
}

function statusLabel(days) {
  if (days == null) return "—";
  if (days < 0)  return `Expired ${Math.abs(days)}d ago`;
  if (days <= 30) return `${days}d left`;
  if (days <= 90) return `${days}d left`;
  return `${days}d left`;
}

export default function MultiStateMatrix() {
  const { data, theme: T } = useApp();
  const degreeType = data.settings?.degreeType || "DO";

  const stateRows = useMemo(() => {
    const licenses = data.licenses || [];
    const stateSet = new Set();
    licenses.forEach((l) => l.state && stateSet.add(l.state));
    if (data.settings?.primaryState) stateSet.add(data.settings.primaryState);
    (data.settings?.additionalStates || []).forEach((s) => stateSet.add(s));

    return [...stateSet].sort().map((state) => {
      // Find primary license for this state (first by type === "Medical License" or earliest expiration)
      const stateLicenses = licenses.filter((l) => l.state === state);
      const medLicense =
        stateLicenses.find((l) => /medical|md|do/i.test(l.type || l.name || "")) ||
        stateLicenses[0];

      // DEA in same state (DEA is federally issued but tied to state of practice address)
      const deaLicense = stateLicenses.find((l) => /dea/i.test(l.type || l.name || ""));

      // Controlled substance permit if state requires
      const csPermit = stateLicenses.find((l) =>
        /controlled.substance|csp|csl/i.test(l.type || l.name || "")
      );

      // CME compliance for this state
      const cmeData = computeCompliance(data.cme || [], state, degreeType);

      // Privileges in this state
      const privCount = (data.privileges || []).filter(
        (p) => p.state === state
      ).length;
      const privEarliest = (data.privileges || [])
        .filter((p) => p.state === state && p.expirationDate)
        .map((p) => p.expirationDate)
        .sort()[0];

      // State req lookup with MD/DO branching
      const reqRoot = STATE_REQS[state];
      const req = reqRoot
        ? reqRoot.md || reqRoot.do
          ? degreeType === "DO"
            ? reqRoot.do || reqRoot.md
            : reqRoot.md || reqRoot.do
          : reqRoot
        : null;

      return {
        state,
        medLicense,
        deaLicense,
        csPermit,
        cmeData,
        req,
        privCount,
        privEarliest,
      };
    });
  }, [data, degreeType]);

  if (stateRows.length === 0) {
    return (
      <div style={{
        textAlign: "center", padding: "40px 20px",
        color: T.textMuted, fontSize: 14,
      }}>
        Add at least one state medical license to see the matrix.
        <br />
        <button
          style={{
            marginTop: 16, padding: "10px 18px", borderRadius: 10,
            border: "none", backgroundColor: T.accent, color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}
          onClick={() => window.location.hash = "#credentials/licenses"}
        >
          Add a license
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 4px" }}>
          Multi-State License Matrix
        </h3>
        <p style={{ fontSize: 12, color: T.textMuted, margin: 0 }}>
          {stateRows.length} state{stateRows.length === 1 ? "" : "s"} ·{" "}
          One row per state, one glance for renewal status.
        </p>
      </div>

      {/* State cards (each state is one row) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {stateRows.map((row) => {
          const licDays = daysUntil(row.medLicense?.expirationDate);
          const deaDays = daysUntil(row.deaLicense?.expirationDate);
          const privDays = daysUntil(row.privEarliest);
          const cmeReq = row.req?.total || 0;
          const cmePct = cmeReq > 0
            ? Math.min(100, Math.round((row.cmeData?.totalHours || 0) / cmeReq * 100))
            : 100;
          const cmePctColor =
            cmePct >= 100 ? "#10b981"
            : cmePct >= 75 ? "#eab308"
            : "#ef4444";

          return (
            <div
              key={row.state}
              style={{
                backgroundColor: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: 12,
                padding: "14px 16px",
              }}
            >
              {/* Header: State + degree-type tag */}
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "center", marginBottom: 10,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: T.text }}>
                    {row.state}
                  </span>
                  <span style={{
                    fontSize: 11, color: T.textMuted,
                  }}>
                    {STATES.find((s) => s.code === row.state)?.name || ""}
                  </span>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  padding: "2px 8px", borderRadius: 10,
                  backgroundColor: T.input, color: T.textMuted,
                }}>
                  {degreeType}
                </span>
              </div>

              {/* Grid: 4 metrics per state */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}>
                {/* License */}
                <Cell
                  T={T}
                  label="Medical License"
                  value={row.medLicense?.licenseNumber || "—"}
                  status={row.medLicense ? statusLabel(licDays) : "Not on file"}
                  statusColor={row.medLicense ? statusColor(licDays, T) : T.textDim}
                />
                {/* DEA */}
                <Cell
                  T={T}
                  label="DEA"
                  value={row.deaLicense?.licenseNumber || "—"}
                  status={row.deaLicense ? statusLabel(deaDays) : "Not in this state"}
                  statusColor={row.deaLicense ? statusColor(deaDays, T) : T.textDim}
                />
                {/* CME */}
                <Cell
                  T={T}
                  label={`CME${cmeReq ? ` (${cmeReq} hr req)` : ""}`}
                  value={`${row.cmeData?.totalHours || 0} / ${cmeReq || "—"} hrs`}
                  status={cmeReq > 0 ? `${cmePct}%` : "No state CME req"}
                  statusColor={cmeReq > 0 ? cmePctColor : T.textDim}
                />
                {/* Privileges */}
                <Cell
                  T={T}
                  label={`Privileges (${row.privCount})`}
                  value={row.privCount === 0 ? "—" : `${row.privCount} hosp.`}
                  status={row.privEarliest ? statusLabel(privDays) : "—"}
                  statusColor={row.privEarliest ? statusColor(privDays, T) : T.textDim}
                />
              </div>

              {/* CME topic gaps for this state */}
              {row.cmeData?.unmet && row.cmeData.unmet.length > 0 && (
                <div style={{
                  marginTop: 10, padding: "6px 10px",
                  backgroundColor: "rgba(239,68,68,0.06)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  borderRadius: 8,
                  fontSize: 11, color: T.text,
                }}>
                  <strong style={{ color: "#ef4444" }}>Unmet topics:</strong>{" "}
                  {row.cmeData.unmet.slice(0, 3).map((u) => u.topic).join(", ")}
                  {row.cmeData.unmet.length > 3 && ` +${row.cmeData.unmet.length - 3} more`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Cell({ T, label, value, status, statusColor }) {
  return (
    <div style={{
      backgroundColor: T.bg,
      border: `1px solid ${T.borderSubtle || T.border}`,
      borderRadius: 8,
      padding: "8px 10px",
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1.2 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: statusColor, marginTop: 2, fontWeight: 600 }}>
        {status}
      </div>
    </div>
  );
}
