import { memo, useCallback, useEffect, useRef, useState } from "react";

/**
 * UpdatePrompt — invisible watcher that pops up a single button when a new
 * version of the app has been deployed. Tapping it reloads with fresh data.
 *
 * How it knows an update exists: every deploy stamps a unique build id into
 * the app bundle and into version.json on the server. This component quietly
 * compares the two — when the app opens, whenever the tab regains focus, and
 * every 15 minutes. It also watches the service worker, which detects new
 * deploys on its own. On mismatch, the green pill appears; tapping it
 * activates the new service worker, clears every cache, and reloads.
 *
 * When the app is current, this renders nothing at all.
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
  const [updateReady, setUpdateReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const reloading = useRef(false);

  const doReload = useCallback(() => {
    if (reloading.current) return;
    reloading.current = true;
    window.location.reload();
  }, []);

  const check = useCallback(async () => {
    const reg = await getRegistration();
    try { await reg?.update(); } catch { /* offline — version.json still decides */ }

    if (reg?.waiting) {
      setUpdateReady(true);
      return;
    }

    const deployed = await fetchDeployedBuild();
    if (deployed && CURRENT_BUILD !== "dev" && deployed !== CURRENT_BUILD) {
      setUpdateReady(true);
    }
  }, []);

  // Apply the update: activate any waiting SW, wipe caches, reload fresh.
  const applyUpdate = useCallback(async () => {
    setApplying(true);
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

    setTimeout(doReload, 800);
  }, [doReload]);

  useEffect(() => {
    let disposed = false;

    // Surface a background-installed update immediately.
    (async () => {
      const reg = await getRegistration();
      if (!reg || disposed) return;
      if (reg.waiting) setUpdateReady(true);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            setUpdateReady(true);
          }
        });
      });
    })();

    check();

    const onFocus = () => { if (document.visibilityState !== "hidden") check(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = setInterval(check, CHECK_INTERVAL_MS);

    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(interval);
    };
  }, [check]);

  // Current version → render nothing.
  if (!updateReady) return null;

  return (
    <button
      onClick={applyUpdate}
      disabled={applying}
      aria-label="Update app to the new version"
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
        cursor: "pointer",
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
        style={applying ? { animation: "cmd-upd-spin 0.8s linear infinite" } : undefined}
      >
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
      <span>{applying ? "Updating…" : "New version — tap to update"}</span>
      <style>{`@keyframes cmd-upd-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </button>
  );
}

export default memo(UpdatePrompt);
