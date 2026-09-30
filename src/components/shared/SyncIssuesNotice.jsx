import { useMemo } from "react";
import { useApp } from "../../context/AppContext";
import { describeSyncIssues } from "../../utils/syncIssues.js";
import { actionButtonStyle } from "./actionButton.js";

/**
 * Records the cloud refused, named one by one.
 *
 * A save whose row the database refuses (a blank required field, a value of
 * the wrong type) used to look saved: the form closed, the record showed on
 * this device, and it was missing on every other device and from the backups
 * with nothing said. src/lib/supabase.js lists those records; this says which
 * ones, why in plain words, and opens each so it can be fixed and saved again.
 * Shown on every tab, because it is a failed save, not account chrome.
 */
export default function SyncIssuesNotice() {
  const { syncIssues, pendingWrites, awaitingAccessWrites, accessRefusedWrites, offlineMode, offlineCopyStale, data, theme: T, isDesktop, navigate } = useApp();
  const lines = useMemo(() => describeSyncIssues(syncIssues, data), [syncIssues, data]);
  // Offline, the offline banner already says changes are waiting.
  const unsent = offlineMode ? 0 : Math.max(0, (pendingWrites || 0) - lines.length);
  // Saves kept on this device while the membership check could not answer,
  // which the answer then refused (the membership is read-only now): not in
  // the account, and no reconnecting sends them. They stay on this device and
  // go up only if the membership allows changes again.
  const refusedCount = Math.max(0, accessRefusedWrites || 0);
  const refused = Math.min(unsent, refusedCount);
  // Saves kept on this device while the membership check could not answer
  // (a bad connection): they go up when it next does, not only at launch.
  const kept = Math.min(unsent - refused, Math.max(0, (awaitingAccessWrites || 0) - refusedCount));
  const waiting = unsent - refused - kept;
  const refusedLine = refused > 0
    ? <>{refused === 1 ? "1 change" : `${refused} changes`} on this device could not be saved to your account because your membership no longer allows changes. {refused === 1 ? "It stays" : "They stay"} on this device and will sync if your membership allows changes again. </>
    : null;
  const keptLine = kept > 0
    ? <>{kept === 1 ? "1 change is" : `${kept} changes are`} saved on this device and will sync to your account when the app reconnects. </>
    : null;
  const stale = offlineCopyStale
    ? <p style={{ margin: lines.length || waiting || kept || refused ? "10px 0 0" : 0, fontSize: isDesktop ? 14 : 16, lineHeight: 1.5, color: T.textMuted }}>
        This device&rsquo;s storage is full, so its offline copy of your records could not be updated. What opens offline is older than what you see now.
      </p>
    : null;
  if (!lines.length && !waiting && !kept && !refused && !stale) return null;
  const one = lines.length === 1;
  const button = actionButtonStyle(T, { primary: false, isDesktop });
  if (!lines.length) {
    return (
      <aside role="status" aria-live="polite" data-sync-waiting="" style={{ padding: "10px 16px", marginBottom: 14,
        background: T.card, color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 12, fontSize: isDesktop ? 14 : 16, lineHeight: 1.5 }}>
        {refusedLine}
        {keptLine}
        {waiting > 0 && <>{waiting === 1 ? "1 change has" : `${waiting} changes have`} not reached your account yet. {waiting === 1 ? "It is" : "They are"} sent again each time the app opens.</>}
        {stale}
      </aside>
    );
  }
  return (
    <aside role="status" aria-live="polite" data-sync-issues="" style={{ padding: "12px 16px", marginBottom: 14,
      background: T.card, color: T.text, border: `1px solid ${T.danger}`, borderRadius: 12 }}>
      <p style={{ margin: 0, fontSize: isDesktop ? 14 : 16, fontWeight: 700 }}>Not saved to your account</p>
      <p style={{ margin: "6px 0 10px", fontSize: isDesktop ? 14 : 16, lineHeight: 1.5, color: T.textMuted }}>
        {one ? "This record is" : `These ${lines.length} records are`} on this device only. Your account refused {one ? "it" : "them"}, so {one ? "it is" : "they are"} missing
        on your other devices and from your backups. Open {one ? "it" : "each one"}, fix what is named and save again.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {lines.map((line) => (
          <li key={`${line.collectionKey}:${line.id}`} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 200px", fontSize: isDesktop ? 14 : 16, lineHeight: 1.45 }}>
              <strong>{line.section}:</strong> {line.title}. <span style={{ color: T.textMuted }}>Refused because {line.reason}.</span>
            </span>
            {line.tab && (
              <button type="button" style={button}
                onClick={() => navigate(line.tab, line.sub, { sec: line.collectionKey, id: line.id })}>Open</button>
            )}
          </li>
        ))}
      </ul>
      {refusedLine && <p data-sync-refused="" style={{ margin: "10px 0 0", fontSize: isDesktop ? 14 : 16, lineHeight: 1.5, color: T.textMuted }}>{refusedLine}</p>}
      {keptLine && <p data-sync-kept="" style={{ margin: "10px 0 0", fontSize: isDesktop ? 14 : 16, lineHeight: 1.5, color: T.textMuted }}>{keptLine}</p>}
      {waiting > 0 && (
        <p style={{ margin: "10px 0 0", fontSize: isDesktop ? 14 : 16, lineHeight: 1.5, color: T.textMuted }}>
          {waiting === 1 ? "1 other change has" : `${waiting} other changes have`} not reached your account yet. {waiting === 1 ? "It is" : "They are"} sent again each time the app opens.
        </p>
      )}
      {stale}
    </aside>
  );
}
