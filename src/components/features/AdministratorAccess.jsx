// Administrator access: give a medical staff office or credentialing
// administrator a standing, view-only link to the healthcare credentials the
// physician chooses. The server (credential-portal, credential_portal_records)
// decides what is shareable; this screen only offers the same catalog
// (credentialPortalView.mjs) and shows the server's own preview.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import {
  CREDENTIAL_PORTAL_ENABLED, credentialPortalRequest, portalDeliveryLabel, adminAccessErrorMessage, isAdminAccessRejection, standingGrantRequest,
} from "../../utils/credentialPortalClient.js";
import { useAdministratorAccessStatus } from "../../hooks/useAdministratorAccessStatus.js";
import { documentActivity, formatDay, formatMoment } from "../../utils/administratorAccess.js";
import {
  ADMIN_ACCESS_POLICY, ADMIN_ACCESS_SECTIONS, ADMIN_ACCESS_DEFAULT_SECTIONS, ADMIN_ACCESS_NEVER_SHARED, viewCounts,
} from "../../../supabase/functions/_shared/credentialPortalView.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECTION_LABEL = Object.fromEntries(ADMIN_ACCESS_SECTIONS.map(s => [s.key, s.label]));
const STATUS_LABEL = {
  active: "Active", expired: "Ended", revoked: "Revoked", redeemed: "Used", pending: "Waiting",
  locked: "Locked after too many wrong codes. Send a new link to unlock it.",
};
const EVENT_LABEL = {
  invitation_created: "Access created", session_verified: "Visit started", summary_listed: "Opened the file",
  documents_listed: "Listed files", invitation_revoked: "Access revoked", link_resent: "New link sent", grant_updated: "Access changed",
};

const emptyForm = () => ({
  email: "", purpose: "", days: ADMIN_ACCESS_POLICY.defaultDays, allowDownload: true,
  sections: new Set(ADMIN_ACCESS_DEFAULT_SECTIONS), customCategories: new Set(),
});
const scopeKey = (sections, customCategories) => JSON.stringify([[...sections].sort(), [...customCategories].sort()]);

