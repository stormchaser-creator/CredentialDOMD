import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { readAdminSource, readAccountMemberships } from "../../utils/adminData";
import { summarizeMembers, loadFounderSpotsLeft } from "../../utils/adminMembershipSummary";
import { ADMIN_REPORT_FACE } from "../../utils/adminOperationsReport";
import { adminButtonStyle } from "../shared/adminButton";

const DASH = "—";

/**
 * Admin > Home: Founder spots left (the public offer the homepage reads) and
 * members by payment status (the profiles list and membership facts People >
 * Accounts reads, counted the same way). No dollar amounts, refunds or Stripe
 * data. Any part that cannot be read shows "—" and the rest of Home stays.
 */
export default function AdminHomeSummary({ T = {}, onNavigate, loadSpots = loadFounderSpotsLeft }) {
  const [revision, setRevision] = useState(0);
  const [spots, setSpots] = useState(undefined);       // undefined = loading, null = unavailable
  const [members, setMembers] = useState(undefined);   // undefined = loading, null = unavailable
  const [coverage, setCoverage] = useState(null);      // { loaded, total } of the profiles list

  useEffect(() => {
    let active = true;
    setSpots(undefined); setMembers(undefined); setCoverage(null);
    Promise.resolve(loadSpots({ supabaseUrl: import.meta.env?.VITE_SUPABASE_URL })).then(
      left => { if (active) setSpots(Number.isSafeInteger(left) ? left : null); },
      () => { if (active) setSpots(null); },
    );
    (async () => {
      try {
        if (!supabase) throw new Error("No connection");
        const [list, memberships] = await Promise.all([readAdminSource(supabase, "users"), readAccountMemberships(supabase)]);
        if (!active) return;
        if (list.error || !list.rows) { setMembers(null); return; }
        setMembers(summarizeMembers(list.rows, memberships));
        setCoverage({ loaded: list.rows.length, total: list.count });
      } catch {
        if (active) setMembers(null);
      }
    })();
    return () => { active = false; };
  }, [revision, loadSpots]);

  const border = T.border || "#d1d5db";
  const show = value => value === undefined ? "…" : value === null ? DASH : value.toLocaleString("en-US");
  const count = key => members === undefined ? undefined : members ? members[key] : null;
  const items = [
    { label: "Founder spots left", value: spots, title: "From the public offer the homepage shows. Only while the Founder plan is open." },
    { label: "Paying members", value: count("paying"), title: "An active paid membership.", tab: "users" },
    { label: "Founding members", value: count("founding"), title: ADMIN_REPORT_FACE.founding, tab: "users" },
    { label: "Free or gifted", value: count("free"), title: "Lifetime access, or beta access that has not ended.", tab: "users" },
    { label: "Unpaid accounts", value: count("unpaid"), title: "Signed in, with no paid membership and no free access.", tab: "users" },
  ];
  const partial = coverage && coverage.total !== null && coverage.loaded < coverage.total;
  const tile = { textAlign: "left", padding: "8px 10px", borderRadius: 10, border: `1px solid ${border}`, background: T.card, color: T.text, font: "inherit" };

  return <section aria-label="Payments and Founder spots" style={{ border: `1px solid ${border}`, borderRadius: 12, padding: 12, margin: "12px 0", background: T.card }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <h3 style={{ fontSize: 15, margin: 0 }}>Payments and Founder spots</h3>
      <button type="button" onClick={() => setRevision(n => n + 1)} style={adminButtonStyle(T)}>Refresh summary</button>
    </div>
    <p style={{ fontSize: 12, color: T.textMuted, margin: "4px 0 8px" }}>Members by payment status, from the accounts list. No dollar amounts.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 104px), 1fr))", gap: 6 }}>
      {items.map(item => {
        const body = <><span style={{ display: "block", fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{show(item.value)}</span><span style={{ display: "block", fontSize: 12, color: T.textMuted }}>{item.label}</span></>;
        return item.tab && onNavigate
          ? <button key={item.label} type="button" title={item.title} onClick={() => onNavigate(item.tab)} style={{ ...tile, cursor: "pointer" }}>{body}</button>
          : <div key={item.label} title={item.title} style={tile}>{body}</div>;
      })}
    </div>
    {members === null && <p role="status" style={{ fontSize: 12, color: T.textMuted, margin: "8px 0 0" }}>Payment details could not be loaded. Refresh to try again.</p>}
    {partial && <p role="status" style={{ fontSize: 12, color: T.textMuted, margin: "8px 0 0" }}>Counted from the first {coverage.loaded.toLocaleString("en-US")} of {coverage.total.toLocaleString("en-US")} account records. Load more on People to see the rest.</p>}
    <details style={{ marginTop: 8, fontSize: 13 }}>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>Details</summary>
      <p><strong>Founder spots left.</strong> Read from the same public offer the homepage shows. It exists only while the Founder plan is open for checkout; otherwise this shows {DASH}.</p>
      <p><strong>Paying, free or gifted, unpaid.</strong> The same groups as People › Accounts: paying is an active paid membership; free or gifted is lifetime access or beta access that has not ended; unpaid signed in with neither. Closed accounts and empty account records are not counted. Your own admin account is counted like any other.</p>
      <p><strong>Founding members.</strong> The same count as People › Accounts: paid founders and pre-launch founders, not deleted. An invitation alone never counts.</p>
      <p>This is a count of accounts, not money. Revenue, refunds and disputes are not shown here.</p>
    </details>
  </section>;
}
