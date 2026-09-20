import { ACCOUNT_RECORDS_SUPPORT_REFERENCE } from "../../utils/accountRecordsLoad.js";

export default function AccountRecordsLoadError({ theme: T, onRetry }) {
  return <main style={{ minHeight: "100dvh", padding: 24, display: "grid", placeItems: "center", background: T.bg, color: T.text }}>
    <section role="alert" aria-labelledby="account-records-error-title" style={{ width: "100%", maxWidth: 440, padding: 24, borderRadius: 16, background: T.card, border: `1px solid ${T.border}` }}>
      <h1 id="account-records-error-title" style={{ fontSize: 22, margin: "0 0 12px" }}>Your records haven't finished loading</h1>
      <p style={{ color: T.textMuted, lineHeight: 1.6 }}>We couldn't load a complete copy of your account. Try again to load your saved records. Please don't re-enter or re-upload them.</p>
      <button type="button" onClick={onRetry} style={{ padding: "12px 18px", border: "none", borderRadius: 10, background: T.accent, color: "#fff", fontWeight: 700, cursor: "pointer" }}>Try again</button>
      <p style={{ color: T.textMuted, lineHeight: 1.5, fontSize: 13 }}>If this continues, <a href={`mailto:support@credentialdomd.com?subject=${ACCOUNT_RECORDS_SUPPORT_REFERENCE}`} style={{ color: T.accent }}>contact support</a> with reference <strong>{ACCOUNT_RECORDS_SUPPORT_REFERENCE}</strong>.</p>
    </section>
  </main>;
}
