import { useEffect, useState } from "react";
import { useApp } from "../context/AppContext";
import { CREDENTIAL_PORTAL_ENABLED, credentialPortalRequest } from "../utils/credentialPortalClient.js";

// One question per signed-in account: does the server offer administrator
// access to it (active, not closed, inside CREDENTIAL_PORTAL_OWNER_PROFILES)?
// A disabled build never asks. A failed question is retried on the next mount.
const statusCache = new Map();

// This answer can insert a card above the control somebody is pressing. Keep
// that layout unchanged through pointerup AND its following click event. This
// only schedules this status update; it never captures or cancels user input.
function pointerIdleCommit(commit) {
  const target = globalThis.window;
  const active = new Set();
  let pending = false;
  let disposed = false;
  let timer = null;
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const flush = () => {
    timer = null;
    if (!disposed && !active.size && pending) { pending = false; commit(); }
  };
  const afterRelease = () => {
    clear();
    // A task, not a promise microtask: the native click still needs its target.
    timer = setTimeout(flush, 0);
  };
  const down = event => { active.add(event.pointerId); clear(); };
  const up = event => { active.delete(event.pointerId); if (!active.size) afterRelease(); };
  const blur = () => { active.clear(); afterRelease(); };
  target?.addEventListener?.("pointerdown", down, true);
  target?.addEventListener?.("pointerup", up, true);
  target?.addEventListener?.("pointercancel", up, true);
  target?.addEventListener?.("blur", blur);
  return {
    run() { pending = true; if (!active.size && timer === null) flush(); },
    dispose() {
      disposed = true; pending = false; active.clear(); clear();
      target?.removeEventListener?.("pointerdown", down, true);
      target?.removeEventListener?.("pointerup", up, true);
      target?.removeEventListener?.("pointercancel", up, true);
      target?.removeEventListener?.("blur", blur);
    },
  };
}

export function useAdministratorAccessStatus() {
  const { user } = useApp();
  const userId = user?.id || null;
  const [state, setState] = useState({ userId: null, available: false });
  useEffect(() => {
    if (!CREDENTIAL_PORTAL_ENABLED || !userId) return undefined;
    let live = true;
    let answer = false;
    const visibility = pointerIdleCommit(() => { if (live) setState({ userId, available: answer }); });
    if (!statusCache.has(userId)) {
      statusCache.set(userId, credentialPortalRequest({ action: "status" })
        .then(result => result?.available === true)
        .catch(() => { statusCache.delete(userId); return false; }));
    }
    statusCache.get(userId).then(available => { answer = available; if (live) visibility.run(); });
    return () => { live = false; visibility.dispose(); };
  }, [userId]);
  return CREDENTIAL_PORTAL_ENABLED && state.userId === userId && state.available;
}
