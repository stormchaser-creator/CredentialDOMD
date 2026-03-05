import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { generateCredentialZip, downloadBlob } from "../../utils/credentialExport";
import { supabase } from "../../lib/supabase";

function CancellationPage() {
  const { data, theme: T, user, userIdRef, navigate } = useApp();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [error, setError] = useState(null);

  // Calculate days remaining from cancelled_at stored in profile
  const { daysLeft, deletionDate, cancelledAt } = useMemo(() => {
    const ca = data.settings?.cancelledAt;
    if (!ca) return { daysLeft: 7, deletionDate: null, cancelledAt: null };
    const cancelled = new Date(ca);
    const deletion = new Date(cancelled.getTime() + 7 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const remaining = Math.max(0, Math.ceil((deletion - now) / (24 * 60 * 60 * 1000)));
    return { daysLeft: remaining, deletionDate: deletion, cancelledAt: ca };
  }, [data.settings?.cancelledAt]);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const blob = await generateCredentialZip(data);
      const date = new Date().toISOString().split("T")[0];
      downloadBlob(blob, `CredentialDOMD_Export_${date}.zip`);
      setExported(true);
    } catch (err) {
      setError("Export failed: " + (err.message || "Unknown error"));
    } finally {
      setExporting(false);
    }
  };

  const handleReactivate = async () => {
    setReactivating(true);
    setError(null);
    try {
      if (supabase && userIdRef.current) {
        await supabase
          .from("profiles")
          .update({
            cancelled_at: null,
            data_deletion_date: null,
          })
          .eq("id", userIdRef.current);
      }
      // Clear local cancellation state
      navigate("more", null);
      window.location.reload();
    } catch (err) {
      setError("Reactivation failed: " + (err.message || "Unknown error"));
    } finally {
      setReactivating(false);
    }
  };

  const countdownColor = daysLeft <= 2 ? "#ef4444" : daysLeft <= 4 ? "#f59e0b" : "#10b981";

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
          Hate to see you go
        </h1>

        <p style={{
          fontSize: 15, color: T.textMuted, lineHeight: 1.6,
          margin: "0 0 8px",
        }}>
          We understand — and we don't want to leave you hanging.
        </p>
        <p style={{
          fontSize: 15, color: T.textMuted, lineHeight: 1.6,
          margin: 0,
        }}>
          Your credentials will be available for export for the <strong style={{ color: T.text }}>next {daysLeft} day{daysLeft !== 1 ? "s" : ""}</strong>. After that, they'll be permanently wiped from our system.
        </p>
      </div>

      {/* Countdown */}
      <div style={{
        margin: "0 0 20px",
        padding: "20px 24px",
        backgroundColor: T.card,
        borderRadius: 16,
        border: `1px solid ${T.border}`,
        boxShadow: T.shadow1,
        textAlign: "center",
      }}>
        <div style={{
          fontSize: 48, fontWeight: 900, color: countdownColor,
          lineHeight: 1,
          marginBottom: 4,
        }}>
          {daysLeft}
        </div>
        <div style={{
          fontSize: 14, fontWeight: 600, color: T.textMuted,
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          {daysLeft === 1 ? "day remaining" : "days remaining"}
        </div>
        {deletionDate && (
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 8 }}>
            Data deletion scheduled: {deletionDate.toLocaleDateString("en-US", {
              month: "long", day: "numeric", year: "numeric",
            })}
          </div>
        )}
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
          Please download your data before then. Your export includes all credential documents organized by type, plus a spreadsheet summary of every license, certification, and record.
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

      {/* Reactivate Button — Secondary */}
      <button
        onClick={handleReactivate}
        disabled={reactivating}
        style={{
          width: "100%",
          padding: "14px 24px",
          borderRadius: 14,
          border: `1px solid ${T.border}`,
          backgroundColor: T.card,
          color: T.textMuted,
          fontSize: 15,
          fontWeight: 600,
          cursor: reactivating ? "wait" : "pointer",
          marginBottom: 24,
          opacity: reactivating ? 0.7 : 1,
          transition: "opacity 0.2s",
        }}
      >
        {reactivating ? "Reactivating..." : "I've changed my mind -- keep my account"}
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
