import { useCallback, useEffect, useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";

/**
 * Monthly server-built backup.
 *
 * The server packages every synced record plus every uploaded document into a
 * ZIP, drops it in a private bucket, and emails a note that it is ready.
 * Nothing is attached to the email, because one physician already has 60 MB
 * of scans, and no link to the file is in it either: the archive is every
 * scan they ever uploaded. Download below asks backup-link for a fresh
 * 15-minute signed URL on every tap and never keeps one.
 *
 * The on-device private vault is structurally absent from all of this: it
 * lives in this browser's storage and never reaches a server, so no
 * server-built archive can contain it. The copy below says exactly that.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  if (!m) return period || "Backup";
  return `${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}

function sizeLabel(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function dateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// The table only exists once the owner ships the migration. PostgREST answers
// a missing relation three different ways depending on schema-cache state, so
// match all of them and go quiet rather than showing a red error.
const NOT_DEPLOYED = /does not exist|schema cache|find the table|relation .* does not exist/i;
function looksUndeployed(error) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202") return true;
  return NOT_DEPLOYED.test(`${error.message || ""} ${error.details || ""} ${error.hint || ""}`);
}

// How long a link from backup-link lives (LINK_TTL_SECONDS in
// supabase/functions/build-backup/lib.ts). The popup-blocked fallback anchor
// is dropped after this so a dead link is never left on screen.
const LINK_TTL_MS = 15 * 60 * 1000;

const STATUS = {
  pending: { label: "Building", tone: "muted" },
  ready: { label: "Ready", tone: "ok" },
  emailed: { label: "Emailed", tone: "ok" },
  failed: { label: "Did not finish", tone: "bad" },
};

function BackupPanel() {
  const { data, updateSettings, theme: T } = useApp();
  const s = data.settings || {};
  // Default on. An account that has never touched the switch is opted in,
  // which is the same thing the server assumes.
  const monthlyOn = s.backupMonthly !== false;

  const [state, setState] = useState("loading"); // loading | ready | undeployed | error
  const [rows, setRows] = useState([]);
  const [loadErr, setLoadErr] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState("");
  const [buildErr, setBuildErr] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [links, setLinks] = useState({});
  const [rowErr, setRowErr] = useState({});

  const load = useCallback(async () => {
    if (!supabase) { setState("undeployed"); return; }
    // RLS scopes this to the caller's own rows, so no filter is needed here
    // and none would help: the policy is the boundary.
    const { data: got, error } = await supabase
      .from("backups")
      .select("id, period, part, parts, bytes, record_count, document_count, skipped_documents, status, error, created_at, emailed_at, expires_at")
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) {
      if (looksUndeployed(error)) { setState("undeployed"); return; }
      setLoadErr(error.message || "Could not read your backup history.");
      setState("error");
      return;
    }
    setRows(got || []);
    setState("ready");
  }, []);

  useEffect(() => { load(); }, [load]);

  const buildNow = async () => {
    if (!supabase || building) return;
    setBuilding(true);
    setBuildErr("");
    setBuildMsg("Packaging your records and documents. This can take a minute.");
    try {
      // No profile_id: the function reads the Clerk JWT and backs up the
      // caller's own account, which is the only account it will ever hand back.
      const res = await supabase.functions.invoke("build-backup", { body: {} });
      if (res.error) {
        // invoke() reports every non-2xx as the same generic sentence; the
        // useful text (rate limit, no key) is in the response body.
        let msg = "";
        try { msg = (await res.error.context?.json())?.error || ""; } catch { /* not JSON */ }
        throw new Error(msg || res.error.message || "The backup did not finish.");
      }
      // The function answers { ok, results: [ per-account ] }; this call only
      // ever asks for one account, so the counts live in results[0].
      const out = res.data?.results?.[0] || res.data || {};
      if (out.error) throw new Error(String(out.error));

      const bits = [];
      if (out.record_count != null) bits.push(`${out.record_count} records`);
      if (out.document_count != null) bits.push(`${out.document_count} documents`);
      const totalBytes = Array.isArray(out.results)
        ? out.results.reduce((n, part) => n + (Number(part.bytes) || 0), 0)
        : Number(out.bytes) || 0;
      const size = sizeLabel(totalBytes);
      if (size) bits.push(size);
      const parts = Number(out.parts) || 1;

      // The function returns 200 even when it built but could not email, so
      // only say "on its way" when it actually says it sent one.
      const where = out.emailed
        ? `A note is on its way to ${s.email}. Download it from the list below.`
        : `It is in the list below. Nothing was emailed${out.note ? `: ${out.note}` : ""}.`;
      setBuildMsg(
        `Backup ready${bits.length ? `: ${bits.join(", ")}` : ""}${parts > 1 ? `, split into ${parts} files` : ""}. ${where}`
      );
      load();
    } catch (e) {
      setBuildMsg("");
      setBuildErr(e.message || "The backup did not finish. Try again in a few minutes.");
    } finally {
      setBuilding(false);
    }
  };

  const download = async (row) => {
    if (!supabase || busyId) return;
    setBusyId(row.id);
    setRowErr((m) => ({ ...m, [row.id]: "" }));
    try {
      const res = await supabase.functions.invoke("backup-link", { body: { backup_id: row.id } });
      if (res.error) {
        let msg = "";
        try { msg = (await res.error.context?.json())?.error || ""; } catch { /* not JSON */ }
        throw new Error(msg || res.error.message || "Could not create a download link.");
      }
      const url = res.data?.url;
      if (!url) throw new Error("Could not create a download link.");
      const w = window.open(url, "_blank", "noopener,noreferrer");
      // A blocked popup is not a failure: show the link and let them tap it,
      // for as long as it lives.
      if (!w) {
        setLinks((m) => ({ ...m, [row.id]: url }));
        setTimeout(() => setLinks((m) => (m[row.id] === url ? { ...m, [row.id]: "" } : m)), LINK_TTL_MS);
      }
    } catch (e) {
      setRowErr((m) => ({ ...m, [row.id]: e.message || "Could not create a download link." }));
    } finally {
      setBusyId(null);
    }
  };

  const card = {
    backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
    padding: "16px 18px", marginBottom: 14, boxShadow: T.shadow1,
  };
  const body = { fontSize: 13, color: T.textMuted, lineHeight: 1.6 };

  return (
    <div style={card}>
      <div style={{ ...body, marginBottom: 12 }}>
        Once a month the server packages your whole account into one ZIP file: every record,
        every document you uploaded, a CSV of each section for spreadsheets, and a JSON file
        this app can import back. The file is kept in private storage and you get an email
        when it is ready. Download it from this screen; the email carries no link to the file.
        Large accounts arrive as more than one file.
      </div>
      <div style={{ ...body, marginBottom: 14 }}>
        Your private notes are never in it. Patient names and MRNs stay in this browser and
        never reach a server, so no server can put them in a backup. AI keys are left out too.
      </div>

      {state === "undeployed" ? (
        <div style={{ fontSize: 13, color: T.textDim, lineHeight: 1.6, paddingTop: 4, borderTop: `1px solid ${T.border}` }}>
          Monthly backups are not switched on for this account yet. This panel fills in on its
          own once they are. Your manual export below works today.
        </div>
      ) : (
        <>
          {/* Opt out */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 0", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Build a backup every month</div>
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                {monthlyOn
                  ? `Built on the 1st${s.email ? `. ${s.email} gets a note when it is ready` : ". Add your email in Settings to be told when it is ready"}`
                  : "Off. Nothing is built and nothing is emailed"}
              </div>
            </div>
            <button
              onClick={() => updateSettings({ backupMonthly: !monthlyOn })}
              aria-label="Monthly backup"
              aria-pressed={monthlyOn}
              style={{
                flexShrink: 0, width: 44, height: 24, borderRadius: 12, border: "none",
                backgroundColor: monthlyOn ? T.accent : T.border, cursor: "pointer",
                position: "relative", transition: "background 0.2s",
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff", position: "absolute",
                top: 3, left: monthlyOn ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </button>
          </div>

          {/* Build one now */}
          <div style={{ padding: "12px 0", borderBottom: `1px solid ${T.border}` }}>
            <button
              onClick={buildNow}
              disabled={building}
              style={{
                padding: "11px 16px", borderRadius: 10, border: "none",
                backgroundColor: building ? T.border : T.accent,
                color: building ? T.textMuted : "#fff",
                fontSize: 13.5, fontWeight: 800, cursor: building ? "default" : "pointer",
              }}
            >
              {building ? "Building your backup..." : "Build a backup now"}
            </button>
            {buildMsg && (
              <div style={{ fontSize: 12.5, color: building ? T.textMuted : T.accent, fontWeight: 600, marginTop: 9, lineHeight: 1.6 }}>
                {buildMsg}
              </div>
            )}
            {buildErr && (
              <div style={{ fontSize: 12.5, color: T.danger, fontWeight: 600, marginTop: 9, lineHeight: 1.6 }}>{buildErr}</div>
            )}
          </div>

          {/* History */}
          <div style={{ paddingTop: 12 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text, marginBottom: 8 }}>Your backups</div>

            {state === "loading" && <div style={{ fontSize: 13, color: T.textDim }}>Loading...</div>}

            {state === "error" && (
              <div style={{ fontSize: 13, color: T.danger, lineHeight: 1.6 }}>{loadErr}</div>
            )}

            {state === "ready" && rows.length === 0 && (
              <div style={{ fontSize: 13, color: T.textDim, lineHeight: 1.6 }}>
                No backups yet. The first one is built on the 1st of the month, or use the button
                above to get one right now.
              </div>
            )}

            {state === "ready" && rows.map((r) => {
              const st = STATUS[r.status] || { label: r.status || "", tone: "muted" };
              const tone = st.tone === "ok" ? T.success : st.tone === "bad" ? T.danger : T.textDim;
              const toneBg = st.tone === "ok" ? T.successDim : st.tone === "bad" ? T.dangerDim : T.neutralDim;
              const canGet = r.status === "ready" || r.status === "emailed";
              const facts = [
                sizeLabel(r.bytes),
                r.record_count != null ? `${r.record_count} records` : "",
                r.document_count != null ? `${r.document_count} documents` : "",
              ].filter(Boolean).join(" | ");
              return (
                <div key={r.id} style={{ padding: "10px 0", borderTop: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                        {periodLabel(r.period)}
                        {Number(r.parts) > 1 && (
                          <span style={{ fontWeight: 600, color: T.textDim }}> {`(file ${r.part || 1} of ${r.parts})`}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                        {facts}
                        {facts && dateLabel(r.created_at) ? " | " : ""}
                        {dateLabel(r.created_at) ? `built ${dateLabel(r.created_at)}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ padding: "3px 10px", borderRadius: 9, fontSize: 11.5, fontWeight: 700, color: tone, backgroundColor: toneBg }}>
                        {st.label}
                      </span>
                      {canGet && (
                        <button
                          onClick={() => download(r)}
                          disabled={busyId === r.id}
                          style={{
                            padding: "8px 13px", borderRadius: 9, border: `1px solid ${T.border}`,
                            backgroundColor: "transparent", color: busyId === r.id ? T.textDim : T.accent,
                            fontSize: 12.5, fontWeight: 700, cursor: busyId === r.id ? "default" : "pointer",
                          }}
                        >
                          {busyId === r.id ? "Linking..." : "Download"}
                        </button>
                      )}
                    </div>
                  </div>
                  {Number(r.skipped_documents) > 0 && (
                    <div style={{ fontSize: 12, color: T.warning, marginTop: 5, lineHeight: 1.5 }}>
                      {r.skipped_documents} document{Number(r.skipped_documents) === 1 ? "" : "s"} could not be
                      read and {Number(r.skipped_documents) === 1 ? "is" : "are"} listed by name in the README
                      inside the ZIP.
                    </div>
                  )}
                  {r.status === "failed" && r.error && (
                    <div style={{ fontSize: 12, color: T.danger, marginTop: 5, lineHeight: 1.5 }}>{r.error}</div>
                  )}
                  {rowErr[r.id] && (
                    <div style={{ fontSize: 12, color: T.danger, marginTop: 5, lineHeight: 1.5 }}>{rowErr[r.id]}</div>
                  )}
                  {links[r.id] && (
                    <div style={{ fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>
                      Your browser blocked the new tab.{" "}
                      <a href={links[r.id]} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, fontWeight: 700 }}>
                        Open the download
                      </a>
                      {" "}(works for 15 minutes)
                    </div>
                  )}
                </div>
              );
            })}

            {state === "ready" && rows.length > 0 && (
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 10, lineHeight: 1.6 }}>
                Download creates a new link each time, good for 15 minutes and only from this
                signed-in screen. The monthly email says a backup is ready and carries no link to
                the file, so a read or forwarded inbox never holds a way into the archive.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default memo(BackupPanel);
