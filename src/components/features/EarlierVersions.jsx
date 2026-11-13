import { useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { discardRecovery, onRecoveryChange, readRecovery, recoveryDownload, RECOVERY_BASE, RECOVERY_GENERATION } from "../../utils/syncRecovery.js";
import { localFence } from "../../utils/storageScope.js";

/**
 * Earlier versions kept on this device (utils/syncRecovery.js).
 *
 * When this device's copy of a record differed from the account copy, the
 * app shows and uses the account version and keeps this device's version
 * aside. Those copies never replay. They used to put a red "needs your
 * review" notice on every tab, which asked the member to judge something the
 * app had already settled (2026-11-13, the owner's iPhone). They are a quiet
 * safety net now, reachable only here: collapsed, with a download and a
 * remove, and nothing at all when there are none.
 */
export default function EarlierVersions() {
  const { user, theme: T } = useApp();
  const accountId = user?.id;
  const [stored, setState] = useState({ owner: null, fence: null, entries: [] });
  // A different member's first render must not expose the previous member's
  // entries while this component waits for its effect to refresh.
  const entries = stored.owner === accountId && stored.fence === localFence(accountId) ? stored.entries : [];
  useEffect(() => {
    const refresh = changed => {
      if (changed && changed !== accountId) return;
      if (!accountId) { setState({ owner: null, fence: null, entries: [] }); return; }
      const owner = { owner: accountId, fence: localFence(accountId) };
      // A store this load cannot read is not the member's problem to solve:
      // the account version is what the app uses either way.
      try { setState({ ...owner, entries: readRecovery(accountId) }); }
      catch { setState({ ...owner, entries: [] }); }
    };
    const storage = event => { if (event.key?.startsWith(RECOVERY_BASE) || event.key === RECOVERY_GENERATION) refresh(); };
    refresh(); const stop = onRecoveryChange(refresh);
    window.addEventListener("storage", storage);
    return () => { stop(); window.removeEventListener("storage", storage); };
  }, [accountId]);
  const download = entryId => {
    try {
      const blob = new Blob([JSON.stringify(recoveryDownload(accountId, entryId), null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = "CredentialDOMD earlier versions (KEEP PRIVATE).json";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { /* the account changed under the tap; nothing to hand over */ }
  };
  const remove = entryId => {
    if (!window.confirm("Remove this earlier version from this device? Your account record stays as it is.")) return;
    try { discardRecovery(accountId, entryId); } catch { /* the account changed under the tap */ }
  };
  if (!entries.length) return null;
  const button = {
    padding: "7px 11px", borderRadius: 9, border: `1px solid ${T.border}`,
    backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
  return (
    <details data-earlier-versions="" style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "12px 18px", marginTop: 14 }}>
      <summary style={{ minHeight: 32, padding: "4px 0", cursor: "pointer", fontSize: 14, fontWeight: 600, color: T.textMuted }}>
        Earlier versions kept on this device ({entries.length})
      </summary>
      <div style={{ fontSize: 13, color: T.textDim, margin: "6px 0 10px", lineHeight: 1.5 }}>
        Your account version is the one in use. These are the versions this device had before, kept here in case you want them.
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {entries.map(entry => {
          const title = entry.local?.name || entry.local?.title || entry.local?.number || entry.collectionKey.replace(/([a-z])([A-Z])/g, "$1 $2");
          return (
            <li key={entry.entryId} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 180px", fontSize: 13.5, color: T.text }}>{String(title)}</span>
              <button type="button" style={button} onClick={() => download(entry.entryId)}>Download</button>
              <button type="button" style={button} onClick={() => remove(entry.entryId)}>Remove</button>
            </li>
          );
        })}
      </ul>
      {entries.length > 1 && (
        <button type="button" style={{ ...button, marginTop: 10 }} onClick={() => download()}>Download all</button>
      )}
    </details>
  );
}
