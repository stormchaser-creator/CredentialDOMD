import { cmeReviewSummary } from "../../utils/cmePresentation";

export default function CmeReviewSummary({ stateComps, credentialDatesCurrent, theme: T }) {
  const summary = cmeReviewSummary(stateComps);
  return <div style={{ fontSize: 13, lineHeight: 1.5, marginTop: 8 }}>
    {summary.records.length > 0 && <div style={{ color: T.warning }}>CME records to review: {summary.records.join(", ")}</div>}
    {summary.confirmation.length > 0 && <div style={{ color: T.textMuted }}>CME confirmation needed: {summary.confirmation.join(", ")}</div>}
    {credentialDatesCurrent && <div style={{ color: T.textMuted }}>Credential dates current</div>}
  </div>;
}
