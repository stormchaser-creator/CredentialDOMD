import { useState, useCallback, useMemo, useEffect } from "react";
import { AppProvider, useApp, useNotifications } from "./context/AppContext";
import {
  HomeIcon, ScanIcon, CredsIcon, MoreIcon,
  SendIcon, BellIcon, SunIcon, MoonIcon,
  BackIcon, SearchIcon, CheckIcon, PlusIcon,
  AsclepiusIcon,
} from "./components/shared/Icons";
import StatusDot from "./components/shared/StatusDot";
import Modal from "./components/shared/Modal";
import StatusBadge from "./components/shared/StatusBadge";
import ComplianceRing from "./components/shared/ComplianceRing";
import { ShareModal } from "./components/features";
import { CrudSection } from "./components/features";
import { CMESection } from "./components/features";
import { CMEResourcesSection } from "./components/features";
import { CVGenerator } from "./components/features";
import { DataExport } from "./components/features";
import { DocumentsSection } from "./components/features";
import { HealthRecordsSection } from "./components/features";
import { ScreeningsSection } from "./components/features";
import { AssistantSection } from "./components/features";
import CPTLookup from "./components/features/CPTLookup";
import PeerNotify from "./components/features/PeerNotify";
import { LocumDashboard, MultiStateMatrix } from "./components/features";
import { AuthPage, NotificationCenter, NotificationBanner, SettingsSection, FAQSection, LegalSection, PricingModal, TeamSection, CancellationPage, FeedbackModal, SupportModal, AdminDashboard } from "./components/pages";
import { isAdminUser } from "./lib/admin";
import FoundingMemberBadge from "./components/shared/FoundingMemberBadge";
import UpdatePrompt from "./components/shared/UpdatePrompt";
import { SignedIn, SignedOut } from "@clerk/clerk-react";
import {
  STATES, getLicenseTypes, PRIVILEGE_TYPES, INSURANCE_TYPES, CASE_CATEGORIES,
  EDUCATION_TYPES, WORK_HISTORY_TYPES, REFERENCE_RELATIONSHIPS, MALPRACTICE_OUTCOMES,
} from "./constants";
import { computeBoardCompliance, aoaNationalEntry } from "./utils/boardCompliance";
import {
  generateId, getStatusColor, getStatusLabel, formatDate, MS_PER_DAY, describeItem,
} from "./utils/helpers";
import { complianceFor, findStateLicense } from "./utils/compliance";
import { generateAlerts, activeAckFor } from "./utils/notifications";
import { lookupNPI, extractLicensesFromNPI } from "./utils/npiLookup";

/* ─── Helpers ─────────────────────────────────────────────────── */

function statusFromColor(color) {
  if (color === "red") return "expired";
  if (color === "orange" || color === "amber") return "expiring";
  if (color === "green") return "active";
  return "draft";
}

/* ─── App Shell ───────────────────────────────────────────────── */

export default function App() {
  const [tab, setTab] = useState("home");
  const [subPage, setSubPage] = useState(null);
  const handleNavigate = useCallback((t, sub) => { setTab(t); setSubPage(sub); }, []);

  return (
    <>
      <SignedOut>
        <AuthPage />
      </SignedOut>
      <SignedIn>
        <AppProvider onNavigate={handleNavigate}>
          <AppInner tab={tab} setTab={setTab} subPage={subPage} setSubPage={setSubPage} />
        </AppProvider>
      </SignedIn>
      {/* Update check/refresh button — outside the auth gate so a stale
          bundle can be refreshed from the sign-in screen too. */}
      <UpdatePrompt />
    </>
  );
}

/* ─── Pro Gate Overlay ────────────────────────────────────────── */
function ProGate({ T, onUpgrade, featureName }) {
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 10,
      backgroundColor: T.bg + "e8",
      backdropFilter: "blur(4px)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      borderRadius: 16, padding: "32px 24px", textAlign: "center",
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 28,
        background: "linear-gradient(135deg, #10b981, #3b82f6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 24, marginBottom: 16,
        boxShadow: "0 4px 16px rgba(16,185,129,0.3)",
      }}>🔒</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginBottom: 6 }}>
        {featureName} — Pro Feature
      </div>
      <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 20, maxWidth: 260 }}>
        Upgrade to Pro to unlock this feature and everything else CredentialDOMD has to offer.
      </div>
      <button
        onClick={onUpgrade}
        style={{
          padding: "13px 28px", borderRadius: 14, border: "none",
          background: "linear-gradient(135deg, #10b981, #059669)",
          color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
          boxShadow: "0 4px 14px rgba(16,185,129,0.35)",
        }}
      >
        Upgrade to Pro →
      </button>
    </div>
  );
}

