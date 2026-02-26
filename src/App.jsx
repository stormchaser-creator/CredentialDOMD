import { useState, useCallback, useMemo, useEffect } from "react";
import { AppProvider, useApp, useNotifications } from "./context/AppContext";
import {
  HomeIcon, ScanIcon, CredsIcon, MoreIcon,
  SendIcon, BellIcon, SunIcon, MoonIcon,
  BackIcon, SearchIcon, CheckIcon, PlusIcon,
  AsclepiusIcon,
} from "./components/shared/Icons";
import StatusDot from "./components/shared/StatusDot";
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
import CPTLookup from "./components/features/CPTLookup";
import PeerNotify from "./components/features/PeerNotify";
import { NotificationCenter, NotificationBanner, SettingsSection, FAQSection, LegalSection } from "./components/pages";
import {
  STATES, getLicenseTypes, PRIVILEGE_TYPES, INSURANCE_TYPES, CASE_CATEGORIES,
  EDUCATION_TYPES, WORK_HISTORY_TYPES, REFERENCE_RELATIONSHIPS, MALPRACTICE_OUTCOMES,
} from "./constants";
import { AOA_NATIONAL } from "./constants/boardRequirements";
import {
  generateId, getStatusColor, getStatusLabel, formatDate, MS_PER_DAY,
} from "./utils/helpers";
import { computeCompliance } from "./utils/compliance";
import { generateAlerts } from "./utils/notifications";
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
    <AppProvider onNavigate={handleNavigate}>
      <AppInner tab={tab} setTab={setTab} subPage={subPage} setSubPage={setSubPage} />
    </AppProvider>
  );
}