/** Entry on Quick Share and More. Renders nothing unless the server offers it. */
export function AdministratorAccessEntry({ onOpen, variant = "more" }) {
  const { theme: T } = useApp();
  const available = useAdministratorAccessStatus();
  if (!available) return null;
  if (variant === "share") {
    return <button type="button" onClick={onOpen} style={{ width: "100%", padding: 12, margin: "8px 0 14px", borderRadius: 10, border: `1px solid ${T.accent}`, background: T.card, color: T.accent, fontWeight: 700, textAlign: "left", cursor: "pointer" }}>
      Administrator access
      <span style={{ display: "block", fontWeight: 400, fontSize: 13, color: T.textMuted, marginTop: 2 }}>Give a medical staff office a view-only link to your credential file</span>
    </button>;
  }
  return <button type="button" onClick={onOpen} className="cmd-card-hover" style={{ display: "flex", alignItems: "center", gap: 12, backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%", boxShadow: T.shadow1 }}>
    <span style={{ fontSize: 20 }}>{"\u{1F5C2}\u{FE0F}"}</span>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Administrator access</div>
      <div style={{ fontSize: 13, color: T.textDim }}>View-only links for medical staff offices</div>
    </div>
    <span style={{ color: T.textDim }}>{"\u{203a}"}</span>
  </button>;
}

/** Exactly what the server says the administrator will see. */
export function AdministratorPreview({ view, allowDownload }) {
  const { theme: T } = useApp();
  const p = view.physician || {};
  const states = [p.primaryState ? `${p.primaryState} (primary)` : "", ...(p.additionalStates || []).filter(s => s !== p.primaryState)].filter(Boolean);
  return <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginTop: 12, background: T.card }}>
    <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>What the administrator sees</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginTop: 6 }}>{[p.name, p.degreeType].filter(Boolean).join(", ") || "Your name is missing"}</div>
    <div style={{ fontSize: 13, color: T.textMuted }}>{[p.npi ? `NPI ${p.npi}` : "", (p.specialties || []).join(", "), states.length ? `Licensed in ${states.join(", ")}` : "", p.email].filter(Boolean).join(" \u{b7} ")}</div>
    {!view.sections?.length && <p style={{ color: T.textMuted, fontSize: 13 }}>Nothing would be shared with these choices.</p>}
    {(view.sections || []).map(section => <div key={section.key} style={{ marginTop: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{section.label} ({section.records.length})</div>
      {section.records.map(record => <div key={record.id} style={{ borderTop: `1px solid ${T.border}`, padding: "8px 0", fontSize: 13, color: T.text }}>
        <strong>{record.title}</strong>{record.expirationDate && <span style={{ color: T.textMuted }}> {"\u{b7}"} expires {formatDay(`${record.expirationDate}T12:00:00`)}</span>}
        {!!record.fields.length && <div style={{ color: T.textMuted }}>{record.fields.map(f => `${f.label}: ${f.value}`).join(" \u{b7} ")}</div>}
        {record.documents.map(d => <div key={d.id} style={{ color: T.text, paddingLeft: 10 }}>{"\u{1F4C4}"} {d.name} <span style={{ color: T.textMuted }}>({allowDownload ? "preview and download" : "preview only"})</span></div>)}
      </div>)}
    </div>)}
  </div>;
}

export default function AdministratorAccessPage() {
  const { data, theme: T, userIdRef, offlineMode } = useApp();
  const available = useAdministratorAccessStatus();
  const [form, setForm] = useState(emptyForm);
  const [grants, setGrants] = useState([]);
  const [counts, setCounts] = useState(null);
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [newEnd, setNewEnd] = useState({});
  const active = useRef(true);
  const owner = useRef(userIdRef.current);
  const current = useCallback(() => active.current && owner.current === userIdRef.current, [userIdRef]);
  const categories = useMemo(() => (data.customCategories || [])
    .filter(c => c && typeof c.id === "string" && UUID.test(c.id) && !c.archivedAt)
    .map(c => ({ id: c.id, name: c.name || "Untitled category", icon: c.icon || "" })), [data.customCategories]);
  const categoryIds = categories.map(c => c.id).join(",");
  const categoryName = useMemo(() => Object.fromEntries(categories.map(c => [c.id, c.name])), [categories]);

  const refresh = useCallback(async () => {
    const result = await credentialPortalRequest({ action: "list" });
    if (current()) setGrants(result.invites || []);
  }, [current]);
  useEffect(() => {
    active.current = true;
    if (available) refresh().catch(e => { if (current()) setError(adminAccessErrorMessage(e)); });
    return () => { active.current = false; };
  }, [available, refresh, current]);
  // Live counts from the server's own allowlist (a driver's license filed as a
  // license is not counted, because it would not be shared).
  useEffect(() => {
    if (!available) return;
    const ids = categoryIds ? categoryIds.split(",") : [];
    credentialPortalRequest({ action: "preview", sections: ADMIN_ACCESS_SECTIONS.map(s => s.key), customCategories: ids })
      .then(result => { if (current()) setCounts(viewCounts(result)); })
      .catch(() => { if (current()) setCounts(null); });
  }, [available, categoryIds, current]);

  const formScope = scopeKey(form.sections, form.customCategories);
  const scopeChosen = form.sections.size + form.customCategories.size > 0;
  const purpose = form.purpose.replace(/\s+/g, " ").trim();
  const canCreate = !busy && EMAIL.test(form.email.trim()) && purpose.length >= 1 && purpose.length <= ADMIN_ACCESS_POLICY.purposeMax && scopeChosen;
  const edit = patch => { if (!pending && !busy) setForm(f => ({ ...f, ...patch })); };
  const toggle = (field, key) => { if (!pending && !busy) setForm(f => { const next = new Set(f[field]); if (next.has(key)) next.delete(key); else next.add(key); return { ...f, [field]: next }; }); };

  const runPreview = async () => {
    setBusy(true); setError("");
    try {
      const result = await credentialPortalRequest({ action: "preview", sections: [...form.sections].sort(), customCategories: [...form.customCategories].sort() });
      if (current()) setPreview({ scope: formScope, view: result, allowDownload: form.allowDownload });
    } catch (e) { if (current()) setError(adminAccessErrorMessage(e)); }
    finally { if (current()) setBusy(false); }
  };
  const create = async () => {
    if (busy || (!pending && !canCreate)) return;
    const body = pending || standingGrantRequest(form, crypto.randomUUID());
    setPending(body); setBusy(true); setError(""); setNotice("");
    try {
      const result = await credentialPortalRequest(body);
      if (!current()) return;
      const invite = result.invite;
      if (!invite?.id) throw new Error("The response was incomplete. Retry to check its status.");
      setGrants(items => [invite, ...items.filter(item => item.id !== invite.id)]);
      setNotice(`Access created for ${invite.recipientEmail}. The link is on its way and works until ${formatDay(invite.expiresAt)}.`);
      setPending(null); setForm(emptyForm()); setPreview(null);
    } catch (e) {
      if (!current()) return;
      if (isAdminAccessRejection(e)) { setPending(null); setError(adminAccessErrorMessage(e)); }
      else setError(`${adminAccessErrorMessage(e)} Retrying sends the same request, so it cannot create a second link.`);
    } finally { if (current()) setBusy(false); }
  };
  const act = async (body, success) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await credentialPortalRequest(body);
      if (!current()) return;
      if (result.invite) setGrants(items => items.map(item => item.id === result.invite.id ? result.invite : item));
      setNotice(success);
      await refresh();
    } catch (e) { if (current()) setError(adminAccessErrorMessage(e)); }
    finally { if (current()) setBusy(false); }
  };
  const revoke = grant => {
    if (typeof window !== "undefined" && window.confirm && !window.confirm(`End ${grant.recipientEmail}'s access now? Files they already downloaded stay with them.`)) return;
    return act({ action: "revoke", inviteId: grant.id }, "Access ended. The link no longer works.");
  };
  const saveNarrow = () => {
    const grant = grants.find(g => g.id === editing.id);
    const body = { action: "update", inviteId: editing.id, sections: [...editing.sections].sort(), customCategories: [...editing.customCategories].sort() };
    if (grant?.allowDownload && !editing.allowDownload) body.allowDownload = false;
    setEditing(null);
    return act(body, "Access narrowed. It applies to their very next page load.");
  };

  const button = { padding: "9px 12px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.card, color: T.text, cursor: "pointer", fontSize: 13 };
  const input = { display: "block", boxSizing: "border-box", width: "100%", margin: "6px 0 12px", padding: 11, borderRadius: 8, border: `1px solid ${T.inputBorder || T.border}`, background: T.input, color: T.text, fontSize: 16 };
  const label = { display: "block", color: T.text, fontSize: 13, fontWeight: 700 };
  const hint = { color: T.textMuted, fontSize: 12, margin: "2px 0 0" };
  const countText = key => { const c = counts?.[key]; return c ? `${c.records} record${c.records === 1 ? "" : "s"}${c.files ? `, ${c.files} file${c.files === 1 ? "" : "s"}` : ""}` : counts ? "Nothing to share yet" : ""; };
  const sectionBox = (section, field = "sections", key = section.key, title = section.label, detail = section.hint) => <label key={key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderTop: `1px solid ${T.border}`, color: T.text, fontSize: 14 }}>
    <input type="checkbox" data-section={field === "sections" ? key : `custom:${key}`} checked={form[field].has(key)} disabled={busy || !!pending} onChange={() => toggle(field, key)} style={{ marginTop: 3 }} />
    <span style={{ flex: 1 }}>
      <span style={{ fontWeight: 600 }}>{title}</span>
      {countText(field === "sections" ? key : `custom:${key}`) && <span style={{ color: T.textMuted, fontSize: 12 }}> {"\u{b7}"} {countText(field === "sections" ? key : `custom:${key}`)}</span>}
      {detail && <span style={{ ...hint, display: "block" }}>{detail}</span>}
    </span>
  </label>;

  if (!CREDENTIAL_PORTAL_ENABLED || !available) {
    return <div><h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: T.text }}>Administrator access</h2>
      <p style={{ color: T.textMuted, fontSize: 14 }}>{offlineMode ? "Administrator access needs a connection." : "Administrator access is not available for this account yet."}</p></div>;
  }
  const previewCurrent = preview && preview.scope === formScope;
  return <div>
    <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>Administrator access</h2>
    <p style={{ margin: "0 0 14px", fontSize: 14, color: T.textMuted }}>Give a medical staff office or credentialing administrator one private link to the credentials you choose. Each time they open it they get a new code by email. They see your records as they are that day, until the end date you pick.</p>

    <section style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, background: T.card, boxShadow: T.shadow1 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 16, color: T.text }}>New access link</h3>
      <label style={label}>Administrator email
        <input type="email" autoComplete="off" value={form.email} disabled={busy || !!pending} onChange={e => edit({ email: e.target.value })} style={input} />
      </label>
      <label style={label}>Facility or office
        <input type="text" maxLength={ADMIN_ACCESS_POLICY.purposeMax} placeholder="Medical staff office, Mercy Hospital" value={form.purpose} disabled={busy || !!pending} onChange={e => edit({ purpose: e.target.value })} style={input} />
      </label>
      <label style={label}>Access ends after
        <select value={form.days} disabled={busy || !!pending} onChange={e => edit({ days: Number(e.target.value) })} style={input}>
          {ADMIN_ACCESS_POLICY.durations.map(days => <option key={days} value={days}>{days} days</option>)}
        </select>
      </label>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", color: T.text, fontSize: 14, margin: "4px 0 12px" }}>
        <input type="checkbox" data-control="allow-download" checked={form.allowDownload} disabled={busy || !!pending} onChange={() => edit({ allowDownload: !form.allowDownload })} style={{ marginTop: 3 }} />
        <span><strong>Allow downloads</strong><span style={{ ...hint, display: "block" }}>Administrators usually file copies in their own system. Turn this off to allow preview only.</span></span>
      </label>

      <fieldset disabled={busy || !!pending} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ ...label, marginBottom: 4 }}>Sections to share</legend>
        {ADMIN_ACCESS_SECTIONS.filter(s => !s.optIn).map(s => sectionBox(s))}
        <div style={{ ...label, marginTop: 14 }}>Only if you turn them on</div>
        {ADMIN_ACCESS_SECTIONS.filter(s => s.optIn).map(s => sectionBox(s))}
        {!!categories.length && <>
          <div style={{ ...label, marginTop: 14 }}>Your categories</div>
          <p style={hint}>Off unless you turn one on. Each category is shared on its own.</p>
          {categories.map(c => sectionBox(c, "customCategories", c.id, `${c.icon ? `${c.icon} ` : ""}${c.name}`, null))}
        </>}
      </fieldset>

      <p style={{ fontSize: 13, color: T.text, margin: "14px 0 6px" }}><strong>Never shared:</strong> {ADMIN_ACCESS_NEVER_SHARED}.</p>
      <p style={{ fontSize: 13, color: T.textMuted, margin: "0 0 12px" }}>View only: the administrator cannot change anything. Anything shown on screen can still be photographed or captured in a screenshot, and downloaded copies stay with them after access ends.</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" style={button} disabled={busy || !scopeChosen} onClick={runPreview}>Preview as administrator</button>
        <button type="button" disabled={pending ? busy : !canCreate} onClick={create} style={{ ...button, background: T.accent, color: "#fff", border: `1px solid ${T.accent}`, opacity: (pending ? busy : !canCreate) ? 0.5 : 1 }}>{busy && pending ? "Working..." : pending ? "Retry the same request" : "Send access link"}</button>
      </div>
      {preview && !previewCurrent && <p style={hint}>Your choices changed since this preview. Preview again to see the current result.</p>}
      {preview && <AdministratorPreview view={preview.view} allowDownload={preview.allowDownload} />}
    </section>

    {error && <p role="alert" style={{ color: T.danger, fontSize: 13 }}>{error}</p>}
    <p role="status" style={{ color: T.text, fontSize: 13 }}>{notice}</p>

    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 18 }}>
      <h3 style={{ color: T.text, fontSize: 16, margin: 0 }}>Access you have given</h3>
      <button type="button" style={button} disabled={busy} onClick={() => refresh().catch(e => setError(adminAccessErrorMessage(e)))}>Refresh</button>
    </div>
    {!grants.length && <p style={{ color: T.textMuted, fontSize: 13 }}>No administrator access yet.</p>}
    {grants.map(grant => {
      const live = grant.kind === "standing" && ["active", "locked"].includes(grant.status);
      const files = documentActivity(grant.audit);
      const visits = (grant.audit || []).filter(e => e.event === "session_verified").length;
      const scope = grant.scope || {};
      const shared = [...(scope.sections || []).map(k => SECTION_LABEL[k] || k), ...(scope.customCategories || []).map(id => categoryName[id] || "A category you removed")];
      return <section key={grant.id} style={{ padding: 12, border: `1px solid ${T.border}`, borderRadius: 10, marginTop: 10, color: T.text, overflowWrap: "anywhere", background: T.card }}>
        <strong style={{ fontSize: 14 }}>{grant.recipientEmail}</strong>
        {grant.purpose && <div style={{ fontSize: 13 }}>{grant.purpose}</div>}
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
          {STATUS_LABEL[grant.status] || grant.status} {"\u{b7}"} {grant.status === "expired" || grant.status === "revoked" ? "ended" : "ends"} {formatDay(grant.expiresAt)} {"\u{b7}"} {grant.lastVisitAt ? `last visit ${formatMoment(grant.lastVisitAt)}` : "no visits yet"}
          {grant.kind === "standing" && <> {"\u{b7}"} downloads {grant.allowDownload ? "on" : "off"}</>} {"\u{b7}"} {portalDeliveryLabel(grant.deliveryState)}
        </div>
        {grant.kind === "standing" ? <div style={{ fontSize: 12, color: T.textMuted }}>Shares: {shared.join(", ") || "nothing"}</div>
          : <div style={{ fontSize: 12, color: T.textMuted }}>Older single-use invitation for {grant.documentCount} selected document{grant.documentCount === 1 ? "" : "s"}.</div>}

        {live && editing?.id !== grant.id && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
          <button type="button" style={button} disabled={busy} onClick={() => revoke(grant)}>Revoke</button>
          <button type="button" style={button} disabled={busy} onClick={() => act({ action: "resend-link", inviteId: grant.id }, `A new link is on its way to ${grant.recipientEmail}. The old link no longer works.`)}>Resend link</button>
          <button type="button" style={button} disabled={busy} onClick={() => setEditing({ id: grant.id, sections: new Set(scope.sections || []), customCategories: new Set(scope.customCategories || []), allowDownload: grant.allowDownload })}>Narrow</button>
          <select aria-label="New end date" value={newEnd[grant.id] || ""} disabled={busy} onChange={e => setNewEnd(v => ({ ...v, [grant.id]: Number(e.target.value) || "" }))} style={{ ...button, padding: "8px 10px" }}>
            <option value="">Change end date</option>
            {ADMIN_ACCESS_POLICY.durations.map(days => <option key={days} value={days}>{days} days from today</option>)}
          </select>
          {!!newEnd[grant.id] && <button type="button" style={button} disabled={busy} onClick={() => { const days = newEnd[grant.id]; setNewEnd(v => ({ ...v, [grant.id]: "" })); act({ action: "update", inviteId: grant.id, accessDays: days }, `Access now ends ${formatDay(Date.now() + days * 86400000)}.`); }}>Save end date</button>}
        </div>}
        {!live && grant.kind !== "standing" && !["revoked", "expired"].includes(grant.status) && <button type="button" style={{ ...button, marginTop: 10 }} disabled={busy} onClick={() => revoke(grant)}>Revoke</button>}

        {editing?.id === grant.id && <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
          <p style={hint}>Remove sections or turn downloads off. Adding anything back needs a new link.</p>
          {(scope.sections || []).map(key => <label key={key} style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
            <input type="checkbox" data-narrow={key} checked={editing.sections.has(key)} onChange={() => setEditing(e => { const next = new Set(e.sections); if (next.has(key)) next.delete(key); else next.add(key); return { ...e, sections: next }; })} />{SECTION_LABEL[key] || key}
          </label>)}
          {(scope.customCategories || []).map(id => <label key={id} style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
            <input type="checkbox" data-narrow={`custom:${id}`} checked={editing.customCategories.has(id)} onChange={() => setEditing(e => { const next = new Set(e.customCategories); if (next.has(id)) next.delete(id); else next.add(id); return { ...e, customCategories: next }; })} />{categoryName[id] || "A category you removed"}
          </label>)}
          {grant.allowDownload && <label style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0" }}>
            <input type="checkbox" checked={editing.allowDownload} onChange={() => setEditing(e => ({ ...e, allowDownload: !e.allowDownload }))} />Allow downloads
          </label>}
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" style={button} disabled={busy || editing.sections.size + editing.customCategories.size === 0} onClick={saveNarrow}>Save</button>
            <button type="button" style={button} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
          {editing.sections.size + editing.customCategories.size === 0 && <p style={hint}>To share nothing, revoke the access instead.</p>}
        </div>}

        {(files.length > 0 || visits > 0) && <details style={{ fontSize: 12, marginTop: 8 }}>
          <summary>Activity: {visits} visit{visits === 1 ? "" : "s"}, {files.length} file{files.length === 1 ? "" : "s"} opened</summary>
          <p style={hint}>File activity means a file was sent to their browser. It does not prove someone read it.</p>
          <ul style={{ paddingLeft: 18 }}>{files.map(f => <li key={f.name + f.last}>{f.name}: {[f.views ? `previewed ${f.views}` : "", f.downloads ? `downloaded ${f.downloads}` : "", f.refused ? `download refused ${f.refused}` : ""].filter(Boolean).join(", ")} {"\u{b7}"} last {formatMoment(f.last)}</li>)}</ul>
          <ul style={{ paddingLeft: 18 }}>{(grant.audit || []).filter(e => EVENT_LABEL[e.event]).slice(0, 20).map((e, i) => <li key={i}>{EVENT_LABEL[e.event]} {"\u{b7}"} {formatMoment(e.createdAt)}</li>)}</ul>
        </details>}
      </section>;
    })}
  </div>;
}
