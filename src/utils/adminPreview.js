/**
 * Admin "Preview as" (ticket d45e857c, phase 1): see the app the way a member
 * with a given membership sees it, on the administrator's OWN records.
 *
 * What differs between an administrator, a Credential member and a member
 * with Practice (locums) comes from the membership snapshot the server
 * sends (limitedLaunchAccess.js), plus the Admin card and the admin AI
 * labels. A preview swaps that snapshot for a synthetic one built from a
 * preset, so the read-only gates, the pending and paused screens and the
 * membership copy all render as they would for that member. No member's data
 * is read.
 *
 * Rules this module keeps:
 * - Admin only. The source returns nothing unless the server has said this
 *   account is an administrator (isAdmin), and only for the account that
 *   started the preview.
 * - It can only take away. Every capability is the preset's AND the admin's
 *   real one (the access authority enforces the same again), so the server,
 *   which still applies the admin's real rights, never sees a request the
 *   admin could not already make.
 * - No checkout, resume or invitation action can start from a preview.
 * - Held in sessionStorage for this tab only, never localStorage, and never
 *   sent to the server. Closing the tab ends it.
 */
import { validateAccessSnapshot } from "./limitedLaunchAccess.js";

export const ADMIN_PREVIEW_STORAGE_KEY = "credentialdomd-admin-preview";
const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPES = ["credential", "practice"];
const OPERATIONS = ["read", "write", "export"];

export const ADMIN_PREVIEW_PRESETS = Object.freeze([
  { id: "credential", label: "Credential only", detail: "Paid Credential member. Practice records can be read and exported but not changed." },
  { id: "credential_practice", label: "Credential + Locums", detail: "Paid Credential + Practice member. Everything can be changed." },
  { id: "practice_trial", label: "Practice trial active", detail: "Credential member inside the included Practice trial." },
  { id: "practice_trial_expired", label: "Practice trial expired", detail: "Credential member after the Practice trial ended. Practice is read-only." },
  { id: "pending", label: "Pending", detail: "Signed in with no membership yet. Sees the membership screen." },
  { id: "paused", label: "Paused", detail: "Access paused by an administrator. Sees the paused screen." },
].map(preset => Object.freeze(preset)));

export function adminPreviewPreset(id) {
  return ADMIN_PREVIEW_PRESETS.find(preset => preset.id === id) || null;
}

/** The server-shaped snapshot a member with this preset would receive. Always passes validateAccessSnapshot. */
export function previewAccessSnapshot(presetId, real) {
  if (!adminPreviewPreset(presetId) || !real) throw new Error("Unknown preview.");
  const evaluatedAt = Date.parse(real.evaluatedAt);
  const at = offset => new Date(evaluatedAt + offset).toISOString();
  const active = presetId !== "pending" && presetId !== "paused";
  const offer = { credential: "core", credential_practice: "core_locum", practice_trial: "core", practice_trial_expired: "core" }[presetId] ?? null;
  const practiceTrial = presetId === "practice_trial" ? { state: "active", startsAt: at(-7 * DAY_MS), endsAt: at(23 * DAY_MS), autoCharges: false }
    : presetId === "practice_trial_expired" ? { state: "expired", startsAt: at(-40 * DAY_MS), endsAt: at(-10 * DAY_MS), autoCharges: false }
      : { state: "none", startsAt: null, endsAt: null, autoCharges: false };
  const practiceWrite = presetId === "credential_practice" || presetId === "practice_trial";
  return validateAccessSnapshot({
    schemaVersion: 1,
    policyVersion: real.policyVersion,
    evaluatedAt: real.evaluatedAt,
    enforcementEnabled: real.enforcementEnabled,
    accessStatus: presetId === "pending" ? "pending" : presetId === "paused" ? "revoked" : "active",
    purchasedOfferId: offer,
    scheduledMembership: null,
    billingEnabled: real.billingEnabled === true,
    checkoutEligible: false,
    checkoutResumeAvailable: false,
    checkoutResumeOfferId: null,
    invitationActivationEnabled: false,
    pricePhase: real.pricePhase ?? null,
    lifetime: { credential: false, practice: false },
    freeBeta: { state: "none", startsAt: null, endsAt: null, autoCharges: false },
    practiceTrial,
    capabilities: {
      credential: { read: active, write: active, export: active },
      practice: { read: active, write: active && practiceWrite, export: active },
    },
  });
}

/** Intersect with the real state: a preview never shows a capability the admin does not have. */
export function restrictToReal(view, real) {
  for (const scope of SCOPES) {
    for (const op of OPERATIONS) view.capabilities[scope][op] = view.capabilities[scope][op] === true && real?.capabilities?.[scope]?.[op] === true;
  }
  return view;
}

/** What the admin sees while previewing `presetId`, given their real (already time-evaluated) access. */
export function applyAdminPreview(real, presetId) {
  const preset = adminPreviewPreset(presetId);
  const view = restrictToReal(previewAccessSnapshot(presetId, real), real);
  view.needsRefresh = real.needsRefresh === true;
  if (real.nextCheckInMs !== undefined) view.nextCheckInMs = real.nextCheckInMs;
  view.adminPreview = { id: preset.id, label: preset.label, detail: preset.detail };
  return view;
}

/** The tab's preview choice. `storage` is sessionStorage in the app; tests pass their own. */
export function createAdminPreviewStore({ storage = () => globalThis.sessionStorage } = {}) {
  const listeners = new Set();
  let loaded = false, current = null, version = 0;
  const store = () => { try { return storage() || null; } catch { return null; } };
  const parse = raw => {
    try {
      const value = JSON.parse(raw);
      return value && typeof value.accountId === "string" && value.accountId && adminPreviewPreset(value.presetId)
        ? { accountId: value.accountId, presetId: value.presetId } : null;
    } catch { return null; }
  };
  const changed = () => { version += 1; for (const listener of [...listeners]) listener(); };
  return {
    read() {
      if (!loaded) {
        loaded = true;
        try { current = parse(store()?.getItem(ADMIN_PREVIEW_STORAGE_KEY) ?? null); } catch { current = null; }
      }
      return current;
    },
    start(accountId, presetId) {
      if (typeof accountId !== "string" || !accountId || !adminPreviewPreset(presetId)) return false;
      loaded = true; current = { accountId, presetId };
      try { store()?.setItem(ADMIN_PREVIEW_STORAGE_KEY, JSON.stringify(current)); } catch { /* this page only */ }
      changed();
      return true;
    },
    exit() {
      loaded = true; current = null;
      try { store()?.removeItem(ADMIN_PREVIEW_STORAGE_KEY); } catch { /* nothing kept */ }
      changed();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    version: () => version,
  };
}

export const adminPreviewStore = createAdminPreviewStore();

/** For the access authority: the previewed state, or null when no preview applies to this account. */
export function adminPreviewSource({ store = adminPreviewStore, isAdmin }) {
  return (accountId, real) => {
    if (!real || !accountId || isAdmin?.() !== true) return null;
    const chosen = store.read();
    if (!chosen || chosen.accountId !== accountId) return null;
    return applyAdminPreview(real, chosen.presetId);
  };
}

/** True while this signed-in administrator is previewing (for display-only admin labels). */
export function adminPreviewActive(accountId, store = adminPreviewStore) {
  const chosen = store.read();
  return !!chosen && !!accountId && chosen.accountId === accountId;
}
