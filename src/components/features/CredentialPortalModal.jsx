// Legacy single-use "selection" invitation UI. No longer mounted: owners now
// use Administrator access (AdministratorAccess.jsx), which offers standing,
// healthcare-only grants. Kept, with its tests, because the server still
// honours selection invitations created before that screen existed.
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";
import { CREDENTIAL_PORTAL_ENABLED, credentialPortalRequest, portalDeliveryLabel, portalDocumentEligibility, isPortalPreCreateRejection } from "../../utils/credentialPortalClient.js";

function CredentialPortalModal({ onClose, initialDocIds = [], initialTo = "" }) {
  const { data, theme: T, userIdRef } = useApp();
  const [email, setEmail] = useState(initialTo);
  const [selected, setSelected] = useState(() => new Set(initialDocIds));
  const [invites, setInvites] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(null);
  const [pendingInviteId, setPendingInviteId] = useState(null);
  const active = useRef(true);
  const owner = useRef(userIdRef.current);
  const current = useCallback(() => active.current && owner.current === userIdRef.current, [userIdRef]);
  const refresh = useCallback(async () => {
    const result = await credentialPortalRequest({ action: "list" });
    if (current()) setInvites(result.invites || []);
  }, [current]);
  useEffect(() => {
    active.current = true;
    refresh().catch(e => { if (current()) setError(e.message); });
    return () => { active.current = false; };
  }, [refresh, current]);
  const docs = data.documents || [];
  const selectedDocs = docs.filter(doc => selected.has(doc.id));
  const invalid = selectedDocs.some(portalDocumentEligibility) || selectedDocs.length !== selected.size;
  const bytes = selectedDocs.reduce((sum, doc) => sum + Number(doc.sizeBytes || doc.size || 0), 0);
  const canCreate = !busy && !pending && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && selected.size > 0 && selected.size <= 10 && !invalid && bytes <= 30 * 1024 * 1024;
  const button = { padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.card, color: T.text, cursor: "pointer", fontSize: 13 };
  const create = async () => {
    if (busy || (!pending && !canCreate)) return;
    const request = pending || { action: "create", requestId: crypto.randomUUID(), recipientEmail: email.trim(), documentIds: [...selected] };
    setPending(request); setBusy(true); setError(""); setNotice("");
    try {
      const result = await credentialPortalRequest(request);
      if (!current()) return;
      const invite = result.invite;
      if (!invite?.id) throw new Error("The response was incomplete. Retry this same invitation request to check its status.");
      setPendingInviteId(invite.id);
      setInvites(items => [invite, ...items.filter(item => item.id !== invite.id)]);
      const uncertain = !["revoked", "expired"].includes(invite.status) && ["pending", "sending", "unknown"].includes(invite.deliveryState);
      setNotice(`${portalDeliveryLabel(invite.deliveryState)}. The recipient must verify their email before accessing the selected documents.`);
      if (!uncertain) { setPending(null); setPendingInviteId(null); setSelected(new Set()); setEmail(""); }
    } catch (e) {
      if (current()) {
        if (isPortalPreCreateRejection(e)) { setPending(null); setPendingInviteId(null); setError(`${e.message} Review the email address and selected synced documents.`); }
        else setError(`${e.message} Retry uses the same request and will not create a second invitation.`);
      }
    }
    finally { if (current()) setBusy(false); }
  };
  const revoke = async id => {
    setBusy(true); setError("");
    try {
      await credentialPortalRequest({ action: "revoke", inviteId: id });
      if (!current()) return;
      setInvites(items => items.map(item => item.id === id ? { ...item, status: "revoked" } : item));
      if (pendingInviteId === id) { setPending(null); setPendingInviteId(null); setSelected(new Set()); setEmail(""); }
      setNotice("Access revoked. Copies already downloaded cannot be recalled.");
      await refresh();
    } catch (e) { if (current()) setError(e.message); }
    finally { if (current()) setBusy(false); }
  };
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Private credential access">
    <p style={{ color: T.textMuted, fontSize: 14 }}>Invite one administrator to view and download only the documents you choose. They must receive a fresh code at the invited email address.</p>
    <label style={{ display: "block", color: T.text, fontSize: 13, fontWeight: 700 }}>
      Administrator email
      <input type="email" autoComplete="off" value={email} disabled={busy || !!pending} onChange={e => setEmail(e.target.value)} style={{ display: "block", boxSizing: "border-box", width: "100%", margin: "6px 0 12px", padding: 11, borderRadius: 8, border: `1px solid ${T.border}`, background: T.input, color: T.text }} />
    </label>
    <fieldset disabled={busy || !!pending} style={{ border: `1px solid ${T.border}`, borderRadius: 10, maxHeight: 260, overflowY: "auto", padding: 10 }}>
      <legend style={{ color: T.text, fontSize: 13 }}>Documents · {selected.size} of 10 selected</legend>
      {docs.length === 0 && <p style={{ color: T.textMuted }}>Add and sync documents before inviting someone.</p>}
      {docs.map(doc => {
        const problem = portalDocumentEligibility(doc);
        return <label key={doc.id} style={{ display: "flex", alignItems: "start", gap: 8, padding: "7px 0", color: T.text, fontSize: 13 }}>
          <input type="checkbox" checked={selected.has(doc.id)} disabled={!selected.has(doc.id) && (!!problem || selected.size >= 10)} onChange={() => setSelected(values => { const next = new Set(values); if (next.has(doc.id)) next.delete(doc.id); else next.add(doc.id); return next; })} />
          <span>{doc.name || "Document"}{problem && <small style={{ display: "block", color: T.textMuted }}>{problem}</small>}</span>
        </label>;
      })}
    </fieldset>
    {!!selected.size && <button style={{ ...button, marginTop: 8 }} disabled={busy || !!pending} onClick={() => setSelected(new Set())}>Clear selection</button>}
    <p style={{ color: T.textMuted, fontSize: 12 }}>Invitation expires in 7 days. Verified access lasts up to 30 minutes. Maximum 10 MB per file and 30 MB total. Changed files require a new invitation.</p>
    <button disabled={pending ? busy : !canCreate} style={{ ...button, background: T.accent, color: "#fff", opacity: (pending ? busy : !canCreate) ? 0.5 : 1 }} onClick={create}>{busy ? "Working…" : pending ? "Retry the same invitation" : "Email private invitation"}</button>
    {pending && <p style={{ color: T.textMuted, fontSize: 12 }}>This request remains open until its outcome is known. If you close this window, check the invitations below before creating another.</p>}
    {error && <p role="alert" style={{ color: T.danger, fontSize: 13 }}>{error}</p>}
    <p role="status" style={{ color: T.text, fontSize: 13 }}>{notice}</p>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 18 }}>
      <h3 style={{ color: T.text, fontSize: 15 }}>Recent invitations</h3>
      <button style={button} disabled={busy} onClick={() => refresh().catch(e => setError(e.message))}>Refresh</button>
    </div>
    {!invites.length && <p style={{ color: T.textMuted, fontSize: 13 }}>No invitations loaded.</p>}
    {invites.map(invite => <section key={invite.id} style={{ padding: 12, border: `1px solid ${T.border}`, borderRadius: 10, marginBottom: 10, color: T.text, overflowWrap: "anywhere" }}>
      <strong style={{ fontSize: 14 }}>{invite.recipientEmail}</strong>
      <p style={{ fontSize: 12 }}>{invite.documentCount} documents · {invite.status} · {portalDeliveryLabel(invite.deliveryState)}</p>
      <p style={{ fontSize: 12 }}>Expires {new Date(invite.expiresAt).toLocaleString()}</p>
      {!["revoked", "expired"].includes(invite.status) && <button disabled={busy} style={button} onClick={() => revoke(invite.id)}>Revoke access</button>}
      {!!invite.audit?.length && <details style={{ fontSize: 12, marginTop: 8 }}><summary>Access activity</summary>
        <p>File responses record access requests; they do not prove someone read or saved a document.</p>
        <ul>{invite.audit.map((event, i) => <li key={i}>{({ invitation_created: "Invitation created", session_verified: "Recipient verified their email", invitation_revoked: "Access revoked", documents_listed: "Document list requested", document_response_prepared: "File response prepared" })[event.event] || "Access event"}{event.intent ? ` (${event.intent})` : ""} · {new Date(event.created_at).toLocaleString()}</li>)}</ul>
      </details>}
    </section>)}
  </Modal>;
}

export default function CredentialPortalLauncher({ initialDocIds, initialTo }) {
  const { theme: T, user } = useApp();
  const [open, setOpen] = useState(null);
  if (!CREDENTIAL_PORTAL_ENABLED) return null;
  return <>
    <button onClick={() => setOpen(user?.id)} style={{ width: "100%", padding: 12, margin: "8px 0", borderRadius: 10, border: `1px solid ${T.accent}`, background: T.card, color: T.accent, fontWeight: 700 }}>Private administrator access</button>
    {open && open === user?.id && <CredentialPortalModal key={open} onClose={() => setOpen(null)} initialDocIds={initialDocIds} initialTo={initialTo} />}
  </>;
}
