import { PUBLIC_BILLING_POLICY } from "../../supabase/functions/_shared/accessPolicy.mjs";
import { BASE_KEYS, lsGetJSON, lsSetJSON } from "./storageScope.js";

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
  if (value.scheduledMembership != null) {
    const scheduled = value.scheduledMembership;
    if (!scheduled || !["core", "core_locum"].includes(scheduled.offerId)
      || !date(scheduled.startsAt) || Date.parse(scheduled.startsAt) % 1000
      || value.checkoutEligible === true || value.purchasedOfferId != null || scheduled.currency !== "usd" || scheduled.interval !== "year"
      || !["scheduled", "payment_pending", "canceling"].includes(scheduled.status)
      || typeof scheduled.cancelAtPeriodEnd !== "boolean" || typeof scheduled.firstChargeCanceled !== "boolean"
      || (scheduled.firstChargeCanceled && !scheduled.cancelAtPeriodEnd)
      || (scheduled.status === "canceling") !== scheduled.cancelAtPeriodEnd
      || !(scheduled.offerId === "core" ? [9900, 14900, 19900] : [24500]).includes(scheduled.annualCents)) {
      throw new Error("Scheduled membership information could not be verified.");
    }
  }
  return structuredClone(value);
}

/** Resume permits only the server's saved offer; it never grants product access. */
export function canReviewBillingOffer(access, offerId) {
  if (!access || access.needsRefresh || access.billingEnabled !== true
    || !["core", "core_locum"].includes(offerId) || !["active", "pending"].includes(access.accessStatus)
    || access.purchasedOfferId || access.lifetime?.credential || access.lifetime?.practice
    || access.scheduledMembership) return false;
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
  // How long this answer stays fresh enough to authorize a write. The access
  // hook asks again before then, so a visible session never goes stale.
  result.freshForMs = Math.max(0, ACCESS_REFRESH_MS - elapsed);
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
  // What the server's last answer allows at this moment, with a trial or beta
  // that has run out already applied. The read-only archive and membership
  // notices follow this, never a snapshot that is merely old or a check that
  // failed (ticket fe321c16). It never authorizes a write: that stays below.
  result.entitled = Object.fromEntries(scopes.map(scope => [scope, result.enforcementEnabled === true && result.capabilities[scope].write === true]));
  // An old result can preserve a user's read/export view, never authorize a new write.
  if (result.needsRefresh || !result.enforcementEnabled) {
    for (const scope of scopes) result.capabilities[scope].write = false;
  }
  return result;
}

/**
 * The server's last answer for this scope: true (may change it), false (it
 * is read-only), or null when there is no answer to go on. With no snapshot
 * this session, the answer this device remembered for the account stands in
 * (`remembered`, from the authority), so a lapsed membership opens on its
 * archive and a current one on its screens.
 */
export function lastAnswer(access, scope, remembered = null) {
  if (!scopes.includes(scope)) return null;
  if (access) {
    const entitled = access.entitled?.[scope];
    if (typeof entitled === "boolean") return entitled;
    if (access.needsRefresh === true) return null;
    return access.capabilities?.[scope]?.write === true;
  }
  const cached = remembered?.[scope];
  return typeof cached === "boolean" ? cached : null;
}

/**
 * True when the server's answer keeps this scope read-only. An old snapshot
 * or a failed check keeps the answer it had: the normal screens stay and the
 * write guard refuses changes meanwhile (ticket fe321c16). With no answer at
 * all, this session or remembered, the archive shows until one arrives.
 */
export function membershipReadOnly(access, scope, remembered = null) {
  if (!scopes.includes(scope)) return false;
  const answer = lastAnswer(access, scope, remembered);
  return answer === null ? !access : !answer;
}

// The last answer per account, kept on this device (two booleans; removed
// with the account's other device keys on Sign out and on a server wipe; a
// session that merely expired keeps it, as it keeps the vault).
const deviceAnswers = {
  read(accountId) {
    const value = lsGetJSON(BASE_KEYS.accessAnswer, accountId);
    return value && scopes.every(scope => typeof value[scope] === "boolean")
      ? Object.fromEntries(scopes.map(scope => [scope, value[scope]])) : null;
  },
  write(accountId, value) { lsSetJSON(BASE_KEYS.accessAnswer, value, accountId); },
};
const sameAnswer = (a, b) => !!a && !!b && scopes.every(scope => a[scope] === b[scope]);

