import { memo, useCallback, useEffect, useRef, useState } from "react";

/**
 * UpdatePrompt — persistent update button + "update available" banner.
 *
 * The app is a PWA on GitHub Pages: HTML is served with max-age=600 and the
 * service worker caches assets, so a freshly deployed build can take a while
 * to reach an open tab (or an installed home-screen app). This component
 * closes that gap three ways:
 *
 *   1. Detects a waiting/installing service worker and offers a one-tap
 *      refresh (posts SKIP_WAITING, reloads on controllerchange).
 *   2. Polls version.json (cache: no-store, so it bypasses every cache layer)
 *      on mount, on tab focus, and every 15 minutes, comparing the deployed
 *      build id against the one compiled into this bundle (__APP_BUILD_ID__).
 *   3. Always shows a small ↻ button (bottom-right) so the user can force a
 *      check + hard refresh at any time — clearing SW caches before reload.
 *
 * States: idle → checking → "update" (green pill, tap to apply) or a brief
 * "Up to date" flash after a manual check that found nothing.
 */

const CURRENT_BUILD = typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : "dev";
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

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

function UpdatePrompt() {
  const [status, setStatus] = useState("idle"); // idle | checking | update | current
  const reloading = useRef(false);

  const doReload = useCallback(() => {
    if (reloading.current) return;
    reloading.current = true;
    window.location.reload();
  }, []);

  // Core check: nudge the SW registration and compare deployed build id.
  const check = useCallback(async (manual) => {
    if (manual) setStatus("checking");

    const reg = await getRegistration();
    try { await reg?.update(); } catch { /* offline or SW not registered — version.json still decides */ }

    if (reg?.waiting) {
      setStatus("update");
      return;
    }

    const deployed = await fetchDeployedBuild();
    if (deployed && CURRENT_BUILD !== "dev" && deployed !== CURRENT_BUILD) {
      setStatus("update");
      return;
    }

    if (manual) {
      setStatus("current");
      setTimeout(() => setStatus((s) => (s === "current" ? "idle" : s)), 2000);
    } else {
      setStatus((s) => (s === "update" ? s : "idle"));
    }
  }, []);

  // Apply the update: activate any waiting SW, wipe SW caches, reload.
  const applyUpdate = useCallback(async () => {
    setStatus("checking");
    const reg = await getRegistration();

    if (reg?.waiting) {
      // Reload once the new SW takes control; fall through to the timed
      // reload below in case controllerchange never fires.
      navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    }

    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* cache wipe is best-effort */ }

    setTimeout(doReload, 800);
  }, [doReload]);

  useEffect(() => {
    let disposed = false;

    // Watch the SW lifecycle so a background-installed update surfaces
    // without waiting for the next poll.
    (async () => {
      const reg = await getRegistration();
      if (!reg || disposed) return;
      if (reg.waiting) setStatus("update");
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            setStatus("update");
          }
        });
      });
    })();

    check(false);

    const onFocus = () => { if (document.visibilityState !== "hidden") check(false); };
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

  const isUpdate = status === "update";
  const isChecking = status === "checking";
  const isCurrent = status === "current";

  return (
    <button
      onClick={isUpdate ? applyUpdate : () => check(true)}
      title={isUpdate ? "A new version is ready — tap to update" : `Check for updates (build ${CURRENT_BUILD})`}
      aria-label={isUpdate ? "Update app to the new version" : "Check for app updates"}
      style={{
        position: "fixed",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 76px)",
        right: 14,
        zIndex: 150,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 40,
        padding: isUpdate || isCurrent ? "0 16px" : 0,
        width: isUpdate || isCurrent ? "auto" : 40,
        justifyContent: "center",
        borderRadius: 20,
        border: isUpdate ? "none" : "1px solid rgba(0,0,0,0.08)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700,
        fontFamily: "inherit",
        color: isUpdate ? "#ffffff" : "#6b7280",
        backgroundColor: isUpdate ? "#10b981" : "rgba(255,255,255,0.92)",
        boxShadow: isUpdate
          ? "0 6px 20px rgba(16,185,129,0.4)"
          : "0 2px 10px rgba(0,0,0,0.12)",
        backdropFilter: "blur(6px)",
        transition: "all 0.25s ease",
      }}
    >
      <svg
        width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={isChecking ? { animation: "cmd-spin 0.8s linear infinite" } : undefined}
      >
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
      {isUpdate && <span>Update available</span>}
      {isCurrent && <span>Up to date</span>}
      <style>{`@keyframes cmd-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </button>
  );
}

export default memo(UpdatePrompt);
