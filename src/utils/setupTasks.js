// Setup — the whole task board, as one pure module.
//
// No React, no fetch, no import.meta, so scripts/setup-tasks.test.mjs can
// import it in plain node the way scripts/npi-import.test.mjs does.
//
// Two ideas carry the design:
//
//  1. Done is DERIVED, never stored. Every doneWhen below is a pure function
//     of the physician's own records, so a checkbox can never lie: delete the
//     DEA record and that task un-completes on the next render, and existing
//     accounts need no backfill because their state computes correctly the
//     first time the page opens.
//  2. Only the things that CANNOT be derived are stored, in
//     settings.setupState: when setup started, when Tier 1 was finished, what
//     was skipped, what was declared inapplicable, and the "Not now" snooze.
//
// Vocabulary used everywhere: a record is PROTECTED when it carries an
// expiration date and a reminder channel is on, and DOCUMENTED when the file
// that proves it is linked to it. The app never says "verified": it does not
// contact boards or primary sources.
//
// Two devices racing a skip resolve last-write-wins. At the current account
// count that is acceptable; a real merge would need per-task timestamps
// compared on read, which is more machinery than the problem deserves.

import { isNonExpiring } from "./helpers.js";

export const SETUP_STATE_VERSION = 1;
const MS_PER_DAY = 86400000;

/* ─── Type matching ───────────────────────────────────────────────
 * The MD and DO license vocabularies differ ("State Medical License" vs
 * "State Medical License (DO)", "Board Certification (ABMS)" vs "(AOA)"),
 * so every rule here is a case-insensitive substring test that matches
 * both. Hardcoding the MD strings would mean a DO account never completes.
 */
export const isMedicalLicense = (l) => /medical license/i.test(l?.type || "");
export const isDea = (l) => /dea registration/i.test(l?.type || "");
export const isCsr = (l) => /controlled substance/i.test(l?.type || "");
export const isBoard = (l) => /board certification/i.test(l?.type || "");
export const isLifeSupport = (l) => /\b(bls|acls|atls|pals|nrp)\b/i.test(`${l?.type || ""} ${l?.name || ""}`);

/**
 * Licenses that owe an expiration date. Scoped to licenses on purpose: the
 * Home banner's wider missingExpiration list also walks privileges,
 * professional insurance and TB/Fit-test records, and one undated hospital
 * privilege must not make "Protected" unreachable. Those keep their own
 * banner. Records that legitimately never expire are excluded by
 * isNonExpiring (course/device certifications, and anything the physician
 * marked as non-expiring).
 */
export function dateless(data) {
  return (data?.licenses || []).filter((l) =>
    l && !l.expirationDate &&
    !isNonExpiring(l, "licenses") &&
    (isMedicalLicense(l) || isDea(l) || isCsr(l))
  );
}

/** Documents linked to a record, using the exact link CrudSection writes. */
const linkedDocs = (data, section, id) =>
  (data?.documents || []).filter((d) => d && d.linkedTo === `${section}:${id}`);

const hasDoc = (data, section, id) => linkedDocs(data, section, id).length > 0;

/* ─── Stored state ─────────────────────────────────────────────── */

export const EMPTY_SETUP_STATE = Object.freeze({
  v: SETUP_STATE_VERSION,
  startedAt: null,
  tier1DoneAt: null,
  tier2DoneAt: null,
  lastTouched: null,
  hiddenUntil: null,
  declared: {},
  tasks: {},
});

/** Anything on file (or nothing at all) read back as the full shape. */
export function normalizeSetupState(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const declared = r.declared && typeof r.declared === "object" && !Array.isArray(r.declared) ? r.declared : {};
  const tasks = r.tasks && typeof r.tasks === "object" && !Array.isArray(r.tasks) ? r.tasks : {};
  return {
    v: SETUP_STATE_VERSION,
    startedAt: r.startedAt || null,
    tier1DoneAt: r.tier1DoneAt || null,
    tier2DoneAt: r.tier2DoneAt || null,
    lastTouched: r.lastTouched || null,
    hiddenUntil: r.hiddenUntil || null,
    declared: { ...declared },
    tasks: { ...tasks },
  };
}

