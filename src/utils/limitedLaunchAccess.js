import { PUBLIC_BILLING_POLICY } from "../../supabase/functions/_shared/accessPolicy.mjs";
import { BASE_KEYS, lsGetJSON, lsSetJSON } from "./storageScope.js";

// This client switch never enables checkout or changes an account entitlement.
export const LIMITED_LAUNCH_ACCESS_ENABLED = import.meta.env?.VITE_LIMITED_LAUNCH_ACCESS_ENABLED === "true";
// Separate rollout switch: existing personal invitations work while public enrollment is off.
export const PUBLIC_SELF_SERVICE_SIGNUP_ENABLED = import.meta.env?.VITE_PUBLIC_SELF_SERVICE_SIGNUP_ENABLED === "true";
export const ACCESS_REFRESH_MS = 5 * 60 * 1000;
// A save that meets an answer older than ACCESS_REFRESH_MS, or a check that
// failed, is not refused for that alone. It is kept on this device and waits
// for a fresh check (writeStatus "verify", holdForAccess). Only while the last
// ACTIVE answer is at most this old: a day covers a call shift on hospital
// Wi-Fi and a phone left in another app, and bounds how long a device keeps
// changes the server has not accepted. It authorizes nothing on the server:
// a kept change is sent only by replay, only after a fresh answer allows it,
// and the database's own write policies (credentialdo_scope_write_allowed,
// credentialdo_current_scope_write_allowed, access_intake_write, the storage
// policy) decide it at that moment. A membership that ended meanwhile is
// refused there, whatever this device kept.
export const WRITE_GRACE_MS = 24 * 60 * 60 * 1000;
// How long a save waits for the check it started. The check itself gives up
// after 9 s (limitedLaunchClient timeoutMs), so this is only a backstop.
export const ACCESS_VERIFY_TIMEOUT_MS = 12000;
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

const MANAGEABLE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

/**
 * A subscription the member can open billing for: a paid or scheduled
 * membership, or one whose payment failed (past_due, unpaid). Drives Manage
 * Billing, Cancel Subscription and the card update; never access.
 */
export const hasManageableSubscription = access => !!(access?.purchasedOfferId || access?.scheduledMembership
  // An incomplete subscription is a checkout still in progress: Resume
  // checkout handles it, and it is not a paid subscription to manage.
  || (access?.billingSubscriptionStatus && access.billingSubscriptionStatus !== "incomplete"));

/** A paid membership whose renewal payment did not go through: the card needs updating. */
export const renewalPaymentFailed = access => !!access && !access.purchasedOfferId && !access.scheduledMembership
  && ["past_due", "unpaid"].includes(access.billingSubscriptionStatus);

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
  // A paid membership that includes Practice: the bundle, or founding Credential.
  // Older servers leave it out; a present value must agree with the purchase.
  if (value.practiceIncluded !== undefined && (typeof value.practiceIncluded !== "boolean"
    || (value.practiceIncluded && !["core", "core_locum"].includes(value.purchasedOfferId))
    || (value.purchasedOfferId === "core_locum" && !value.practiceIncluded))) throw new Error("Membership information could not be verified.");
  for (const flag of ["checkoutEligible", "checkoutResumeAvailable", "invitationActivationEnabled", "bundleAvailable"]) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw new Error("Membership information could not be verified.");
  }
  if (value.checkoutResumeAvailable === true
    ? value.billingEnabled !== true || !["core", "core_locum"].includes(value.checkoutResumeOfferId)
    : value.checkoutResumeOfferId != null) throw new Error("Checkout resume information could not be verified.");
  if (value.pricePhase != null && !["founding", "earlybird", "standard"].includes(value.pricePhase)) throw new Error("Membership information could not be verified.");
  // The live subscription's status while it can still be paid or managed
  // (20260930002000); older servers leave it out. It never grants access.
  if (value.billingSubscriptionStatus != null && !MANAGEABLE_SUBSCRIPTION_STATUSES.includes(value.billingSubscriptionStatus)) {
    throw new Error("Membership information could not be verified.");
  }
  // Whether that subscription renews, and when its paid period ends
  // (20260930032000); older servers leave it out. Display only.
  if (value.billingRenewal != null && (typeof value.billingRenewal !== "object"
    || typeof value.billingRenewal.cancelAtPeriodEnd !== "boolean" || !date(value.billingRenewal.periodEnd))) {
    throw new Error("Membership information could not be verified.");
  }
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
      // A cancellation date before the first charge (20261001081000); older
      // servers leave it out.
      || (scheduled.cancelsAt != null && (!scheduled.firstChargeCanceled || !date(scheduled.cancelsAt)
        || Date.parse(scheduled.cancelsAt) >= Date.parse(scheduled.startsAt)))
      || !(scheduled.offerId === "core" ? [9900, 14900, 19900] : [24500]).includes(scheduled.annualCents)) {
      throw new Error("Scheduled membership information could not be verified.");
    }
  }
  return structuredClone(value);
}

/** The active paid membership includes Practice: the bundle, or founding Credential. */
const membershipIncludesPractice = access => access?.purchasedOfferId === "core_locum"
  || (access?.purchasedOfferId === "core" && access.practiceIncluded === true);

/**
 * An active Credential membership that Practice is not part of: bought
 * without it (not founding, not the bundle) and no lifetime Practice. Its
 * Practice records are read-only because of what was bought, not because the
 * membership lapsed, and the way to Practice is to ask support. Display only.
 */