function AppInner({ tab, setTab, subPage, setSubPage }) {
  const { data, setData, loaded, theme: T, toggleTheme, allTrackedStates, addItem, editItem, deleteItem, updateSettings, user, authChecked, signOut, isPro, isPractice, plan, manage } = useApp();
  const [showPricing, setShowPricing] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [shareItem, setShareItem] = useState(null);
  const [shareSection, setShareSection] = useState(null);
  const [searchQ, setSearchQ] = useState("");
  const [shareFilter, setShareFilter] = useState("all");
  const [notifCenterOpen, setNotifCenterOpen] = useState(false);
  const [autoAddLicense, setAutoAddLicense] = useState(false);
  // {sec, id} — opens that record's edit form after navigating (Home → fix-it links)
  const [autoEditTarget, setAutoEditTarget] = useState(null);
  const [npiImporting, setNpiImporting] = useState(false);
  const [npiImportMsg, setNpiImportMsg] = useState(null);

  useNotifications();

  const alerts = useMemo(() => generateAlerts(data), [data]);
  const alertCount = alerts?.count || 0;

  // Renewal packet: per-state CME transcript for the current cycle + the
  // linked certificate files, sent as one share.
  const sendRenewalPacket = useCallback(async (st) => {
    const comp = complianceFor(data, st);
    const sName = data.settings?.name ? `${data.settings.name}, ${data.settings.degreeType || "MD"}` : "Physician";
    const inWin = (data.cme || []).filter(c => {
      if (!c.date) return false;
      const d = new Date(c.date);
      return d >= comp.windowStart && d <= comp.windowEnd;
    }).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const div = "\u2500".repeat(40);
    const lines = [
      `CME TRANSCRIPT \u2014 ${st} RENEWAL`, div,
      `Physician: ${sName}${data.settings?.npi ? " \u00b7 NPI " + data.settings.npi : ""}`,
      `Cycle window: ${formatDate(comp.windowStart)} \u2013 ${formatDate(comp.windowEnd)}`,
      `Requirement: ${comp.noGeneralReq ? "topic-specific only" : `${comp.totalRequired} hrs / ${comp.cycle} yrs`}${comp.cat1Required ? ` (min ${comp.cat1Required} Cat 1)` : ""}`,
      div,
    ];
    for (const c of inWin) {
      lines.push(`${formatDate(c.date)}  ${c.title || c.category || "CME"}`);
      lines.push(`   ${c.hours || 0} hrs \u00b7 ${c.category || "uncategorized"}${c.provider ? " \u00b7 " + c.provider : ""}${(c.topics || []).length ? " \u00b7 " + c.topics.join(", ") : ""}`);
    }
    lines.push(div, `TOTAL: ${comp.totalEarned} hrs${comp.cat1Required ? ` (Cat 1: ${comp.cat1Earned})` : ""}`);
    for (const t of comp.topicResults) {
      lines.push(`  ${t.met ? "\u2713" : "\u2717"} ${t.topic}: ${t.checklist ? (t.met ? "completed" : "REQUIRED") : `${t.earned}/${t.required} hrs`}`);
    }
    lines.push("", `Generated by CredentialDOMD \u00b7 ${new Date().toLocaleDateString()}`);
    const text = lines.join("\n");

    // Attach certificates linked to the in-window entries
    const ids = new Set(inWin.map(c => "cme:" + c.id));
    const files = (data.documents || [])
      .filter(d2 => ids.has(d2.linkedTo) && d2.data)
      .map(d2 => {
        try {
          const [head, b64] = d2.data.split(",");
          const mime = d2.type || head.match(/data:(.*?)[;,]/)?.[1] || "application/octet-stream";
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return new File([arr], d2.name || "certificate", { type: mime });
        } catch { return null; }
      }).filter(Boolean);

    const title = `${st} CME transcript \u2014 ${sName}`;
    if (navigator.share) {
      try {
        await navigator.share(files.length && navigator.canShare?.({ files }) ? { files, title, text } : { title, text });
        addItem("shareLog", { id: generateId(), itemId: null, itemName: `${st} renewal packet`, section: "cme", method: "share", recipient: "", sentAt: new Date().toISOString() });
        return;
      } catch (err) { if (err?.name === "AbortError") return; }
    }
    await navigator.clipboard?.writeText(text).catch(() => {});
    window.alert("Transcript copied to clipboard (this browser can't attach files to a share).");
  }, [data, addItem]);

  const openShare = useCallback((item, section) => { setShareItem(item); setShareSection(section); }, []);
  const closeShare = useCallback(() => { setShareItem(null); setShareSection(null); }, []);
  const logShare = useCallback((entry) => addItem("shareLog", { ...entry, id: entry.id || crypto.randomUUID() }), [addItem]);

  const linkedDocs = useMemo(() => {
    if (!shareItem || !shareSection) return [];
    return data.documents.filter(d => d.linkedTo === shareSection + ":" + shareItem.id);
  }, [shareItem, shareSection, data.documents]);

  const crud = useCallback((key) => ({
    onAdd: (item) => addItem(key, item),
    onEdit: (item) => editItem(key, item),
    onDelete: (id) => deleteItem(key, id),
  }), [addItem, editItem, deleteItem]);

  const allCreds = useMemo(() => [
    ...data.licenses.map(l => ({ ...l, _sec: "licenses", _cat: "License" })),
    ...data.cme.map(c => ({ ...c, _sec: "cme", _cat: "CME" })),
    ...data.privileges.map(p => ({ ...p, _sec: "privileges", _cat: "Privilege" })),
    ...data.insurance.map(i => ({ ...i, _sec: "insurance", _cat: "Insurance" })),
    ...(data.caseLogs || []).map(c => ({ ...c, _sec: "caseLogs", _cat: "Case" })),
    ...(data.healthRecords || []).map(h => ({ ...h, _sec: "healthRecords", _cat: "Health" })),
    ...(data.education || []).map(e => ({ ...e, _sec: "education", _cat: "Education" })),
    ...(data.workHistory || []).map(w => ({ ...w, _sec: "workHistory", _cat: "Work" })),
    ...(data.peerReferences || []).map(r => ({ ...r, _sec: "peerReferences", _cat: "Reference" })),
    ...(data.malpracticeHistory || []).map(m => ({ ...m, _sec: "malpracticeHistory", _cat: "Malpractice" })),
    ...(data.publications || []).map(p => ({ ...p, _sec: "publications", _cat: "Publication" })),
    ...(data.memberships || []).map(m => ({ ...m, _sec: "memberships", _cat: "Organization" })),
  ], [data.licenses, data.cme, data.privileges, data.insurance, data.caseLogs, data.healthRecords, data.education, data.workHistory, data.peerReferences, data.malpracticeHistory, data.publications, data.memberships]);

  const { expired, soon, urgent, snoozed } = useMemo(() => {
    const now = new Date();
    const lead = data.settings.reminderLeadDays || 90;
    const inWindow = allCreds.filter(i => {
      if (!i.expirationDate) return false;
      if (new Date(i.expirationDate) < now) return true;
      const d = Math.ceil((new Date(i.expirationDate) - now) / MS_PER_DAY);
      return d >= 0 && d <= lead;
    });
    // Acknowledged alerts step aside until their snooze date passes
    const active = inWindow.filter(i => !activeAckFor(data, i.id));
    const snz = inWindow.filter(i => activeAckFor(data, i.id));
    const exp = active.filter(i => new Date(i.expirationDate) < now);
    const sn = active.filter(i => new Date(i.expirationDate) >= now);
    const urg = [...exp, ...sn].sort((a, b) => new Date(a.expirationDate) - new Date(b.expirationDate));
    return { expired: exp, soon: sn, urgent: urg, snoozed: snz };
  }, [allCreds, data.settings.reminderLeadDays, data]);

  // CME math breakdown — tap a state card to see exactly which entries
  // counted, which didn't, and why. {st, comp}
  const [cmeDetail, setCmeDetail] = useState(null);
  // Same for board certification cards. {b}
  const [boardDetail, setBoardDetail] = useState(null);

  // Acknowledge-an-alert modal: {item} being acknowledged + form state
  const [ackItem, setAckItem] = useState(null);
  const [ackNote, setAckNote] = useState("");
  const [ackUntil, setAckUntil] = useState("");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const openAck = useCallback((item) => {
    setAckItem(item); setAckNote(""); setAckUntil("");
  }, []);
  const saveAck = useCallback((untilDate) => {
    if (!ackItem || !untilDate) return;
    addItem("alertAcks", {
      id: generateId(), itemId: ackItem.id, until: untilDate,
      note: ackNote.trim(), createdAt: new Date().toISOString(),
    });
    setAckItem(null);
  }, [ackItem, ackNote, addItem]);

  // Board continuing-certification standing (cycle-windowed). Every DO sees
  // the AOA national cycle even before picking a specific board.
  const boardComps = useMemo(() => {
    const list = computeBoardCompliance(data);
    if (data.settings.degreeType === "DO" && data.cme.length > 0 && !list.some(b => b.source === "AOA")) {
      list.unshift(aoaNationalEntry(data));
    }
    return list;
  }, [data]);

  // An incomplete profile silently degrades everything downstream — degree
  // type drives MD-vs-DO CME rules, specialty drives board requirements,
  // NPI/email feed credentialing paperwork. Flag gaps loudly on Home.
  const profileGaps = useMemo(() => {
    const s = data.settings;
    const gaps = [];
    if (!s.name) gaps.push("your name");
    if (!s.degreeType) gaps.push("degree (MD or DO — it changes which CME rules apply)");
    if (!s.primaryState) gaps.push("primary state");
    if (!(s.specialties || []).length) gaps.push("board specialty (drives your board's CME requirements)");
    if (!s.npi) gaps.push("NPI");
    if (!s.email) gaps.push("email");
    return gaps;
  }, [data.settings]);

  // Expiring record types that are MISSING their expiration date — the app
  // can't protect what it can't see. Surfaced on Home until fixed.
  const missingExpiration = useMemo(() => {
    const out = [];
    for (const l of data.licenses || []) if (!l.expirationDate) out.push({ item: l, sec: "licenses", label: describeItem(l, data.settings.name) });
    for (const pv of data.privileges || []) if (!pv.expirationDate) out.push({ item: pv, sec: "privileges", label: describeItem(pv, data.settings.name) });
    for (const ins of data.insurance || []) if (!ins.expirationDate) out.push({ item: ins, sec: "insurance", label: describeItem(ins, data.settings.name) });
    for (const h of data.healthRecords || []) {
      if ((h.category === "TB Test" || h.category === "Fit Test") && !h.expirationDate) {
        out.push({ item: h, sec: "healthRecords", label: describeItem(h, data.settings.name) });
      }
    }
    return out;
  }, [data.licenses, data.privileges, data.insurance, data.healthRecords, data.settings.name]);

  // States where a DEA registration (or other state credential) exists but no
  // medical license record does — CME/renewal tracking can't cover that state
  // until the license itself is in the app.
  const statesMissingLicense = useMemo(() => {
    const licensed = new Set((data.licenses || []).filter(l => l.state && /medical license/i.test(l.type || "")).map(l => l.state));
    const out = new Set();
    for (const l of data.licenses || []) {
      if (l.state && !licensed.has(l.state)) out.add(l.state);
    }
    return [...out];
  }, [data.licenses]);

  // Per-state CME compliance, anchored to each license's renewal window,
  // sorted soonest-deadline-first. Drives the home cards AND the ring.
  const stateComps = useMemo(() =>
    allTrackedStates.map(st => ({
      st,
      comp: complianceFor(data, st),
      lic: findStateLicense(data.licenses, st),
    })).sort((a, b) => (a.comp.daysLeft ?? 9e9) - (b.comp.daysLeft ?? 9e9)),
  [allTrackedStates, data]);

  // Compliance percentage for ring — credentials current AND CME on track.
  const compliancePercent = useMemo(() => {
    const credItems = allCreds.filter(c => c.expirationDate);
    const activeCreds = credItems.filter(c => new Date(c.expirationDate) >= new Date()).length;
    const cmeItems = stateComps.length;
    const cmeOk = stateComps.filter(x => x.comp.fullyCompliant).length;
    const total = credItems.length + cmeItems;
    if (total === 0) return allCreds.length === 0 ? 0 : 100;
    return Math.round(((activeCreds + cmeOk) / total) * 100);
  }, [allCreds, stateComps]);

  // Credential counts for ring stats
  const credStats = useMemo(() => {
    const now = new Date();
    const lead = data.settings.reminderLeadDays || 90;
    const activeCount = allCreds.filter(c => {
      if (!c.expirationDate) return true;
      return Math.ceil((new Date(c.expirationDate) - now) / MS_PER_DAY) > lead;
    }).length;
    return { active: activeCount, expiring: soon.length, expired: expired.length, total: allCreds.length };
  }, [allCreds, soon, expired, data.settings.reminderLeadDays]);

  // Still checking auth (Clerk SDK still bootstrapping)
  if (!authChecked) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: T.bg, color: T.textMuted }}>
      <div style={{ textAlign: "center" }}>
        <AsclepiusIcon size={40} color={T.accent} />
        <div style={{ marginTop: 12, fontSize: 14, fontWeight: 500 }}>Loading...</div>
      </div>
    </div>
  );

  if (!loaded) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: T.bg, color: T.textMuted }}>
      <div style={{ textAlign: "center" }}>
        <AsclepiusIcon size={40} color={T.accent} />
        <div style={{ marginTop: 12, fontSize: 14, fontWeight: 500 }}>Loading...</div>
      </div>
    </div>
  );

  /* ─── HOME PAGE ──────────────────────────────────────────── */
  const renderHome = () => (
    <div className="cmd-fade-in">
      {/* Hero: Compliance Ring + Stats */}
      {allCreds.length > 0 ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 20,
          backgroundColor: T.card, borderRadius: 16, padding: "20px 24px",
          marginBottom: 16, boxShadow: T.shadow1,
          position: "relative", overflow: "hidden",
        }}>
          {/* Subtle gradient glow behind ring */}
          <div style={{
            position: "absolute", top: -40, left: -40,
            width: 200, height: 200,
            background: "radial-gradient(circle, rgba(16,185,129,0.08) 0%, transparent 70%)",
            pointerEvents: "none",
          }} />
          <div className="cmd-ring-animated">
            <ComplianceRing percent={compliancePercent} size={120} stroke={9} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {credStats.active > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: T.success }} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>{credStats.active} Active</span>
                </div>
              )}
              {credStats.expiring > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: T.warning }} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>{credStats.expiring} Expiring</span>
                </div>
              )}
              {credStats.expired > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: T.danger }} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>{credStats.expired} Expired</span>
                </div>
              )}
              {/* The ring counts CME cycles too — say so when they're the drag */}
              {stateComps.some(x => !x.comp.fullyCompliant) && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: T.warning }} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>
                    CME behind: {stateComps.filter(x => !x.comp.fullyCompliant).map(x => x.st).join(", ")}
                  </span>
                </div>
              )}
              {credStats.active > 0 && credStats.expiring === 0 && credStats.expired === 0 && (
                <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>All credentials current</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div onClick={() => { setAutoAddLicense(true); setTab("credentials"); setSubPage("licenses"); }} style={{
          backgroundColor: T.card, borderRadius: 16, padding: "32px 24px",
          marginBottom: 16, cursor: "pointer", border: `2px dashed ${T.border}`,
          textAlign: "center", boxShadow: T.shadow1,
        }}>
          <div style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: T.accentDim, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
            <AsclepiusIcon size={26} color={T.accent} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: T.text, marginBottom: 4 }}>Get Started</div>
          <div style={{ fontSize: 14, color: T.textMuted }}>Add your medical license to begin tracking credentials</div>
        </div>
      )}

      {/* Incomplete profile — the app can only compute what it knows */}
      {profileGaps.length > 0 && (
        <div onClick={() => { setTab("more"); setSubPage("settings"); }} style={{
          backgroundColor: T.warningDim, border: `1px solid ${T.warning}55`,
          borderRadius: 12, padding: "12px 16px", marginBottom: 14, cursor: "pointer",
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>
            {"⚠️"} Finish your profile — {profileGaps.length} thing{profileGaps.length === 1 ? "" : "s"} missing
          </div>
          <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
            Missing: {profileGaps.join(" · ")}. The app can only track what it knows — an empty specialty or degree hides CME requirements that apply to you. Tap to complete it in Settings.
          </div>
        </div>
      )}

      {/* Action Required — Horizontal Scroll Cards */}
      {/* Records the app can't protect: no expiration date on file */}
      {missingExpiration.length > 0 && (
        <div style={{
          backgroundColor: T.warningDim, border: `1px solid ${T.warning}55`,
          borderRadius: 12, padding: "12px 16px", marginBottom: 14,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>
            ⚠️ {missingExpiration.length} record{missingExpiration.length > 1 ? "s" : ""} missing an expiration date
          </div>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>
            Tap a record below, then use its pencil to add the expiration date. Until then the app can't warn you before it lapses.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {missingExpiration.slice(0, 5).map(({ item, sec, label }) => {
              const secLabel = sec === "licenses" ? "License" : sec === "privileges" ? "Privilege" : sec === "insurance" ? "Insurance" : "Health record";
              return (
              <button key={item.id} onClick={() => { setTab("credentials"); setSubPage(sec); setAutoEditTarget({ sec, id: item.id }); }} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "8px 10px", borderRadius: 8, border: "none",
                backgroundColor: T.card, color: T.text, fontSize: 13, fontWeight: 600,
                cursor: "pointer", textAlign: "left",
              }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ color: T.textMuted, fontWeight: 700 }}>{secLabel}: </span>{label}
                </span>
                <span style={{ color: T.warning, flexShrink: 0, fontWeight: 700 }}>Add date →</span>
              </button>
              );
            })}
          </div>
        </div>
      )}

      {(urgent.length > 0 || snoozed.length > 0) && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>Action Required</h3>
            {urgent.length > 0 && <span style={{ fontSize: 12, fontWeight: 600, color: T.danger }}>{urgent.length} item{urgent.length !== 1 ? "s" : ""}</span>}
          </div>
          <div className="cmd-snap-scroll">
            {urgent.slice(0, 6).map(item => {
              const sc = getStatusColor(item.expirationDate);
              const isExpired = sc === "red";
              return (
                <div key={item.id} onClick={() => { setTab("credentials"); setSubPage(item._sec); }} style={{
                  flex: "0 0 auto", width: 240, backgroundColor: T.card, borderRadius: 12,
                  padding: 16, cursor: "pointer", boxShadow: T.shadow1,
                  borderTop: `3px solid ${isExpired ? T.danger : T.warning}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>{item._cat}</span>
                    <StatusBadge status={isExpired ? "expired" : "expiring"} customLabel={getStatusLabel(item.expirationDate)} />
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {describeItem(item, data.settings.name)}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 12, color: T.textMuted }}>
                      {item.expirationDate ? `Exp ${formatDate(item.expirationDate)}` : ""}
                    </div>
                    <button onClick={(ev) => { ev.stopPropagation(); openAck(item); }} style={{
                      padding: "5px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
                      backgroundColor: "transparent", color: T.textMuted, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                    }}>Acknowledge</button>
                  </div>
                </div>
              );
            })}
          </div>
          {snoozed.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setShowSnoozed(v => !v)} style={{
                background: "none", border: "none", padding: "4px 2px", cursor: "pointer",
                fontSize: 12.5, fontWeight: 600, color: T.textMuted,
              }}>
                {"🔕"} {snoozed.length} acknowledged {showSnoozed ? "▴" : "▾"}
              </button>
              {showSnoozed && snoozed.map(item => {
                const ack = activeAckFor(data, item.id);
                return (
                  <div key={item.id} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                    backgroundColor: T.card, border: `1px dashed ${T.border}`, borderRadius: 10, marginTop: 6,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {describeItem(item, data.settings.name)}
                      </div>
                      <div style={{ fontSize: 11.5, color: T.textDim }}>
                        Exp {formatDate(item.expirationDate)} · quiet until {formatDate(ack?.until)}{ack?.note ? ` · ${ack.note}` : ""}
                      </div>
                    </div>
                    <button onClick={() => ack && deleteItem("alertAcks", ack.id)} style={{
                      padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
                      backgroundColor: "transparent", color: T.accent, fontSize: 11.5, fontWeight: 700, cursor: "pointer", flexShrink: 0,
                    }}>Wake</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* CME math — which entries counted, which didn't, and why */}
      <Modal open={!!cmeDetail} onClose={() => setCmeDetail(null)} title={cmeDetail ? `${cmeDetail.st} CME — the math` : "CME"}>
        {cmeDetail && (() => {
          const { comp } = cmeDetail;
          const deg = data.settings.degreeType;
          const cat1Keys = deg === "DO"
            ? (comp.cat1OneAOnly ? ["AOA Category 1-A"] : ["AOA Category 1-A", "AOA Category 1-B", "AMA PRA Category 1"])
            : ["AMA PRA Category 1"];
          const mandateTopics = comp.topicResults.map(t => t.topic);
          const inWin = [], outWin = [];
          for (const c of data.cme || []) {
            const d = c.date ? new Date(c.date) : null;
            if (d && d >= comp.windowStart && d <= comp.windowEnd) inWin.push(c);
            else outWin.push(c);
          }
          const fmtD = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          return (
            <>
              <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
                Cycle window: <strong style={{ color: T.text }}>{fmtD(comp.windowStart)} – {fmtD(comp.windowEnd)}</strong>
                {comp.windowAnchored ? " (anchored to your license renewal)" : " (rolling — add the license's expiration date to anchor it)"}
                {comp.daysLeft != null && ` · ${comp.daysLeft} days left`}. Only hours dated inside this window count toward this renewal.
              </div>

              {/* Requirement scoreboard */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {!comp.noGeneralReq && (
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13.5 }}>
                    <span style={{ color: T.text, fontWeight: 600 }}>Total hours</span>
                    <span style={{ fontWeight: 800, color: comp.totalMet ? T.success : T.warning }}>{comp.totalEarned} / {comp.totalRequired}</span>
                  </div>
                )}
                {comp.cat1Required > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13.5 }}>
                    <span style={{ color: T.text, fontWeight: 600 }}>{comp.cat1OneAOnly ? "AOA Category 1-A" : "Category 1"} minimum
                      <span style={{ display: "block", fontSize: 11, color: T.textDim, fontWeight: 500 }}>counts: {cat1Keys.join(", ")}</span>
                    </span>
                    <span style={{ fontWeight: 800, color: comp.cat1Met ? T.success : T.warning }}>{comp.cat1Earned} / {comp.cat1Required}</span>
                  </div>
                )}
                {comp.topicResults.map(t => (
                  <div key={t.topic} style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13.5 }}>
                    <span style={{ color: T.text, fontWeight: 600 }}>{t.topic}{t.checklist ? " (required topic)" : ""}</span>
                    <span style={{ fontWeight: 800, color: t.met ? T.success : T.warning }}>{t.checklist ? (t.met ? "✓" : "missing") : `${t.earned} / ${t.required}`}</span>
                  </div>
                ))}
                {comp.mate && (
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13.5 }}>
                    <span style={{ color: T.text, fontWeight: 600 }}>MATE Act (one-time, any date)</span>
                    <span style={{ fontWeight: 800, color: comp.mate.met ? T.success : T.warning }}>{comp.mate.earned} / {comp.mate.required}</span>
                  </div>
                )}
              </div>

              {/* What counted */}
              <div style={{ fontSize: 12, fontWeight: 800, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Counted this cycle ({inWin.length})
              </div>
              {inWin.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>Nothing yet — every hour you log dated inside the window lands here.</div>}
              {inWin.map(c => (
                <div key={c.id} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13.5 }}>
                    <span style={{ fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || c.category}</span>
                    <span style={{ fontWeight: 800, color: T.text, flexShrink: 0 }}>{c.hours}h</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: T.textDim }}>{c.date}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 8, backgroundColor: cat1Keys.includes(c.category) ? T.successDim : T.input, color: cat1Keys.includes(c.category) ? T.success : T.textMuted }}>
                      {c.category || "no category"}{cat1Keys.includes(c.category) ? " · counts as Cat 1" : ""}
                    </span>
                    {(c.topics || []).filter(t => mandateTopics.includes(t)).map(t => (
                      <span key={t} style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 8, backgroundColor: T.accentDim, color: T.accent }}>{t}</span>
                    ))}
                  </div>
                </div>
              ))}

              {/* What didn't count */}
              {outWin.length > 0 && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "10px 0 6px" }}>
                    Not counting toward this renewal ({outWin.length})
                  </div>
                  {outWin.map(c => (
                    <div key={c.id} style={{ padding: "8px 10px", borderRadius: 8, border: `1px dashed ${T.border}`, marginBottom: 6, opacity: 0.75 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                        <span style={{ fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || c.category}</span>
                        <span style={{ fontWeight: 700, color: T.textMuted, flexShrink: 0 }}>{c.hours}h</span>
                      </div>
                      <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
                        {c.date ? `${c.date} — outside the cycle window` : "no date on the entry — add one so it can count"}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {comp.notes && (
                <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 10, lineHeight: 1.5 }}>{comp.notes}</div>
              )}
            </>
          );
        })()}
      </Modal>

      {/* Board math — same transparency as the state cards */}
      <Modal open={!!boardDetail} onClose={() => setBoardDetail(null)} title={boardDetail ? `${boardDetail.name} — the math` : "Board"}>
        {boardDetail && (() => {
          const b = boardDetail;
          const counts = (c) => !b.countRule || (c.category || "").includes(b.countRule);
          const inWin = [], excluded = [];
          for (const c of data.cme || []) {
            if (c.date && b.from && c.date >= b.from && c.date <= b.to) {
              if (counts(c)) inWin.push(c);
              else excluded.push({ c, why: `category doesn't count for this board — needs ${b.countRule}` });
            } else {
              excluded.push({ c, why: c.date ? "outside this cycle window" : "no date on the entry — add one so it can count" });
            }
          }
          const fmtD = (d) => new Date(d + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          return (
            <>
              <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
                {b.label}. Cycle window: <strong style={{ color: T.text }}>{b.from ? fmtD(b.from) : "—"} – {b.to ? fmtD(b.to) : "—"}</strong>
                {b.daysLeft != null && ` · ${b.daysLeft} days left`}. {b.countRule ? `Only ${b.countRule} credit counts for this board.` : "All CME categories count toward the total."}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13.5 }}>
                  <span style={{ color: T.text, fontWeight: 600 }}>Total hours ({b.unit})</span>
                  <span style={{ fontWeight: 800, color: b.met ? T.success : T.warning }}>{b.earned} / {b.required}</span>
                </div>
                {b.cat1aRequired > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13.5 }}>
                    <span style={{ color: T.text, fontWeight: 600 }}>AOA Category 1-A minimum</span>
                    <span style={{ fontWeight: 800, color: b.cat1aEarned >= b.cat1aRequired ? T.success : T.warning }}>{b.cat1aEarned} / {b.cat1aRequired}</span>
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, fontWeight: 800, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Counted this cycle ({inWin.length})
              </div>
              {inWin.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>Nothing yet — hours dated inside the window land here.</div>}
              {inWin.map(c => (
                <div key={c.id} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13.5 }}>
                    <span style={{ fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || c.category}</span>
                    <span style={{ fontWeight: 800, color: T.text, flexShrink: 0 }}>{c.hours}h</span>
                  </div>
                  <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{c.date} · {c.category || "no category"}</div>
                </div>
              ))}
              {excluded.length > 0 && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "10px 0 6px" }}>
                    Not counting ({excluded.length})
                  </div>
                  {excluded.map(({ c, why }) => (
                    <div key={c.id} style={{ padding: "8px 10px", borderRadius: 8, border: `1px dashed ${T.border}`, marginBottom: 6, opacity: 0.75 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                        <span style={{ fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || c.category}</span>
                        <span style={{ fontWeight: 700, color: T.textMuted, flexShrink: 0 }}>{c.hours}h</span>
                      </div>
                      <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{c.date ? `${c.date} — ${why}` : why}</div>
                    </div>
                  ))}
                </>
              )}
              {b.assessment && (
                <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 10, lineHeight: 1.5 }}>Also required: {b.assessment}</div>
              )}
              {b.notes && <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>{b.notes}</div>}
            </>
          );
        })()}
      </Modal>

      {/* Acknowledge an alert — "seen it, nothing to do yet" is a real state */}
      <Modal open={!!ackItem} onClose={() => setAckItem(null)} title="Acknowledge this alert">
        {ackItem && (() => {
          const exp = ackItem.expirationDate;
          const fmtISO = (d) => d.toISOString().slice(0, 10);
          const plus = (days) => fmtISO(new Date(Date.now() + days * MS_PER_DAY));
          const before30 = exp ? fmtISO(new Date(new Date(exp + "T12:00").getTime() - 30 * MS_PER_DAY)) : null;
          const today = fmtISO(new Date());
          const chips = [
            { l: "2 weeks", v: plus(14) },
            { l: "1 month", v: plus(30) },
            ...(before30 && before30 > today ? [{ l: "Until 30 days before it expires", v: before30 }] : []),
          ];
          return (
            <>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 2 }}>{describeItem(ackItem, data.settings.name)}</div>
              <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 12 }}>
                Expires {formatDate(exp)}. Nothing to do right now? Silence this alert and the app will raise it again when the date you pick arrives.
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>Quiet until</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {chips.map(c => (
                  <button key={c.l} onClick={() => setAckUntil(c.v)} style={{
                    padding: "9px 13px", borderRadius: 16, fontSize: 13, fontWeight: 700, cursor: "pointer",
                    border: `1px solid ${ackUntil === c.v ? T.accent : T.border}`,
                    backgroundColor: ackUntil === c.v ? T.accent : "transparent",
                    color: ackUntil === c.v ? "#fff" : T.textMuted,
                  }}>{c.l}</button>
                ))}
                <input type="date" value={ackUntil} min={today} onChange={e => setAckUntil(e.target.value)}
                  style={{ padding: "8px 10px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13 }} />
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>Why (optional — shows with the acknowledged alert)</div>
              <input value={ackNote} onChange={e => setAckNote(e.target.value)} placeholder="e.g. waiting on the board to extend"
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 15 }} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button onClick={() => setAckItem(null)} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                <button onClick={() => saveAck(ackUntil)} disabled={!ackUntil} style={{
                  padding: "12px 18px", borderRadius: 10, border: "none",
                  backgroundColor: ackUntil ? T.accent : T.border, color: "#fff", fontSize: 15, fontWeight: 600,
                  cursor: ackUntil ? "pointer" : "default",
                }}>Acknowledge</button>
              </div>
            </>
          );
        })()}
      </Modal>

      {/* Credentials List */}
      {allCreds.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>Credentials</h3>
            <button onClick={() => { setTab("credentials"); setSubPage(null); }} style={{
              background: "none", border: "none", fontSize: 13, fontWeight: 600,
              color: T.accent, cursor: "pointer", padding: 0,
            }}>View All</button>
          </div>
          <div style={{ backgroundColor: T.card, borderRadius: 12, overflow: "hidden", boxShadow: T.shadow1 }}>
            {data.licenses.slice(0, 5).map((item, idx) => {
              const sc = getStatusColor(item.expirationDate);
              return (
                <div key={item.id} onClick={() => { setTab("credentials"); setSubPage("licenses"); }} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 16px", cursor: "pointer",
                  borderBottom: idx < Math.min(data.licenses.length, 5) - 1 ? `1px solid ${T.border}` : "none",
                  transition: "background 0.15s",
                }}>
                  <StatusDot color={sc} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {describeItem(item, data.settings.name)}
                    </div>
                    <div style={{ fontSize: 13, color: T.textMuted, marginTop: 1 }}>
                      {[item.state, item.expirationDate ? `Exp ${formatDate(item.expirationDate)}` : null].filter(Boolean).join(" \u00b7 ")}
                    </div>
                  </div>
                  <StatusBadge status={statusFromColor(sc)} />
                  <span style={{ color: T.textDim, fontSize: 16 }}>{"\u203a"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CME Compliance — shown for every tracked state even with zero CME
          logged; "30 hrs to go" is exactly what an empty cycle needs to say */}
      {allTrackedStates.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>CME Progress</h3>
            <button onClick={() => { setTab("credentials"); setSubPage("findCme"); }} style={{
              background: "none", border: "none", fontSize: 13, fontWeight: 600,
              color: T.accent, cursor: "pointer", padding: 0,
            }}>Find CME</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {statesMissingLicense.map(st => (
              <button key={`ml-${st}`} onClick={() => { setTab("credentials"); setSubPage("licenses"); }} style={{
                textAlign: "left", backgroundColor: T.warningDim, border: `1px solid ${T.warning}`,
                borderRadius: 14, padding: "12px 14px", cursor: "pointer",
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.warning }}>
                  {st}: no medical license on file
                </div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
                  You have a {st} credential (like a DEA registration) but the {st} medical
                  license itself isn't in the app — add it and {st} CME &amp; renewal tracking
                  turn on automatically. Tap to add it.
                </div>
              </button>
            ))}
            {stateComps.map(({ st, comp, lic }) => {
              const unmetTopics = comp.topicResults.filter(t => !t.met);
              const dl = comp.daysLeft;
              const urgency = dl == null ? null : dl <= 60 ? "danger" : dl <= 180 ? "warning" : "ok";
              return (
                <div key={st} onClick={() => setCmeDetail({ st, comp })} style={{
                  backgroundColor: T.card, borderRadius: 12, padding: "14px 16px",
                  boxShadow: T.shadow1, cursor: "pointer",
                  borderLeft: `3px solid ${comp.fullyCompliant ? T.success : T.warning}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{st}</span>
                      {st === data.settings.primaryState && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: T.accent, backgroundColor: T.accentDim, padding: "2px 6px", borderRadius: 4 }}>PRIMARY</span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {comp.noGeneralReq
                        ? <span style={{ fontSize: 13, color: T.textDim }}>Topic-specific</span>
                        : <span style={{ fontSize: 14, fontWeight: 700, color: comp.totalMet ? T.success : T.text }}>
                            {comp.totalMet ? `${comp.totalEarned}/${comp.totalRequired} hrs \u2713` : `${comp.hoursRemaining} hrs to go`}
                          </span>
                      }
                      <div style={{
                        width: 22, height: 22, borderRadius: 11,
                        backgroundColor: comp.fullyCompliant ? T.successDim : T.warningDim,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: comp.fullyCompliant ? T.success : T.warning, fontSize: 13, fontWeight: 700,
                      }}>{comp.fullyCompliant ? "\u2713" : "!"}</div>
                    </div>
                  </div>
                  {/* Renewal deadline */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: T.textDim }}>
                      {comp.windowAnchored
                        ? `License renews ${formatDate(lic.expirationDate)}`
                        : `No ${st} license on file \u2014 tracking a rolling ${comp.cycle}-yr window`}
                    </span>
                    {dl != null && (
                      <span style={{
                        fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 8,
                        backgroundColor: urgency === "danger" ? T.dangerDim : urgency === "warning" ? T.warningDim : T.successDim,
                        color: urgency === "danger" ? T.danger : urgency === "warning" ? T.warning : T.success,
                      }}>
                        {dl <= 0 ? "OVERDUE" : `${dl} days`}
                      </span>
                    )}
                  </div>

                  {/* Progress bar */}
                  {!comp.noGeneralReq && comp.totalRequired > 0 && (
                    <div style={{ height: 6, backgroundColor: T.input, borderRadius: 3, overflow: "hidden", marginBottom: unmetTopics.length > 0 ? 8 : 0 }}>
                      <div style={{
                        height: "100%", borderRadius: 3,
                        width: Math.min(100, (comp.totalEarned / comp.totalRequired) * 100) + "%",
                        backgroundColor: comp.totalMet ? T.success : T.accent,
                        transition: "width 0.5s ease",
                      }} />
                    </div>
                  )}
                  {unmetTopics.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                      {unmetTopics.map(t => (
                        <span key={t.topic} style={{
                          padding: "3px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                          backgroundColor: T.warningDim, color: T.warning,
                        }}>{t.checklist ? `${t.topic}: required` : `${t.topic}: ${t.earned}/${t.required}h`}</span>
                      ))}
                      <button onClick={(e) => { e.stopPropagation(); setTab("credentials"); setSubPage("findCme"); }} style={{
                        padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6,
                        border: "none", backgroundColor: T.accentDim, color: T.accent, cursor: "pointer",
                      }}>Find CME &rarr;</button>
                    </div>
                  )}
                  {!comp.cat1Met && comp.cat1Required > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <span style={{ padding: "3px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6, backgroundColor: T.dangerDim, color: T.danger }}>
                        {comp.cat1OneAOnly ? "AOA Cat 1-A" : "Cat 1"}: {comp.cat1Earned}/{comp.cat1Required}h needed
                      </span>
                    </div>
                  )}
                  {comp.mate && !comp.mate.met && (
                    <div style={{ marginTop: 6 }}>
                      <span style={{ padding: "3px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6, backgroundColor: T.dangerDim, color: T.danger }}>
                        MATE Act (one-time): {comp.mate.earned}/{comp.mate.required}h opioid/SUD training
                      </span>
                    </div>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <button onClick={(e) => { e.stopPropagation(); sendRenewalPacket(st); }} style={{
                      padding: "6px 12px", fontSize: 12, fontWeight: 700, borderRadius: 8,
                      border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.accent, cursor: "pointer",
                    }}>
                      {"\ud83d\udce4"} Renewal packet
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Board certification standing \u2014 cycle-windowed, from Settings \u2192
          Board Specialties. Replaces the old lifetime-sum AOA card. */}
      {boardComps.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 10 }}>Board Certification</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {boardComps.filter(b => !b.followsParent).map(b => (
              <div key={b.id} onClick={() => setBoardDetail(b)} style={{
                backgroundColor: T.card, borderRadius: 12, padding: "14px 16px", boxShadow: T.shadow1, cursor: "pointer",
                borderLeft: `3px solid ${b.met ? T.success : T.warning}`,
              }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{b.label}</div>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: b.met ? T.success : T.warning, flexShrink: 0 }}>
                    {b.earned}/{b.required} hrs
                  </div>
                </div>
                <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                  {b.unit} \u00b7 {b.windowLabel}{b.daysLeft != null ? ` \u00b7 ${b.daysLeft} days left` : ""}
                </div>
                {b.required > 0 && (
                  <div style={{ height: 6, backgroundColor: T.input, borderRadius: 3, overflow: "hidden", marginTop: 8 }}>
                    <div style={{
                      height: "100%", borderRadius: 3,
                      width: Math.min(100, (b.earned / b.required) * 100) + "%",
                      backgroundColor: b.met ? T.success : T.accent,
                    }} />
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8, alignItems: "center" }}>
                  {b.cat1aRequired > 0 && (
                    <span style={{
                      padding: "3px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                      backgroundColor: b.cat1aEarned >= b.cat1aRequired ? T.successDim : T.warningDim,
                      color: b.cat1aEarned >= b.cat1aRequired ? T.success : T.warning,
                    }}>AOA Cat 1-A: {b.cat1aEarned}/{b.cat1aRequired}h</span>
                  )}
                  {!b.met && (
                    <button onClick={(e) => { e.stopPropagation(); setTab("credentials"); setSubPage("findCme"); }} style={{
                      padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6,
                      border: "none", backgroundColor: T.accentDim, color: T.accent, cursor: "pointer",
                    }}>Find CME &rarr;</button>
                  )}
                </div>
                {b.assessment && (
                  <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 6, lineHeight: 1.4 }}>
                    Also required: {b.assessment}
                  </div>
                )}
                {b.notes && (
                  <div style={{ fontSize: 11, color: T.textDim, marginTop: 3 }}>{b.notes}</div>
                )}
              </div>
            ))}
            {boardComps.filter(b => b.followsParent).map(b => (
              <div key={b.id} style={{ fontSize: 12, color: T.textDim, padding: "0 4px" }}>
                {b.label} \u2014 CME follows the primary board above
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All clear */}
      {allCreds.length > 0 && urgent.length === 0 && (
        <div style={{
          textAlign: "center", padding: "24px 16px", backgroundColor: T.successDim,
          borderRadius: 12, marginBottom: 16,
        }}>
          <div style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: T.success, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px", color: "#fff" }}>
            <CheckIcon />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>All Clear</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginTop: 2 }}>No urgent items right now.</div>
        </div>
      )}
    </div>
  );

  /* ─── SHARE PAGE ─────────────────────────────────────────── */
  const renderShare = () => {
    const filtered = allCreds.filter(item => {
      const text = [item.name, item.type, item.title, item.category, item.licenseNumber, item.policyNumber, item.facility, item.state, item.provider, item.organization, item.role, item.citation, item.institution].filter(Boolean).join(" ").toLowerCase();
      return (searchQ === "" || text.includes(searchQ.toLowerCase())) && (shareFilter === "all" || item._sec === shareFilter);
    });
    const fTabs = [{ k: "all", l: "All" }, { k: "licenses", l: "Licenses" }, { k: "cme", l: "CME" }, { k: "privileges", l: "Privileges" }, { k: "insurance", l: "Insurance" }, { k: "caseLogs", l: "Cases" }, { k: "healthRecords", l: "Health" }, { k: "education", l: "Education" }];

    return (
      <div>
        <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>Quick Share</h2>
        <p style={{ margin: "0 0 14px", fontSize: 14, color: T.textMuted }}>Search and send any credential.</p>
        <div style={{ position: "relative", marginBottom: 12 }}>
          <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: T.textDim }}><SearchIcon /></div>
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search credentials..." style={{
            width: "100%", padding: "12px 14px 12px 40px", backgroundColor: T.input,
            border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text,
            fontSize: 15, outline: "none", boxSizing: "border-box",
          }} />
        </div>
        <div className="cmd-h-scroll" style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {fTabs.map(t => (
            <button key={t.k} onClick={() => setShareFilter(t.k)} style={{
              padding: "6px 14px", fontSize: 13, borderRadius: 20, flexShrink: 0,
              border: `1px solid ${shareFilter === t.k ? T.accent : T.border}`,
              backgroundColor: shareFilter === t.k ? T.accent : "transparent",
              color: shareFilter === t.k ? "#fff" : T.textMuted, fontWeight: 600,
            }}>{t.l}</button>
          ))}
        </div>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 32, color: T.textDim, fontSize: 14 }}>{allCreds.length === 0 ? "No credentials added yet." : "No matching credentials."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map(item => (
              <div key={item.id} onClick={() => openShare(item, item._sec)} className="cmd-card-hover" style={{
                backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
                padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between",
                cursor: "pointer", boxShadow: T.shadow1,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{describeItem(item, data.settings.name)}</div>
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    <span style={{ display: "inline-block", padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700, textTransform: "uppercase", backgroundColor: T.shareDim, color: T.share, marginRight: 6 }}>{item._cat}</span>
                    {[item.state, item.facility, item.provider, item.institution].filter(Boolean).join(" \u00b7 ")}
                  </div>
                </div>
                <div style={{
                  padding: "8px 14px", backgroundColor: T.accent, color: "#fff", borderRadius: 8,
                  fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
                }}><SendIcon /> Send</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  /* ─── CREDENTIALS PAGE ───────────────────────────────────── */
  const PRO_GATED = new Set(["privileges", "insurance", "caseLogs", "peerReferences", "malpracticeHistory"]);

  const credGroups = [
    { title: "Active Credentials", items: [
      { id: "licenses", label: "Licenses", icon: "\ud83e\udea3", count: data.licenses.length },
      { id: "matrix", label: "Multi-State Matrix", icon: "\ud83d\uddfa\ufe0f" },
      { id: "privileges", label: "Privileges", icon: "\ud83c\udfe5", count: data.privileges.length, pro: true },
      { id: "insurance", label: "Insurance", icon: "\ud83d\udee1\ufe0f", count: data.insurance.length, pro: true },
    ]},
    { title: "Continuing Education", items: [
      { id: "cme", label: "CME Credits", icon: "\ud83c\udf93", count: data.cme.length },
      { id: "findCme", label: "Find CME", icon: "\ud83d\udd17", accent: true },
    ]},
    { title: "Professional History", items: [
      { id: "education", label: "Education", icon: "\ud83c\udf93", count: (data.education || []).length },
      { id: "workHistory", label: "Work History", icon: "\ud83c\udfe2", count: (data.workHistory || []).length },
      { id: "caseLogs", label: "Case Logs", icon: "\ud83d\udccb", count: (data.caseLogs || []).length, pro: true },
    ]},
    { title: "Supporting Records", items: [
      { id: "healthRecords", label: "Health Records", icon: "\ud83d\udc89", count: (data.healthRecords || []).length },
      { id: "screenings", label: "Screenings", icon: "\ud83d\udd0e", count: (data.screenings || []).length },
      { id: "professionalPhotos", label: "Professional Photo", icon: "\ud83d\udcf8", count: (data.professionalPhotos || []).length },
      { id: "publications", label: "Publications", icon: "\ud83d\udcda", count: (data.publications || []).length },
      { id: "memberships", label: "Professional Organizations", icon: "\ud83c\udfdb\ufe0f", count: (data.memberships || []).length },
      { id: "peerReferences", label: "Peer References", icon: "\ud83d\udc65", count: (data.peerReferences || []).length, pro: true },
      { id: "malpracticeHistory", label: "Malpractice History", icon: "\ud83d\udccb", count: (data.malpracticeHistory || []).length, pro: true },
    ]},
  ];

  const renderCredentials = () => {
    if (subPage === "licenses") {
      const handleNpiImport = async () => {
        const npi = data.settings.npi;
        if (!npi) { setNpiImportMsg("Set your NPI in Settings first."); setTimeout(() => setNpiImportMsg(null), 4000); return; }
        setNpiImporting(true); setNpiImportMsg(null);
        try {
          const result = await lookupNPI(npi);
          if (!result) { setNpiImportMsg("No provider found for this NPI."); setTimeout(() => setNpiImportMsg(null), 4000); return; }
          const npiLicenses = extractLicensesFromNPI(result);
          if (npiLicenses.length === 0) { setNpiImportMsg("No license data found in NPI registry."); setTimeout(() => setNpiImportMsg(null), 4000); return; }
          const cur = data.licenses || [];
          const newOnes = npiLicenses
            .filter(nl => !cur.some(el => el.licenseNumber === nl.licenseNumber && el.state === nl.state))
            .map(nl => ({ id: generateId(), type: "Medical License", name: `${nl.state} Medical License`, licenseNumber: nl.licenseNumber, state: nl.state, issuedDate: "", expirationDate: "", notes: "Imported from NPPES NPI Registry", npiImported: true }));
          if (newOnes.length === 0) { setNpiImportMsg("All licenses already imported."); setTimeout(() => setNpiImportMsg(null), 4000); return; }
          for (const lic of newOnes) addItem("licenses", lic);
          setNpiImportMsg(`${newOnes.length} license${newOnes.length > 1 ? "s" : ""} imported!`);
          setTimeout(() => setNpiImportMsg(null), 5000);
        } catch (err) { setNpiImportMsg(err.message || "Import failed"); setTimeout(() => setNpiImportMsg(null), 4000); }
        finally { setNpiImporting(false); }
      };
      return (<>
        {data.settings.npi && (
          <div style={{ marginBottom: 12, padding: "14px 16px", borderRadius: 14, backgroundColor: T.accentDim, border: `1px solid ${T.accent}30`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Import from NPI Registry</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>Auto-fill licenses linked to NPI {data.settings.npi}</div>
            </div>
            <button onClick={handleNpiImport} disabled={npiImporting} style={{ padding: "8px 16px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 600, cursor: npiImporting ? "wait" : "pointer", opacity: npiImporting ? 0.7 : 1, flexShrink: 0 }}>
              {npiImporting ? "Looking up..." : "Import"}
            </button>
          </div>
        )}
        {npiImportMsg && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: npiImportMsg.includes("imported") ? T.success : T.warning, backgroundColor: npiImportMsg.includes("imported") ? T.successDim : T.warningDim }}>{npiImportMsg}</div>}
        <CrudSection title="Licenses" sectionKey="licenses" filterTabs={[
          { key: "medical", label: "Medical Licenses", match: i => /medical license|physician|osteopathic|training license/i.test(i.type || "") },
          { key: "dea", label: "DEA / CSR", match: i => /dea|controlled substance/i.test(i.type || "") },
          { key: "board", label: "Board Certs", match: i => /board/i.test(i.type || "") },
          { key: "life", label: "Life Support", match: i => /\b(bls|acls|atls|pals|nrp)\b|life support/i.test(i.type || "") },
        ]} autoEditId={autoEditTarget?.sec === "licenses" ? autoEditTarget.id : null} onAutoEditDone={() => setAutoEditTarget(null)} items={data.licenses} {...crud("licenses")} onShare={openShare} emptyIcon={"\ud83e\udea3"} emptyTitle="No licenses" emptySub="Add your medical licenses, DEA, and certifications." autoOpen={autoAddLicense} onAutoOpenDone={() => setAutoAddLicense(false)} fields={[{ key: "type", label: "Type", type: "select", options: getLicenseTypes(data.settings.degreeType) }, { key: "name", label: "Display Name", placeholder: "e.g. CA Medical License" }, { key: "licenseNumber", label: "License #" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "issuedDate", label: "Issued", type: "date" }, { key: "expirationDate", label: "Expires", type: "date", required: true }, { key: "notes", label: "Notes", type: "textarea" }]} />
      </>);
    }
    if (subPage === "cme") return <CMESection onShare={openShare} />;
    if (subPage === "findCme") return <CMEResourcesSection />;
    if (subPage === "matrix") return <MultiStateMatrix />;
    if (subPage?.startsWith("findCme:")) return <CMEResourcesSection initialTopicFilter={subPage.split(":")[1]} />;
    if (subPage === "privileges") {
      if (!isPro) return <div style={{ position: "relative", minHeight: 320 }}><ProGate T={T} onUpgrade={() => { setSubPage(null); setShowPricing(true); }} featureName="Hospital Privileges" /></div>;
      return <CrudSection title="Privileges" sectionKey="privileges" autoEditId={autoEditTarget?.sec === "privileges" ? autoEditTarget.id : null} onAutoEditDone={() => setAutoEditTarget(null)} items={data.privileges} {...crud("privileges")} onShare={openShare} emptyIcon={"\ud83c\udfe5"} emptyTitle="No privileges" emptySub="Track hospital admitting and surgical privileges." fields={[{ key: "type", label: "Type", type: "select", options: PRIVILEGE_TYPES }, { key: "name", label: "Display Name" }, { key: "facility", label: "Facility" }, { key: "city", label: "City" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "appointmentDate", label: "Appointed", type: "date" }, { key: "expirationDate", label: "Reappointment Due", type: "date", required: true }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    }
    if (subPage === "insurance") {
      if (!isPro) return <div style={{ position: "relative", minHeight: 320 }}><ProGate T={T} onUpgrade={() => { setSubPage(null); setShowPricing(true); }} featureName="Insurance Policies" /></div>;
      return <CrudSection title="Insurance" sectionKey="insurance" autoEditId={autoEditTarget?.sec === "insurance" ? autoEditTarget.id : null} onAutoEditDone={() => setAutoEditTarget(null)} items={data.insurance} {...crud("insurance")} onShare={openShare} emptyIcon={"\ud83d\udee1\ufe0f"} emptyTitle="No policies" emptySub="Track malpractice and liability insurance." fields={[{ key: "type", label: "Type", type: "select", options: INSURANCE_TYPES }, { key: "name", label: "Display Name" }, { key: "provider", label: "Carrier" }, { key: "policyNumber", label: "Policy #" }, { key: "coveragePerClaim", label: "Per Claim" }, { key: "coverageAggregate", label: "Aggregate" }, { key: "effectiveDate", label: "Effective", type: "date" }, { key: "expirationDate", label: "Expires", type: "date", required: true }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    }
    if (subPage === "screenings") return <ScreeningsSection onShare={openShare} />;
    if (subPage === "publications") return <CrudSection title="Publications" sectionKey="publications" items={data.publications || []} {...crud("publications")} onShare={openShare} emptyIcon={"\ud83d\udcda"} emptyTitle="No publications" emptySub="Papers, chapters, and case reports — they appear on your CV in the order you set." fields={[{ key: "name", label: "Short Label", placeholder: "e.g. Cureus 2026 — Composite Homeostatic Wave" }, { key: "citation", label: "Full Citation (as it should read on the CV)", type: "textarea" }, { key: "year", label: "Year" }, { key: "sortOrder", label: "Order on CV", type: "number", placeholder: "1 = first; blank = after the ordered ones" }, { key: "doi", label: "DOI" }, { key: "pmid", label: "PMID" }, { key: "url", label: "Link" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "memberships") return <CrudSection title="Professional Organizations" sectionKey="memberships" items={data.memberships || []} {...crud("memberships")} onShare={openShare} emptyIcon={"\ud83c\udfdb\ufe0f"} emptyTitle="No memberships" emptySub="AMA, ACS, CNS — society memberships appear on your CV under Professional Organizations." fields={[{ key: "organization", label: "Organization", placeholder: "e.g. Congress of Neurological Surgeons" }, { key: "role", label: "Membership Type", placeholder: "e.g. Member, Fellow, Resident member" }, { key: "startDate", label: "Member Since", type: "date" }, { key: "endDate", label: "Ended (blank if current)", type: "date" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "professionalPhotos") return <CrudSection title="Professional Photo" sectionKey="professionalPhotos" items={data.professionalPhotos || []} {...crud("professionalPhotos")} onShare={openShare} emptyIcon={"\ud83d\udcf8"} emptyTitle="No professional photo" emptySub="Agencies ask for a recent color photo — keep a dated headshot here and it rides along in packets." fields={[{ key: "name", label: "Label", placeholder: "e.g. Professional headshot" }, { key: "dateTaken", label: "Date Taken", type: "date" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "healthRecords") return <HealthRecordsSection onShare={openShare} autoEditId={autoEditTarget?.sec === "healthRecords" ? autoEditTarget.id : null} onAutoEditDone={() => setAutoEditTarget(null)} />;
    if (subPage === "education") return <CrudSection title="Education" sectionKey="education" items={data.education || []} {...crud("education")} onShare={openShare} emptyIcon={"\ud83c\udf93"} emptyTitle="No education records" emptySub="Add your degrees, diplomas, and training certificates." fields={[{ key: "type", label: "Type", type: "select", options: EDUCATION_TYPES }, { key: "name", label: "Display Name", placeholder: "e.g. DO Diploma - PCOM" }, { key: "institution", label: "Institution" }, { key: "startDate", label: "Start Date", type: "date" }, { key: "graduationDate", label: "Graduation / End Date", type: "date" }, { key: "fieldOfStudy", label: "Field of Study / Specialty" }, { key: "honors", label: "Honors" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "caseLogs") {
      if (!isPro) return <div style={{ position: "relative", minHeight: 320 }}><ProGate T={T} onUpgrade={() => { setSubPage(null); setShowPricing(true); }} featureName="Case Logs" /></div>;
      return <CrudSection title="Case Logs" sectionKey="caseLogs" items={data.caseLogs || []} {...crud("caseLogs")} onShare={openShare} emptyIcon={"\ud83d\udccb"} emptyTitle="No cases logged" emptySub="Track surgical cases for credentialing." fields={[{ key: "category", label: "Category", type: "select", options: CASE_CATEGORIES }, { key: "title", label: "Description" }, { key: "date", label: "Date", type: "date" }, { key: "facility", label: "Facility", type: "datalist", options: [...new Set((data.workHistory || []).map(w => w.employer).filter(Boolean))] }, { key: "role", label: "Role", type: "select", options: ["Primary Surgeon", "Co-Surgeon", "Teaching/Supervising", "First Assist", "Observer"] }, { key: "cptCodes", label: "CPT Code(s)", type: "cptPicker" }, { key: "notes", label: "Notes", type: "textarea" }]} renderExtra={item => item.role ? <div style={{ fontSize: 12, color: "#a78bfa", fontWeight: 600, marginTop: 2 }}>{item.role}</div> : null} />;
    }
    if (subPage === "workHistory") return <CrudSection title="Work History" sectionKey="workHistory" items={data.workHistory || []} {...crud("workHistory")} onShare={openShare} emptyIcon={"\ud83c\udfe2"} emptyTitle="No work history" emptySub="Track employment and practice experience for credentialing applications." fields={[{ key: "type", label: "Position Type", type: "select", options: WORK_HISTORY_TYPES }, { key: "position", label: "Position/Title", placeholder: "e.g. Attending Neurosurgeon" }, { key: "employer", label: "Employer/Organization" }, { key: "city", label: "City" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "startDate", label: "Start Date", type: "date" }, { key: "endDate", label: "End Date", type: "date" }, { key: "current", label: "Current Position", type: "select", options: ["No", "Yes"] }, { key: "description", label: "Description", type: "textarea" }, { key: "reasonForLeaving", label: "Reason for Leaving" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "peerReferences") {
      if (!isPro) return <div style={{ position: "relative", minHeight: 320 }}><ProGate T={T} onUpgrade={() => { setSubPage(null); setShowPricing(true); }} featureName="Peer References" /></div>;
      const handleContactImport = async () => {
        if (!('contacts' in navigator && 'ContactsManager' in window)) { return; }
        try {
          const [contact] = await navigator.contacts.select(['name', 'email', 'tel'], { multiple: false });
          if (!contact) return;
          addItem('peerReferences', {
            id: generateId(),
            name: contact.name?.[0] || "",
            email: contact.email?.[0] || "",
            phone: contact.tel?.[0] || "",
          });
        } catch {}
      };
      const contactsSupported = typeof window !== 'undefined' && 'contacts' in navigator && 'ContactsManager' in window;
      return (<>
        {contactsSupported && (
          <div style={{ marginBottom: 12, padding: "14px 16px", borderRadius: 14, backgroundColor: T.accentDim, border: `1px solid ${T.accent}30`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Import from Contacts</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>Add a peer reference from your phone contacts</div>
            </div>
            <button onClick={handleContactImport} style={{ padding: "8px 16px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
              Import
            </button>
          </div>
        )}
        <CrudSection title="Peer References" sectionKey="peerReferences" items={data.peerReferences || []} {...crud("peerReferences")} onShare={openShare} emptyIcon={"\ud83d\udc65"} emptyTitle="No references" emptySub="Store peer references needed for credentialing applications." fields={[{ key: "name", label: "Full Name", placeholder: "e.g. Jane Smith, MD" }, { key: "degree", label: "Degree/Credential", placeholder: "MD, DO, etc." }, { key: "specialty", label: "Specialty" }, { key: "institution", label: "Institution/Hospital" }, { key: "relationship", label: "Relationship", type: "select", options: REFERENCE_RELATIONSHIPS }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "yearsKnown", label: "Years Known" }, { key: "notes", label: "Notes", type: "textarea" }]} renderExtra={item => <PeerNotify peer={item} />} />
      </>);
    }
    if (subPage === "malpracticeHistory") {
      if (!isPro) return <div style={{ position: "relative", minHeight: 320 }}><ProGate T={T} onUpgrade={() => { setSubPage(null); setShowPricing(true); }} featureName="Malpractice History" /></div>;
      return <CrudSection title="Malpractice History" sectionKey="malpracticeHistory" items={data.malpracticeHistory || []} {...crud("malpracticeHistory")} onShare={openShare} emptyIcon={"\ud83d\udccb"} emptyTitle="No malpractice claims" emptySub="Track malpractice claims for consistent disclosure across applications." fields={[{ key: "dateOfIncident", label: "Date of Incident", type: "date" }, { key: "dateFiled", label: "Date Filed", type: "date" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "outcome", label: "Outcome", type: "select", options: MALPRACTICE_OUTCOMES }, { key: "settlementAmount", label: "Settlement Amount" }, { key: "description", label: "Description", type: "textarea" }, { key: "facility", label: "Facility" }, { key: "insuranceCarrier", label: "Insurance Carrier" }, { key: "dateResolved", label: "Date Resolved", type: "date" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    }

    return (
      <div>
        <h2 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 700, color: T.text }}>Credentials</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {credGroups.map(group => {
            const sorted = [...group.items].sort((a, b) => ((b.count || 0) > 0 ? 1 : 0) - ((a.count || 0) > 0 ? 1 : 0));
            return (
              <div key={group.title}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, paddingLeft: 2 }}>{group.title}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sorted.map(p => {
                    const hasUrgent = [...expired, ...soon].filter(i => i._sec === p.id).length;
                    const locked = p.pro && !isPro;
                    return (
                      <button key={p.id} onClick={() => setSubPage(p.id)} className="cmd-card-hover" style={{
                        display: "flex", alignItems: "center", gap: 12,
                        backgroundColor: p.accent ? T.accentDim : T.card,
                        border: `1px solid ${p.accent ? T.accent : T.border}`,
                        borderRadius: 12, padding: "14px 16px", cursor: "pointer",
                        textAlign: "left", width: "100%", boxShadow: p.accent ? "none" : T.shadow1,
                        opacity: locked ? 0.75 : 1,
                      }}>
                        <span style={{ fontSize: 22, width: 32, textAlign: "center" }}>{locked ? "🔒" : p.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 15, fontWeight: 600, color: p.accent ? T.accent : T.text }}>{p.label}</div>
                          {locked
                            ? <div style={{ fontSize: 12, color: "#10b981", fontWeight: 600 }}>Pro feature — Upgrade to unlock</div>
                            : p.count !== undefined
                              ? <div style={{ fontSize: 13, color: T.textDim }}>{p.count} item{p.count !== 1 ? "s" : ""}</div>
                              : p.accent && <div style={{ fontSize: 13, color: T.textMuted }}>Browse accredited CME providers</div>
                          }
                        </div>
                        {!locked && hasUrgent > 0 && <span style={{ backgroundColor: T.danger, color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{hasUrgent}</span>}
                        <span style={{ color: p.accent ? T.accent : T.textDim, fontSize: 18 }}>{"\u203a"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  /* ─── MORE PAGE ──────────────────────────────────────────── */
  const renderMore = () => {
    if (subPage === "settings") return <SettingsSection />;
    if (subPage === "cv") return <CVGenerator />;
    if (subPage === "export") return <DataExport />;
    if (subPage === "cptLookup") return <CPTLookup />;
    if (subPage === "assistant") return <AssistantSection />;
    if (subPage === "faq") return <FAQSection />;
    if (subPage === "privacy") return <LegalSection page="privacy" />;
    if (subPage === "terms") return <LegalSection page="terms" />;
    if (subPage === "data-rights") return <LegalSection page="data-rights" />;
    if (subPage === "cancellation") return <CancellationPage />;
    if (subPage === "admin") return <AdminDashboard />;

    return (
      <div>
        <h2 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 700, color: T.text }}>More</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          {/* ─── Plan Card ─────────────────────────────────────── */}
          <div style={{
            borderRadius: 16, padding: "16px 18px", marginBottom: 4,
            background: isPractice
              ? "linear-gradient(135deg, #7c3aed, #4f46e5)"
              : isPro
                ? "linear-gradient(135deg, #059669, #0d9488)"
                : "linear-gradient(135deg, #1e293b, #334155)",
            boxShadow: isPro ? "0 4px 16px rgba(5,150,105,0.25)" : "0 2px 8px rgba(0,0,0,0.2)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isPro ? 10 : 0 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>Current Plan</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>
                  {isPractice ? "Practice" : isPro ? "Pro" : "Free"}
                </div>
              </div>
              {!isPro && (
                <button onClick={() => setShowPricing(true)} style={{
                  padding: "10px 18px", borderRadius: 12, border: "none",
                  backgroundColor: "#10b981", color: "#fff",
                  fontSize: 14, fontWeight: 700, cursor: "pointer",
                  boxShadow: "0 2px 8px rgba(16,185,129,0.4)",
                }}>
                  Upgrade →
                </button>
              )}
            </div>
            {isPro && (
              <button onClick={() => manage()} style={{
                padding: "9px 16px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.25)",
                backgroundColor: "rgba(255,255,255,0.1)", color: "#fff",
                fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%",
              }}>
                Manage Billing
              </button>
            )}
          </div>

          {/* Generate CV */}
          <button onClick={() => setSubPage("cv")} className="cmd-card-hover" style={{
            display: "flex", alignItems: "center", gap: 12,
            backgroundColor: T.accentDim, border: `1px solid ${T.accent}`,
            borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
          }}>
            <span style={{ fontSize: 20 }}>{"\ud83d\udcc4"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: T.accent }}>Generate CV</div>
              <div style={{ fontSize: 13, color: T.textMuted }}>Auto-generate your curriculum vitae</div>
            </div>
            <span style={{ color: T.accent }}>{"\u203a"}</span>
          </button>

          {/* CPT Lookup */}
          <button onClick={() => setSubPage("cptLookup")} className="cmd-card-hover" style={{
            display: "flex", alignItems: "center", gap: 12,
            backgroundColor: T.card, border: `1px solid ${T.border}`,
            borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
            boxShadow: T.shadow1,
          }}>
            <span style={{ fontSize: 20 }}>{"\ud83d\udd0d"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>CPT Lookup</div>
              <div style={{ fontSize: 13, color: T.textDim }}>Search and reference CPT codes</div>
            </div>
            <span style={{ color: T.textDim }}>{"\u203a"}</span>
          </button>

          {/* Data & Backup */}
          <button onClick={() => setSubPage("export")} className="cmd-card-hover" style={{
            display: "flex", alignItems: "center", gap: 12,
            backgroundColor: T.card, border: `1px solid ${T.border}`,
            borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
            boxShadow: T.shadow1,
          }}>
            <span style={{ fontSize: 20 }}>{"\ud83d\udcbe"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Data & Backup</div>
              <div style={{ fontSize: 13, color: T.textDim }}>Export, import, or print your data</div>
            </div>
            <span style={{ color: T.textDim }}>{"\u203a"}</span>
          </button>

          {/* Settings */}
          <button onClick={() => setSubPage("settings")} className="cmd-card-hover" style={{
            display: "flex", alignItems: "center", gap: 12,
            backgroundColor: T.card, border: `1px solid ${T.border}`,
            borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
            boxShadow: T.shadow1,
          }}>
            <span style={{ fontSize: 20 }}>{"\u2699\ufe0f"}</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: T.text, flex: 1 }}>Settings</span>
            <span style={{ color: T.textDim }}>{"\u203a"}</span>
          </button>

          {/* Send feedback */}
          {user && (
            <button onClick={() => setShowFeedback(true)} className="cmd-card-hover" style={{
              display: "flex", alignItems: "center", gap: 12,
              backgroundColor: T.card, border: `1px solid ${T.border}`,
              borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
              boxShadow: T.shadow1,
            }}>
              <span style={{ fontSize: 20 }}>{"\ud83d\udcac"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Send feedback</div>
                <div style={{ fontSize: 13, color: T.textDim }}>The founder reads every one</div>
              </div>
              <span style={{ color: T.textDim }}>{"\u203a"}</span>
            </button>
          )}

          {/* Get help / report a problem */}
          {user && (
            <button onClick={() => setShowSupport(true)} className="cmd-card-hover" style={{
              display: "flex", alignItems: "center", gap: 12,
              backgroundColor: T.card, border: `1px solid ${T.border}`,
              borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
              boxShadow: T.shadow1,
            }}>
              <span style={{ fontSize: 20 }}>{"\ud83c\udd98"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Get help</div>
                <div style={{ fontSize: 13, color: T.textDim }}>Bug, billing question, anything</div>
              </div>
              <span style={{ color: T.textDim }}>{"\u203a"}</span>
            </button>
          )}

          {/* Admin (founders only) */}
          {isAdminUser(user) && (
            <button onClick={() => setSubPage("admin")} className="cmd-card-hover" style={{
              display: "flex", alignItems: "center", gap: 12,
              backgroundColor: T.card, border: `2px solid ${T.accent}`,
              borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
              boxShadow: T.shadow1,
            }}>
              <span style={{ fontSize: 20 }}>{"\ud83d\udd11"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.accent }}>Admin</div>
                <div style={{ fontSize: 13, color: T.textDim }}>Tickets, feedback, signups</div>
              </div>
              <span style={{ color: T.accent }}>{"\u203a"}</span>
            </button>
          )}

          {/* Assistant */}
          <button onClick={() => setSubPage("assistant")} className="cmd-card-hover" style={{
            display: "flex", alignItems: "center", gap: 12,
            backgroundColor: T.card, border: `2px solid ${T.accent}`,
            borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
            boxShadow: T.shadow1,
          }}>
            <span style={{ fontSize: 22 }}>{"\u2728"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>Vera</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>Your credentialing coordinator — documents, packets, answers</div>
            </div>
          </button>

          {/* Theme Toggle */}
          <div style={{
            backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
            padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between",
            boxShadow: T.shadow1,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 20 }}>{data.settings.theme === "dark" ? "\ud83c\udf19" : "\u2600\ufe0f"}</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{data.settings.theme === "dark" ? "Dark Mode" : "Light Mode"}</span>
            </div>
            <button onClick={toggleTheme} style={{
              width: 48, height: 28, borderRadius: 14, border: "none",
              backgroundColor: data.settings.theme === "dark" ? T.accent : T.border,
              cursor: "pointer", position: "relative", transition: "background 0.2s",
            }}>
              <div style={{
                width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff",
                position: "absolute", top: 3,
                left: data.settings.theme === "dark" ? 23 : 3,
                transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </button>
          </div>

          {/* Text Size */}
          <div style={{
            backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
            padding: "14px 16px", boxShadow: T.shadow1,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: T.textMuted }}>Aa</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Text Size</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { id: "S", label: "S", size: 14 },
                { id: "M", label: "M", size: 17 },
                { id: "L", label: "L", size: 20 },
                { id: "XL", label: "XL", size: 24 },
                { id: "XXL", label: "XXL", size: 28 },
              ].map(opt => {
                const active = (data.settings.fontSize || "M") === opt.id;
                return (
                  <button key={opt.id} onClick={() => updateSettings({ fontSize: opt.id })} style={{
                    flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                    gap: 4, padding: "12px 4px", borderRadius: 12,
                    border: active ? `2px solid ${T.accent}` : `1px solid ${T.border}`,
                    backgroundColor: active ? T.accentGlow : T.input, cursor: "pointer",
                    transition: "all 0.15s",
                  }}>
                    <span style={{ fontSize: opt.size, fontWeight: 700, color: active ? T.accent : T.text, lineHeight: 1.2 }}>Aa</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: active ? T.accent : T.textDim }}>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* FAQ */}
          <button onClick={() => setSubPage("faq")} className="cmd-card-hover" style={{
            display: "flex", alignItems: "center", gap: 12,
            backgroundColor: T.card, border: `1px solid ${T.border}`,
            borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", width: "100%",
            boxShadow: T.shadow1,
          }}>
            <span style={{ fontSize: 20 }}>{"\u2753"}</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: T.text, flex: 1 }}>Help & FAQ</span>
            <span style={{ color: T.textDim }}>{"\u203a"}</span>
          </button>

          {/* Legal */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setSubPage("privacy")} className="cmd-card-hover" style={{
              flex: 1, display: "flex", alignItems: "center", gap: 8,
              backgroundColor: T.card, border: `1px solid ${T.border}`,
              borderRadius: 12, padding: "12px 14px", cursor: "pointer", textAlign: "left",
              boxShadow: T.shadow1,
            }}>
              <span style={{ fontSize: 16 }}>{"\ud83d\udee1\ufe0f"}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.textMuted }}>Privacy</span>
            </button>
            <button onClick={() => setSubPage("terms")} className="cmd-card-hover" style={{
              flex: 1, display: "flex", alignItems: "center", gap: 8,
              backgroundColor: T.card, border: `1px solid ${T.border}`,
              borderRadius: 12, padding: "12px 14px", cursor: "pointer", textAlign: "left",
              boxShadow: T.shadow1,
            }}>
              <span style={{ fontSize: 16 }}>{"\ud83d\udcc3"}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.textMuted }}>Terms</span>
            </button>
            <button onClick={() => setSubPage("data-rights")} className="cmd-card-hover" style={{
              flex: 1, display: "flex", alignItems: "center", gap: 8,
              backgroundColor: T.card, border: `1px solid ${T.border}`,
              borderRadius: 12, padding: "12px 14px", cursor: "pointer", textAlign: "left",
              boxShadow: T.shadow1,
            }}>
              <span style={{ fontSize: 16 }}>{"\ud83d\uddd1\ufe0f"}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.textMuted }}>Data Rights</span>
            </button>
          </div>

          {/* Version */}
          <div style={{
            backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
            padding: "12px 16px", boxShadow: T.shadow1,
          }}>
            <div style={{ fontSize: 13, color: T.textDim }}>
              CredentialDOMD v2.3 &middot; {user ? `Signed in as ${user.email}` : "Data saved locally"}
            </div>
          </div>

          {/* Cancel Subscription (only when authenticated + subscribed) */}
          {user && isPro && (
            <button onClick={() => setSubPage("cancellation")} className="cmd-card-hover" style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              backgroundColor: T.card, border: `1px solid ${T.border}`,
              borderRadius: 12, padding: "14px 16px", cursor: "pointer", width: "100%",
              boxShadow: T.shadow1,
            }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: T.textDim }}>Cancel Subscription</span>
            </button>
          )}

          {/* Sign Out (only when authenticated) */}
          {user && (
            <button onClick={() => signOut()} className="cmd-card-hover" style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              backgroundColor: T.dangerDim, border: `1px solid ${T.danger}30`,
              borderRadius: 12, padding: "14px 16px", cursor: "pointer", width: "100%",
            }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: T.danger }}>Sign Out</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  /* ─── RENDER ─────────────────────────────────────────────── */
  const renderContent = () => {
    if (tab === "home") return renderHome();
    if (tab === "documents") return <DocumentsSection />;
    if (tab === "share") return renderShare();
    if (tab === "credentials") return renderCredentials();
    if (tab === "locum") return <LocumDashboard />;
    if (tab === "team") return <TeamSection />;
    if (tab === "more") return renderMore();
  };

  const showBack = (tab === "credentials" && subPage) || (tab === "more" && subPage);

  // Bottom-nav slot 4: Locum (for tier === "locum") OR Team (for practice/group) OR Team default.
  // Eric is a locum so this lights up for him.
  const isLocumTier = plan === "locum";
  const slot4 = isLocumTier
    ? { id: "locum", label: "Locum", icon: <span style={{ fontSize: 18 }}>🏥</span> }
    : { id: "team", label: "Team", icon: <span style={{ fontSize: 18 }}>👥</span> };

  const tabItems = [
    { id: "home", label: "Home", icon: <HomeIcon /> },
    { id: "credentials", label: "Credentials", icon: <CredsIcon /> },
    { id: "add", label: "Add", icon: <PlusIcon />, isCenter: true },
    slot4,
    { id: "more", label: "More", icon: <MoreIcon /> },
  ];

  const pageTitle = tab === "home" ? "Dashboard" : tab === "documents" ? "Documents" : tab === "share" ? "Share" : tab === "credentials" ? "Credentials" : tab === "locum" ? "Locum" : tab === "team" ? "Team" : "More";

  const FONT_ZOOM = { S: 0.88, M: 1, L: 1.1, XL: 1.2, XXL: 1.35 };
  const fontZoom = FONT_ZOOM[data.settings.fontSize] || 1;

  return (
    <div style={{
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      backgroundColor: T.bg, minHeight: "100vh", maxWidth: 480, margin: "0 auto", position: "relative",
    }}>
      <ShareModal open={!!shareItem} onClose={closeShare} item={shareItem} section={shareSection} linkedDocs={linkedDocs} onLogShare={logShare} />
      <PricingModal open={showPricing} onClose={() => setShowPricing(false)} />
      <FeedbackModal open={showFeedback} onClose={() => setShowFeedback(false)} contextPage={`${tab}${subPage ? "/" + subPage : ""}`} />
      <SupportModal open={showSupport} onClose={() => setShowSupport(false)} contextPage={`${tab}${subPage ? "/" + subPage : ""}`} />
      <NotificationCenter open={notifCenterOpen} onClose={() => setNotifCenterOpen(false)} />

      {/* ─── TOP BAR (56px) ────────────────────────────── */}
      <div style={{
        position: "sticky", top: 0, zIndex: 50,
        backgroundColor: T.card, borderBottom: `1px solid ${T.border}`,
        boxShadow: T.shadow1,
        paddingTop: "env(safe-area-inset-top, 0px)",
      }}>
        <div style={{
          height: 56, display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 16px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {showBack ? (
              <button onClick={() => setSubPage(null)} style={{
                display: "flex", alignItems: "center", gap: 4, background: "none",
                border: "none", color: T.accent, fontSize: 15, fontWeight: 600,
                cursor: "pointer", padding: 0,
              }}><BackIcon /> Back</button>
            ) : (
              <>
                <div onClick={() => { setTab("more"); setSubPage("settings"); }} style={{
                  width: 36, height: 36, borderRadius: 18, overflow: "hidden",
                  background: "linear-gradient(135deg, #0D9488, #1A73E8)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
                  boxShadow: "0 2px 6px rgba(13,148,136,0.3)",
                }}>
                  {data.settings.profilePhoto
                    ? <img src={data.settings.profilePhoto} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 25%" }} />
                    : (data.settings.name ? data.settings.name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase() : "MD")}
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: T.text, lineHeight: 1.2 }}>{pageTitle}</div>
                    {tab === "home" && data.settings.isFoundingMember && <FoundingMemberBadge size="small" />}
                  </div>
                  {tab === "home" && data.settings.name && (
                    <div style={{ fontSize: 12, color: T.textMuted }}>{data.settings.name}{data.settings.degreeType ? `, ${data.settings.degreeType}` : ""}</div>
                  )}
                </div>
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => setNotifCenterOpen(true)} style={{
              width: 36, height: 36, borderRadius: 10,
              backgroundColor: T.input, border: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", color: T.textMuted, position: "relative",
            }}>
              <BellIcon />
              {alertCount > 0 && (
                <div style={{
                  position: "absolute", top: -3, right: -3,
                  width: 18, height: 18, borderRadius: 9,
                  backgroundColor: T.danger, color: "#fff",
                  fontSize: 10, fontWeight: 800,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: `2px solid ${T.card}`,
                }}>
                  {alertCount > 9 ? "9+" : alertCount}
                </div>
              )}
            </button>
            <button onClick={toggleTheme} style={{
              width: 36, height: 36, borderRadius: 10,
              backgroundColor: T.input, border: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", color: T.textMuted,
            }}>
              {data.settings.theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
      </div>

      {/* ─── CONTENT ───────────────────────────────────── */}
      <div style={{ paddingBottom: "calc(80px + env(safe-area-inset-bottom, 0px))", zoom: fontZoom }}>
        {tab === "home" && <NotificationBanner onOpenCenter={() => setNotifCenterOpen(true)} onGoSettings={() => { setTab("more"); setSubPage("settings"); }} />}
        <div style={{ padding: "16px 16px 0" }}>{renderContent()}</div>
      </div>

      {/* ─── BOTTOM TAB BAR ────────────────────────────── */}
      <div style={{
        position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 480,
        backgroundColor: T.tabBar, borderTop: `1px solid ${T.tabBorder}`,
        display: "flex", justifyContent: "space-around", alignItems: "center",
        // Safe-area padding must ADD to the bar height (border-box would
        // otherwise carve it out of the 64px and squash the buttons on
        // iPhones in standalone/home-screen mode).
        height: "calc(64px + env(safe-area-inset-bottom, 0px))",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        zIndex: 100, boxShadow: "0 -1px 8px rgba(0,0,0,0.04)", overflow: "hidden",
      }}>
        {tabItems.map(t => {
          if (t.isCenter) {
            return (
              <button key={t.id} onClick={() => { setTab("documents"); setSubPage(null); }} style={{
                width: 50, height: 50, borderRadius: 25, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)",
                color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
                boxShadow: "0 4px 14px rgba(16,185,129,0.45)",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              onMouseDown={e => { e.currentTarget.style.transform = "scale(0.94)"; }}
              onMouseUp={e => { e.currentTarget.style.transform = "scale(1)"; }}
              >
                <PlusIcon />
              </button>
            );
          }
          const active = tab === t.id || (t.id === "documents" && tab === "share");
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setSubPage(null); }} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              padding: "6px 12px", background: "none", border: "none", cursor: "pointer",
              color: active ? T.tabActive : T.tabInactive, fontSize: 11,
              fontWeight: active ? 700 : 500, minWidth: 56, position: "relative",
              transition: "color 0.2s",
            }}>
              <div style={{
                opacity: active ? 1 : 0.55,
                transform: active ? "scale(1.1)" : "scale(1)",
                transition: "opacity 0.2s, transform 0.2s",
              }}>{t.icon}</div>
              {t.label}
              {active && (
                <div style={{
                  position: "absolute", bottom: 0, left: "50%",
                  transform: "translateX(-50%)",
                  width: 4, height: 4, borderRadius: 2,
                  backgroundColor: T.tabActive,
                  animation: "fadeIn 0.2s ease-out both",
                }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
