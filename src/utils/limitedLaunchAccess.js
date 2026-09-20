import { PUBLIC_BILLING_POLICY } from "../../supabase/functions/_shared/accessPolicy.mjs";

// This client switch never enables checkout or changes an account entitlement.
export const LIMITED_LAUNCH_ACCESS_ENABLED = import.meta.env?.VITE_LIMITED_LAUNCH_ACCESS_ENABLED === "true";
// Separate rollout switch: existing personal invitations work while public enrollment is off.
export const PUBLIC_SELF_SERVICE_SIGNUP_ENABLED = import.meta.env?.VITE_PUBLIC_SELF_SERVICE_SIGNUP_ENABLED === "true";
export const ACCESS_REFRESH_MS = 5 * 60 * 1000;
const scopes = ["credential", "practice"];
const operations = ["read", "write", "export"];
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export const PRACTICE_COLLECTIONS = new Set([
  "locumContracts", "workLog", "invoices", "encounters", "travelExpenses",
  "taxPayments", "scheduleDays", "taskNotes", "dutyDays", "deductibles", "rotations",
]);

export function scopeForCollection(key, record) {
  if (key === "documents" && typeof record?.linkedTo === "string") {
    return PRACTICE_COLLECTIONS.has(record.linkedTo.split(":")[0]) ? "practice" : "credential";
  }
  return PRACTICE_COLLECTIONS.has(key) ? "practice" : "credential";
}

/** Validate the server contract before using it for any client permission. */
export function validateAccessSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.policyVersion !== PUBLIC_BILLING_POLICY.version
    || !date(value.evaluatedAt) || typeof value.enforcementEnabled !== "boolean"
    || !["active", "pending", "revoked"].includes(value.accessStatus)
    || ![null, "core", "core_locum"].includes(value.purchasedOfferId)
    || typeof value.billingEnabled !== "boolean") throw new Error("Membership information could not be verified.");
  for (const scope of scopes) {
    if (typeof value.lifetime?.[scope] !== "boolean"
      || operations.some(op => typeof value.capabilities?.[scope]?.[op] !== "boolean")) {
      throw new Error("Membership information could not be verified.");
    }
  }
  const trial = value.practiceTrial;
  if (!trial || !["none", "active", "expired"].includes(trial.state) || trial.autoCharges !== false
    || (trial.state === "none" ? trial.startsAt !== null || trial.endsAt !== null
      : !date(trial.startsAt) || !date(trial.endsAt) || Date.parse(trial.endsAt) <= Date.parse(trial.startsAt))) {
    throw new Error("Practice trial information could not be verified.");
  }
  if (value.accessStatus !== "active" && scopes.some(scope => operations.some(op => value.capabilities[scope][op]))) {
    throw new Error("Membership information could not be verified.");
  }
  for (const flag of ["checkoutEligible", "checkoutResumeAvailable", "invitationActivationEnabled"]) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw new Error("Membership information could not be verified.");
  }
  if (value.checkoutResumeAvailable === true
    ? value.billingEnabled !== true || !["core", "core_locum"].includes(value.checkoutResumeOfferId)
    : value.checkoutResumeOfferId != null) throw new Error("Checkout resume information could not be verified.");
  if (value.pricePhase != null && !["founding", "earlybird", "standard"].includes(value.pricePhase)) throw new Error("Membership information could not be verified.");
  if (value.freeBeta !== undefined) {
    const beta = value.freeBeta;
    if (!beta || !["none", "active", "expired"].includes(beta.state) || beta.autoCharges !== false
      || (beta.state === "none" ? beta.startsAt !== null || beta.endsAt !== null
        : !date(beta.startsAt) || !date(beta.endsAt) || Date.parse(beta.endsAt) <= Date.parse(beta.startsAt))) {
      throw new Error("Free beta information could not be verified.");
    }
  }
  return structuredClone(value);
}

/** Resume permits only the server's saved offer; it never grants product access. */
export function canReviewBillingOffer(access, offerId) {
  if (!access || access.needsRefresh || access.billingEnabled !== true
    || !["core", "core_locum"].includes(offerId) || !["active", "pending"].includes(access.accessStatus)
    || access.purchasedOfferId || access.lifetime?.credential || access.lifetime?.practice
    || access.freeBeta?.state === "active") return false;
  if (access.checkoutResumeAvailable === true) return access.checkoutResumeOfferId === offerId;
  return access.checkoutEligible === true;
}

