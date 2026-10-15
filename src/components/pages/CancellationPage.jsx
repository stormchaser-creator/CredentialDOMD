import { useState, useRef, memo } from "react";
import { TAP_MIN } from "../shared/actionButton";
import { useApp } from "../../context/AppContext";
import { generateCredentialZip, downloadBlob } from "../../utils/credentialExport";
import { downloadDocumentBlob } from "../../lib/supabase";
import { membershipRenewalCopy, scheduledMembershipCopy } from "../../utils/membershipTiming.js";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy.js";
import RefundSection from "./RefundSection.jsx";
import { reloadPage } from "../../utils/pageLeave.js";

function CancellationPage() {
  const { data, theme: T, navigate, hasSubscription, isFreeBeta, limitedLaunch, manage } = useApp();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState(null);
  // What the refund section showed, kept across the branch change a refund
  // press causes (RefundSection's `carry`).
  const refundCarry = useRef(null);

  // Nothing to cancel: no live subscription (always the case during the free
  // beta) and no cancellation on record. Cancellation retains saved records.
  const nothingToCancel = !data.settings?.cancelledAt && (isFreeBeta || !hasSubscription);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const blob = await generateCredentialZip(data, { scope: "account", download: downloadDocumentBlob });
      const date = new Date().toISOString().split("T")[0];
      downloadBlob(blob, `CredentialDOMD_Export_${date}.zip`);
      setExported(true);
    } catch (err) {
      setError(err?.name === "PacketFilesError" ? err.message : "Export failed: " + (err.message || "Unknown error"));
    } finally {
      setExporting(false);
    }
  };

  // A paid membership says whether it renews, or when it ends after renewal
  // was cancelled in the billing portal (BILL-005). Lifetime access says so
  // instead, as the membership card does: an admin grants it only after
  // renewal is cancelled, so "will not renew ... after it ends" is false there.
  const lifetime = limitedLaunch.access?.lifetime?.credential || limitedLaunch.access?.lifetime?.practice;
  const renewalLine = membershipRenewalCopy(limitedLaunch.access);
  // A membership that was paid for: cancel now with a refund of its most
  // recent annual payment, beside cancelling at the end of the paid period.
  const paidMembership = !!limitedLaunch.access?.purchasedOfferId && !lifetime && !limitedLaunch.access?.scheduledMembership;

  if (limitedLaunch.enabled) return <section style={{ color: T.text, maxWidth: 520, margin: "0 auto" }}>
    <h1 style={{ fontSize: 22 }}>Membership and cancellation</h1>
    <p style={{ color: T.textMuted, lineHeight: 1.6 }}>A free beta does not enroll you in payment automatically. If you explicitly chose a scheduled paid membership, manage that purchase below. A Practice trial never adds a charge automatically, and founding Credential includes Practice only while that membership stays active. Your saved records remain available to view and export.</p>
    {lifetime && <p>{MEMBERSHIP_COPY.lifetimeProtected}</p>}
    {limitedLaunch.access?.scheduledMembership ? <>
      <p>{scheduledMembershipCopy(limitedLaunch.access.scheduledMembership)}</p>
      <button style={{ minHeight: TAP_MIN }} onClick={manage}>Manage scheduled membership</button>
    </> : hasSubscription ? <>
      {renewalLine && <p>{renewalLine}</p>}
      <p>Manage renewal or cancel your paid subscription in the secure billing portal. Your saved records remain available for viewing and export after membership ends.</p>
      <button style={{ minHeight: TAP_MIN }} onClick={manage}>Manage paid subscription</button>
      {paidMembership && <>
        <p style={{ marginTop: 16 }}>Or cancel now and get your money back: {MEMBERSHIP_COPY.refundTerms}</p>
        <RefundSection paid carry={refundCarry} />
      </>}
    </> : <>
      <p>No active paid subscription was found.</p>
      <RefundSection carry={refundCarry} />
    </>}
    <button style={{ marginLeft: 10, minHeight: TAP_MIN }} onClick={() => navigate("more", "export")}>Export saved records</button>
  </section>;

  if (nothingToCancel) {
    return (
      <div className="cmd-fade-in" style={{ maxWidth: 440, margin: "0 auto", textAlign: "center", padding: "32px 24px" }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: T.text, margin: "0 0 12px" }}>
          Nothing to cancel
        </h1>
        <p style={{ fontSize: 15, color: T.textMuted, lineHeight: 1.6, margin: "0 0 20px" }}>
          {isFreeBeta
            ? "You are on the free beta. There is no subscription, no card on file, and nothing scheduled for deletion. When paid plans open you will be told first."
            : "There is no active subscription on this account, so there is nothing to cancel and nothing scheduled for deletion."}
        </p>
        <p style={{ fontSize: 13, color: T.textDim, lineHeight: 1.6, margin: "0 0 24px" }}>
          Want a copy of your data anyway? Export it any time from More, then Export Data.
        </p>
        <button
          onClick={() => navigate("more", null)}
          style={{
            width: "100%", padding: "14px 24px", borderRadius: 14,
            border: `1px solid ${T.border}`, backgroundColor: T.card,
            color: T.text, fontSize: 15, fontWeight: 600, cursor: "pointer",
          }}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="cmd-fade-in" style={{ maxWidth: 440, margin: "0 auto" }}>
      {/* Header */}
      <div style={{
        textAlign: "center",
        padding: "32px 24px 24px",
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: 32,
          background: "linear-gradient(135deg, #1e293b, #334155)",
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 20px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        }}>
          <svg width={32} height={32} viewBox="0 0 24 24" fill="none">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z" fill="#64748b" />
            <path d="M15.5 8.5L12 12l-3.5-3.5" stroke="#94a3b8" strokeWidth={2} strokeLinecap="round" />
            <line x1="12" y1="12" x2="12" y2="16" stroke="#94a3b8" strokeWidth={2} strokeLinecap="round" />
          </svg>
        </div>

        <h1 style={{
          fontSize: 24, fontWeight: 800, color: T.text,
          margin: "0 0 12px",
        }}>
          Membership and cancellation
        </h1>

        <p style={{
          fontSize: 15, color: T.textMuted, lineHeight: 1.6,
          margin: "0 0 8px",
        }}>
          Your saved records stay available.
        </p>
        <p style={{
          fontSize: 15, color: T.textMuted, lineHeight: 1.6,
          margin: 0,
        }}>
          Canceling a paid membership does not delete anything. Your records and documents remain available to view and export until you choose Delete All My Data in More &gt; Data Rights.
        </p>
      </div>

      {/* Export notice */}
      <div style={{
        margin: "0 0 20px",
        padding: "16px 20px",
        backgroundColor: T.card,
        borderRadius: 12,
        border: `1px solid ${T.border}`,
        boxShadow: T.shadow1,
      }}>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
          You can download your data at any time. Your export includes all credential documents organized by type, plus a spreadsheet summary of every license, certification, and record.
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          margin: "0 0 16px",
          padding: "12px 16px",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 10,
          fontSize: 13,
          color: "#dc2626",
        }}>
          {error}
        </div>
      )}

      {/* Export Button — Primary */}
      <button
        onClick={handleExport}
        disabled={exporting}
        style={{
          width: "100%",
          padding: "16px 24px",
          borderRadius: 14,
          border: "none",
          background: exported
            ? "linear-gradient(135deg, #065f46, #047857)"
            : "linear-gradient(135deg, #10b981, #059669)",
          color: "#fff",
          fontSize: 16,
          fontWeight: 700,
          cursor: exporting ? "wait" : "pointer",
          boxShadow: "0 4px 16px rgba(16,185,129,0.35)",
          marginBottom: 12,
          opacity: exporting ? 0.7 : 1,
          transition: "opacity 0.2s",
        }}
      >
        {exporting ? "Generating export..." : exported ? "Download again" : "Export & Download My Data"}
      </button>

      {exported && (
        <div style={{
          textAlign: "center",
          fontSize: 13,
          color: "#10b981",
          fontWeight: 600,
          marginBottom: 12,
        }}>
          Export downloaded successfully
        </div>
      )}

      {/* Return to the app without changing membership or retention. */}
      <button
        onClick={() => navigate("more", null)}
        style={{
          width: "100%",
          padding: "14px 24px",
          borderRadius: 14,
          border: `1px solid ${T.border}`,
          backgroundColor: T.card,
          color: T.textMuted,
          fontSize: 15,
          fontWeight: 600,
          cursor: "pointer",
          marginBottom: 24,
          transition: "opacity 0.2s",
        }}
      >
        Back to app
      </button>

      {/* Closing note */}
      <div style={{
        textAlign: "center",
        padding: "0 24px 32px",
      }}>
        <p style={{
          fontSize: 14, color: T.textDim, lineHeight: 1.6,
          margin: 0,
        }}>
          Thank you for trusting us with your credentials.
        </p>
      </div>
    </div>
  );
}

export default memo(CancellationPage);
