import { useMemo } from "react";
import { useApp } from "../../context/AppContext";
import { describeSyncIssues } from "../../utils/syncIssues.js";
import { actionButtonStyle } from "./actionButton.js";
import { reloadPage } from "../../utils/pageLeave.js";

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
  const { syncIssues, pendingWrites, awaitingAccessWrites, accessRefusedWrites, offlineMode, offlineCopyStale, deviceOnlyUnsaved, data, theme: T, isDesktop, navigate } = useApp();
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
  // Why the offline copy is older than the screen (utils/storage.js
  // cacheStaleReason): out of space, an offline store that would not open,
  // or a stored copy this load could not read. Only the first is "full".
  // An offline store that would not open (iOS took it from an app left in
  // the background) matters only while something is in no other copy: the
  // app is offline, a change has not reached the account, or a Protected
  // Identity or Answer Bank change waits. Online with everything in the
  // account, the line said nothing he could act on (2026-10-02).
  const atRisk = !!offlineMode || unsent > 0 || lines.length > 0 || deviceOnlyUnsaved === "held" || deviceOnlyUnsaved === "memory";
  const stale = offlineCopyStale && (offlineCopyStale !== "unavailable" || atRisk)
    ? <p style={{ margin: lines.length || waiting || kept || refused ? "10px 0 0" : 0, fontSize: isDesktop ? 14 : 16, lineHeight: 1.5, color: T.textMuted }}>
        {offlineCopyStale === "unread"
          ? <>This device&rsquo;s offline storage could not be read, so Protected Identity and the Answer Bank, kept only on this device, may not all be shown and cannot be changed, and its offline copy of your records is not being updated. The app tries again on its own; reload the app to try again now.</>
          : offlineCopyStale === "unavailable"
            // iOS takes the offline store away from an app left in the
            // background, and WebKit lets a page open it again only after a
            // reload (2026-10-02, the owner's iPhone): say so, and offer it.
            ? <>This device&rsquo;s offline storage could not be opened, so its offline copy of your records could not be updated. Reload the app to open it again.{" "}
                <button type="button" data-offline-reload="" onClick={() => reloadPage()}
                  style={{ ...actionButtonStyle(T, { primary: false, isDesktop }), marginTop: 8 }}>Reload</button></>
            : <>This device&rsquo;s storage is full, so its offline copy of your records could not be updated. What opens offline is older than what you see now.</>}
      </p>
    : null;
  // Protected Identity or Answer Bank changes that are in no copy of the
  // offline file (utils/storage.js deviceOnlyUnsavedState): kept aside on this
  // device until a save takes them, or on screen only. Those sections have no
  // cloud copy, so the one way to keep them safe meanwhile is a JSON backup.
  const deviceOnly = deviceOnlyUnsaved === "held" || deviceOnlyUnsaved === "memory"
    ? <p data-device-only-unsaved="" style={{ margin: lines.length || waiting || kept || refused || stale ? "10px 0 0" : 0, fontSize: isDesktop ? 14 : 16, lineHeight: 1.5, color: T.textMuted }}>
        {deviceOnlyUnsaved === "held"
          ? <>A change to Protected Identity or the Answer Bank is not in this device&rsquo;s offline copy yet. It is kept aside on this device and saved into the offline copy as soon as the copy can be saved. Until then, save a full JSON backup under More, Data &amp; Backup.</>
          : <>A change to Protected Identity or the Answer Bank is on this screen only: this device could not save it anywhere. Save a full JSON backup under More, Data &amp; Backup now; closing the app loses it.</>}
      </p>
    : null;
  if (!lines.length && !waiting && !kept && !refused && !stale && !deviceOnly) return null;
  const one = lines.length === 1;
  const button = actionButtonStyle(T, { primary: false, isDesktop });
  if (!lines.length) {
    return (
      <aside role="status" aria-live="polite" data-sync-waiting="" style={{ padding: "10px 16px", marginBottom: 14,
        background: T.card, color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 12, fontSize: isDesktop ? 14 : 16, lineHeight: 1.5 }}>
        {refusedLine}
        {keptLine}
        {waiting > 0 && <>{waiting === 1 ? "1 change has" : `${waiting} changes have`} not reached your account yet. {waiting === 1 ? "It is" : "They are"} sent again when the connection returns and each time the app opens.</>}
        {stale}
        {deviceOnly}
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
          {waiting === 1 ? "1 other change has" : `${waiting} other changes have`} not reached your account yet. {waiting === 1 ? "It is" : "They are"} sent again when the connection returns and each time the app opens.
        </p>
      )}
      {stale}
      {deviceOnly}
    </aside>
  );
}