function AppInner({ tab, setTab, subPage, setSubPage }) {
  const { data, setData, loaded, theme: T, toggleTheme, allTrackedStates, addItem, editItem, deleteItem } = useApp();
  const [shareItem, setShareItem] = useState(null);
  const [shareSection, setShareSection] = useState(null);
  const [searchQ, setSearchQ] = useState("");
  const [shareFilter, setShareFilter] = useState("all");
  const [notifCenterOpen, setNotifCenterOpen] = useState(false);
  const [autoAddLicense, setAutoAddLicense] = useState(false);
  const [npiImporting, setNpiImporting] = useState(false);
  const [npiImportMsg, setNpiImportMsg] = useState(null);

  useNotifications();

  const alerts = useMemo(() => generateAlerts(data), [data]);
  const alertCount = alerts?.count || 0;

  const openShare = useCallback((item, section) => { setShareItem(item); setShareSection(section); }, []);
  const closeShare = useCallback(() => { setShareItem(null); setShareSection(null); }, []);
  const logShare = useCallback((entry) => setData(d => ({ ...d, shareLog: [...(d.shareLog || []), entry] })), [setData]);

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
  ], [data.licenses, data.cme, data.privileges, data.insurance, data.caseLogs, data.healthRecords, data.education, data.workHistory, data.peerReferences, data.malpracticeHistory]);

  const { expired, soon, urgent } = useMemo(() => {
    const now = new Date();
    const lead = data.settings.reminderLeadDays || 90;
    const exp = allCreds.filter(i => i.expirationDate && new Date(i.expirationDate) < now);
    const sn = allCreds.filter(i => {
      if (!i.expirationDate) return false;
      const d = Math.ceil((new Date(i.expirationDate) - now) / MS_PER_DAY);
      return d >= 0 && d <= lead;
    });
    const urg = [...exp, ...sn].sort((a, b) => new Date(a.expirationDate) - new Date(b.expirationDate));
    return { expired: exp, soon: sn, urgent: urg };
  }, [allCreds, data.settings.reminderLeadDays]);

  const totalCME = useMemo(() => data.cme.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0), [data.cme]);

  // Compliance percentage for ring
  const compliancePercent = useMemo(() => {
    if (allCreds.length === 0) return 0;
    const total = allCreds.filter(c => c.expirationDate).length;
    if (total === 0) return 100;
    const active = allCreds.filter(c => {
      if (!c.expirationDate) return false;
      return new Date(c.expirationDate) >= new Date();
    }).length;
    return Math.round((active / total) * 100);
  }, [allCreds]);

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
        }}>
          <ComplianceRing percent={compliancePercent} size={120} stroke={9} />
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

      {/* Action Required — Horizontal Scroll Cards */}
      {urgent.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>Action Required</h3>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.danger }}>{urgent.length} item{urgent.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="cmd-h-scroll" style={{ display: "flex", gap: 10, paddingBottom: 4 }}>
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
                    {item.name || item.type || item.title}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted }}>
                    {item.expirationDate ? `Exp ${formatDate(item.expirationDate)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
                      {item.name || item.type || "Untitled"}
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

      {/* CME Compliance */}
      {allTrackedStates.length > 0 && data.cme.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>CME Progress</h3>
            <button onClick={() => { setTab("credentials"); setSubPage("findCme"); }} style={{
              background: "none", border: "none", fontSize: 13, fontWeight: 600,
              color: T.accent, cursor: "pointer", padding: 0,
            }}>Find CME</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {allTrackedStates.map(st => {
              const comp = computeCompliance(data.cme, st, data.settings.degreeType);
              const unmetTopics = comp.topicResults.filter(t => !t.met);
              return (
                <div key={st} style={{
                  backgroundColor: T.card, borderRadius: 12, padding: "14px 16px",
                  boxShadow: T.shadow1,
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
                        : <span style={{ fontSize: 14, fontWeight: 700, color: comp.totalMet ? T.success : T.text }}>{comp.totalEarned}/{comp.totalRequired} hrs</span>
                      }
                      <div style={{
                        width: 22, height: 22, borderRadius: 11,
                        backgroundColor: comp.fullyCompliant ? T.successDim : T.warningDim,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: comp.fullyCompliant ? T.success : T.warning, fontSize: 13, fontWeight: 700,
                      }}>{comp.fullyCompliant ? "\u2713" : "!"}</div>
                    </div>
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
                        }}>{t.topic}: {t.earned}/{t.required}h</span>
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
                        Cat 1: {comp.cat1Earned}/{comp.cat1Required}h needed
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AOA for DOs */}
      {data.settings.degreeType === "DO" && data.cme.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 10 }}>AOA National Requirement</h3>
          <div style={{ backgroundColor: T.card, borderRadius: 12, padding: "14px 16px", boxShadow: T.shadow1 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>Total: {totalCME} / {AOA_NATIONAL.hours} hrs</div>
                <div style={{ fontSize: 13, color: T.textDim }}>{AOA_NATIONAL.cycle}-year cycle</div>
              </div>
              <div style={{
                width: 24, height: 24, borderRadius: 12,
                backgroundColor: totalCME >= AOA_NATIONAL.hours ? T.successDim : T.dangerDim,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: totalCME >= AOA_NATIONAL.hours ? T.success : T.danger, fontSize: 14, fontWeight: 700,
              }}>{totalCME >= AOA_NATIONAL.hours ? "\u2713" : "\u2717"}</div>
            </div>
            {(() => {
              const aoaHrs = data.cme.filter(c => c.category === "AOA Category 1-A").reduce((s, c) => s + (parseFloat(c.hours) || 0), 0);
              return (
                <div style={{ padding: "10px 12px", backgroundColor: T.input, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Cat 1-A: {aoaHrs} / {AOA_NATIONAL.cat1a} hrs</div>
                    <div style={{ fontSize: 12, color: T.textDim }}>Minimum AOA Category 1-A</div>
                  </div>
                  <div style={{
                    width: 20, height: 20, borderRadius: 10,
                    backgroundColor: aoaHrs >= AOA_NATIONAL.cat1a ? T.successDim : T.warningDim,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: aoaHrs >= AOA_NATIONAL.cat1a ? T.success : T.warning, fontSize: 12,
                  }}>{aoaHrs >= AOA_NATIONAL.cat1a ? "\u2713" : "!"}</div>
                </div>
              );
            })()}
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
      const text = [item.name, item.type, item.title, item.category, item.licenseNumber, item.policyNumber, item.facility, item.state, item.provider].filter(Boolean).join(" ").toLowerCase();
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
                  <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{item.name || item.type || item.title || item.category}</div>
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
  const credGroups = [
    { title: "Active Credentials", items: [
      { id: "licenses", label: "Licenses", icon: "\ud83e\udea3", count: data.licenses.length },
      { id: "privileges", label: "Privileges", icon: "\ud83c\udfe5", count: data.privileges.length },
      { id: "insurance", label: "Insurance", icon: "\ud83d\udee1\ufe0f", count: data.insurance.length },
    ]},
    { title: "Continuing Education", items: [
      { id: "cme", label: "CME Credits", icon: "\ud83c\udf93", count: data.cme.length },
      { id: "findCme", label: "Find CME", icon: "\ud83d\udd17", accent: true },
    ]},
    { title: "Professional History", items: [
      { id: "education", label: "Education", icon: "\ud83c\udf93", count: (data.education || []).length },
      { id: "workHistory", label: "Work History", icon: "\ud83c\udfe2", count: (data.workHistory || []).length },
      { id: "caseLogs", label: "Case Logs", icon: "\ud83d\udccb", count: (data.caseLogs || []).length },
    ]},
    { title: "Supporting Records", items: [
      { id: "healthRecords", label: "Health Records", icon: "\ud83d\udc89", count: (data.healthRecords || []).length },
      { id: "peerReferences", label: "Peer References", icon: "\ud83d\udc65", count: (data.peerReferences || []).length },
      { id: "malpracticeHistory", label: "Malpractice History", icon: "\ud83d\udccb", count: (data.malpracticeHistory || []).length },
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
          let importedCount = 0;
          setData(d => {
            const cur = d.licenses || [];
            const newOnes = npiLicenses
              .filter(nl => !cur.some(el => el.licenseNumber === nl.licenseNumber && el.state === nl.state))
              .map(nl => ({ id: generateId(), type: "Medical License", name: `${nl.state} Medical License`, licenseNumber: nl.licenseNumber, state: nl.state, issuedDate: "", expirationDate: "", notes: "Imported from NPPES NPI Registry", npiImported: true }));
            importedCount = newOnes.length;
            if (newOnes.length === 0) return d;
            return { ...d, licenses: [...cur, ...newOnes] };
          });
          if (importedCount === 0) { setNpiImportMsg("All licenses already imported."); setTimeout(() => setNpiImportMsg(null), 4000); return; }
          setNpiImportMsg(`${importedCount} license${importedCount > 1 ? "s" : ""} imported!`);
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
        <CrudSection title="Licenses" sectionKey="licenses" items={data.licenses} {...crud("licenses")} onShare={openShare} emptyIcon={"\ud83e\udea3"} emptyTitle="No licenses" emptySub="Add your medical licenses, DEA, and certifications." autoOpen={autoAddLicense} onAutoOpenDone={() => setAutoAddLicense(false)} fields={[{ key: "type", label: "Type", type: "select", options: getLicenseTypes(data.settings.degreeType) }, { key: "name", label: "Display Name", placeholder: "e.g. CA Medical License" }, { key: "licenseNumber", label: "License #" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "issuedDate", label: "Issued", type: "date" }, { key: "expirationDate", label: "Expires", type: "date" }, { key: "notes", label: "Notes", type: "textarea" }]} />
      </>);
    }
    if (subPage === "cme") return <CMESection onShare={openShare} />;
    if (subPage === "findCme") return <CMEResourcesSection />;
    if (subPage?.startsWith("findCme:")) return <CMEResourcesSection initialTopicFilter={subPage.split(":")[1]} />;
    if (subPage === "privileges") return <CrudSection title="Privileges" sectionKey="privileges" items={data.privileges} {...crud("privileges")} onShare={openShare} emptyIcon={"\ud83c\udfe5"} emptyTitle="No privileges" emptySub="Track hospital admitting and surgical privileges." fields={[{ key: "type", label: "Type", type: "select", options: PRIVILEGE_TYPES }, { key: "name", label: "Display Name" }, { key: "facility", label: "Facility" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "appointmentDate", label: "Appointed", type: "date" }, { key: "expirationDate", label: "Reappointment Due", type: "date" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "insurance") return <CrudSection title="Insurance" sectionKey="insurance" items={data.insurance} {...crud("insurance")} onShare={openShare} emptyIcon={"\ud83d\udee1\ufe0f"} emptyTitle="No policies" emptySub="Track malpractice and liability insurance." fields={[{ key: "type", label: "Type", type: "select", options: INSURANCE_TYPES }, { key: "name", label: "Display Name" }, { key: "provider", label: "Carrier" }, { key: "policyNumber", label: "Policy #" }, { key: "coveragePerClaim", label: "Per Claim" }, { key: "coverageAggregate", label: "Aggregate" }, { key: "effectiveDate", label: "Effective", type: "date" }, { key: "expirationDate", label: "Expires", type: "date" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "healthRecords") return <HealthRecordsSection onShare={openShare} />;
    if (subPage === "education") return <CrudSection title="Education" sectionKey="education" items={data.education || []} {...crud("education")} onShare={openShare} emptyIcon={"\ud83c\udf93"} emptyTitle="No education records" emptySub="Add your degrees, diplomas, and training certificates." fields={[{ key: "type", label: "Type", type: "select", options: EDUCATION_TYPES }, { key: "name", label: "Display Name", placeholder: "e.g. DO Diploma - PCOM" }, { key: "institution", label: "Institution" }, { key: "graduationDate", label: "Graduation Date", type: "date" }, { key: "fieldOfStudy", label: "Field of Study / Specialty" }, { key: "honors", label: "Honors" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "caseLogs") return <CrudSection title="Case Logs" sectionKey="caseLogs" items={data.caseLogs || []} {...crud("caseLogs")} onShare={openShare} emptyIcon={"\ud83d\udccb"} emptyTitle="No cases logged" emptySub="Track surgical cases for credentialing." fields={[{ key: "category", label: "Category", type: "select", options: CASE_CATEGORIES }, { key: "title", label: "Description" }, { key: "date", label: "Date", type: "date" }, { key: "facility", label: "Facility", type: "datalist", options: [...new Set((data.workHistory || []).map(w => w.employer).filter(Boolean))] }, { key: "role", label: "Role", type: "select", options: ["Primary Surgeon", "Co-Surgeon", "Teaching/Supervising", "First Assist", "Observer"] }, { key: "cptCodes", label: "CPT Code(s)", type: "cptPicker" }, { key: "notes", label: "Notes", type: "textarea" }]} renderExtra={item => item.role ? <div style={{ fontSize: 12, color: "#a78bfa", fontWeight: 600, marginTop: 2 }}>{item.role}</div> : null} />;
    if (subPage === "workHistory") return <CrudSection title="Work History" sectionKey="workHistory" items={data.workHistory || []} {...crud("workHistory")} onShare={openShare} emptyIcon={"\ud83c\udfe2"} emptyTitle="No work history" emptySub="Track employment and practice experience for credentialing applications." fields={[{ key: "type", label: "Position Type", type: "select", options: WORK_HISTORY_TYPES }, { key: "position", label: "Position/Title", placeholder: "e.g. Attending Neurosurgeon" }, { key: "employer", label: "Employer/Organization" }, { key: "city", label: "City" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "startDate", label: "Start Date", type: "date" }, { key: "endDate", label: "End Date", type: "date" }, { key: "current", label: "Current Position", type: "select", options: ["No", "Yes"] }, { key: "description", label: "Description", type: "textarea" }, { key: "reasonForLeaving", label: "Reason for Leaving" }, { key: "notes", label: "Notes", type: "textarea" }]} />;
    if (subPage === "peerReferences") {
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
    if (subPage === "malpracticeHistory") return <CrudSection title="Malpractice History" sectionKey="malpracticeHistory" items={data.malpracticeHistory || []} {...crud("malpracticeHistory")} onShare={openShare} emptyIcon={"\ud83d\udccb"} emptyTitle="No malpractice claims" emptySub="Track malpractice claims for consistent disclosure across applications." fields={[{ key: "dateOfIncident", label: "Date of Incident", type: "date" }, { key: "dateFiled", label: "Date Filed", type: "date" }, { key: "state", label: "State", type: "select", options: STATES }, { key: "outcome", label: "Outcome", type: "select", options: MALPRACTICE_OUTCOMES }, { key: "settlementAmount", label: "Settlement Amount" }, { key: "description", label: "Description", type: "textarea" }, { key: "facility", label: "Facility" }, { key: "insuranceCarrier", label: "Insurance Carrier" }, { key: "dateResolved", label: "Date Resolved", type: "date" }, { key: "notes", label: "Notes", type: "textarea" }]} />;

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
                    return (
                      <button key={p.id} onClick={() => setSubPage(p.id)} className="cmd-card-hover" style={{
                        display: "flex", alignItems: "center", gap: 12,
                        backgroundColor: p.accent ? T.accentDim : T.card,
                        border: `1px solid ${p.accent ? T.accent : T.border}`,
                        borderRadius: 12, padding: "14px 16px", cursor: "pointer",
                        textAlign: "left", width: "100%", boxShadow: p.accent ? "none" : T.shadow1,
                      }}>
                        <span style={{ fontSize: 22, width: 32, textAlign: "center" }}>{p.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 15, fontWeight: 600, color: p.accent ? T.accent : T.text }}>{p.label}</div>
                          {p.count !== undefined && <div style={{ fontSize: 13, color: T.textDim }}>{p.count} item{p.count !== 1 ? "s" : ""}</div>}
                          {p.accent && <div style={{ fontSize: 13, color: T.textMuted }}>Browse accredited CME providers</div>}
                        </div>
                        {hasUrgent > 0 && <span style={{ backgroundColor: T.danger, color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{hasUrgent}</span>}
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
    if (subPage === "faq") return <FAQSection />;
    if (subPage === "privacy") return <LegalSection page="privacy" />;
    if (subPage === "terms") return <LegalSection page="terms" />;
    if (subPage === "data-rights") return <LegalSection page="data-rights" />;

    return (
      <div>
        <h2 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 700, color: T.text }}>More</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                  <button key={opt.id} onClick={() => setData(d => ({ ...d, settings: { ...d.settings, fontSize: opt.id } }))} style={{
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
            <div style={{ fontSize: 13, color: T.textDim }}>CredentialDOMD v2.3 &middot; Data saved locally</div>
          </div>
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
    if (tab === "more") return renderMore();
  };

  const showBack = (tab === "credentials" && subPage) || (tab === "more" && subPage);

  const tabItems = [
    { id: "home", label: "Home", icon: <HomeIcon /> },
    { id: "credentials", label: "Credentials", icon: <CredsIcon /> },
    { id: "add", label: "Add", icon: <PlusIcon />, isCenter: true },
    { id: "documents", label: "Documents", icon: <ScanIcon /> },
    { id: "more", label: "More", icon: <MoreIcon /> },
  ];

  const pageTitle = tab === "home" ? "Dashboard" : tab === "documents" ? "Documents" : tab === "share" ? "Share" : tab === "credentials" ? "Credentials" : "More";

  const FONT_ZOOM = { S: 0.88, M: 1, L: 1.1, XL: 1.2, XXL: 1.35 };
  const fontZoom = FONT_ZOOM[data.settings.fontSize] || 1;

  return (
    <div style={{
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      backgroundColor: T.bg, minHeight: "100vh", maxWidth: 480, margin: "0 auto", position: "relative",
    }}>
      <ShareModal open={!!shareItem} onClose={closeShare} item={shareItem} section={shareSection} linkedDocs={linkedDocs} onLogShare={logShare} />
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
                  width: 36, height: 36, borderRadius: 18,
                  background: "linear-gradient(135deg, #0D9488, #1A73E8)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
                  boxShadow: "0 2px 6px rgba(13,148,136,0.3)",
                }}>
                  {data.settings.name ? data.settings.name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase() : "MD"}
                </div>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: T.text, lineHeight: 1.2 }}>{pageTitle}</div>
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
        height: 64, paddingBottom: "env(safe-area-inset-bottom, 0px)",
        zIndex: 100, boxShadow: "0 -1px 8px rgba(0,0,0,0.04)", overflow: "hidden",
      }}>
        {tabItems.map(t => {
          if (t.isCenter) {
            return (
              <button key={t.id} onClick={() => { setTab("documents"); setSubPage(null); }} style={{
                width: 48, height: 48, borderRadius: 24, border: "none",
                backgroundColor: T.accent, color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", boxShadow: "0 4px 12px rgba(26,115,232,0.35)",
              }}>
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
              fontWeight: active ? 700 : 500, minWidth: 56,
            }}>
              <div style={{ opacity: active ? 1 : 0.6 }}>{t.icon}</div>
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
