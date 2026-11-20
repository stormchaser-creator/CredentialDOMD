import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { ADMIN_REPORT_DAYS, ADMIN_REPORT_FRESH_MS, ADMIN_REPORT_DEFINITIONS, ADMIN_REPORT_FACE, adminReportCsv, adminReportErrorMessage, formatReportTimestamp, normalizeAdminReport } from "../../utils/adminOperationsReport";

const emptySnapshot = () => ({ report: null, status: "loading", error: "", expiresAt: 0 });
const number = value => value.toLocaleString("en-US");

/**
 * Admin > Home: what needs you first, then the snapshot numbers and the daily
 * table. Every number is the control that opens its section (onNavigate with
 * the same section and filters the Overview cards used). `children` is the
 * payments and Founder spots summary, shown right under Needs attention.
 */
export default function AdminOperationsReport({ T = {}, onNavigate, children }) {
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
  const border = T.border || "#d1d5db";
  const card = { border: `1px solid ${border}`, background: T.card, borderRadius: 12, padding: 16 };
  const button = { minHeight: 44, borderRadius: 8, border: `1px solid ${border}`, background: T.card, color: T.text, padding: "10px 14px", font: "inherit", cursor: "pointer" };
  // Needs attention: the same counts, sections and filters as the old Overview cards.
  const attention = report ? [
    ...(report.attention ? [{ label: "Unread replies", value: report.attention.unread_replies, face: ADMIN_REPORT_FACE.unread_replies, tab: "messages" }] : []),
    { label: "Awaiting approval", value: report.support.waiting_approval, face: ADMIN_REPORT_FACE.approval, tab: "tickets", filters: { status: "unresolved", approval: "needs_review" } },
    { label: "Urgent open tickets", value: report.support.urgent, face: ADMIN_REPORT_FACE.urgent, tab: "tickets", filters: { status: "unresolved", priority: "urgent" } },
    ...(report.attention ? [
      { label: "Waitlist", value: report.attention.waitlist_waiting, face: ADMIN_REPORT_FACE.waitlist_waiting, tab: "waitlist" },
      { label: "Fields to review", value: report.attention.fields_pending, face: ADMIN_REPORT_FACE.fields_pending, tab: "fields" },
      { label: "New error reports", value: report.attention.new_errors_since_seen, face: ADMIN_REPORT_FACE.new_errors, tab: "errors" },
    ] : []),
  ] : [];
  const numbers = report ? [
    { label: "Open tickets", value: report.support.open, face: ADMIN_REPORT_FACE.open, tab: "tickets", filters: { status: "unresolved" } },
    { label: "Account profiles", value: report.accounts.total, face: ADMIN_REPORT_FACE.accounts, tab: "users" },
    { label: "Active accounts", value: report.accounts.active, face: ADMIN_REPORT_FACE.active, tab: "users", filters: { access: "active" } },
    { label: `New signups (${days} days)`, value: report.accounts.new_in_period, face: ADMIN_REPORT_FACE.signups, tab: "signups" },
    { label: `Error reports (${days} days)`, value: report.errors.in_period, face: ADMIN_REPORT_FACE.errors, tab: "errors" },
  ] : [];
  const open = item => onNavigate?.(item.tab, item.filters);

  return <section aria-label="Administrative operations report" style={{ color: T.text, fontSize: 14, lineHeight: 1.5 }}>
    {status === "loading" && <p role="status" aria-live="polite">Loading the operations report…</p>}
    {error && <div role="alert" style={{ ...card, color: T.danger || "#b91c1c", marginBottom: 16 }}>{error}</div>}
    {report && <section aria-label="Needs attention" style={{ marginBottom: 12 }}>
      <h3 style={{ fontSize: 15, margin: "0 0 6px" }}>Needs attention</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {attention.map(item => <button key={item.label} type="button" title={item.face} onClick={() => open(item)} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 999, font: "inherit", fontSize: 13, cursor: "pointer",
          border: `1px solid ${item.value > 0 ? (T.accent || border) : border}`, background: item.value > 0 ? T.card : "transparent",
          color: item.value > 0 ? T.text : T.textMuted, fontWeight: item.value > 0 ? 700 : 500,
        }}>{item.label}<strong style={{ fontVariantNumeric: "tabular-nums" }}>{number(item.value)}</strong></button>)}
      </div>
    </section>}
    {children}
    {report && <section aria-label="Snapshot" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 104px), 1fr))", gap: 6, margin: "12px 0" }}>
      {numbers.map(item => <button key={item.label} type="button" title={item.face} onClick={() => open(item)} style={{
        textAlign: "left", padding: "8px 10px", borderRadius: 10, border: `1px solid ${border}`, background: T.card, color: T.text, font: "inherit", cursor: "pointer",
      }}><span style={{ display: "block", fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{number(item.value)}</span><span style={{ display: "block", fontSize: 12, color: T.textMuted }}>{item.label}</span></button>)}
    </section>}
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "12px 0 4px" }}>
      <label htmlFor="admin-report-days">Window</label>
      {/* 16px: a smaller control makes iOS Safari zoom the page on focus. */}
      <select id="admin-report-days" value={days} onChange={event => reload(Number(event.target.value))} style={{ ...button, fontSize: 16 }}>
        {ADMIN_REPORT_DAYS.map(value => <option key={value} value={value}>Last {value} UTC days</option>)}
      </select>
      <button type="button" onClick={() => reload()} disabled={status === "loading"} style={button}>Refresh report</button>
      <button type="button" onClick={exportCsv} disabled={!exportReady} aria-describedby="admin-report-export-help" style={{ ...button, opacity: exportReady ? 1 : 0.55 }}>Export aggregate CSV</button>
    </div>
    <p id="admin-report-export-help" style={{ color: T.textMuted, fontSize: 12, margin: "0 0 8px" }}>{ADMIN_REPORT_FACE.csv}</p>
    {status === "stale" && <p role="status" style={card}>This snapshot is more than five minutes old. Refresh the report before exporting or acting on its counts.</p>}
    {report && <>
      <p style={{ fontSize: 13, margin: "0 0 4px" }}><strong>Snapshot {formatReportTimestamp(report.generated_at)}</strong> · last {report.days} UTC days</p>
      <p style={{ fontSize: 13, margin: "0 0 12px" }}>Oldest open ticket: {report.support.oldest_open_at ? `created ${formatReportTimestamp(report.support.oldest_open_at)}` : "No open tickets in this snapshot."}</p>
      <div style={{ ...card, padding: 0, overflowX: "auto" }} role="region" aria-label="Daily operations counts" tabIndex={0}>
        <table style={{ width: "100%", minWidth: 600, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
          <caption style={{ textAlign: "left", padding: 16, fontWeight: 700 }}>Daily activity in UTC (today is partial)</caption>
          <thead><tr>{["UTC date", "New signup profiles", "Recorded page loads", "Tickets created", "Retained error reports"].map(label => <th key={label} scope="col" style={{ textAlign: label === "UTC date" ? "left" : "right", padding: "10px 12px", borderBottom: `1px solid ${border}`, fontSize: 12 }}>{label}</th>)}</tr></thead>
          <tbody>{report.daily.map(row => <tr key={row.day}>
            <th scope="row" style={{ textAlign: "left", fontWeight: 500, padding: "10px 12px", borderBottom: `1px solid ${border}` }}>{row.day}</th>
            {[row.signups, row.page_views, row.tickets, row.errors].map((value, index) => <td key={index} style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${border}` }}>{number(value)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <details style={{ ...card, marginTop: 12 }}>
        <summary style={{ cursor: "pointer", minHeight: 32, fontWeight: 700 }}>How these counts are defined</summary>
        <p>Reporting window: {formatReportTimestamp(report.period_start)} (inclusive) to {formatReportTimestamp(report.period_end)} (exclusive). Includes today’s partial UTC day. Ticket backlog and account totals describe the current snapshot; new signups, page loads, tickets created and retained error reports use the selected window.</p>
        <p>Exact server counts across all records, independent of list display limits.</p>
        {[
          ["Open tickets", "open"], ["Urgent open tickets", "urgent"], ["Awaiting approval", "approval"], ["New signups", "signups"],
          ["Account profiles", "accounts"], ["Active accounts", "active"], ["Retained error reports", "errors"],
          ["Unread replies", "unread_replies"], ["New error reports", "new_errors"], ["Waitlist", "waitlist_waiting"], ["Fields to review", "fields_pending"],
          ["Recorded page loads", "page_views"], ["Tickets created", "tickets"],
        ].map(([label, key]) => <p key={key}><strong>{label}.</strong> {ADMIN_REPORT_FACE[key] ? `${ADMIN_REPORT_FACE[key]} ` : ""}{ADMIN_REPORT_DEFINITIONS[key]}</p>)}
        <p>CSV includes counts, definitions and UTC timestamps. Export requires a successful report loaded within the last five minutes.</p>
        <p>Profile creation, administrative access status and billing are separate. This report does not calculate revenue or paid membership from profile counts.</p>
      </details>
    </>}
  </section>;
}