/* ─── The task table ───────────────────────────────────────────────
 * Row order on the page is the order of this array. The Next card ranks by
 * CARD_PRIORITY below, which is exposure order, not page order.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "4 Sep" — short enough to sit on a row, unambiguous in both date orders. */
export function shortDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const plural = (n, one, many) => (n === 1 ? one : many);

export const TASK_DEFS = [
  {
    id: "identity",
    tier: 1,
    secs: 30,
    pro: false,
    label: "About you",
    why: "Degree picks the MD or DO rule set. Primary state sets the CME clock.",
    verb: "Fill in your details",
    doneWhen: ({ s }) => !!s.name && (s.degreeType === "MD" || s.degreeType === "DO") && !!s.primaryState,
    evidenceWhen: null,
    cardLine: () => "Your degree and primary state decide which CME rules apply to you.",
    pendingDetail: ({ s }) => {
      const missing = [];
      if (!s.name) missing.push("your name");
      if (s.degreeType !== "MD" && s.degreeType !== "DO") missing.push("MD or DO");
      if (!s.primaryState) missing.push("primary state");
      return `Still needed: ${missing.join(", ")}.`;
    },
  },
  {
    id: "licenses",
    tier: 1,
    secs: 20,
    pro: false,
    label: "Your licenses",
    why: "The federal registry already has your license numbers. One lookup pulls every state it lists.",
    verb: "Import my licenses",
    doneWhen: ({ licenses }) => licenses.some(isMedicalLicense),
    evidenceWhen: null,
    cardLine: () => "No licenses on file yet. The federal registry probably already has yours.",
    pendingDetail: () => "No medical license on file yet.",
  },
  {
    id: "dates",
    tier: 1,
    secs: 10,
    pro: false,
    label: "Expiration dates",
    why: "Every reminder in the app counts down from these dates. A record without one is invisible to the warning system.",
    verb: "Add the missing dates",
    // The first clause stops an empty account reading as done.
    doneWhen: (ctx) => ctx.licenses.some(isMedicalLicense) && dateless(ctx.data).length === 0,
    evidenceWhen: null,
    blockedBy: (ctx) => (ctx.licenses.some(isMedicalLicense) ? null : "licenses"),
    // secs is per record, so the whole job is worth naming honestly.
    estimateSecs: (ctx) => 10 * Math.max(1, dateless(ctx.data).length),
    cardLine: (ctx) => {
      const n = dateless(ctx.data).length;
      if (!n) return "No licenses on file yet. The federal registry probably already has yours.";
      return `${n} ${plural(n, "license", "licenses")} on file with no expiration date. Nothing will warn you about ${plural(n, "it", "them")}.`;
    },
    pendingDetail: (ctx) => {
      const n = dateless(ctx.data).length;
      if (!ctx.licenses.some(isMedicalLicense)) return "Add a license first, then the dates land here.";
      return `${n} ${plural(n, "record", "records")} with no expiration date.`;
    },
    regressionLine: (ctx) => {
      const missing = dateless(ctx.data);
      if (missing.length === 1) {
        const l = missing[0];
        const who = l.state ? `your ${l.state} license` : (l.name || "a license");
        return `${who} lost its expiration date`;
      }
      return `${missing.length} licenses have no expiration date`;
    },
  },
  {
    id: "dea",
    tier: 1,
    secs: 45,
    pro: false,
    label: "DEA registration",
    why: "NPPES does not carry DEA. If you hold one, this is the only place the app can learn about it.",
    verb: "Add my DEA",
    // The one task that has to exist as a declared negative: no record can
    // prove the absence of a DEA registration.
    declaredNa: "noDea",
    naDetail: "Not applicable. You told us you do not hold a DEA registration.",
    doneWhen: ({ licenses }) => licenses.some((l) => isDea(l) && !!l.expirationDate),
    evidenceWhen: ({ data, licenses }) => licenses.some((l) => isDea(l) && !!l.expirationDate && hasDoc(data, "licenses", l.id)),
    cardLine: () => "No DEA registration on file. If you hold one, the app cannot warn you about it yet.",
    pendingDetail: ({ licenses }) =>
      licenses.some(isDea) ? "On file, but with no expiration date." : "Nothing on file yet.",
    regressionLine: () => "your DEA registration has no expiration date",
  },
  {
    id: "reminders",
    tier: 1,
    secs: 15,
    pro: false,
    label: "Reminders",
    why: "Nothing you enter here matters if nothing tells you before it lapses.",
    verb: "Turn on reminders",
    doneWhen: ({ s }) =>
      !!(s.notifyEmail || s.notifyBrowser || s.notifyText) && !!s.email && Number(s.reminderLeadDays) > 0,
    evidenceWhen: null,
    cardLine: () => "Reminders are off. Everything you have entered is sitting here silently.",
    pendingDetail: ({ s }) => (s.email ? "No channel is on." : "No address on file to warn."),
    regressionLine: () => "reminders are off",
  },
];

