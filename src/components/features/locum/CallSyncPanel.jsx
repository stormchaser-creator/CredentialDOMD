import { memo, useMemo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Field from "../../shared/Field";
import { formatDate } from "../../../utils/helpers";
import { selectableContracts, termLabel } from "../../../utils/contractsForDate";
import { CALLSYNC_SOURCE, detectContract, parseFeedUrl, describeSync, iso } from "../../../utils/callsync";
import { useCallSync } from "../../../hooks/useCallSync";

const when = (t) => {
  if (!t) return "";
  const d = new Date(t);
  return isNaN(d) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/**
 * CallSync: the ANMG on-call schedule, pulled onto this calendar. Paste the
 * calendar subscription link from CallSync's dashboard once per device;
 * the app checks it daily and the physician can force a check any time.
 */
function CallSyncPanel() {
  const { data, updateSettings, theme: T, offlineMode } = useApp();
  const iS = useInputStyle();
  const s = data.settings;
  const { running, record, syncNow } = useCallSync();

  const detected = useMemo(() => detectContract(data.locumContracts), [data.locumContracts]);
  const contracts = data.locumContracts || [];
  const contractId = s.callsyncContractId || detected?.id || "";
  const pickable = selectableContracts(contracts, contractId);
  const linkOk = !!parseFeedUrl(s.callsyncFeedUrl);
  const today = iso(new Date());

  const synced = useMemo(() => (data.scheduleDays || []).filter(e => e?.source === CALLSYNC_SOURCE), [data.scheduleDays]);
  const upcoming = useMemo(
    () => synced.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6),
    [synced, today]
  );

  // Only a physician with an ANMG agreement (or a link already saved, or
  // shifts already synced) has any use for this card.
  if (!detected && !s.callsyncFeedUrl && !s.callsyncContractId && synced.length === 0) return null;

  const status = (() => {
    if (running) return { text: "Checking CallSync...", color: T.textMuted };
    if (!record) return { text: linkOk ? "Not checked yet. Tap Sync now." : "", color: T.textMuted };
    if (record.ok) {
      const head = describeSync({ total: synced.length, added: record.added, updated: record.updated, removed: record.removed });
      return { text: `Last checked ${when(record.lastOkAt)}: ${head}.`, color: T.textDim };
    }
    const tail = record.lastOkAt ? ` Last good check ${when(record.lastOkAt)}.` : "";
    return { text: `${record.message || "CallSync check failed."}${tail}`, color: T.danger };
  })();

  return (
    <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>CallSync</div>
          <div style={{ fontSize: 12, color: T.textMuted }}>Your published ANMG on-call shifts, pulled onto this calendar.</div>
        </div>
        <button
          onClick={() => syncNow()}
          disabled={!linkOk || running || offlineMode}
          style={{
            flexShrink: 0, padding: "9px 14px", borderRadius: 10, border: "none",
            backgroundColor: (!linkOk || running || offlineMode) ? T.border : T.accent,
            color: (!linkOk || running || offlineMode) ? T.textDim : "#fff",
            fontSize: 13, fontWeight: 700, cursor: (!linkOk || running || offlineMode) ? "default" : "pointer",
          }}
        >{running ? "Syncing..." : "Sync now"}</button>
      </div>

      <Field label="CallSync calendar link" hint={linkOk
        ? "Saved ✓ on this device only, never synced to your account. Checked once a day when the app opens; enter it again on any other device you use."
        : "In CallSync, open Dashboard, then Calendar Subscription, tap Copy URL and paste it here. Saved on this device only, never synced to your account."}>
        <input
          type="text" inputMode="url" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
          value={s.callsyncFeedUrl || ""}
          onChange={e => updateSettings({ callsyncFeedUrl: e.target.value.trim() })}
          style={{ ...iS, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14 }}
          placeholder="https://.../api/ical?token=..."
        />
        {s.callsyncFeedUrl && !linkOk && (
          <div style={{ fontSize: 12.5, fontWeight: 600, color: T.danger, marginTop: 6 }}>
            That does not look like a CallSync calendar link. It ends in /api/ical?token=...
          </div>
        )}
      </Field>

      {pickable.length > 0 && (
        <Field label="Lands on" hint={detected && !s.callsyncContractId ? "Your ANMG agreement, found by name. Each shift is priced from its call-rate grid." : "Each synced shift becomes a call day on this agreement, priced from its call-rate grid."}>
          <select value={contractId} onChange={e => updateSettings({ callsyncContractId: e.target.value })} style={{ ...iS, appearance: "auto" }}>
            {!contractId && <option value="">Pick the ANMG agreement</option>}
            {pickable.map(c => (
              <option key={c.id} value={c.id}>{c.shortName || c.facility || "Agreement"}{termLabel(c) ? ` · ${termLabel(c)}` : ""}</option>
            ))}
          </select>
        </Field>
      )}
      {pickable.length === 0 && (
        <div style={{ fontSize: 12.5, color: T.warning, fontWeight: 600, marginBottom: 10 }}>
          Add your ANMG agreement on the Contracts tab first; synced shifts need somewhere to land.
        </div>
      )}

      {status.text && (
        <div style={{ fontSize: 12.5, color: status.color, lineHeight: 1.45, marginBottom: upcoming.length ? 10 : 0 }}>{status.text}</div>
      )}

      {upcoming.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Next call</div>
          {upcoming.map(e => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "5px 0", borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
              <span style={{ fontWeight: 700, color: e.date === today ? T.accent : T.text, flexShrink: 0 }}>{e.date === today ? "Today" : formatDate(e.date)}</span>
              <span style={{ color: T.textDim, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(e.note || "").replace(/\s*\(CallSync\)\s*$/, "")}</span>
            </div>
          ))}
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 6 }}>
            Shifts that leave the published schedule come off the calendar. Days you added by hand are never touched.
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(CallSyncPanel);
