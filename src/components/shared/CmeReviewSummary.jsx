import { cmeReviewSummary } from "../../utils/cmePresentation";

export default function CmeReviewSummary({ stateComps, credentialDatesCurrent, standing, onReviewState, onOpenProfile, onOpenLicenses, theme: T }) {
  const summary = cmeReviewSummary(stateComps);
  const buttonStyle = { background: T.input, color: T.accent, border: `1px solid ${T.border}`, borderRadius: 8,
    padding: "8px 10px", minHeight: 44, textAlign: "left", font: "inherit", fontWeight: 600, cursor: "pointer" };
  return <div style={{ fontSize: 13, lineHeight: 1.5, marginTop: 8 }}>
    {standing && <p style={{ margin: "0 0 8px", color: T.textMuted }}>
      {standing.good} of {standing.total} tracked deadline checks have no alert. The ring shows deadline status, not CME completion.
    </p>}
    {summary.records.length > 0 && <div style={{ color: T.warning }}>CME records to review: {summary.records.join(", ")}</div>}
    {summary.confirmation.length > 0 && <div style={{ color: T.textMuted }}>CME confirmation needed: {summary.confirmation.join(", ")}</div>}
    {summary.confirmation.length > 0 && <p style={{ margin: "4px 0 8px", color: T.textMuted }}>
      Review the items below to identify which rules apply. An unanswered question does not mean you are missing CME hours.
    </p>}
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      {stateComps.filter(({ st }) => summary.records.includes(st) || summary.confirmation.includes(st)).map(({ st, comp, lic }) => {
        const topics = (comp.conditionalTopics || []).filter(t => t.applicability === "unknown").map(t => t.topic);
        const needsLicense = !comp.degreeUnknown && comp.applicabilityUnknown && !lic;
        const action = comp.degreeUnknown ? onOpenProfile : needsLicense ? onOpenLicenses : onReviewState && (() => onReviewState(st));
        const label = comp.degreeUnknown ? `${st}: choose MD or DO in Profile & settings`
          : needsLicense ? `${st}: add or update your medical license to answer CME questions`
          : topics.length ? `${st}: confirm ${topics.join(", ")}` : `${st}: review recorded CME hours and topics`;
        return action && <button key={st} type="button" onClick={action} style={buttonStyle}>{label} →</button>;
      })}
    </div>
    {credentialDatesCurrent && <div style={{ color: T.textMuted }}>Credential dates current</div>}
  </div>;
}