export const credentialOnlyMembership = access => access?.accessStatus === "active" && access.purchasedOfferId === "core"
  && access.practiceIncluded !== true && access.lifetime?.practice !== true;

/** Resume permits only the server's saved offer; it never grants product access. */
export function canReviewBillingOffer(access, offerId) {
  if (!access || access.needsRefresh || access.billingEnabled !== true
    || !["core", "core_locum"].includes(offerId) || !["active", "pending"].includes(access.accessStatus)
    || access.purchasedOfferId || access.lifetime?.credential || access.lifetime?.practice
    || access.scheduledMembership) return false;
  // While this account's offer is founding, $99 Credential already includes Practice.
  if (offerId === "core_locum" && access.bundleAvailable === false) return false;
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
    if (!result.lifetime.practice && !membershipIncludesPractice(result)) result.capabilities.practice.write = false;
  }
  if (result.freeBeta?.state === "active") {
    const remaining = Date.parse(result.freeBeta.endsAt) - serverNow;
    if (remaining > 0) result.nextCheckInMs = Math.min(result.nextCheckInMs, remaining);
    else {
      result.freeBeta.state = "expired";
      if (!result.lifetime.credential && !result.purchasedOfferId) result.capabilities.credential.write = false;
      if (!result.lifetime.practice && !membershipIncludesPractice(result)
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

// What a write may do now: go ahead, be refused (with a reason code), or be
// kept on this device while a fresh membership check decides it.
const ALLOW = Object.freeze({ status: "allow", reason: null });
const refuse = reason => ({ status: "refuse", reason });
const pending = reason => ({ status: "verify", reason });
/** One answer for several needs: any refusal refuses, then any wait waits. */
export function combineWriteStatus(list) {
  const all = [...(list || [])];
  return all.find(item => item?.status === "refuse") || all.find(item => item?.status === "verify") || ALLOW;
}

/** In-memory write guard shared by UI and persistence; the server still enforces access. */
export function createAccessAuthority({ enabled = LIMITED_LAUNCH_ACCESS_ENABLED, now = () => globalThis.performance?.now() ?? Date.now(), currentAccount, memory = deviceAnswers,
  wallClock = () => Date.now(), timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) },
  graceMs = WRITE_GRACE_MS, verifyTimeoutMs = ACCESS_VERIFY_TIMEOUT_MS } = {}) {
  let accountId = null, snapshot = null, receivedAt = 0, refreshFailed = false, records = null, previewSource = null;
  // The answer remembered for this account, why writes are suspended, and
  // how to start a membership check at once (set by the access hook).
  let remembered = null, outdated = false, recheck = null;
  // When the last answer arrived by the wall clock too: the monotonic clock
  // can stand still while a phone sleeps, so the grace counts whichever
  // clock says more time has passed. The check writes are waiting on, and
  // who hears about a new answer.
  let receivedWall = 0, verifying = null, halted = false;
  const answerListeners = new Set();
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
      remembered = null; receivedWall = 0; verifying = null; halted = false;
      if (accountId) { try { remembered = memory?.read(accountId) || null; } catch { remembered = null; } }
    },
    registerRecords(expectedAccountId, value) {
      if (accountId === expectedAccountId && current() === expectedAccountId) records = value;
    },
    previousRecord(key, id, expectedAccountId = accountId) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return null;
      return records?.[key]?.find(record => record.id === id) || null;
    },
    /**
     * A failed check refuses writes until a fresh answer. `outdated`: this
     * build cannot read the answer. `checkFailed`: only the access hook's
     * check failed (a bad connection), so a save inside the grace is kept on
     * the device while a new check decides it (writeStatus "verify"). Without
     * it this is a hard stop (an identity that could not be verified, a data
     * deletion not confirmed): nothing is kept until a fresh answer.
     */
    suspendWrites({ outdated: stale = false, checkFailed = false } = {}) {
      refreshFailed = true; outdated = outdated || stale === true;
      if (checkFailed !== true) halted = true;
    },
    /** True after a check this build could not read (an older app version); a reload is the fix. */
    outdated() { return outdated; },
    accept(expectedAccountId, value) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return false;
      snapshot = validateAccessSnapshot(value); receivedAt = now(); receivedWall = wallClock(); refreshFailed = false; outdated = false; halted = false;
      remember(accessAt(snapshot, receivedAt, receivedAt).entitled);
      for (const listener of [...answerListeners]) { try { listener(expectedAccountId); } catch { /* a listener never stops an answer */ } }
      return true;
    },
    /** Called with the account id each time a fresh answer is taken; returns the unsubscribe. */
    onAnswer(fn) {
      if (typeof fn !== "function") return () => {};
      answerListeners.add(fn);
      return () => { answerListeners.delete(fn); };
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
    state(expectedAccountId = accountId, at = now()) {
      if (!expectedAccountId || current() !== expectedAccountId || accountId !== expectedAccountId) return null;
      const value = accessAt(snapshot, receivedAt, at);
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
    /** The scopes allowsMutation asks about for this change. */
    mutationScopes(key, record, previous) {
      const existing = previous || records?.[key]?.find(item => item.id === record?.id);
      if (key === "documents" && !existing && !record?.linkedTo) return [...scopes];
      return [...new Set([scopeForCollection(key, record), ...(existing ? [scopeForCollection(key, existing)] : [])])];
    },
    /**
     * What a write to `scope` may do now. "allow" is exactly allows(scope,
     * "write"). A refusal carries why: "read_only" (the server's answer, a
     * trial or beta that ran out included, says no; with none this session
     * yet, the answer this device remembered says no), "outdated" (this
     * build cannot read the answer), "no_answer" (none this session yet),
     * "not_connected" (no check can run), "suspended" (writes were stopped
     * outright, suspendWrites without checkFailed) or "grace_expired" (no
     * active answer for WRITE_GRACE_MS). "verify": the answer is old or the last check
     * failed, but the last one this session allowed this scope and is inside
     * the grace. The write is kept on this device while a check decides it.
     *
     * `at` ({ now, wall }, from verify) evaluates at that moment, so every
     * write waiting on one check is decided alike. `settled`: the check this
     * write waited for is over. A write still unconfirmed then (the check
     * failed, timed out, or answered in a form this build cannot read) stays
     * "verify", which means: keep it on this device and queue it for replay.
     */
    writeStatus(scope, expectedAccountId = accountId, { at = null, settled = false, awaitAnswer = false } = {}) {
      if (!enabled) return ALLOW;
      if (!scopes.includes(scope)) return refuse("read_only");
      const moment = at?.now ?? now();
      const value = this.state(expectedAccountId, moment);
      if (value?.capabilities?.[scope]?.write === true) return ALLOW;
      if (!value) {
        // `awaitAnswer` (settingsStatus, mutationStatus, dataChangeStatus,
        // the record writes in lib/supabase.js): the page load's first
        // answer is not here yet, a check that will bring it can run, and
        // the answer this device remembered does not already deny the scope.
        // The member app opens from the loaded profile before that answer,
        // and the Setup board stamps the profile at once: refusing that save
        // alerted "Reconnecting" on a load where nobody typed anything, and
        // a record added, edited, deleted or starred in that window was
        // refused the same way. It is kept on this device instead, as an old
        // answer's is, and decided by the answer when it comes. It
        // authorizes nothing: it is sent only once an answer allows it.
        // Settled after Clerk stopped reporting the write's account (a
        // session that ended, which unmounts the access hook without a
        // reset, another account signed in before the reset, a resume with
        // Clerk not back yet) while this authority still holds it: no answer
        // refused anything. "account_changed" only stops the send; the
        // write's identity guard decides it, and a copy kept for that
        // account stays for its next sign-in (lib/supabase.js
        // authorizeOwner, settleHeldRound). Before the first answer only:
        // one taken after it keeps its own handling.
        if (settled && snapshot === null && expectedAccountId && accountId === expectedAccountId
          && current() !== expectedAccountId) return refuse("account_changed");
        const ours = accountId === expectedAccountId && current() === expectedAccountId;
        if (awaitAnswer && snapshot === null && !outdated && !halted && recheck
          && ours && remembered?.[scope] !== false) return pending("no_answer");
        if (outdated) return refuse("outdated");
        // The answer this device remembered already denies the scope (a
        // membership that ended): refused as read-only, which is what the
        // screens already show, never as a momentary "no answer yet".
        if (ours && remembered?.[scope] === false) return refuse("read_only");
        return refuse(recheck ? "no_answer" : "not_connected");
      }
      if (value.needsRefresh !== true || value.entitled?.[scope] !== true) return refuse("read_only");
      if (halted) return refuse("suspended");
      const elapsed = Math.max(moment - receivedAt, (at?.wall ?? wallClock()) - receivedWall);
      if (!(elapsed <= graceMs)) return refuse("grace_expired");
      // Why it is still unconfirmed, for the operator's report.
      if (settled) return pending(outdated ? "outdated" : refreshFailed ? "check_failed" : "check_timeout");
      if (outdated) return refuse("outdated");
      if (!recheck) return refuse("not_connected");
      return pending(refreshFailed ? "check_failed" : "stale");
    },
    /** combineWriteStatus over writeStatus for each scope. */
    statusFor(scopeList, expectedAccountId = accountId, options = {}) {
      return combineWriteStatus([...new Set(scopeList || [])].map(scope => this.writeStatus(scope, expectedAccountId, options)));
    },
    /**
     * allowsMutation as a writeStatus. A change made before this page load's
     * first answer waits for it, as a settings save does (awaitAnswer).
     */
    mutationStatus(key, record, previous, expectedAccountId = accountId, options = {}) {
      if (!enabled) return ALLOW;
      return this.statusFor(this.mutationScopes(key, record, previous), expectedAccountId, { ...options, awaitAnswer: true });
    },
    /**
     * allowsSettingsChange as a writeStatus: preferences never need a
     * membership. A save made before this page load's first answer waits for
     * it ("verify", reason "no_answer"; writeStatus awaitAnswer).
     */
    settingsStatus(updates, expectedAccountId = accountId, options = {}) {
      if (!enabled) return ALLOW;
      return this.statusFor(settingsScopes(updates), expectedAccountId, { ...options, awaitAnswer: true });
    },
    /**
     * Ask the server now, for writes waiting on an answer. Every write that
     * asks while a check is under way shares it (and the access hook shares
     * its own check in flight). Resolves with the moment it ended, { now,
     * wall }, once the check has answered or failed, or after
     * verifyTimeoutMs; never rejects. The writes then read writeStatus with
     * that moment and `settled`.
     */
    verify() {
      if (verifying) return verifying;
      const round = new Promise(resolve => {
        let started = null;
        try { started = recheck ? recheck() : null; } catch { started = null; }
        if (!started || typeof started.then !== "function") { resolve(); return; }
        let timer = null, done = false;
        const finish = () => { if (done) return; done = true; if (timer !== null) { try { timers.clear(timer); } catch { /* gone */ } } resolve(); };
        try { timer = timers.set(finish, verifyTimeoutMs); } catch { timer = null; }
        started.then(finish, finish);
      }).then(() => ({ now: now(), wall: wallClock() }));
      verifying = round;
      round.then(() => { if (verifying === round) verifying = null; });
      return round;
    },
  };
}

