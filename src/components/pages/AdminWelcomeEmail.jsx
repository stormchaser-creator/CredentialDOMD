import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import {
  WELCOME_EMAIL_FROM, WELCOME_EMAIL_REPLY_TO, WELCOME_EMAIL_SUBJECT, WELCOME_EMAIL_VERSION,
  welcomeEmailPreview, welcomeEmailFingerprint,
} from "../../utils/welcomeEmail";

const when = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "an unknown time";
};

/**
 * Admin > Emails: the welcome email a member receives after their first
 * verified payment, exactly as it is sent (src/utils/welcomeEmail.js), and
 * the owner's approval. Off until approved. "Approve and turn on" binds the
 * approval to the fingerprint of every version shown here; the server
 * refuses anyone who is not an administrator and sends only content whose
 * fingerprint matches (20260929132000_welcome_email.sql).
 *
 * The fingerprint here comes from this browser's bundle, which can be a
 * cached one, and the webhook that sends is deployed separately. So the page
 * never says "On." from the browser alone: the server reports the fingerprint
 * the deployed webhook last presented (a purchase, or its 10-minute sweep),
 * and when that is not the approved one the page says nothing is sending.
 */
export default function AdminWelcomeEmail({ T }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const preview = welcomeEmailPreview();

  useEffect(() => {
    let active = true;
    welcomeEmailFingerprint().then(
      (value) => { if (active) setFingerprint(value); },
      () => { if (active) setError("This browser could not fingerprint the email, so it cannot be approved here."); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data, error: failure } = await supabase.rpc("admin_welcome_email_status");
        if (failure) throw failure;
        if (!data || typeof data.enabled !== "boolean") throw new Error("No status was returned.");
        if (active) { setStatus(data); setError(""); }
      } catch (failure) {
        if (active) setError(failure?.message || "Could not load the welcome email status.");
      }
    })();
    return () => { active = false; };
  }, [revision]);

  const approvedHere = Boolean(status?.enabled && fingerprint && status.approvedFingerprint === fingerprint && status.approvedVersion === WELCOME_EMAIL_VERSION);
  // What the deployed webhook holds, as it last told the server.
  const sender = typeof status?.senderFingerprint === "string" ? status.senderFingerprint : "";
  const senderRefused = Boolean(status?.enabled && sender && sender !== status.approvedFingerprint);
  const short = (value) => String(value || "").slice(0, 12);

  const change = async (enabled) => {
    if (busy || (enabled && (!reviewed || !fingerprint))) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await supabase.rpc("admin_set_welcome_email", {
        p_enabled: enabled, p_fingerprint: enabled ? fingerprint : null, p_version: enabled ? WELCOME_EMAIL_VERSION : null,
      });
      if (failure) throw failure;
      if (!data || data.enabled !== enabled || (enabled && data.approvedFingerprint !== fingerprint)) {
        throw new Error("The server did not confirm the change. Refresh and check the status before trying again.");
      }
      setStatus(data); setReviewed(false);
    } catch (failure) {
      setError(failure?.message || "Could not change the welcome email.");
    } finally {
      setBusy(false);
    }
  };

  const card = { marginTop: 12, padding: 12, border: `1px solid ${T.border}`, borderRadius: 8, background: T.card, overflowWrap: "anywhere" };
  const button = { padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.card, color: T.text, fontWeight: 700, cursor: "pointer" };

  return <section aria-label="Welcome email" style={{ color: T.text }}>
    <h3>Welcome email after a paid purchase</h3>
    <p style={{ fontSize: 13, color: T.textMuted }}>
      Sent once per purchase, after the first payment is verified, to the address the member verified at sign-in. Only purchases paid while it is on, and only within 72 hours of payment. Never for gifts, free betas or unpaid checkouts. One that could not go out is tried again every 10 minutes, up to 5 times within 23 hours. Changing any word of it needs a new approval here before it sends again.
    </p>

    <div role="status" style={card}>
      {!status && !error && <span>Loading status…</span>}
      {status && (status.enabled
        ? <>
          {senderRefused
            ? <>
              <strong>On, but nothing is sending.</strong>{" "}
              {`The deployed webhook holds a different email (fingerprint ${short(sender)}, last checked ${when(status.senderCheckedAt)}) from the approved one (${short(status.approvedFingerprint)}), so every purchase is refused. `}
              {sender === fingerprint
                ? "It holds the email shown here; approve it below if it is right."
                : "Deploy limited-stripe-webhook from the same commit as the app, then reload this page."}
              {" Purchases paid while it is on are still sent once the two match, up to 72 hours after payment."}
            </>
            : <>
              <strong>{approvedHere ? "On." : "On, but not for the email shown here."}</strong>{" "}
              {approvedHere
                ? `Approved ${when(status.approvedAt)} by ${status.approvedBy || "an administrator"}.`
                : "The approved email is a different version. Nothing sends until the server's copy matches an approved email; approve the one below if it is right."}
              {sender
                ? ` The deployed webhook holds the approved email (last checked ${when(status.senderCheckedAt)}).`
                : " The deployed webhook has not reported which email it holds yet; it checks in every 10 minutes."}
            </>}
          <div style={{ marginTop: 6, fontSize: 13, color: T.textMuted }}>
            Paid purchases since it was turned on: {status.purchasesSinceOn}. Sent: {status.sent}. Not sent: {status.notSent}.
          </div>
        </>
        : <>
          <strong>Off.</strong> No welcome email is sent.
          {status.approvedAt && ` Last approved ${when(status.approvedAt)} by ${status.approvedBy || "an administrator"}.`}
          {sender && fingerprint && (sender === fingerprint
            ? " The deployed webhook holds the email shown here."
            : ` The deployed webhook holds a different email (fingerprint ${short(sender)}); deploy limited-stripe-webhook from the same commit as the app before approving.`)}
        </>)}
    </div>
    {error && <p role="alert" style={{ color: T.danger }}>{error}</p>}

    <div style={{ marginTop: 14 }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input type="checkbox" checked={reviewed} disabled={busy || approvedHere} onChange={(event) => setReviewed(event.target.checked)} />
        <span>I have read the subject and every version of the email below, exactly as members will receive it.</span>
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <button style={button} disabled={busy || approvedHere || !reviewed || !fingerprint} onClick={() => change(true)}>
          {busy ? "Saving…" : "Approve and turn on"}
        </button>
        {status?.enabled && <button style={button} disabled={busy} onClick={() => change(false)}>Turn off</button>}
        <button style={button} disabled={busy} onClick={() => setRevision((n) => n + 1)}>Refresh status</button>
      </div>
    </div>

    <div style={card}>
      <div>From: {WELCOME_EMAIL_FROM}</div>
      <div>Reply to: {WELCOME_EMAIL_REPLY_TO}</div>
      <div>Subject: <strong>{WELCOME_EMAIL_SUBJECT}</strong></div>
      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>
        Version {WELCOME_EMAIL_VERSION}{fingerprint ? `, content fingerprint ${fingerprint.slice(0, 12)}` : ""}. Shown with the sample name Jordan; a member with no usable name on their profile is greeted with "Hello," instead.
      </div>
    </div>

    {preview.map((item) => <article key={item.variant} aria-label={item.label} style={card}>
      <h4 style={{ margin: "0 0 8px" }}>{item.label}</h4>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 14, lineHeight: 1.5 }}>{item.text}</pre>
    </article>)}

    {status?.history?.length > 0 && <details style={{ marginTop: 14 }}>
      <summary>Approval history</summary>
      {status.history.map((entry, index) => <div key={index} style={{ fontSize: 13, marginTop: 6 }}>
        {entry.action === "approve" ? `Approved version ${entry.version} (${String(entry.fingerprint || "").slice(0, 12)})` : "Turned off"} {when(entry.at)} by {entry.by || "an administrator"}
      </div>)}
    </details>}
  </section>;
}
