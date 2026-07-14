import { memo, useCallback, useEffect, useRef, useState } from "react";

/**
 * UpdatePrompt — CallSync-style silent auto-update.
 *
 * Every deploy stamps a unique build id into the bundle and version.json.
 * This watcher compares them when the app opens and whenever it regains
 * focus; on mismatch it updates AUTOMATICALLY — activate new SW, wipe
 * caches, reload — showing only a brief "Updating…" toast.
 *
 * Safety valves:
 *  - One auto-attempt per build id per session (sessionStorage guard). If
 *    the page still isn't current after an auto-reload (e.g. the CDN cache
 *    hasn't caught up yet), we don't loop — we fall back to a tappable
 *    "New version — tap to update" pill.
 *  - Updates found by the 15-minute background timer also show the pill
 *    instead of yanking the page out from under the user mid-task.
 */

const CURRENT_BUILD = typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : "dev";
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_GUARD_PREFIX = "cmd-auto-update-";

async function getRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

async function fetchDeployedBuild() {
  try {
    const url = `${import.meta.env.BASE_URL}version.json?t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.build === "string" ? json.build : null;
  } catch {
    return null;
  }
}

function autoAttempted(build) {
  try { return sessionStorage.getItem(AUTO_GUARD_PREFIX + build) !== null; }
  catch { return true; } // storage unavailable → never auto-reload (pill only)
}

function markAutoAttempt(build) {
  try { sessionStorage.setItem(AUTO_GUARD_PREFIX + build, "1"); } catch { /* noop */ }
}

function UpdatePrompt() {
  const [mode, setMode] = useState("idle"); // idle | updating | pill
  const reloading = useRef(false);

  const doReload = useCallback(() => {
    if (reloading.current) return;
    reloading.current = true;
    window.location.reload();
  }, []);

  // Activate any waiting SW, wipe caches, reload fresh.
  const applyUpdate = useCallback(async () => {
    setMode("updating");
    const reg = await getRegistration();

    if (reg?.waiting) {
      navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    }

    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* cache wipe is best-effort */ }

    setTimeout(doReload, 600);
  }, [doReload]);

  // silent=true (open/focus): auto-update. silent=false (timer): show pill.
  const check = useCallback(async (silent) => {
    const reg = await getRegistration();
    try { await reg?.update(); } catch { /* offline — version.json still decides */ }

    let newBuild = null;
    const deployed = await fetchDeployedBuild();
    if (deployed && CURRENT_BUILD !== "dev" && deployed !== CURRENT_BUILD) {
      newBuild = deployed;
    } else if (reg?.waiting) {
      newBuild = "sw-waiting";
    }
    if (!newBuild) return;

    if (silent && !autoAttempted(newBuild)) {
      markAutoAttempt(newBuild);
      applyUpdate();
    } else {
      setMode((m) => (m === "updating" ? m : "pill"));
    }
  }, [applyUpdate]);

  useEffect(() => {
    let disposed = false;

    // A SW installed in the background also triggers the same flow.
    (async () => {
      const reg = await getRegistration();
      if (!reg || disposed) return;
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            check(true);
          }
        });
      });
    })();

    check(true); // app opened

    const onFocus = () => { if (document.visibilityState !== "hidden") check(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = setInterval(() => check(false), CHECK_INTERVAL_MS);

    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(interval);
    };
  }, [check]);

  if (mode === "idle") return null;

  const updating = mode === "updating";

  return (
    <button
      onClick={updating ? undefined : applyUpdate}
      disabled={updating}
      aria-label={updating ? "Updating the app" : "Update app to the new version"}
      style={{
        position: "fixed",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 76px)",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 150,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 44,
        padding: "0 20px",
        borderRadius: 22,
        border: "none",
        cursor: updating ? "default" : "pointer",
        fontSize: 14,
        fontWeight: 700,
        fontFamily: "inherit",
        color: "#ffffff",
        backgroundColor: "#10b981",
        boxShadow: "0 6px 24px rgba(16,185,129,0.45)",
        whiteSpace: "nowrap",
      }}
    >
      <svg
        width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={updating ? { animation: "cmd-upd-spin 0.8s linear infinite" } : undefined}
      >
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
      <span>{updating ? "Updating…" : "New version — tap to update"}</span>
      <style>{`@keyframes cmd-upd-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </button>
  );
}

export default memo(UpdatePrompt);