/**
 * The Next card's ranking: exposure order, not page order. Dates come first
 * because an undated record is invisible to every warning in the app;
 * identity comes last because nothing lapses because of it. Within one tier
 * an unblocked task always outranks a blocked one, and secs breaks a tie.
 */
export const CARD_PRIORITY = ["dates", "licenses", "dea", "reminders", "identity"];

/** A skipped task re-enters the Next rotation for one week, starting a week
 *  after the skip. Skipping means "not now"; a physician must not fight the
 *  same card every morning, and must not lose the item forever either. */
const REOFFER_FROM_DAYS = 7;
const REOFFER_UNTIL_DAYS = 14;

/* ─── Resolution ───────────────────────────────────────────────── */

function detailFor(def, status, stored, ctx) {
  if (status === "documented") return "Dated. Proof attached.";
  if (status === "done") return def.evidenceWhen ? "On file. No copy attached yet." : "On file.";
  if (status === "na") return def.naDetail || "Not applicable.";
  if (status === "skipped") {
    const when = shortDate(stored?.at);
    return when ? `Skipped ${when}. Still on the list.` : "Skipped. Still on the list.";
  }
  return def.pendingDetail ? def.pendingDetail(ctx) : "";
}

function resolveTask(def, ctx, state) {
  const stored = state.tasks?.[def.id] || null;
  const derivedDone = !!def.doneWhen(ctx);
  const declaredNa = def.declaredNa ? state.declared?.[def.declaredNa] === true : false;

  // Resolution order: derived first (it can never lie), then a declared
  // "does not apply", then a skip, then pending.
  let status;
  if (derivedDone) status = def.evidenceWhen && def.evidenceWhen(ctx) ? "documented" : "done";
  else if (stored?.s === "na" || declaredNa) status = "na";
  else if (stored?.s === "skipped") status = "skipped";
  else status = "pending";

  return {
    id: def.id,
    tier: def.tier,
    label: def.label,
    why: def.why,
    verb: def.verb,
    pro: !!def.pro,
    secs: def.estimateSecs ? def.estimateSecs(ctx) : def.secs,
    status,
    detail: detailFor(def, status, stored, ctx),
    blockedBy: def.blockedBy ? def.blockedBy(ctx) : null,
    hasEvidence: !!def.evidenceWhen,
    declaredNa: def.declaredNa || null,
    skippedAt: stored?.s === "skipped" ? stored.at || null : null,
    naWhy: status === "na" && stored?.s === "na" ? stored.why || "" : "",
    cardLine: def.cardLine ? def.cardLine(ctx) : def.why,
    regressionLine: def.regressionLine ? def.regressionLine(ctx) : null,
  };
}

