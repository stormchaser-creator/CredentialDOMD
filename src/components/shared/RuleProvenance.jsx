import { memo, useCallback, useState } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "./useInputStyle";
import Modal from "./Modal";
import Field from "./Field";
import { supabase } from "../../lib/supabase";
import { safeHttpUrl } from "../../utils/safeUrl";

/**
 * Provenance line for a rule set (state CME or board MOC) plus a one-tap
 * "Rules changed?" report.
 *
 *   Source: <citation> · database Feb 2026 · verified Aug 2026   [Rules changed?]
 *   Coming: <upcoming rule> · <upcoming rule>
 *
 * The citation is a link when the rule set carries `sourceUrl` (the best
 * primary-source page loaded at the last recheck). `upcoming` lists rules
 * that are enacted or pending but not yet in force.
 *
 * The report lands in the founder's review queue (public.field_proposals,
 * the same table the assistant's new-field proposals use; RLS lets any
 * signed-in user insert). If that insert fails, it falls back to a support
 * ticket through the create-ticket edge function.
 *
 * Row shape written to field_proposals:
 *   section: "rule_change:<key>"     e.g. rule_change:CA, rule_change:board:ABNS
 *   label:   "<subject> rule change: <what changed, first 140 chars>"
 *   sample:  "Link: <url or none> | On file: <citation> | database <YYYY-MM>, verified <YYYY-MM or not yet>"
 *   user_id: profile id (null when unknown)
 *   status:  "pending" (column default)
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-02" -> "Feb 2026"; anything unparseable is returned as-is. */
function formatMonth(ym) {
  if (!ym) return "";
  const m = /^(\d{4})-(\d{2})/.exec(String(ym));
  if (!m) return String(ym);
  const idx = parseInt(m[2], 10) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]} ${m[1]}` : String(ym);
}

async function submitRuleChange({ reportKey, subject, citation, meta, verified, what, link, uid }) {
  const label = `${subject} rule change: ${what.slice(0, 140)}`;
  const sample = [
    `Link: ${link || "none"}`,
    `On file: ${citation || "no citation on file"}`,
    `database ${meta?.databaseDate || "?"}, verified ${verified || "not yet"}`,
  ].join(" | ");
  const row = { section: `rule_change:${reportKey}`, label, sample: sample.slice(0, 600), user_id: uid || null };

  if (!supabase) throw new Error("Not connected. Try again when you are back online.");

  const ins = await supabase.from("field_proposals").insert(row);
  if (!ins.error) return { via: "field_proposals" };

  // Fallback: a support ticket. The deployed create-ticket function only
  // accepts its fixed category list, so the report goes in as "compliance"
  // with a [Rule change] subject prefix.
  const res = await supabase.functions.invoke("create-ticket", {
    body: {
      subject: `[Rule change] ${subject}`.slice(0, 120),
      body: `${what}\n\n${sample}`,
      category: "compliance",
      priority: "normal",
      context_page: "cme",
    },
  });
  if (res.error) throw new Error(ins.error.message || res.error.message || "Could not send the report.");
  return { via: "ticket" };
}

function RuleProvenance({ reportKey, subject, citation, meta, verified, sourceUrl, upcoming, compact = false, style }) {
  const { theme: T, userIdRef } = useApp();
  const iS = useInputStyle();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const close = useCallback(() => { setOpen(false); setError(""); }, []);
  const openForm = useCallback(() => { setSent(false); setError(""); setOpen(true); }, []);

  const send = useCallback(async () => {
    const text = what.trim();
    if (text.length < 8) { setError("Say what changed, at least a few words."); return; }
    setBusy(true); setError("");
    try {
      await submitRuleChange({ reportKey, subject, citation, meta, verified, what: text, link: link.trim(), uid: userIdRef?.current });
      setSent(true);
      setWhat(""); setLink("");
      setTimeout(() => setOpen(false), 1400);
    } catch (e) {
      setError(e.message || "Could not send the report.");
    } finally {
      setBusy(false);
    }
  }, [what, link, reportKey, subject, citation, meta, verified, userIdRef]);

  const href = safeHttpUrl(sourceUrl);
  const citationText = citation || "not on file";
  const trailing = [
    meta?.databaseDate ? `database ${formatMonth(meta.databaseDate)}` : null,
    verified ? `verified ${formatMonth(verified)}` : null,
  ].filter(Boolean);
  const coming = (Array.isArray(upcoming) ? upcoming : []).map(u => String(u || "").trim()).filter(Boolean);

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap",
      marginTop: compact ? 6 : 8, paddingTop: compact ? 0 : 8,
      borderTop: compact ? "none" : `1px dashed ${T.border}`,
      ...style,
    }}>
      <div style={{ fontSize: 11, color: T.textDim, lineHeight: 1.4, minWidth: 0, flex: 1 }}>
        <div>
          {"Source: "}
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, textDecoration: "underline", wordBreak: "break-word" }}>{citationText}</a>
          ) : citationText}
          {trailing.length > 0 ? ` · ${trailing.join(" · ")}` : ""}
        </div>
        {coming.length > 0 && (
          <div style={{ marginTop: 3, color: T.textMuted }}>
            <span style={{ fontWeight: 700 }}>Coming: </span>
            {coming.join(" · ")}
          </div>
        )}
      </div>
      <button type="button" onClick={openForm} style={{
        padding: "3px 9px", fontSize: 11, fontWeight: 700, borderRadius: 8, flexShrink: 0,
        border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer",
      }}>Rules changed?</button>

      <Modal open={open} onClose={close} title={`Report a rule change: ${subject}`} width={460}>
        {sent ? (
          <div style={{ padding: "12px 0", textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.success }}>Sent. Thank you.</div>
            <div style={{ fontSize: 13, color: T.textDim, marginTop: 4 }}>We check it against the regulator and update the database.</div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12, lineHeight: 1.45 }}>
              On file: <span style={{ color: T.text }}>{citation || "no citation"}</span>
              {meta?.databaseDate ? `, database ${formatMonth(meta.databaseDate)}` : ""}
              {verified ? `, verified ${formatMonth(verified)}` : ", not yet re-verified"}.
            </div>
            <Field label="What changed?">
              <textarea
                value={what}
                onChange={e => setWhat(e.target.value)}
                style={{ ...iS, minHeight: 80, resize: "vertical" }}
                placeholder="e.g. Opioid requirement dropped from 3 hrs to 2 hrs starting with 2027 renewals"
                autoFocus
              />
            </Field>
            <Field label="Link to the rule or board notice" hint="Optional, but it speeds up the check.">
              <input value={link} onChange={e => setLink(e.target.value)} style={iS} placeholder="https://" inputMode="url" />
            </Field>
            {error && <div style={{ fontSize: 12.5, color: T.danger, marginBottom: 10 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={close} style={{ padding: "10px 16px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button type="button" onClick={send} disabled={busy} style={{ padding: "10px 16px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>{busy ? "Sending..." : "Send"}</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

export default memo(RuleProvenance);