// Theme and notification preferences remain usable while saved records are read-only.
const READ_ONLY_PREFERENCES = new Set(["theme", "fontSize", "notifyBrowser", "notifyEmail", "notifyText", "notifyFreqDays", "alertsFingerprint", "lastNotified", "snoozedUntil"]);
const settingsScopes = updates => (Object.keys(updates || {}).every(key => READ_ONLY_PREFERENCES.has(key)) ? [] : ["credential"]);

export const accessAuthority = createAccessAuthority({ currentAccount: () => globalThis.window?.Clerk?.user?.id || null });

export function membershipWriteError(reason = null) {
  const error = new Error("This record is read-only. Your saved records and exports are still available.");
  error.code = "membership_read_only";
  // Why (writeStatus): a record the server answered read-only, or a
  // membership not confirmed for longer than the grace.
  if (reason) error.reason = reason;
  return error;
}

// A write refused while membership is being re-checked is momentary, and says so.
export const RECONNECTING_MESSAGE = "Reconnecting, try again in a moment.";
// With no check able to run (offline, or an account that never finished
// loading), "try again in a moment" cannot come true. This is what is true.
export const NOT_CONNECTED_MESSAGE = "Changes can't be saved until you reconnect.";
// A build that cannot read the server's answer never recovers on its own.
export const OUTDATED_MESSAGE = "This version of the app is out of date. Reload to continue.";
// No active answer for longer than WRITE_GRACE_MS: nothing new is kept on the
// device until one arrives.
export const GRACE_EXPIRED_MESSAGE = "Your membership has not been confirmed for over a day, so this change was not saved. Check your connection and try again.";
// A change kept on this device while the check ran, which then answered that
// the membership no longer allows it: the change is taken back.
export const READ_ONLY_AFTER_CHECK_MESSAGE = "Your membership no longer allows changes here, so your last change was not kept. Your saved records and exports are still available.";

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
  if (authority?.enabled && typeof authority.statusFor === "function"
    && authority.statusFor(scope == null ? scopes : [scope].flat()).reason === "grace_expired") return GRACE_EXPIRED_MESSAGE;
  return authority.canCheck?.() === false ? NOT_CONNECTED_MESSAGE : RECONNECTING_MESSAGE;
}