/**
 * The denominator. A SKIPPED task stays in it: deferring must never raise
 * your score. A NA task leaves it: declaring something inapplicable is a
 * deliberate claim, and the number has to be able to reach zero.
 */
function countTier(list) {
  const na = list.filter((t) => t.status === "na").length;
  const done = list.filter((t) => t.status === "done" || t.status === "documented").length;
  const skipped = list.filter((t) => t.status === "skipped").length;
  const total = list.length - na;
  return { total, done, skipped, na, left: Math.max(0, total - done), complete: total > 0 && total === done };
}

function pickNext(tasks, state, nowMs) {
  const open = tasks.filter((t) => {
    if (t.status === "pending") return true;
    if (t.status !== "skipped" || !t.skippedAt) return false;
    const age = nowMs - new Date(t.skippedAt).getTime();
    return age >= REOFFER_FROM_DAYS * MS_PER_DAY && age < REOFFER_UNTIL_DAYS * MS_PER_DAY;
  });
  if (!open.length) return null;
  const prio = (t) => {
    const i = CARD_PRIORITY.indexOf(t.id);
    return i === -1 ? CARD_PRIORITY.length : i;
  };
  const order = tasks.map((t) => t.id);
  const sorted = [...open].sort((a, b) =>
    a.tier - b.tier ||
    (a.blockedBy ? 1 : 0) - (b.blockedBy ? 1 : 0) ||
    prio(a) - prio(b) ||
    a.secs - b.secs ||
    order.indexOf(a.id) - order.indexOf(b.id)
  );
  return sorted[0];
}

/**
 * The board. `data` is the app's record file; `isPro` gates the Pro rows.
 * Pure: the same arguments always give the same answer, so it memoizes on
 * the dependency lists Home already keeps.
 */
export function buildSetup(data, { isPro = false, now = new Date() } = {}) {
  const d = data || {};
  const s = d.settings || {};
  const state = normalizeSetupState(s.setupState);
  const nowMs = new Date(now).getTime();
  const ctx = {
    data: d,
    s,
    licenses: Array.isArray(d.licenses) ? d.licenses.filter(Boolean) : [],
    isPro,
  };

  const tasks = TASK_DEFS.filter((def) => !def.pro || isPro).map((def) => resolveTask(def, ctx, state));
  const tier1 = tasks.filter((t) => t.tier === 1);
  const tier2 = tasks.filter((t) => t.tier === 2);

  // Degree unset means the license-type vocabulary is unknown, so the board
  // offers About you and nothing else until it is answered.
  const degreeUnset = s.degreeType !== "MD" && s.degreeType !== "DO";
  const candidates = degreeUnset ? tasks.filter((t) => t.id === "identity") : tasks;

  return {
    tasks,
    tier1,
    tier2,
    byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
    counts: { tier1: countTier(tier1), tier2: countTier(tier2) },
    next: pickNext(candidates, state, nowMs),
    state,
    skipped: tasks.filter((t) => t.status === "skipped"),
    notApplicable: tasks.filter((t) => t.status === "na"),
  };
}

/* ─── Writes ───────────────────────────────────────────────────────
 * Every writer is pure and prunes on the way out. Pruning NEVER happens on
 * read: a transient empty data load must not be able to destroy a
 * physician's skip decisions.
 */

/**
 * Drop stored entries for task ids that no longer exist, and drop a stored
 * skip for a task the records now close. A skip must not outlive the fact
 * that resolved it.
 */
