import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";
import { createAdminLifetimeAccessClient } from "../../utils/adminLifetimeAccessClient";

export default function AdminLifetimeAccess({ target, onClose, onGranted }) {
  const { user, theme } = useApp();
  if (!target || !user?.id) return null;
  return <LifetimeAccessForTarget key={`${user.id}:${target.id}:${target.auth_user_id}`} accountId={user.id}
    target={target} theme={theme} onClose={onClose} onGranted={onGranted} />;
}

function LifetimeAccessForTarget({ accountId, target, theme: T, onClose, onGranted }) {
  const [review, setReview] = useState(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const lifecycle = useRef({ mounted: false, generation: 0 });
  const inFlight = useRef(false);
  const client = useMemo(() => createAdminLifetimeAccessClient({ accountId, isCurrent: () => lifecycle.current.mounted }), [accountId]);
  useEffect(() => {
    const owned = lifecycle.current;
    owned.mounted = true;
    const generation = ++owned.generation;
    const current = () => owned.mounted && generation === owned.generation;
    client.review({ profileId: target.id, clerkSubject: target.auth_user_id })
      .then(value => { if (current()) setReview(value); })
      .catch(e => { if (current()) setError(e.message); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { owned.mounted = false; owned.generation++; };
  }, [client, target.id, target.auth_user_id]);

  const close = () => { lifecycle.current.mounted = false; lifecycle.current.generation++; onClose(); };
  const grant = async () => {
    if (inFlight.current || !review?.canGrant || !confirmed || reason.trim().length < 10) return;
    if (Date.parse(review.expiresAt) <= Date.now() && !submitted) {
      setError("This account review expired. Close this dialog and review the account again."); return;
    }
    const generation = lifecycle.current.generation;
    const current = () => lifecycle.current.mounted && generation === lifecycle.current.generation
      && window.Clerk?.user?.id === accountId;
    if (!current()) return;
    inFlight.current = true; setBusy(true); setSubmitted(true); setError("");
    try {
      const value = await client.grant(review, { reason, confirmed: true });
      if (!current()) return;
      setResult(value);
      onGranted?.(value);
    } catch (e) { if (current()) setError(e.message); }
    finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const bothLifetime = review?.lifetime.credential && review?.lifetime.practice;
  const label = { display: "block", fontWeight: 700, marginBottom: 6 };
  const action = { borderRadius: 9, padding: "12px 16px", minHeight: 44, border: `1px solid ${T.border}`, cursor: "pointer" };
  const canSubmit = review?.canGrant && confirmed && reason.trim().length >= 10 && !busy;
  return <Modal open onClose={close} title="Give free lifetime access" width={600}>
    <div style={{ color: T.text, fontSize: 14, lineHeight: 1.6 }}>
      {loading && <p role="status">Checking the registered account and its membership…</p>}
      {error && <p role="alert" style={{ color: T.danger || "#ef4444" }}>{error}</p>}
      {review && <>
        <p style={{ marginTop: 0 }}>Review this verified account before giving Credential and Practice free for life.</p>
        <div style={{ background: T.input, padding: 12, borderRadius: 10, overflowWrap: "anywhere" }}>
          <strong>{review.target.name || "Registered account"}</strong>
          <div>Verified email: {review.target.verifiedPrimaryEmail}</div>
          <div style={{ color: T.textMuted, fontSize: 12 }}>Account: {review.target.profileId}</div>
          <div style={{ color: T.textMuted, fontSize: 12 }}>Sign-in identity: {review.target.clerkSubject}</div>
        </div>
        {result ? <div role="status">
          <p><strong>Credential and Practice are free for life for this account.</strong></p>
          <p>No card, checkout, subscription, or email was created.</p>
          <p>The member can refresh their app to load the new access.</p>
          <p style={{ fontSize: 12, color: T.textMuted }}>Recorded {new Date(result.grantedAt).toLocaleString()}. Grant: {result.grantId}</p>
        </div> : bothLifetime ? <p role="status">This account already has Credential and Practice free for life. No new grant is needed.</p> : <>
          {(review.lifetime.credential || review.lifetime.practice) && <p>Existing lifetime access is preserved. This grant adds lifetime access for both products.</p>}
          <p>{review.billing.notice}</p>
          {!review.canGrant ? <p role="status">Lifetime access cannot be granted until this account is eligible. No access or billing was changed.</p> : <>
            <p>No card or checkout is required. This action records your reason and does not send an email.</p>
            <label style={label} htmlFor="lifetime-grant-reason">Reason for the lifetime grant</label>
            <textarea id="lifetime-grant-reason" value={reason} onChange={event => setReason(event.target.value)}
              rows={3} minLength={10} maxLength={500} disabled={submitted} aria-describedby="lifetime-reason-help"
              style={{ width: "100%", boxSizing: "border-box", font: "inherit", color: T.text, background: T.input, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10 }} />
            <p id="lifetime-reason-help" style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>10–500 characters. Saved in the administrative audit record.</p>
            {review.billing.hasExistingSubscription && <p>This action does not cancel, change, or refund a subscription.</p>}
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "14px 0" }}>
              <input type="checkbox" checked={confirmed} disabled={submitted} onChange={event => setConfirmed(event.target.checked)} />
              <span>Give this verified account both Credential and Practice free for life.</span>
            </label>
            {submitted && !busy && <p style={{ fontSize: 12, color: T.textMuted }}>Retry uses the same account, reason, and request. Close and review the account again to check its current access.</p>}
            <button type="button" disabled={!canSubmit} onClick={grant} style={{ ...action, background: canSubmit ? T.accent : T.input, color: canSubmit ? "#fff" : T.textMuted, fontWeight: 700 }}>
              {busy ? "Recording lifetime access…" : submitted ? "Retry the same grant" : "Give free lifetime access"}
            </button>
          </>}
        </>}
      </>}
      <div style={{ marginTop: 18 }}><button type="button" onClick={close} style={{ ...action, background: T.card, color: T.text }}>{result ? "Done" : "Close"}</button></div>
    </div>
  </Modal>;
}