/** Start a membership check at once (the hook's own, coalesced with one in flight). */
export function requestAccessCheck(authority = accessAuthority) {
  return authority?.requestCheck?.() === true;
}

// ─── What the operator sees ─────────────────────────────────
// Every refused save and every save kept on the device for want of an answer
// is reported to client_errors (the app passes errorReport's reportError):
// the event, a reason code and the section (a collection name such as
// "invoices"), never a record, a value or an id. Refusals were alerted on the
// device only, so the owner never saw the save his invoice lost. Once per
// session per event, reason and section, as the membership-check failures
// are, so an import of a hundred refused records sends one row.
let writeAccessReporter = null;
const writeAccessReported = new Set();
let writeAccessSession = 0;
const SECTION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Refusals that can be the page being left rather than a lost save. A reload
// or a navigation ends the account load still in flight (the reconcile load
// that runs once the membership answer opens writes), the load's catch stops
// writes (suspendWrites, AppContext), and the Setup board's pagehide flush
// (useSetupState) then meets that stop: "Save refused (suspended, settings)"
// for a member who only left. The stop's own report is dropped on a page
// being left (reportUnlessLeaving, OPS-008); this refusal is dropped the same
// way. A stop on a page that stays is still reported, a moment later.
const REPORTED_UNLESS_LEAVING = new Set(["suspended"]);
/**
 * Where refused and kept saves are reported: fn(message, extra, options). A
 * new reporter starts a new session's once-each. `options` is given for a
 * refusal the page being left can cause: { unlessLeaving: true, onDropped },
 * for errorReport's reportUnlessLeaving; a dropped report is not counted as sent.
 */
export function setWriteAccessReporter(fn) {
  writeAccessReporter = typeof fn === "function" ? fn : null;
  writeAccessReported.clear();
  writeAccessSession += 1;
}
export function reportWriteAccess(event, reason, section = null) {
  const code = typeof reason === "string" && /^[a-z_]{1,40}$/.test(reason) ? reason : "unknown";
  const where = typeof section === "string" && SECTION.test(section) ? section : null;
  const key = `${event}|${code}|${where ?? ""}`;
  if (writeAccessReported.has(key)) return false;
  writeAccessReported.add(key);
  const label = event === "write_refused" ? "Save refused" : "Save kept on device awaiting membership check";
  const session = writeAccessSession;
  const options = event === "write_refused" && REPORTED_UNLESS_LEAVING.has(code)
    ? { unlessLeaving: true, onDropped: () => { if (session === writeAccessSession) writeAccessReported.delete(key); } }
    : undefined;
  try { writeAccessReporter?.(`${label} (${code}${where ? `, ${where}` : ""})`, { event, reason: code, section: where }, options); } catch { /* reporting never blocks a save */ }
  return true;
}

