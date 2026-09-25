import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { ADMIN_REPORT_DAYS, ADMIN_REPORT_FRESH_MS, ADMIN_REPORT_DEFINITIONS, adminReportCsv, adminReportErrorMessage, formatReportTimestamp, normalizeAdminReport } from "../../utils/adminOperationsReport";

const emptySnapshot = () => ({ report: null, status: "loading", error: "", expiresAt: 0 });
const TAB_NAMES = { users: "accounts", signups: "traffic history", errors: "errors", tickets: "tickets", messages: "messages", waitlist: "waitlist", fields: "field proposals" };
const number = value => value.toLocaleString("en-US");

export default function AdminOperationsReport({ T = {}, onNavigate }) {
  const [days, setDays] = useState(30);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    let cancelled = false;
    const current = () => !cancelled && request === generation.current;
    const load = async () => {
      try {
        if (!supabase) throw new Error("Reporting connection unavailable");
        const { data, error } = await supabase.rpc("admin_operations_report", { p_days: days });
        if (!current()) return;
        if (error) throw error;
        const report = normalizeAdminReport(data, days);
        setSnapshot({ report, status: "ready", error: "", expiresAt: Date.now() + ADMIN_REPORT_FRESH_MS });
      } catch (error) {
        if (current()) setSnapshot({ report: null, status: "error", error: adminReportErrorMessage(error), expiresAt: 0 });
      }
    };
    load();
    return () => { cancelled = true; };
  }, [days, revision]);

  useEffect(() => {
    if (!snapshot.expiresAt) return;
    const expiresAt = snapshot.expiresAt;
    const timer = setTimeout(() => setSnapshot(previous => previous.expiresAt === expiresAt ? { ...previous, status: "stale" } : previous), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [snapshot.expiresAt]);

  const reload = (nextDays = days) => {
    generation.current++;
    setSnapshot(emptySnapshot());
    setDays(nextDays);
    setRevision(value => value + 1);
  };
  const { report, status, error } = snapshot;
  const exportReady = status === "ready" && report?.days === days;
  const exportCsv = () => {
    if (!exportReady) return;
    if (Date.now() >= snapshot.expiresAt) { setSnapshot(previous => ({ ...previous, status: "stale" })); return; }
    const csv = adminReportCsv(report);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `credentialdomd-operations-${days}days-${report.generated_at.slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const card = { border: `1px solid ${T.border || "#d1d5db"}`, background: T.card, borderRadius: 12, padding: 16 };
  const button = { minHeight: 44, borderRadius: 8, border: `1px solid ${T.border || "#d1d5db"}`, background: T.card, color: T.text, padding: "10px 14px", font: "inherit", cursor: "pointer" };
  const metrics = report ? [
    { label: "Open tickets", value: report.support.open, detail: ADMIN_REPORT_DEFINITIONS.open, tab: "tickets", filters: { status: "unresolved" } },
    { label: "Urgent open tickets", value: report.support.urgent, detail: ADMIN_REPORT_DEFINITIONS.urgent, tab: "tickets", filters: { status: "unresolved", priority: "urgent" } },
    { label: "Awaiting approval", value: report.support.waiting_approval, detail: ADMIN_REPORT_DEFINITIONS.approval, tab: "tickets", filters: { status: "unresolved", approval: "needs_review" } },
    { label: "New signup profiles", value: report.accounts.new_in_period, detail: ADMIN_REPORT_DEFINITIONS.signups, tab: "signups" },
    { label: "Account profiles", value: report.accounts.total, detail: ADMIN_REPORT_DEFINITIONS.accounts, tab: "users" },
    { label: "Active account profiles", value: report.accounts.active, detail: ADMIN_REPORT_DEFINITIONS.active, tab: "users", filters: { access: "active" } },
    { label: "Retained error reports", value: report.errors.in_period, detail: ADMIN_REPORT_DEFINITIONS.errors, tab: "errors" },
    // Present once the database update that restores these counts is applied.
    ...(report.attention ? [
      { label: "Unread message replies", value: report.attention.unread_replies, detail: ADMIN_REPORT_DEFINITIONS.unread_replies, tab: "messages" },
      { label: "New error reports", value: report.attention.new_errors_since_seen, detail: ADMIN_REPORT_DEFINITIONS.new_errors, tab: "errors" },
      { label: "Waiting on the waitlist", value: report.attention.waitlist_waiting, detail: ADMIN_REPORT_DEFINITIONS.waitlist_waiting, tab: "waitlist" },
      { label: "Fields awaiting review", value: report.attention.fields_pending, detail: ADMIN_REPORT_DEFINITIONS.fields_pending, tab: "fields" },
    ] : []),
  ] : [];

  return <section aria-label="Administrative operations report" style={{ color: T.text, fontSize: 14, lineHeight: 1.5 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
      <div><h3 style={{ fontSize: 19, margin: "0 0 4px" }}>Operations report</h3>
        <p style={{ color: T.textMuted, margin: 0 }}>Exact server counts across all records, independent of directory display limits.</p></div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label htmlFor="admin-report-days">Window</label>
        {/* 16px: a smaller control makes iOS Safari zoom the page on focus. */}
        <select id="admin-report-days" value={days} onChange={event => reload(Number(event.target.value))} style={{ ...button, fontSize: 16 }}>
          {ADMIN_REPORT_DAYS.map(value => <option key={value} value={value}>Last {value} UTC days</option>)}
        </select>
        <button type="button" onClick={() => reload()} disabled={status === "loading"} style={button}>Refresh report</button>
        <button type="button" onClick={exportCsv} disabled={!exportReady} aria-describedby="admin-report-export-help" style={{ ...button, opacity: exportReady ? 1 : 0.55 }}>Export aggregate CSV</button>
      </div>
    </div>
    <p id="admin-report-export-help" style={{ color: T.textMuted, fontSize: 12 }}>CSV includes counts, definitions and UTC timestamps. Export requires a successful report loaded within the last five minutes.</p>
    {status === "loading" && <p role="status" aria-live="polite">Loading the operations report…</p>}
    {error && <div role="alert" style={{ ...card, color: T.danger || "#b91c1c", marginBottom: 16 }}>{error}</div>}
    {status === "stale" && <p role="status" style={card}>This snapshot is more than five minutes old. Refresh the report before exporting or acting on its counts.</p>}
    {report && <>
      <div style={{ ...card, marginBottom: 16, fontSize: 13 }}>
        <strong>Snapshot: {formatReportTimestamp(report.generated_at)}</strong>
        <div>Reporting window: {formatReportTimestamp(report.period_start)} (inclusive) to {formatReportTimestamp(report.period_end)} (exclusive).</div>
        <div style={{ color: T.textMuted }}>Includes today’s partial UTC day. Ticket backlog and account totals describe the current snapshot; new signups, page loads, tickets created and retained error reports use the selected window.</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 225px), 1fr))", gap: 12 }}>
        {metrics.map(metric => <article key={metric.label} style={card}>
          <h4 style={{ margin: 0, fontSize: 14 }}>{metric.label}</h4>
          <div style={{ fontSize: 30, fontWeight: 800, margin: "4px 0" }}>{number(metric.value)}</div>
          <p style={{ color: T.textMuted, fontSize: 12, margin: "0 0 12px" }}>{metric.detail}</p>
          {onNavigate && <button type="button" onClick={() => onNavigate(metric.tab, metric.filters)} style={{ ...button, fontSize: 12 }}>Open {TAB_NAMES[metric.tab]}</button>}
        </article>)}
      </div>
      <p style={{ fontSize: 13 }}>Oldest open ticket: {report.support.oldest_open_at ? `created ${formatReportTimestamp(report.support.oldest_open_at)}` : "No open tickets in this snapshot."}</p>
      <div style={{ ...card, padding: 0, overflowX: "auto", marginTop: 20 }} role="region" aria-label="Daily operations counts" tabIndex={0}>
        <table style={{ width: "100%", minWidth: 600, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
          <caption style={{ textAlign: "left", padding: 16, fontWeight: 700 }}>Daily activity in UTC — today is partial</caption>
          <thead><tr>{["UTC date", "New signup profiles", "Recorded page loads", "Tickets created", "Retained error reports"].map(label => <th key={label} scope="col" style={{ textAlign: label === "UTC date" ? "left" : "right", padding: "10px 12px", borderBottom: `1px solid ${T.border || "#d1d5db"}`, fontSize: 12 }}>{label}</th>)}</tr></thead>
          <tbody>{report.daily.map(row => <tr key={row.day}>
            <th scope="row" style={{ textAlign: "left", fontWeight: 500, padding: "10px 12px", borderBottom: `1px solid ${T.border || "#d1d5db"}` }}>{row.day}</th>
            {[row.signups, row.page_views, row.tickets, row.errors].map((value, index) => <td key={index} style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${T.border || "#d1d5db"}` }}>{number(value)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <details style={{ ...card, marginTop: 12 }}>
        <summary style={{ cursor: "pointer", minHeight: 32, fontWeight: 700 }}>How to interpret this report</summary>
        <p>{ADMIN_REPORT_DEFINITIONS.page_views}</p>
        <p>{ADMIN_REPORT_DEFINITIONS.tickets}</p>
        <p>{ADMIN_REPORT_DEFINITIONS.errors}</p>
        <p>Profile creation, administrative access status and billing are separate. This report does not calculate revenue or paid membership from profile counts.</p>
      </details>
    </>}
  </section>;
}