/** In-memory write guard shared by UI and persistence; the server still enforces access. */
export function createAccessAuthority({ enabled = LIMITED_LAUNCH_ACCESS_ENABLED, now = () => globalThis.performance?.now() ?? Date.now(), currentAccount, memory = deviceAnswers } = {}) {
  let accountId = null, snapshot = null, receivedAt = 0, refreshFailed = false, records = null, previewSource = null;
  // The answer remembered for this account, why writes are suspended, and
  // how to start a membership check at once (set by the access hook).
  let remembered = null, outdated = false, recheck = null;
  const current = () => typeof currentAccount === "function" ? currentAccount() : accountId;
  const remember = value => {
    if (!value || sameAnswer(value, remembered)) return;
    remembered = { ...value };
    try { memory?.write(accountId, remembered); } catch { /* the device cannot keep it; this session still does */ }
  };
  // The preview source's answer for `value`, clamped to it, or null.
  const previewOf = (expectedAccountId, value) => {
    const real = Object.fromEntries(scopes.map(scope => [scope, Object.fromEntries(operations.map(op => [op, value.capabilities[scope][op] === true]))]));
    let preview = null;
    try { preview = previewSource(expectedAccountId, value); } catch { preview = null; }
    if (!preview || preview === value || typeof preview !== "object" || !scopes.every(scope => preview.capabilities?.[scope] && typeof preview.capabilities[scope] === "object")) return null;
    for (const scope of scopes) for (const op of operations) {
      preview.capabilities[scope][op] = preview.capabilities[scope][op] === true && real[scope][op];
    }
    return preview;
  };
  return {
    enabled,
    /**
     * An admin "Preview as" view (utils/adminPreview.js). The source may only
     * take capabilities away: whatever it returns is intersected with the
     * real state here, so no source can grant a write the server snapshot
     * did not. A source that throws or returns nothing leaves the real state.
     */
    setPreviewSource(source) { previewSource = typeof source === "function" ? source : null; },
    reset(nextAccountId = null) {
      accountId = nextAccountId; snapshot = null; receivedAt = 0; refreshFailed = false; records = null; outdated = false;
      remembered = null;
      if (accountId) { try { remembered = memory?.read(accountId) || null; } catch { remembered = null; } }
    },
    registerRecords(expectedAccountId, value) {
      if (accountId === expectedAccountId && current() === expectedAccountId) records = value;
    },
    previousRecord(key, id, expectedAccountId = accountId) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return null;
      return records?.[key]?.find(record => record.id === id) || null;
    },
    /** A failed check refuses writes until a fresh answer. `outdated`: this build cannot read the answer. */
    suspendWrites({ outdated: stale = false } = {}) { refreshFailed = true; outdated = outdated || stale === true; },
    /** True after a check this build could not read (an older app version); a reload is the fix. */
    outdated() { return outdated; },
    accept(expectedAccountId, value) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return false;
      snapshot = validateAccessSnapshot(value); receivedAt = now(); refreshFailed = false; outdated = false;
      remember(accessAt(snapshot, receivedAt, receivedAt).entitled);
      return true;
    },
    /**
     * The answer this device remembered for the account, or null. Only for
     * the screens, never for a write. A moment when Clerk reports no user (an
     * offline session, or Clerk between sessions on a resume) still has it;
     * a different signed-in account never does. While no check can run, the
     * access hook lets it keep a scope read-only but never open one.
     */
    remembered(expectedAccountId = accountId) {
      const signedIn = current();
      if (!expectedAccountId || (signedIn && signedIn !== expectedAccountId)) return null;
      // The first render for a newly signed-in account comes before reset():
      // read the device's copy so a cold start opens on the right screens.
      if (accountId !== expectedAccountId) { try { return memory?.read(expectedAccountId) || null; } catch { return null; } }
      return remembered ? { ...remembered } : null;
    },
    /**
     * True while this authority holds `expectedAccountId`. Sign out resets it
     * to nobody before the purge, so a check still in flight for the account
     * is simply dropped: it neither writes the answer back nor counts as a
     * failed check.
     */
    serves(expectedAccountId) { return !!expectedAccountId && accountId === expectedAccountId; },
    /** The access hook's way to start a check now; returns the unsubscribe. */
    setRecheck(fn) {
      recheck = typeof fn === "function" ? fn : null;
      return () => { if (recheck === fn) recheck = null; };
    },
    /**
     * False when no membership check can run in this session: the hook is not
     * running (an offline session, or an account load that never reached the
     * server). Nothing will answer until the app reconnects.
     */
    canCheck() { return recheck !== null; },
    requestCheck() {
      if (!recheck) return false;
      try { recheck(); } catch { return false; }
      return true;
    },
    state(expectedAccountId = accountId) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return null;
      const value = accessAt(snapshot, receivedAt, now());
      // A trial or beta that ends while the app is open changes the answer
      // the next launch should open on.
      if (value) remember(value.entitled);
      if (value && refreshFailed) {
        value.needsRefresh = true;
        for (const scope of scopes) value.capabilities[scope].write = false;
      }
      if (value && previewSource) {
        const preview = previewOf(expectedAccountId, value);
        if (preview) {
          if (value.needsRefresh) preview.needsRefresh = true;
          // The previewed membership's own answer decides its archive, as it
          // would with a fresh snapshot; it is never more than the real one.
          const settled = structuredClone(value);
          settled.needsRefresh = false;
          for (const scope of scopes) settled.capabilities[scope].write = value.entitled[scope];
          const settledPreview = previewOf(expectedAccountId, settled);
          preview.entitled = Object.fromEntries(scopes.map(scope => [scope, value.entitled[scope]
            && (settledPreview ? settledPreview.capabilities[scope].write === true : true)]));
          return preview;
        }
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

// A write refused while membership is being re-checked is momentary, and says so.
export const RECONNECTING_MESSAGE = "Reconnecting, try again in a moment.";
// With no check able to run (offline, or an account that never finished
// loading), "try again in a moment" cannot come true. This is what is true.
export const NOT_CONNECTED_MESSAGE = "Changes can't be saved until you reconnect.";
// A build that cannot read the server's answer never recovers on its own.
export const OUTDATED_MESSAGE = "This version of the app is out of date. Reload to continue.";

/** The scopes a change to this record needs: both for a new file not filed to anything. */
export function scopesForWrite(key, record, previous = null) {
  if (key === "documents" && !previous && !record?.linkedTo) return [...scopes];
  return [...new Set([scopeForCollection(key, record), ...(previous ? [scopeForCollection(key, previous)] : [])])];
}

/**
 * True while this account's membership is being re-checked (no snapshot yet,
 * an old one, or a failed check) and the last answer did not already deny
 * `scope`. A scope the server said is read-only is not "reconnecting": it
 * stays read-only whatever the next check says. `scope` may be a list (all
 * must be open); with none, any open scope counts.
 */
export function accessVerifying(authority = accessAuthority, scope = null) {
  if (!authority?.enabled) return false;
  const value = authority.state();
  if (value && value.needsRefresh !== true) return false;
  const remembered = authority.remembered?.() ?? null;
  const open = name => lastAnswer(value, name, remembered) !== false;
  if (Array.isArray(scope)) return scope.every(open);
  if (scope) return open(scope);
  return scopes.some(open);
}

/** What to tell someone whose change was refused: out of date, reconnecting, not connected, or read-only. */
export function writeRefusalMessage(authority = accessAuthority, scope = null) {
  if (authority?.enabled && authority.outdated?.() === true) return OUTDATED_MESSAGE;
  if (!accessVerifying(authority, scope)) return membershipWriteError().message;
  return authority.canCheck?.() === false ? NOT_CONNECTED_MESSAGE : RECONNECTING_MESSAGE;
}

/** Start a membership check at once (the hook's own, coalesced with one in flight). */
export function requestAccessCheck(authority = accessAuthority) {
  return authority?.requestCheck?.() === true;
}

// Once per burst: an import of many records refused while reconnecting says
// so once, not once per record. Measured from when the message was closed.
// "Try again in a moment" is made true by asking for a fresh answer now,
// whatever the retry schedule had reached.
const REFUSAL_QUIET_MS = 3000;
let refusalShownAt = -Infinity;
export function alertWriteRefused({ authority = accessAuthority, scope = null, alert = message => globalThis.window?.alert?.(message), now = () => Date.now() } = {}) {
  const verifying = authority?.outdated?.() !== true && accessVerifying(authority, scope);
  if (verifying) requestAccessCheck(authority);
  if (now() - refusalShownAt < REFUSAL_QUIET_MS) return false;
  alert(writeRefusalMessage(authority, scope));
  refusalShownAt = now();
  return true;
}

/**
 * Before work that has to end in a saved record (an invoice sent from the
 * share sheet), ask whether the write would be allowed now. A refusal is
 * explained exactly as a refused save is, and nothing is started.
 */
export function writeAllowedNow(scope, options = {}) {
  const authority = options.authority || accessAuthority;
  if (authority.allows(scope, "write")) return true;
  alertWriteRefused({ ...options, authority, scope });
  return false;
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