/** Why a save for `scope` (one, a list, or any) is refused, as writeStatus says. */
export function writeRefusalReason(authority = accessAuthority, scope = null) {
  if (!authority?.enabled) return "unknown";
  if (authority.outdated?.() === true) return "outdated";
  if (typeof authority.statusFor !== "function") return accessVerifying(authority, scope) ? "verifying" : "read_only";
  const result = authority.statusFor(scope == null ? scopes : [scope].flat());
  // Refused by the caller's own check while writeStatus would keep it: a
  // momentary refusal, like any made while the check runs.
  return result.status === "refuse" ? result.reason : "verifying";
}

// Once per burst: an import of many records refused while reconnecting says
// so once, not once per record. Measured from when the message was closed.
// "Try again in a moment" is made true by asking for a fresh answer now,
// whatever the retry schedule had reached. Every refusal is reported
// (reportWriteAccess), `section` naming the collection.
const REFUSAL_QUIET_MS = 3000;
let refusalShownAt = -Infinity;
const refusalHolds = new Set();
export function alertWriteRefused({ authority = accessAuthority, scope = null, section = null, alert = message => globalThis.window?.alert?.(message), now = () => Date.now() } = {}) {
  reportWriteAccess("write_refused", writeRefusalReason(authority, scope), section);
  const verifying = authority?.outdated?.() !== true && accessVerifying(authority, scope);
  if (verifying) requestAccessCheck(authority);
  if (refusalHolds.size) {
    // Held (holdWriteRefusalAlerts): said later by whoever holds it, or not at all.
    // Written down for this account too (hold.keep): iOS can discard the
    // page while Mail is in front, before it is said (review of 5cb89c90).
    const message = writeRefusalMessage(authority, scope);
    let accountId = null;
    try { accountId = globalThis.window?.Clerk?.user?.id || null; } catch { accountId = null; }
    for (const held of refusalHolds) held.keep({ message, alert, now, accountId });
    return false;
  }
  if (now() - refusalShownAt < REFUSAL_QUIET_MS) return false;
  alert(writeRefusalMessage(authority, scope));
  refusalShownAt = now();
  return true;
}

/**
 * A refusal's alert held back instead of shown inside the current task: the
 * share sheet's hand-off (utils/shareHandoff.js) writes its share log as
 * navigator.share is called, and a window.alert in that same task asked iOS
 * for two presentations at once, and said "can't save" for a send he might
 * then cancel (link audit, 2026-10-01). The refusal is still reported and a
 * check still asked for at once; only the alert waits. stop() ends the
 * catching; show() says the first held message (once per burst, as any
 * refusal); drop() forgets them, for a send that did not happen.
 *
 * Catching ends with stop(), but the hold stays open until show() or drop():
 * a save caught while catching that the membership check refuses later
 * (holdForAccess, an answer that was only old) brings its "not kept" alert
 * here too, while the hold is open, instead of over the share sheet
 * (review of 27a0d491). Once shown, a later one alerts as usual: he is back
 * in front. Once dropped, it is never said: the send did not happen.
 */
export function holdWriteRefusalAlerts() {
  const held = [];
  let state = "open";
  let awaiting = 0;
  const id = `${Date.now().toString(36)}-${++heldRefusalSeq}`;
  const hold = {
    keep(entry) {
      if (state !== "open" || held.some(one => one.message === entry.message)) return;
      held.push(entry);
      // Written down as well: the page may never come back to say it. First
      // only a save the check took back (review of 9484782c); a save refused
      // at once, on a launch with no answer yet, was lost the same way with
      // the page (review of 5cb89c90). The first one is what show() says.
      if (held.length === 1 || entry.always) rememberHeldRefusal(id, entry.message, entry.accountId ?? null);
    },
    // A save caught here that waits for the membership check (holdForAccess).
    track(done) {
      awaiting++;
      Promise.resolve(done).finally(() => { awaiting--; }).catch(() => {});
    },
    get state() { return state; },
  };
  refusalHolds.add(hold);
  liveHeldRefusals.add(id);
  const releasePage = markHeldRefusalOpen(id);
  const stop = () => { refusalHolds.delete(hold); };
  const close = (to) => { stop(); state = to; held.length = 0; liveHeldRefusals.delete(id); forgetHeldRefusal(id); releasePage(); };
  return {
    hold,
    stop,
    get pending() { return held.length > 0; },
    // Saves caught here still waiting for the check's answer.
    get awaiting() { return awaiting; },
    show() {
      const first = held[0];
      close("shown");
      if (!first) return false;
      // A save the check took back is always said, as settleHeldRound does.
      if (!first.always && first.now() - refusalShownAt < REFUSAL_QUIET_MS) return false;
      try { first.alert(first.message); } catch { /* no window */ }
      refusalShownAt = first.now();
      return true;
    },
    drop() { close("dropped"); },
  };
}