/** Use elapsed time since receipt, so a physician's clock does not set a trial's end. */
export function accessAt(snapshot, receivedAt, now = Date.now()) {
  if (!snapshot) return null;
  const result = structuredClone(snapshot);
  const elapsed = Math.max(0, now - receivedAt);
  result.needsRefresh = elapsed >= ACCESS_REFRESH_MS;
  const serverNow = Date.parse(snapshot.evaluatedAt) + elapsed;
  result.nextCheckInMs = Math.max(1, ACCESS_REFRESH_MS - elapsed);
  if (result.practiceTrial.state === "active" && Date.parse(result.practiceTrial.endsAt) > serverNow) {
    result.nextCheckInMs = Math.min(result.nextCheckInMs, Date.parse(result.practiceTrial.endsAt) - serverNow);
  }
  if (result.practiceTrial.state === "active" && serverNow >= Date.parse(result.practiceTrial.endsAt)) {
    result.practiceTrial.state = "expired";
    if (!result.lifetime.practice && result.purchasedOfferId !== "core_locum") result.capabilities.practice.write = false;
  }
  if (result.freeBeta?.state === "active") {
    const remaining = Date.parse(result.freeBeta.endsAt) - serverNow;
    if (remaining > 0) result.nextCheckInMs = Math.min(result.nextCheckInMs, remaining);
    else {
      result.freeBeta.state = "expired";
      if (!result.lifetime.credential && !result.purchasedOfferId) result.capabilities.credential.write = false;
      if (!result.lifetime.practice && result.purchasedOfferId !== "core_locum"
        && !(result.purchasedOfferId === "core" && result.practiceTrial.state === "active")) result.capabilities.practice.write = false;
    }
  }
  // An old result can preserve a user's read/export view, never authorize a new write.
  if (result.needsRefresh || !result.enforcementEnabled) {
    for (const scope of scopes) result.capabilities[scope].write = false;
  }
  return result;
}

/** In-memory write guard shared by UI and persistence; the server still enforces access. */
export function createAccessAuthority({ enabled = LIMITED_LAUNCH_ACCESS_ENABLED, now = () => globalThis.performance?.now() ?? Date.now(), currentAccount } = {}) {
  let accountId = null, snapshot = null, receivedAt = 0, refreshFailed = false, records = null;
  const current = () => typeof currentAccount === "function" ? currentAccount() : accountId;
  return {
    enabled,
    reset(nextAccountId = null) { accountId = nextAccountId; snapshot = null; receivedAt = 0; refreshFailed = false; records = null; },
    registerRecords(expectedAccountId, value) {
      if (accountId === expectedAccountId && current() === expectedAccountId) records = value;
    },
    previousRecord(key, id, expectedAccountId = accountId) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return null;
      return records?.[key]?.find(record => record.id === id) || null;
    },
    suspendWrites() { refreshFailed = true; },
    accept(expectedAccountId, value) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return false;
      snapshot = validateAccessSnapshot(value); receivedAt = now(); refreshFailed = false; return true;
    },
    state(expectedAccountId = accountId) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return null;
      const value = accessAt(snapshot, receivedAt, now());
      if (value && refreshFailed) {
        value.needsRefresh = true;
        for (const scope of scopes) value.capabilities[scope].write = false;
      }
      return value;
    },
    allows(scope, operation, expectedAccountId = accountId) {
      if (!enabled) return true;
      if (!scopes.includes(scope) || !operations.includes(operation)) return false;
      return this.state(expectedAccountId)?.capabilities[scope]?.[operation] === true;
    },
    allowsMutation(key, record, previous, expectedAccountId = accountId) {
      if (!enabled) return true;
      const existing = previous || records?.[key]?.find(item => item.id === record?.id);
      if (key === "documents" && !existing && !record?.linkedTo) {
        return scopes.every(scope => this.allows(scope, "write", expectedAccountId));
      }
      return this.allows(scopeForCollection(key, record), "write", expectedAccountId)
        && (!existing || this.allows(scopeForCollection(key, existing), "write", expectedAccountId));
    },
  };
}

export const accessAuthority = createAccessAuthority({ currentAccount: () => globalThis.window?.Clerk?.user?.id || null });

export function membershipWriteError() {
  const error = new Error("This record is read-only. Your saved records and exports are still available.");
  error.code = "membership_read_only";
  return error;
}

// A backup restore or direct collection replacement is checked as one operation.
// Theme and notification preferences remain usable while saved records are read-only.
const READ_ONLY_PREFERENCES = new Set(["theme", "fontSize", "notifyBrowser", "notifyEmail", "notifyText", "notifyFreqDays", "alertsFingerprint", "lastNotified", "snoozedUntil"]);
export function allowsSettingsChange(updates, authority = accessAuthority) {
  return !authority.enabled || Object.keys(updates || {}).every(key => READ_ONLY_PREFERENCES.has(key))
    || authority.allows("credential", "write");
}
const sameValue = (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right);
export function allowsDataChange(previous, next, authority = accessAuthority) {
  if (!authority.enabled) return true;
  for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])) {
    if (sameValue(previous?.[key], next?.[key])) continue;
    if (key === "settings") {
      const changed = Object.fromEntries([...new Set([...Object.keys(previous?.settings || {}), ...Object.keys(next.settings || {})])].filter(name => !sameValue(next.settings?.[name], previous?.settings?.[name])).map(name => [name, next.settings?.[name]]));
      if (!allowsSettingsChange(changed, authority)) return false;
      continue;
    }
    if (!Array.isArray(previous?.[key]) && !Array.isArray(next?.[key])) {
      if (!authority.allows("credential", "write")) return false;
      continue;
    }
    const before = new Map((previous?.[key] || []).map(item => [item.id, item]));
    const after = new Map((next?.[key] || []).map(item => [item.id, item]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (sameValue(before.get(id), after.get(id))) continue;
      if (!authority.allowsMutation(key, after.get(id) || before.get(id), before.get(id))) return false;
    }
  }
  return true;
}
export function assertRecordWrite(key, record, previous) {
  if (!accessAuthority.allowsMutation(key, record, previous)) throw membershipWriteError();
}
