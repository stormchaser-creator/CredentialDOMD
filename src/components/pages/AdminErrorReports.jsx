import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";

/** Groups and actions apply only to the reports supplied by the parent. */
export default function AdminErrorReports({ rows = [], users = [], T, onCleared }) {
  const [openId, setOpenId] = useState(null);
  const [liveBuild, setLiveBuild] = useState(null);
  const [buildStatus, setBuildStatus] = useState("loading");
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState(null);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    fetch(`${import.meta.env.BASE_URL}version.json?cb=${Date.now()}`)
      .then(response => {
        if (!response.ok) throw new Error("Build unavailable");
        return response.json();
      })
      .then(version => {
        if (!current) return;
        const build = typeof version?.build === "string" ? version.build.trim() : "";
        setLiveBuild(build || null);
        setBuildStatus(build ? "ready" : "unavailable");
      })
      .catch(() => { if (current) setBuildStatus("unavailable"); });
    return () => { current = false; mounted.current = false; };
  }, []);

  const groups = [];
  const bySignature = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.build || null, row.kind || null, row.message || null]);
    const existing = bySignature.get(key);
    if (existing) {
      existing.ids.push(row.id);
    } else {
      const group = { ...row, ids: [row.id] };
      bySignature.set(key, group);
      groups.push(group);
    }
  }
  const otherBuildIds = groups
    .filter(group => liveBuild && group.build && group.build !== liveBuild)
    .flatMap(group => group.ids);

  const clearReports = async (requestedIds, scope) => {
    if (pending.current || !mounted.current) return;
    const ids = [...new Set(requestedIds)].filter(Boolean);
    if (!ids.length) return;
    if (!window.confirm(`Permanently delete ${ids.length} error report${ids.length === 1 ? "" : "s"} ${scope}? This removes diagnostic history and does not confirm that the cause is fixed.`)) return;
    pending.current = true;
    setClearing(true);
    setNotice(null);
    try {
      if (!supabase) throw new Error("The connection is unavailable.");
      const result = await supabase.from("client_errors").delete().in("id", ids).select("id");
      if (!mounted.current) return;
      if (result.error) throw result.error;
      const requested = new Set(ids);
      const deletedIds = [...new Set((result.data || []).map(row => row.id))].filter(id => requested.has(id));
      if (!deletedIds.length) {
        setNotice({ error: true, text: "No deletions were confirmed. Refresh the reports before trying again." });
        return;
      }
      onCleared?.(deletedIds);
      if (deletedIds.length !== ids.length) {
        setNotice({ error: true, text: `Deleted ${deletedIds.length} of ${ids.length} selected reports. The remaining deletions were not confirmed; refresh before retrying.` });
      } else {
        setNotice({ error: false, text: `Deleted ${deletedIds.length} error report${deletedIds.length === 1 ? "" : "s"}.` });
      }
    } catch (error) {
      if (mounted.current) setNotice({ error: true, text: `Could not confirm deletion. Refresh the reports before retrying.${error?.message ? ` ${error.message}` : ""}` });
    } finally {
      pending.current = false;
      if (mounted.current) setClearing(false);
    }
  };

  const who = (report) => {
    const user = users.find(item => item.auth_user_id && item.auth_user_id === report.auth_user_id)
      || users.find(item => item.id === report.profile_id);
    return user ? (user.name || user.email || "Account") : (report.auth_user_id ? "Signed-in user" : "Signed-out visitor");
  };
  const buttonStyle = {
    fontSize: 12, fontWeight: 700, padding: "7px 10px", borderRadius: 8,
    border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text,
    cursor: clearing ? "wait" : "pointer",
  };

  return (
    <section aria-label="Client error reports" aria-busy={clearing}>
      {notice && <div role={notice.error ? "alert" : "status"} style={{ marginBottom: 10, fontSize: 13, color: notice.error ? "#ef4444" : T.text }}>{notice.text}</div>}
      {!rows.length ? (
        <p style={{ color: T.textMuted, fontSize: 13 }}>No client error reports in this list.</p>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: T.textMuted }}>
              <div>{groups.length} error group{groups.length === 1 ? "" : "s"} from {rows.length} report{rows.length === 1 ? "" : "s"} in this list.</div>
              <div style={{ marginTop: 4 }}>
                {buildStatus === "loading" ? "Checking the current build…"
                  : buildStatus === "unavailable" ? "Current build unavailable. Build comparisons are not shown."
                    : "A different build does not establish whether an error is fixed."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {otherBuildIds.length > 0 && (
                <button type="button" onClick={() => clearReports(otherBuildIds, "from other builds in this list")} disabled={clearing} style={buttonStyle}>Delete other-build reports ({otherBuildIds.length})</button>
              )}
              <button type="button" onClick={() => clearReports(rows.map(row => row.id), "in this list")} disabled={clearing} style={buttonStyle}>{clearing ? "Deleting…" : `Delete listed reports (${rows.length})`}</button>
            </div>
          </div>
          {groups.map(group => {
            const expanded = openId === group.id;
            const detailsId = `admin-error-details-${group.id}`;
            const created = new Date(group.created_at);
            const timestamp = Number.isNaN(created.getTime()) ? "Time unavailable" : created.toLocaleString();
            return (
              <article key={group.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, marginBottom: 8 }}>
                <button type="button" aria-expanded={expanded} aria-controls={detailsId}
                  onClick={() => setOpenId(expanded ? null : group.id)}
                  style={{ width: "100%", padding: "10px 12px", textAlign: "left", border: "none", borderRadius: 12, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontFamily: "inherit" }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", color: group.kind === "react" ? "#ef4444" : "#f59e0b" }}>{group.kind || "Error"}</span>
                    <span style={{ fontSize: 11, color: T.textMuted }}>{group.ids.length} report{group.ids.length === 1 ? "" : "s"} · {timestamp} · {who(group)}</span>
                  </span>
                  <span style={{ display: "block", fontSize: 13, marginTop: 5, wordBreak: "break-word" }}>{group.message || "No error message recorded"}</span>
                  <span style={{ display: "block", marginTop: 5, fontSize: 11, color: T.textMuted }}>
                    {group.build ? `Build ${String(group.build).slice(-12)}${liveBuild ? group.build === liveBuild ? " · Current build" : " · Other build" : ""}` : "Build not recorded"}
                    {expanded ? " · Hide details" : " · Show details"}
                  </span>
                </button>
                <div id={detailsId} hidden={!expanded} style={{ padding: "0 12px 12px" }}>
                  {expanded && <>
                    <div style={{ fontSize: 12, color: T.textMuted, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace" }}>
                      {group.url && <div>Page: {group.url}</div>}
                      {group.user_agent && <div style={{ marginTop: 4 }}>Browser: {group.user_agent}</div>}
                      {group.stack && <div style={{ marginTop: 6 }}>{group.stack}</div>}
                      {!group.url && !group.user_agent && !group.stack && <div>No diagnostic details recorded.</div>}
                    </div>
                    <button type="button" onClick={() => clearReports(group.ids, "in this group")} disabled={clearing} style={{ ...buttonStyle, marginTop: 10 }}>Delete group reports ({group.ids.length})</button>
                  </>}
                </div>
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}