// A held "not kept" alert for a save the check took back (holdWriteRefusalAlerts
// `always`), written to the device until it is said or dropped. iOS can
// discard the installed app while Mail is in front, and the alert held in
// memory went with it: Send history was missing the share he was told was
// sent, and he was never told why (review of 9484782c). The next load of the
// same account says it (takeHeldRefusalNotice). Not kept past a day.
const HELD_REFUSAL_KEY = "credentialdomd-held-refusal";
const HELD_REFUSAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const HELD_REFUSAL_RELAUNCH_PREFIX = "Before the app closed: ";
let heldRefusalSeq = 0;
const liveHeldRefusals = new Set();
function heldRefusalStore() {
  try { return globalThis.localStorage || null; } catch { return null; }
}
function readHeldRefusals(store) {
  try {
    const list = JSON.parse(store.getItem(HELD_REFUSAL_KEY) || "[]");
    return Array.isArray(list) ? list.filter(one => one && typeof one.message === "string") : [];
  } catch { return []; }
}
function writeHeldRefusals(store, list) {
  try {
    if (list.length) store.setItem(HELD_REFUSAL_KEY, JSON.stringify(list));
    else store.removeItem(HELD_REFUSAL_KEY);
  } catch { /* storage full or blocked: the in-memory hold still says it */ }
}
function rememberHeldRefusal(id, message, accountId) {
  const store = heldRefusalStore();
  if (!store) return;
  const list = readHeldRefusals(store).filter(one => one.id !== id);
  list.push({ id, message, accountId, at: Date.now() });
  writeHeldRefusals(store, list.slice(-5));
}
function forgetHeldRefusal(id) {
  const store = heldRefusalStore();
  if (!store) return;
  const list = readHeldRefusals(store);
  if (list.some(one => one.id === id)) writeHeldRefusals(store, list.filter(one => one.id !== id));
}
// Holds still open on any page. localStorage is shared by every tab of the
// app, so a second desktop tab took a live tab's held alert, said "Before the
// app closed:" though nothing closed, and the live tab said it again (review
// of 5cb89c90). An open hold keeps a Web Lock under its id (released when it
// closes, or with the page when it is closed or discarded); with no Web Locks,
// the page answers a BroadcastChannel ping for it.
const HELD_REFUSAL_LOCK = "credentialdomd-held-refusal:";
const HELD_REFUSAL_CHANNEL = "credentialdomd-held-refusal";
const webLocks = () => { try { const l = globalThis.navigator?.locks; return l && typeof l.request === "function" ? l : null; } catch { return null; } };
let heldRefusalAnswers = null;
function markHeldRefusalOpen(id) {
  const locks = webLocks();
  if (locks) {
    let release = () => {};
    const until = new Promise(resolve => { release = resolve; });
    try { Promise.resolve(locks.request(HELD_REFUSAL_LOCK + id, () => until)).catch(() => {}); } catch { /* told by the ping below */ }
    return () => release();
  }
  if (!heldRefusalAnswers && typeof globalThis.BroadcastChannel === "function") {
    try {
      heldRefusalAnswers = new globalThis.BroadcastChannel(HELD_REFUSAL_CHANNEL);
      heldRefusalAnswers.onmessage = (event) => {
        const ask = event?.data?.ask;
        if (Array.isArray(ask)) {
          const open = ask.filter(one => liveHeldRefusals.has(one));
          if (open.length) { try { heldRefusalAnswers.postMessage({ open }); } catch { /* closed */ } }
        }
      };
      heldRefusalAnswers.unref?.();
    } catch { heldRefusalAnswers = null; }
  }
  return () => {};
}
// Of `ids`, the ones a hold on another page still has open.
async function heldRefusalsOpenElsewhere(ids, waitMs) {
  const locks = webLocks();
  if (locks && typeof locks.query === "function") {
    try {
      const state = await locks.query();
      const names = new Set([...(state?.held || []), ...(state?.pending || [])].map(one => one?.name));
      return new Set(ids.filter(id => names.has(HELD_REFUSAL_LOCK + id)));
    } catch { /* the ping below */ }
  }
  if (typeof globalThis.BroadcastChannel !== "function") return new Set();
  return new Promise((resolve) => {
    const open = new Set();
    let channel = null, timer = null;
    const done = () => { clearTimeout(timer); try { channel?.close(); } catch { /* closed */ } resolve(open); };
    try {
      channel = new globalThis.BroadcastChannel(HELD_REFUSAL_CHANNEL);
      channel.onmessage = (event) => { for (const id of event?.data?.open || []) if (ids.includes(id)) open.add(id); };
      channel.postMessage({ ask: ids });
    } catch { done(); return; }
    timer = setTimeout(done, waitMs);
  });
}

/**
 * The "not kept" alert a page held for this account and never said (it was
 * discarded or reloaded first), as the words to say now, or null (a promise).
 * Taken once: it is removed as it is read. Holds still open, on this page or
 * another tab, are left to say their own.
 */
export async function takeHeldRefusalNotice(accountId, now = Date.now(), { waitMs = 250 } = {}) {
  const store = heldRefusalStore();
  if (!store || !accountId) return null;
  const ours = one => !liveHeldRefusals.has(one.id) && (one.accountId == null || one.accountId === accountId);
  const asked = readHeldRefusals(store).filter(ours).map(one => one.id);
  if (!asked.length) return null;
  const elsewhere = await heldRefusalsOpenElsewhere(asked, waitMs);
  // Read again: another tab may have taken one meanwhile.
  const list = readHeldRefusals(store);
  const mine = list.filter(one => ours(one) && asked.includes(one.id) && !elsewhere.has(one.id));
  if (!mine.length) return null;
  writeHeldRefusals(store, list.filter(one => !mine.includes(one)));
  const fresh = mine.find(one => Number.isFinite(one.at) && now - one.at >= 0 && now - one.at < HELD_REFUSAL_MAX_AGE_MS);
  return fresh ? HELD_REFUSAL_RELAUNCH_PREFIX + fresh.message : null;
}