export function pruneSetupState(state, { knownIds, doneIds } = {}) {
  const next = normalizeSetupState(state);
  if (!knownIds && !doneIds) return next;
  const known = knownIds ? new Set(knownIds) : null;
  const done = doneIds ? new Set(doneIds) : new Set();
  const tasks = {};
  for (const [id, entry] of Object.entries(next.tasks)) {
    if (known && !known.has(id)) continue;
    if (entry?.s === "skipped" && done.has(id)) continue;
    tasks[id] = entry;
  }
  next.tasks = tasks;
  return next;
}

const write = (state, patch, prune) => pruneSetupState({ ...normalizeSetupState(state), ...patch }, prune);

/** First render for an account that has never seen the board. */
export function withStarted(state, nowIso, prune) {
  return write(state, { startedAt: nowIso }, prune);
}

/** Stamped once, which is what stops the Protected moment replaying. */
export function withTier1Done(state, nowIso, prune) {
  return write(state, { tier1DoneAt: nowIso }, prune);
}

/** "Not now" is a snooze, never a permanent dismissal. */
export function withSnooze(state, untilIso, prune) {
  return write(state, { hiddenUntil: untilIso }, prune);
}

/** Stamped whenever a task transitions to done; the card reads it. */
export function withTouched(state, nowIso, prune) {
  return write(state, { lastTouched: nowIso }, prune);
}

/**
 * Set a task to "skipped" or "na", or clear it back to pending with null.
 * Every row carries this escape, T1 through T5 included: one wrong
 * completion rule anywhere would otherwise freeze a physician at 4 of 5
 * forever, and diligence is not a mitigation.
 */
export function withTask(state, id, status, { why = "", now = new Date() } = {}, prune) {
  const next = normalizeSetupState(state);
  const tasks = { ...next.tasks };
  if (!status) delete tasks[id];
  else tasks[id] = { s: status, at: new Date(now).toISOString(), ...(why ? { why } : {}) };
  return write(next, { tasks }, prune);
}

/** A declared negative, e.g. declared.noDea for a physician who holds none. */
export function withDeclared(state, key, value, prune) {
  const next = normalizeSetupState(state);
  const declared = { ...next.declared };
  if (value) declared[key] = true;
  else delete declared[key];
  return write(next, { declared }, prune);
}

/* ─── Home card ────────────────────────────────────────────────── */

export const CARD_FORM = { NONE: "none", A: "A", B: "B", D: "D" };

/**
 * Which form the Home card takes. Form A is the bordered setup card; it can
 * NEVER return once tier1DoneAt is stamped, so an active physician who adds
 * a dateless record months later gets the one-line Form D, not a setup
 * prompt. Form B is the Protected moment, which renders once.
 */
export function homeCardForm(setup, { now = new Date() } = {}) {
  const st = setup.state;
  const complete = setup.counts.tier1.complete;
  if (!st.tier1DoneAt) {
    // A board that has never been rendered is stamped by firstRenderPatch in
    // the same pass. Until that lands, a physician who was ALREADY set up
    // would otherwise be congratulated for finishing something they never
    // started, so the moment waits for startedAt.
    if (complete) return st.startedAt ? CARD_FORM.B : CARD_FORM.NONE;
    const hidden = st.hiddenUntil && new Date(st.hiddenUntil).getTime() > new Date(now).getTime();
    return hidden ? CARD_FORM.NONE : CARD_FORM.A;
  }
  return CARD_FORM.D;
}

/**
 * The patch to write on the very first render of an account that has never
 * seen the board. An account that was already set up gets tier1DoneAt in the
 * same pass, so the Protected moment never fires for someone who was never
 * setting up. (settings.onboardingDone is deliberately not consulted: the
 * derived rule already covers every account it described, and the flag never
 * synced past this device anyway.)
 */
export function firstRenderPatch(setup, { now = new Date() } = {}) {
  if (setup.state.startedAt) return null;
  const nowIso = new Date(now).toISOString();
  const patch = { startedAt: nowIso };
  if (setup.counts.tier1.complete) patch.tier1DoneAt = nowIso;
  return patch;
}
