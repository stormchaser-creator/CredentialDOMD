import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { useIsAdmin } from "../../lib/admin";
import { shareProbePayload } from "../../utils/shareProbe";

/**
 * Admin-only line-break test for the share sheet (tickets e8cc2a02 and
 * 821d2f76). One tap opens the share sheet with a message that labels each
 * candidate separator; the owner sends it to himself from Mail and from the
 * Gmail app and reports what arrived. The invoice share body keeps its
 * one-paragraph shape until this has been run.
 */
export default function ShareFormatProbe() {
  const { theme: T } = useApp();
  const isAdmin = useIsAdmin();
  const [status, setStatus] = useState("");
  if (!isAdmin) return null;

  const run = async (withFile) => {
    const payload = shareProbePayload({ withFile });
    if (typeof navigator === "undefined" || !navigator.share) {
      setStatus("This browser has no share sheet. Run the test from the app on your iPhone.");
      return;
    }
    if (withFile && !navigator.canShare?.({ files: payload.files })) {
      setStatus("This browser cannot attach a file to a share. Run the test from the app on your iPhone.");
      return;
    }
    setStatus("");
    try {
      await navigator.share(payload);
      setStatus(withFile
        ? "Sent with a file. Now run Text only, then report what arrived."
        : "Sent as text only. Report what arrived in each app.");
    } catch (err) {
      if (err?.name !== "AbortError") setStatus(`The share sheet did not open: ${err?.message || "unknown error"}.`);
    }
  };

  const btn = {
    flex: 1, minWidth: 140, padding: "11px 10px", borderRadius: 10, cursor: "pointer",
    border: `1px solid ${T.accent}`, backgroundColor: "transparent", color: T.accent,
    fontSize: 13.5, fontWeight: 700,
  };

  return (
    <div style={{
      marginBottom: 16, padding: "14px 16px", backgroundColor: T.card,
      border: `1px solid ${T.border}`, borderRadius: 14,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>
        Test how line breaks arrive in Mail and Gmail
      </div>
      <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 10 }}>
        Admin only. Each button opens the share sheet with a test message. Send it to yourself once
        from Mail and once from the Gmail app. In each email, note which numbered AFTER sentences start
        on a new line, and whether the Subject reads &quot;Subject from title&quot; or &quot;Subject from body&quot;.
        Put the answers on the Formatting ticket.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => run(true)} style={btn}>With a file (like an invoice)</button>
        <button onClick={() => run(false)} style={btn}>Text only</button>
      </div>
      {status && <div role="status" style={{ fontSize: 12.5, color: T.textMuted, marginTop: 8 }}>{status}</div>}
    </div>
  );
}