/**
 * Would a save needing `scope` (one or a list) be kept? Resolves true when it
 * is allowed now, false when it is refused now. An answer that is only old,
 * or a failed check (writeStatus "verify"), is settled first: this waits for
 * the check (authority.verify, shared with any in flight) and reads the
 * answer it left, as the save's own round would (holdForAccess). Allowed,
 * true. Still unconfirmed because the check failed or timed out, true: the
 * save will be kept on this device and queued. Refused (read-only, the grace
 * ran out), false. Before the page load's first answer, the check that
 * brings it is waited for the same way; when it brings none, false. Never
 * alerts and never rejects.
 */
export async function settleWriteAccess(scope, authority = accessAuthority) {
  if (!authority?.enabled) return true;
  const needed = [...new Set([scope].flat().filter(Boolean))];
  if (!needed.length) return true;
  if (typeof authority.statusFor !== "function") return needed.every(name => authority.allows(name, "write"));
  // Before the page load's first answer too: the save it guards would wait
  // for that answer (awaitAnswer), so this waits for it as well. Work that
  // leaves the app never starts on no answer at all: when the check brings
  // none, false, as before.
  const now = authority.statusFor(needed, undefined, { awaitAnswer: true });
  if (now.status !== "verify") return now.status === "allow";
  let at = null;
  try { at = await authority.verify(); } catch { at = null; }
  const settled = authority.statusFor(needed, undefined, { at, settled: true, awaitAnswer: true });
  return settled.status !== "refuse" && settled.reason !== "no_answer";
}

/**
 * Before work outside the app that cannot be taken back and has to end in a
 * saved record (an invoice sent through the share sheet or copied to be
 * pasted into an email): the work starts only once the save is known to be
 * kept. An answer that is only old is not taken on trust, because the check
 * could answer read-only after the invoice had gone out, and its record
 * would then be refused: settleWriteAccess waits for the check first. A
 * refusal is explained exactly as a refused save is, and nothing is started.
 * prepareWriteCheck, when the invoice preview opens, has usually brought the
 * answer back before the tap, so the share sheet opens at once.
 */
export async function confirmWriteAllowed(scope, options = {}) {
  const authority = options.authority || accessAuthority;
  if (authority.allows(scope, "write")) return true;
  if (await settleWriteAccess(scope, authority)) return true;
  alertWriteRefused({ ...options, authority, scope });
  return false;
}

/**
 * The save option for the record of work that already left the app once
 * confirmWriteAllowed let it go (an invoice sent, and the entries it billed):
 * AppContext addItem/editItem keep it even when the membership check it then
 * waits for answers read-only (holdForAccess `keep`).
 */
export const SENT_WORK = Object.freeze({ keepOnRefusal: true });

/**
 * Start now the check confirmWriteAllowed would wait for (the answer is only
 * old, or the last check failed), so its answer is likely back before the
 * tap that needs it. True when one was started or joined.
 */
export function prepareWriteCheck(scope, authority = accessAuthority) {
  if (!authority?.enabled || typeof authority.statusFor !== "function" || typeof authority.verify !== "function") return false;
  if (authority.statusFor([scope].flat(), undefined, { awaitAnswer: true }).status !== "verify") return false;
  void authority.verify();
  return true;
}

// ─── Saves kept while membership is re-checked ───────────────
// A save that meets an old answer, or a failed check, inside the grace
// (writeStatus "verify") is applied on this device at once, as an allowed one
// is, so a form closes and a timer stops the way it always did. The caller
// hands over how to take it back. Every save waiting at the same time shares
// one check (authority.verify); when it ends each is decided with the same
// moment, as its cloud write is (lib/supabase.js):
//   allowed    nothing more here; its cloud write goes on by itself;
//   unconfirmed (the check failed or timed out) it stays on this device, its
//              cloud write is queued for replay (the "saved on this device,
//              will sync" notice), and that is reported;
//   refused    (the server answered read-only, or the grace ran out) it is
//              taken back, newest first, the member told once and each
//              refusal reported (one nobody typed, `quiet`, neither). Except with `keep`: the change records work
//              already done outside the app (an invoice that went out), which
//              taking it back would not undo, only hide (its entries would
//              show unbilled and could be billed again). It stays on this
//              device, its cloud write is queued marked refused
//              (lib/supabase.js), which the page's notice says, and the
//              refusal is reported.
const heldRounds = new WeakMap();
export function holdForAccess({ scopes: needed = scopes, accountId = null, section = null, undo = null, quiet = false, keep = false, awaitAnswer = false } = {}, authority = accessAuthority, { alert = message => globalThis.window?.alert?.(message) } = {}) {
  let round = heldRounds.get(authority);
  if (!round) {
    round = { entries: [] };
    heldRounds.set(authority, round);
    const settle = at => {
      if (heldRounds.get(authority) === round) heldRounds.delete(authority);
      settleHeldRound(round.entries, at, authority, alert);
    };
    round.done = authority.verify().then(settle, () => settle(null));
  }
  // Saved while a refusal's alert is held (a share log written as the share
  // sheet is asked for): what the check later says is said by that hold.
  const holds = [...refusalHolds];
  for (const hold of holds) hold.track?.(round.done);
  round.entries.push({ needed: [...new Set(needed)], accountId, section, undo, quiet: quiet === true, keep: keep === true, awaitAnswer: awaitAnswer === true, holds });
  return round.done;
}

