import { useEffect, useState } from "react";
import { useApp } from "../context/AppContext";
import { CREDENTIAL_PORTAL_ENABLED, credentialPortalRequest } from "../utils/credentialPortalClient.js";

// One question per signed-in account: does the server offer administrator
// access to it (active, not closed, inside CREDENTIAL_PORTAL_OWNER_PROFILES)?
// A disabled build never asks. A failed question is retried on the next mount.
const statusCache = new Map();

export function useAdministratorAccessStatus() {
  const { user } = useApp();
  const userId = user?.id || null;
  const [state, setState] = useState({ userId: null, available: false });
  useEffect(() => {
    if (!CREDENTIAL_PORTAL_ENABLED || !userId) return undefined;
    let live = true;
    if (!statusCache.has(userId)) {
      statusCache.set(userId, credentialPortalRequest({ action: "status" })
        .then(result => result?.available === true)
        .catch(() => { statusCache.delete(userId); return false; }));
    }
    statusCache.get(userId).then(available => { if (live) setState({ userId, available }); });
    return () => { live = false; };
  }, [userId]);
  return CREDENTIAL_PORTAL_ENABLED && state.userId === userId && state.available;
}