function settleHeldRound(entries, at, authority, alert) {
  const refused = [];
  for (const entry of entries) {
    // Signed out, or another account, meanwhile: its own writes stop on the
    // identity guards, and nothing is said to whoever is here now.
    if (entry.accountId && authority.serves?.(entry.accountId) === false) continue;
    // A settings save decided as one (settingsStatus): still no answer at all
    // keeps it, for the answer that comes later.
    const result = authority.statusFor(entry.needed, entry.accountId || undefined, { at, settled: true, awaitAnswer: entry.awaitAnswer });
    // Settled after Clerk stopped reporting the account (writeStatus
    // "account_changed"): the same, though the authority was not reset yet.
    // Not an answer: nothing is taken back, said or reported, and the
    // write's queued copy stays for that account.
    if (result.status === "allow" || result.reason === "account_changed") continue;
    if (result.status === "verify") {
      // A stamp nobody typed, kept because the page load's first answer has
      // not come (no connection yet): nothing was lost and nothing to report.
      if (!(entry.quiet && result.reason === "no_answer")) reportWriteAccess("write_queued_for_access", result.reason, entry.section);
      continue;
    }
    refused.push({ entry, result });
  }
  if (!refused.length) return;
  for (const { entry } of [...refused].reverse()) {
    if (entry.keep) continue;
    try { entry.undo?.(); } catch { /* one undo never stops the others */ }
  }
  // A change nobody typed (a "seen" stamp, the Setup board's own stamps:
  // AppContext updateSettings `quiet`) is neither reported nor alerted, as
  // when it is refused at once: nobody made it, so nothing was refused.
  for (const { entry, result } of refused) if (!entry.quiet) reportWriteAccess("write_refused", result.reason, entry.section);
  // Only what someone typed and was taken back is announced: a "seen" stamp
  // is not, and a kept record of work done is told by the notice instead.
  const said = refused.filter(({ entry }) => !entry.quiet && !entry.keep);
  if (!said.length) return;
  const messageFor = list => {
    const reasons = list.map(({ result }) => result.reason);
    return reasons.includes("read_only") ? READ_ONLY_AFTER_CHECK_MESSAGE
      : reasons.includes("grace_expired") ? GRACE_EXPIRED_MESSAGE : writeRefusalMessage(authority);
  };
  // One saved while a share sheet's hand-off held refusals: still open, its
  // alert waits there (never over the sheet); dropped, the send did not
  // happen and it is not said; shown, he is back in front and it is said now.
  const now = () => Date.now();
  const loose = [];
  for (const one of said) {
    const holds = one.entry.holds || [];
    if (!holds.length || holds.some(hold => hold.state === "shown")) { loose.push(one); continue; }
    const open = holds.filter(hold => hold.state === "open");
    for (const hold of open) hold.keep({ message: messageFor([one]), alert, now, always: true, accountId: one.entry.accountId });
  }
  if (!loose.length) return;
  try { alert(messageFor(loose)); } catch { /* no window */ }
}

// A backup restore or direct collection replacement is checked as one operation.
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

/**
 * allowsDataChange as a writeStatus, with the scopes it needs (for
 * holdForAccess) and the first section it changes (for the report). "allow"
 * exactly when allowsDataChange is true.
 */
export function dataChangeStatus(previous, next, authority = accessAuthority) {
  const needed = new Set(), sections = new Set();
  let section = null, changedSettings = null;
  const touch = (key, list) => { section ??= key; sections.add(key); for (const scope of list) needed.add(scope); };
  for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])) {
    if (sameValue(previous?.[key], next?.[key])) continue;
    if (key === "settings") {
      const changed = [...new Set([...Object.keys(previous?.settings || {}), ...Object.keys(next?.settings || {})])].filter(name => !sameValue(next?.settings?.[name], previous?.settings?.[name]));
      changedSettings = Object.fromEntries(changed.map(name => [name, true]));
      touch(key, settingsScopes(changedSettings));
      continue;
    }
    if (!Array.isArray(previous?.[key]) && !Array.isArray(next?.[key])) { touch(key, ["credential"]); continue; }
    const before = new Map((previous?.[key] || []).map(item => [item.id, item]));
    const after = new Map((next?.[key] || []).map(item => [item.id, item]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (sameValue(before.get(id), after.get(id))) continue;
      touch(key, authority.mutationScopes(key, after.get(id) || before.get(id), before.get(id)));
    }
  }
  // A change to the profile settings alone is decided as a settings save
  // (settingsStatus). Every change waits for the page load's first answer
  // (awaitAnswer): a record added, edited, deleted or starred before it is
  // kept on this device and decided by it, as a settings save is.
  const onlySettings = sections.size === 1 && changedSettings !== null;
  const result = !authority.enabled ? ALLOW
    : onlySettings && typeof authority.settingsStatus === "function" ? authority.settingsStatus(changedSettings)
      : authority.statusFor([...needed], undefined, { awaitAnswer: true });
  return { ...result, scopes: [...needed], section, awaitAnswer: true };
}
export function assertRecordWrite(key, record, previous) {
  if (!accessAuthority.allowsMutation(key, record, previous)) throw membershipWriteError();
}
