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
import { STATE_NAMES } from "../constants/states.js";
import { CV_FILENAME_RE } from "./cvImport.js";

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
 * Licenses a date is expected on at all. This is the denominator behind
 * "3 of your 4 licenses have no expiration date", so it has to be the same
 * set dateless() filters, minus the date test.
 */
export function datable(data) {
  return (data?.licenses || []).filter((l) =>
    l && !isNonExpiring(l, "licenses") && (isMedicalLicense(l) || isDea(l) || isCsr(l))
  );
}

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

/* ─── Tier 2 record sets ───────────────────────────────────────────
 * Each one names the records a packet row is about, so the row's rule, its
 * count, its sentence and its capture queue all read the same list.
 */

/** The two records every credentialing office asks for a copy of. */
const proofRecords = (ctx) => ctx.licenses.filter((l) => isMedicalLicense(l) || isDea(l));
const proofMissing = (ctx) => proofRecords(ctx).filter((l) => !hasDoc(ctx.data, "licenses", l.id));

const boardRecords = (ctx) => ctx.licenses.filter(isBoard);
const lifeSupportRecords = (ctx) => ctx.licenses.filter((l) => isLifeSupport(l) && !!l.expirationDate);

/** A government photo ID with its number on file. Loyalty cards are not IDs. */
const idRecords = (ctx) =>
  (ctx.data.travelDocs || []).filter((t) => t && /passport|driver|identification/i.test(t.type || "") && !!t.number);
const hasHeadshot = (ctx) => (ctx.data.professionalPhotos || []).length > 0 || !!ctx.s.profilePhoto;

const privilegeRecords = (ctx) => (ctx.data.privileges || []).filter(Boolean);
const isMalpracticeType = (type) => /malpractice|tail|professional liability/i.test(type || "");
const malpracticeRecords = (ctx) =>
  (ctx.data.insurance || []).filter((i) => i && isMalpracticeType(i.type) && !!i.expirationDate);
const reachableReferences = (ctx) =>
  (ctx.data.peerReferences || []).filter((r) => r && r.name && (r.email || r.phone));

// EDUCATION_TYPES spells the degree two ways and the training three, so both
// halves are substring tests rather than a list membership.
const isDegreeRecord = (e) => /doctor of (osteopathic )?medicine|\(md\)|\(do\)/i.test(e?.type || "");
const isTrainingRecord = (e) => /residency|internship|fellowship/i.test(e?.type || "");
const educationRecords = (ctx) => (ctx.data.education || []).filter(Boolean);

/* ─── Stored state ─────────────────────────────────────────────── */

export const EMPTY_SETUP_STATE = Object.freeze({
  v: SETUP_STATE_VERSION,
  startedAt: null,
  tier1DoneAt: null,
  tier2DoneAt: null,
  lastTouched: null,
  lastDone: null,
  hiddenUntil: null,
  proCounted: null,
  betaCounted: null,
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
    lastDone: r.lastDone || null,
    hiddenUntil: r.hiddenUntil || null,
    // How many Pro rows were in the denominator the last time the board was
    // read, and whether the free beta was what put them there. Both are null
    // until the first read, and a null never narrates: the fraction is only
    // explained when it actually changes under someone.
    proCounted: typeof r.proCounted === "number" ? r.proCounted : null,
    betaCounted: typeof r.betaCounted === "boolean" ? r.betaCounted : null,
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

/** "Texas", falling back to the code the record actually carries. */
const stateName = (code) => (code ? STATE_NAMES[code] || code : "");

export const TASK_DEFS = [
  {
    // First, because it is the one step that can fill in most of the rest.
    // Deliberately no regressionLine: an established account with no
    // CV-named file must not be nagged forever about a file it never needed.
    id: "cv",
    tier: 1,
    secs: 60,
    pro: false,
    label: "Start from your CV",
    why: "Your CV already holds your degree, your training, where you work and your licenses. Reading it once fills in most of this list.",
    verb: "Upload my CV",
    declaredNa: "noCv",
    naDetail: "Not applicable. You said you would rather type it in.",
    // Done when a CV is on file, OR when the record it would have filled is
    // already there. The second clause is what keeps an established account
    // from being told it is behind on a step it no longer needs.
    doneWhen: ({ data }) =>
      (data.documents || []).some((d) => CV_FILENAME_RE.test(d?.name || ""))
      || ((data.education || []).length > 0 && (data.workHistory || []).length > 0),
    evidenceWhen: null,
    cardLine: () => "Upload your CV and the app reads your degree, training, positions and licenses off it.",
    nextPhrase: () => "your CV",
    doneClause: "your CV",
    pendingDetail: () => "Nothing uploaded yet.",
  },
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
    nextPhrase: () => "your degree and primary state",
    doneClause: "your details",
    // Three fields complete this task, so three fields can un-complete it.
    // A cleared name used to be reported as a blank degree.
    regressionLine: ({ s }) => {
      if (!s.name) return "your name is blank";
      if (!s.degreeType) return "your degree is blank";
      return "your primary state is blank";
    },
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
    nextPhrase: () => "the registry lookup that fills in your licenses",
    doneClause: "your licenses",
    regressionLine: () => "no medical license is on file",
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
    nextPhrase: (ctx) => {
      const missing = dateless(ctx.data);
      if (missing.length === 1 && missing[0].state) return `the expiration date on your ${stateName(missing[0].state)} license`;
      if (missing.length === 1) return "the expiration date on your remaining license";
      return `${missing.length} licenses still without an expiration date`;
    },
    // Quantified out of their own file. There is no statistic about
    // physicians in general here because we do not have one.
    costLine: (ctx) => {
      const total = datable(ctx.data).length;
      const missing = dateless(ctx.data).length;
      if (!total || !missing) return null;
      // The verb agrees with the count that leads the sentence, not the total.
      return `${missing} of your ${total} ${plural(total, "license", "licenses")} ${plural(missing, "has", "have")} no expiration date on file. No reminder can fire for ${plural(missing, "it", "those")} until ${plural(missing, "it does", "they do")}.`;
    },
    doneClause: "your expiration dates",
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
    documentedDetail: "Dated. Proof attached.",
    doneWhen: ({ licenses }) => licenses.some((l) => isDea(l) && !!l.expirationDate),
    evidenceWhen: ({ data, licenses }) => licenses.some((l) => isDea(l) && !!l.expirationDate && hasDoc(data, "licenses", l.id)),
    cardLine: () => "No DEA registration on file. If you hold one, the app cannot warn you about it yet.",
    nextPhrase: () => "your DEA registration",
    doneClause: "your DEA registration",
    pendingDetail: ({ licenses }) =>
      licenses.some(isDea) ? "On file, but with no expiration date." : "Nothing on file yet.",
    // A deleted registration and an undated one are different facts, and the
    // constant asserted the second when it was the first.
    regressionLine: ({ licenses }) =>
      licenses.some(isDea)
        ? "your DEA registration has no expiration date"
        : "your DEA registration is no longer on file",
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
    nextPhrase: () => "turning reminders on",
    costLine: (ctx) => {
      const dated = datable(ctx.data).filter((l) => !!l.expirationDate).length;
      if (!dated) return null;
      return `You have ${dated} dated ${plural(dated, "record", "records")} on file and nothing switched on to warn you about ${plural(dated, "it", "any of them")}.`;
    },
    doneClause: "your reminders",
    pendingDetail: ({ s }) => (s.email ? "No channel is on." : "No address on file to warn."),
    regressionLine: () => "reminders are off",
  },

  /* ─── TIER 2 ─ "Packet ready" ────────────────────────────────────
   * A credentialing office asks for the same list every time, and this is
   * that list. Nothing here changes whether the app warns you, so nothing
   * here is allowed to read as urgent.
   *
   * `variable: true` marks a row whose length depends on the physician's
   * filing cabinet rather than on the form: those rows print no time
   * estimate, because any number we printed would be invented.
   *
   * Three rows are Pro. They are never dropped from the board, only marked
   * locked when the account cannot reach them, so a free physician sees what
   * a full packet contains without being told they already have it.
   */
  {
    id: "proof",
    tier: 2,
    secs: 60,
    pro: false,
    variable: true,
    section: "licenses",
    label: "Copies of your license and DEA",
    why: "A credentialing office asks for the document, not the number you typed into it.",
    verb: "Photograph them",
    // The drawer's manual escape opens the Licenses add form, so it cannot
    // carry the camera verb the Next card uses.
    addVerb: "Add a license by hand",
    doneWhen: (ctx) => proofRecords(ctx).length > 0 && proofMissing(ctx).length === 0,
    // The proof IS the task here, so the record dot and the proof dot move
    // together. Both are filled or neither is.
    evidenceWhen: (ctx) => proofRecords(ctx).length > 0 && proofMissing(ctx).length === 0,
    blockedBy: (ctx) => (proofRecords(ctx).length ? null : "licenses"),
    nextPhrase: (ctx) => {
      const first = proofMissing(ctx)[0];
      return first?.state ? `a copy of your ${first.state} license` : "a copy of your license";
    },
    costLine: (ctx) => {
      const total = proofRecords(ctx).length;
      const missing = proofMissing(ctx).length;
      if (!total || !missing) return null;
      return `${missing} of your ${total} license ${plural(total, "record", "records")} ${plural(missing, "has", "have")} no copy attached. The number on its own is not what a credentialing office asks for.`;
    },
    doneClause: "the copies of your licenses",
    cardLine: (ctx) => {
      const missing = proofMissing(ctx).length;
      if (!missing) return "Attach a copy of each license and DEA record.";
      return `${missing} license ${plural(missing, "record has", "records have")} no copy attached.`;
    },
    pendingDetail: (ctx) => {
      const total = proofRecords(ctx).length;
      if (!total) return "Add a license first, then the copies land here.";
      return `${total - proofMissing(ctx).length} of ${total} have a copy attached.`;
    },
  },
  {
    id: "boards",
    tier: 2,
    secs: 45,
    pro: false,
    section: "licenses",
    label: "Board certification",
    // No expiration date is required here, ever. isNonExpiring reads
    // item.noExpiration and nothing in the app sets that field yet, so a
    // lifetime diplomate asked for a date would be stranded on this row.
    why: "Your specialty drives which board rules apply, and the certificate is the first thing an application asks for.",
    verb: "Add my board certification",
    doneWhen: (ctx) => (ctx.s.specialties || []).length > 0 && boardRecords(ctx).length > 0,
    evidenceWhen: (ctx) => boardRecords(ctx).some((l) => hasDoc(ctx.data, "licenses", l.id)),
    nextPhrase: () => "your board certification",
    costLine: null,
    doneClause: "your board certification",
    cardLine: () => "No board certification on file.",
    pendingDetail: (ctx) => {
      if (!boardRecords(ctx).length) return "Nothing on file yet.";
      return (ctx.s.specialties || []).length ? "" : "On file. Your specialty is still blank.";
    },
  },
  {
    id: "lifeSupport",
    tier: 2,
    secs: 45,
    pro: false,
    section: "licenses",
    label: "BLS, ACLS or ATLS",
    why: "Every hospital application asks for a current card, and they lapse on a two-year clock.",
    verb: "Add my card",
    doneWhen: (ctx) => lifeSupportRecords(ctx).length > 0,
    evidenceWhen: (ctx) => lifeSupportRecords(ctx).some((l) => hasDoc(ctx.data, "licenses", l.id)),
    nextPhrase: () => "your BLS or ACLS card",
    costLine: null,
    doneClause: "your life support card",
    cardLine: () => "No dated BLS, ACLS or ATLS card on file.",
    pendingDetail: () => "Nothing dated on file yet.",
  },
  {
    id: "cme",
    tier: 2,
    secs: 60,
    pro: false,
    variable: true,
    section: "cme",
    label: "CME for the current cycle",
    why: "The transcript from CE Broker or your state board imports every line at once.",
    verb: "Import my transcript",
    doneWhen: (ctx) => (ctx.data.cme || []).length > 0,
    evidenceWhen: null,
    nextPhrase: () => "this cycle's CME",
    costLine: null,
    doneClause: "your CME",
    cardLine: () => "No CME on file for this cycle.",
    pendingDetail: () => "Nothing logged yet.",
  },
  {
    id: "education",
    tier: 2,
    secs: 60,
    pro: false,
    variable: true,
    section: "education",
    label: "Medical school and postgraduate training",
    why: "Every application asks for both, and the dates have to match the certificates.",
    verb: "Add my training",
    doneWhen: (ctx) => {
      const list = educationRecords(ctx);
      return list.some(isDegreeRecord) && list.some(isTrainingRecord);
    },
    evidenceWhen: (ctx) => educationRecords(ctx).some((e) => hasDoc(ctx.data, "education", e.id)),
    nextPhrase: (ctx) => (educationRecords(ctx).some(isDegreeRecord) ? "your residency or fellowship" : "your medical school"),
    costLine: null,
    doneClause: "your training history",
    cardLine: () => "Medical school or postgraduate training is missing.",
    pendingDetail: (ctx) => {
      const list = educationRecords(ctx);
      if (!list.length) return "Nothing on file yet.";
      if (!list.some(isDegreeRecord)) return "No medical school on file.";
      return "No residency, internship or fellowship on file.";
    },
  },
  {
    id: "work",
    tier: 2,
    secs: 45,
    pro: false,
    section: "workHistory",
    label: "Your current position",
    // A physician between assignments has no open-ended row, so any entry
    // closes this. The open row is what a packet wants, not what we require.
    why: "A packet leads with where you work now, and an unexplained gap is what an office asks about.",
    verb: "Add my position",
    doneWhen: (ctx) => (ctx.data.workHistory || []).length >= 1,
    evidenceWhen: null,
    nextPhrase: () => "your current position",
    costLine: null,
    doneClause: "your work history",
    cardLine: () => "No work history on file.",
    pendingDetail: () => "Nothing on file yet.",
  },
  {
    id: "idPhoto",
    tier: 2,
    secs: 60,
    pro: false,
    variable: true,
    section: "travelDocs",
    label: "Photo ID and a headshot",
    why: "Two separate asks on nearly every application, and neither one changes.",
    verb: "Add my ID",
    doneWhen: (ctx) => idRecords(ctx).length > 0 && hasHeadshot(ctx),
    evidenceWhen: (ctx) => idRecords(ctx).some((t) => hasDoc(ctx.data, "travelDocs", t.id)),
    nextPhrase: (ctx) => (idRecords(ctx).length ? "a headshot" : "your passport or driver's license"),
    costLine: null,
    doneClause: "your photo ID",
    cardLine: () => "No photo ID or no headshot on file.",
    pendingDetail: (ctx) => {
      if (!idRecords(ctx).length && !hasHeadshot(ctx)) return "Neither one on file yet.";
      if (!idRecords(ctx).length) return "Headshot on file. No photo ID yet.";
      return "Photo ID on file. No headshot yet.";
    },
  },
  {
    id: "privileges",
    tier: 2,
    secs: 90,
    pro: true,
    variable: true,
    section: "privileges",
    label: "Hospital privileges",
    why: "Privileges lapse on their own clock, and the reappointment letter is what proves them.",
    verb: "Add my privileges",
    doneWhen: (ctx) => privilegeRecords(ctx).length > 0 && privilegeRecords(ctx).every((p) => !!p.expirationDate),
    evidenceWhen: (ctx) => privilegeRecords(ctx).length > 0 && privilegeRecords(ctx).every((p) => hasDoc(ctx.data, "privileges", p.id)),
    nextPhrase: () => "your hospital privileges",
    costLine: (ctx) => {
      const total = privilegeRecords(ctx).length;
      const undated = privilegeRecords(ctx).filter((p) => !p.expirationDate).length;
      if (!total || !undated) return null;
      return `${undated} of your ${total} privilege ${plural(total, "record", "records")} ${plural(undated, "has", "have")} no expiration date on file.`;
    },
    doneClause: "your hospital privileges",
    cardLine: () => "Hospital privileges are missing or undated.",
    pendingDetail: (ctx) => {
      const total = privilegeRecords(ctx).length;
      if (!total) return "Nothing on file yet.";
      return `${privilegeRecords(ctx).filter((p) => !!p.expirationDate).length} of ${total} carry a date.`;
    },
  },
  {
    id: "malpractice",
    tier: 2,
    secs: 60,
    pro: true,
    section: "insurance",
    label: "Malpractice certificate of insurance",
    why: "The certificate of insurance is asked for by name, and its dates have to be current.",
    verb: "Add my coverage",
    doneWhen: (ctx) => malpracticeRecords(ctx).length > 0,
    evidenceWhen: (ctx) => malpracticeRecords(ctx).some((i) => hasDoc(ctx.data, "insurance", i.id)),
    nextPhrase: () => "your malpractice certificate",
    costLine: null,
    doneClause: "your malpractice coverage",
    cardLine: () => "No dated malpractice policy on file.",
    pendingDetail: (ctx) =>
      (ctx.data.insurance || []).some((i) => isMalpracticeType(i?.type))
        ? "On file, but with no expiration date."
        : "Nothing on file yet.",
  },
  {
    id: "references",
    tier: 2,
    secs: 90,
    pro: true,
    section: "peerReferences",
    label: "Three peer references",
    // A reference is a contact, not a certificate, so this row takes no
    // evidence and shows no proof dot.
    why: "Three is the number nearly every application asks for, each with a way to reach them.",
    verb: "Add my references",
    doneWhen: (ctx) => reachableReferences(ctx).length >= 3,
    evidenceWhen: null,
    nextPhrase: () => "three peer references",
    costLine: (ctx) => {
      const n = reachableReferences(ctx).length;
      return n > 0 && n < 3 ? `${n} of the three peer references an application asks for ${plural(n, "is", "are")} on file with a way to reach them.` : null;
    },
    doneClause: "your peer references",
    cardLine: (ctx) => {
      const n = reachableReferences(ctx).length;
      return n === 0 ? "No peer references on file." : `${n} of three peer references on file.`;
    },
    pendingDetail: (ctx) => {
      const n = reachableReferences(ctx).length;
      const total = (ctx.data.peerReferences || []).length;
      if (!total) return "Nothing on file yet.";
      return `${n} of 3 have a name and a way to reach them.`;
    },
  },
];

/* ─── Capture queues ───────────────────────────────────────────────
 * Which records a packet row is still missing its proof for, in the order the
 * run will walk them. Kept beside the rules above so the queue can never
 * disagree with the checkbox it is supposed to close.
 */

const queueCtx = (data) => {
  const d = data || {};
  return { data: d, s: d.settings || {}, licenses: Array.isArray(d.licenses) ? d.licenses.filter(Boolean) : [] };
};
const undocumented = (ctx, section, list) => list.filter((r) => r && !hasDoc(ctx.data, section, r.id));

export function evidenceQueue(data, taskId) {
  const ctx = queueCtx(data);
  const q = (section, list) => ({ section, records: undocumented(ctx, section, list) });
  switch (taskId) {
    case "proof": return q("licenses", proofRecords(ctx));
    case "boards": return q("licenses", boardRecords(ctx));
    case "lifeSupport": return q("licenses", lifeSupportRecords(ctx));
    case "dea": return q("licenses", ctx.licenses.filter(isDea));
    case "education": return q("education", educationRecords(ctx));
    case "idPhoto": return q("travelDocs", idRecords(ctx));
    case "privileges": return q("privileges", privilegeRecords(ctx));
    case "malpractice": return q("insurance", malpracticeRecords(ctx));
    default: return { section: null, records: [] };
  }
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** Words up to twelve, digits after: this opens a sentence. */
export const numberWord = (n) => (NUMBER_WORDS[n] != null ? NUMBER_WORDS[n] : String(n));
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The line a run opens with, counted from the queue it is about to walk.
 *
 * `wantsDate` false for the rows whose records carry no expiration at all: a
 * lifetime diplomate has no board date and a diploma has no diploma date, and
 * the run must not assert one, nor offer a field that would write one.
 */
export function runIntro(count, noun = "licenses", singular = "license", wantsDate = true) {
  if (!wantsDate) {
    if (count === 1) {
      return `One ${singular} needs one thing: a copy of the certificate. Photograph it and the app reads it off the page.`;
    }
    return `${capitalize(numberWord(count))} ${noun} need one thing: a copy of the certificate. Photograph them one after another and the app reads them off the page.`;
  }
  if (count === 1) {
    return `One ${singular} needs two things: the date it expires and a copy of the certificate. Photograph it and the app reads both off the page.`;
  }
  return `${capitalize(numberWord(count))} ${noun} need two things: the date they expire and a copy of the certificate. Photograph them one after another and the app reads both off the page.`;
}

/** How the section heading and the Pro group are worded, in one place. */
export const TIER2_COPY = {
  header: "Packet ready",
  intro: "A credentialing office asks for the same list every time. This is that list.",
  second: "Nothing here changes whether the app warns you. It changes how fast you can answer a request.",
  proof: "Proof means the document is on file and linked to the record it belongs to. CredentialDOMD does not contact boards or primary sources on your behalf.",
  legend: "record · proof",
  proHeader: "Also in a full packet.",
  proBlurb: "Hospital privileges, malpractice coverage and peer references are part of Pro. They are not counted in your total above.",
};

/**
 * The Next card's ranking: exposure order, not page order. Dates come first
 * because an undated record is invisible to every warning in the app;
 * identity comes last because nothing lapses because of it. Within one tier
 * an unblocked task always outranks a blocked one, and secs breaks a tie.
 */
// The CV sits second, not first, on purpose: an undated license is invisible
// to every warning in the app, and reading a CV is a convenience. Exposure
// still comes first. Below that the CV leads, because it is the one row that
// can answer several of the others at once.
export const CARD_PRIORITY = ["dates", "cv", "licenses", "dea", "reminders", "identity"];

/** A skipped task re-enters the Next rotation for one week, starting a week
 *  after the skip. Skipping means "not now"; a physician must not fight the
 *  same card every morning, and must not lose the item forever either. */
const REOFFER_FROM_DAYS = 7;
const REOFFER_UNTIL_DAYS = 14;

/* ─── Resolution ───────────────────────────────────────────────── */

function detailFor(def, status, stored, ctx) {
  if (status === "documented") return def.documentedDetail || "On file. Proof attached.";
  if (status === "done") return def.evidenceWhen ? "On file. No copy attached yet." : "On file.";
  if (status === "na") return def.naDetail || "Not applicable.";
  if (status === "skipped") {
    const when = shortDate(stored?.at);
    return when ? `Skipped ${when}. Still on the list.` : "Skipped. Still on the list.";
  }
  return def.pendingDetail ? def.pendingDetail(ctx) : "";
}

const call = (fn, ctx) => (typeof fn === "function" ? fn(ctx) : fn || null);

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
    // What the drawer's "do it yourself" button says, when that is not the
    // same action as the card's verb.
    addVerb: def.addVerb || def.verb,
    pro: !!def.pro,
    // Locked is not a status: the row still resolves normally, it is simply
    // out of the denominator and out of the Next rotation while the account
    // cannot reach it. A locked row never claims the physician has it.
    locked: !!def.pro && !ctx.isPro,
    betaTag: !!def.pro && ctx.isFreeBeta && !ctx.hasSubscription,
    section: def.section || null,
    variable: !!def.variable,
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
    // The re-engagement ladder's three vocabularies: a noun phrase for what
    // is next, a quantified sentence built only from their own records, and
    // a past-tense clause for the task that last closed.
    nextPhrase: call(def.nextPhrase, ctx),
    costLine: call(def.costLine, ctx),
    doneClause: def.doneClause || null,
  };
}

/**
 * The denominator. A SKIPPED task stays in it: deferring must never raise
 * your score. A NA task leaves it: declaring something inapplicable is a
 * deliberate claim, and the number has to be able to reach zero.
 */
function countTier(list) {
  // A locked Pro row is not in the fraction at all. Counting it would tell a
  // free physician they are behind on something they cannot open.
  const live = list.filter((t) => !t.locked);
  const na = live.filter((t) => t.status === "na").length;
  const done = live.filter((t) => t.status === "done" || t.status === "documented").length;
  const skipped = live.filter((t) => t.status === "skipped").length;
  const total = live.length - na;
  return {
    total, done, skipped, na,
    left: Math.max(0, total - done),
    complete: total > 0 && total === done,
    locked: list.length - live.length,
  };
}

/** Everything still asking to be done: pending, or a skip inside its one-week re-offer window. */
function openTasks(tasks, nowMs) {
  return tasks.filter((t) => {
    if (t.locked) return false;
    if (t.status === "pending") return true;
    if (t.status !== "skipped" || !t.skippedAt) return false;
    const age = nowMs - new Date(t.skippedAt).getTime();
    return age >= REOFFER_FROM_DAYS * MS_PER_DAY && age < REOFFER_UNTIL_DAYS * MS_PER_DAY;
  });
}

function rankOpen(open, tasks) {
  const prio = (t) => {
    const i = CARD_PRIORITY.indexOf(t.id);
    return i === -1 ? CARD_PRIORITY.length : i;
  };
  const order = tasks.map((t) => t.id);
  return [...open].sort((a, b) =>
    a.tier - b.tier ||
    (a.blockedBy ? 1 : 0) - (b.blockedBy ? 1 : 0) ||
    prio(a) - prio(b) ||
    a.secs - b.secs ||
    order.indexOf(a.id) - order.indexOf(b.id)
  );
}

/**
 * The board. `data` is the app's record file; `isPro` gates the Pro rows.
 * Pure: the same arguments always give the same answer, so it memoizes on
 * the dependency lists Home already keeps.
 */
export function buildSetup(data, { isPro = false, isFreeBeta = false, hasSubscription = false, now = new Date() } = {}) {
  const d = data || {};
  const s = d.settings || {};
  const state = normalizeSetupState(s.setupState);
  const nowMs = new Date(now).getTime();
  const ctx = {
    data: d,
    s,
    licenses: Array.isArray(d.licenses) ? d.licenses.filter(Boolean) : [],
    isPro,
    isFreeBeta,
    hasSubscription,
  };

  // Pro rows are never dropped from the board, only locked: a free physician
  // should be able to see what a full packet contains. countTier and the
  // ranker both skip them, so a paywall can never be the page's next action.
  const tasks = TASK_DEFS.map((def) => resolveTask(def, ctx, state));
  const tier1 = tasks.filter((t) => t.tier === 1);
  const tier2 = tasks.filter((t) => t.tier === 2);

  // Degree unset means the license-type vocabulary is unknown, so the board
  // offers About you and nothing else until it is answered.
  // The CV is the exception: it is the step that ANSWERS the degree question,
  // so gating it behind the answer would make the first step unreachable.
  const degreeUnset = s.degreeType !== "MD" && s.degreeType !== "DO";
  const candidates = degreeUnset ? tasks.filter((t) => t.id === "identity" || t.id === "cv") : tasks;
  const open = openTasks(candidates, nowMs);
  const ranked = rankOpen(open, tasks);

  return {
    tasks,
    tier1,
    tier2,
    byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
    counts: { tier1: countTier(tier1), tier2: countTier(tier2) },
    open: ranked,
    next: ranked[0] || null,
    // The day-30 form offers the cheapest thing left, which is rarely the
    // most important thing left. That is the point of it.
    cheapest: open.length ? [...open].sort((a, b) => a.secs - b.secs || ranked.indexOf(a) - ranked.indexOf(b))[0] : null,
    state,
    skipped: tasks.filter((t) => t.status === "skipped"),
    notApplicable: tasks.filter((t) => t.status === "na"),
    proLive: tier2.filter((t) => t.pro && !t.locked).length,
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

/**
 * Stamped whenever a task transitions to done, along with WHICH task closed.
 * The re-engagement ladder reads both, so it can say "You finished your
 * licenses on Monday" out of the physician's own history rather than out of
 * a generic nag.
 */
export function withTouched(state, nowIso, taskId, prune) {
  return write(state, { lastTouched: nowIso, lastDone: taskId || null }, prune);
}

/**
 * Record how many Pro rows are in the denominator now. Written silently when
 * nothing changed, and only after the change has been narrated when it did:
 * the fraction is never allowed to renumber without a sentence.
 */
export function withProSnapshot(state, { proCounted, betaCounted }, prune) {
  return write(state, { proCounted, betaCounted }, prune);
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

export const CARD_FORM = { NONE: "none", A: "A", B: "B", C: "C", D: "D" };

/**
 * Which form the Home card takes. Form A is the bordered setup card; it can
 * NEVER return once tier1DoneAt is stamped, so an active physician who adds
 * a dateless record months later gets the one-line Form D, not a setup
 * prompt. Form B is the Protected moment, which renders once. Form C is the
 * quiet packet line, and Form D is navigation.
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
  // Tier 1 has regressed since it was stamped: name what regressed, in one
  // line, and never reopen the bordered card for it.
  if (!complete) return CARD_FORM.D;
  const t2 = setup.counts.tier2;
  return t2.total > 0 && !t2.complete ? CARD_FORM.C : CARD_FORM.D;
}

/**
 * The whole board as one fraction. Tier 1 is the number that matters while
 * setup is running; once it is stamped, "Setup" means the whole list, which
 * is what the terminal Home line and the Setup tiles count.
 */
export function boardCounts(setup) {
  const a = setup.counts.tier1;
  const b = setup.counts.tier2;
  return {
    done: a.done + b.done,
    total: a.total + b.total,
    left: a.left + b.left,
    skipped: a.skipped + b.skipped,
    complete: a.complete && b.complete,
  };
}

/**
 * The Tier 1 task that has come undone since Tier 1 was stamped, or null.
 *
 * Read in CARD_PRIORITY order (exposure order), so a physician who deleted a
 * date and turned reminders off in the same week is told about the date. It
 * is deliberately NOT read off setup.next: the top-ranked open task can be a
 * packet row, and a Tier 1 task carrying a skip that was written before it
 * ever closed is not open at all, so either would leave the terminal line
 * saying nothing about what actually changed.
 */
export function tier1Regressed(setup) {
  for (const id of CARD_PRIORITY) {
    const t = setup.byId?.[id];
    if (!t || t.tier !== 1) continue;
    if (t.status === "done" || t.status === "documented" || t.status === "na") continue;
    if (t.regressionLine) return t;
  }
  return null;
}

/* ─── The re-engagement ladder ─────────────────────────────────────
 * What the card says depends on how long the physician has been away from
 * it, and every rung is built out of their own records. There is no email
 * anywhere in this, and no streak: a streak measures return visits on a
 * board that is supposed to end.
 */

export const LADDER = { FRESH: "fresh", CONTINUITY: "continuity", COST: "cost", ONE_THING: "oneThing" };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Monday". Only ever used inside a six-day window, where it is unambiguous. */
export function weekdayName(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : WEEKDAYS[d.getDay()];
}

/**
 * Words, not digits, because this appears mid-sentence in the day-30 line.
 * Every value is one the task table actually carries, so nothing here is a
 * guess about how long a physician will take.
 */
export function secsPhrase(secs) {
  const n = Number(secs) || 0;
  if (n <= 10) return "about ten seconds";
  if (n <= 15) return "about fifteen seconds";
  if (n <= 20) return "about twenty seconds";
  if (n <= 30) return "about half a minute";
  if (n <= 45) return "under a minute";
  if (n <= 60) return "about a minute";
  return "a minute or two";
}

/** Whole days between two instants, floored. */
const daysBetween = (from, to) => {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / MS_PER_DAY);
};

/**
 * The sentence and the button the card should carry right now.
 *
 * Day 0 to 1  the exposure itself.
 * Day 2 to 6  continuity: what they finished, and what comes next.
 * Day 7 to 29 the cost, quantified out of their own file. Never a statistic
 *             about physicians in general, because we do not have one.
 * Day 30+     one line offering the cheapest thing left. Shrinking after a
 *             month of being ignored is what keeps the card credible.
 *
 * Any rung that cannot say something true and specific falls back to day 0.
 */
export function ladderState(setup, { now = new Date(), tier = null } = {}) {
  // The Home card and the page's Next card both speak for Tier 1 while Tier 1
  // is unfinished. Without this the ranker falls straight through to a packet
  // row the moment every remaining Tier 1 row is skipped, and the bordered
  // card offers board certification under a "Setup · 4 of 5" header.
  const pool = tier ? setup.open.filter((t) => t.tier === tier) : setup.open;
  const next = pool[0] || null;
  if (!next) return null;
  const fresh = { bucket: LADDER.FRESH, taskId: next.id, text: next.cardLine, verb: next.verb };

  const lastTouched = setup.state.lastTouched;
  if (!lastTouched) return fresh;
  const days = daysBetween(lastTouched, now);
  if (days == null || days <= 1) return fresh;

  if (days <= 6) {
    const closed = setup.byId[setup.state.lastDone];
    const when = weekdayName(lastTouched);
    if (!closed?.doneClause || !when || !next.nextPhrase) return fresh;
    return {
      bucket: LADDER.CONTINUITY,
      taskId: next.id,
      verb: next.verb,
      text: `You finished ${closed.doneClause} on ${when}. Next: ${next.nextPhrase}.`,
    };
  }

  if (days <= 29) {
    return next.costLine
      ? { bucket: LADDER.COST, taskId: next.id, verb: next.verb, text: next.costLine }
      : fresh;
  }

  const cheapest = (tier
    ? [...pool].sort((a, b) => a.secs - b.secs || pool.indexOf(a) - pool.indexOf(b))[0]
    : setup.cheapest) || next;
  if (!cheapest.nextPhrase) return fresh;
  return {
    bucket: LADDER.ONE_THING,
    taskId: cheapest.id,
    verb: "Add it",
    text: `One thing, ${secsPhrase(cheapest.secs)}: ${cheapest.nextPhrase}.`,
  };
}

/* ─── The denominator, narrated ────────────────────────────────── */

/** What to record once the current Pro state has been shown to the physician. */
export function proSnapshot(setup, { isFreeBeta = false } = {}) {
  return { proCounted: setup.proLive, betaCounted: !!isFreeBeta };
}

/** True when what is on file already matches what is on screen. */
export function proSnapshotMatches(setup, { isFreeBeta = false } = {}) {
  const st = setup.state;
  return st.proCounted === setup.proLive && st.betaCounted === !!isFreeBeta;
}

/**
 * The sentence explaining why the total moved, or null when it did not.
 * The fraction is the one number on the page a physician is asked to trust,
 * so it never renumbers in either direction without saying why.
 */
export function denominatorNarration(setup, { isFreeBeta = false } = {}) {
  const st = setup.state;
  const prev = st.proCounted;
  const now = setup.proLive;
  if (prev == null || prev === now) return null;
  if (now > prev) {
    const n = now - prev;
    return `Pro added ${n} ${plural(n, "item", "items")} to your board.`;
  }
  const n = prev - now;
  if (st.betaCounted && !isFreeBeta) {
    return `The free beta has ended, so ${n} Pro ${plural(n, "item", "items")} left your total. Nothing you entered was removed.`;
  }
  return `${n} Pro ${plural(n, "item", "items")} left your total. Nothing you entered was removed.`;
}

/**
 * Whether setup is the surface currently saying what `taskId` says.
 *
 * Home suppresses its older banners while setup owns the same sentence, and
 * that ownership has to end the moment setup stops speaking, or a skipped or
 * snoozed task silences BOTH surfaces forever: a skip keeps the task in the
 * denominator by design, so tier1DoneAt never lands and a "done setting up"
 * test would suppress the banner for the life of the account.
 *
 * Ownership therefore needs two things at once: the bordered card is on
 * screen (Form A), and the task that would say it is still open.
 */
export function setupOwns(setup, taskId, opts = {}) {
  if (homeCardForm(setup, opts) !== CARD_FORM.A) return false;
  return setup.byId?.[taskId]?.status === "pending";
}

/**
 * The patch to write on the very first render of an account that has never
 * seen the board. An account that was already set up gets tier1DoneAt in the
 * same pass, so the Protected moment never fires for someone who was never
 * setting up.
 *
 * settings.onboardingDone is deliberately not consulted: the derived rule
 * already covers every account that flag described, and it never synced past
 * one device anyway. It is not being deleted yet either. This is the release
 * that replaces it, and the first-render rule above has to be seen working
 * on real accounts before the key is stripped from the caches still holding
 * it. It is already unreachable from every code path; retire it one release
 * from now.
 */
export function firstRenderPatch(setup, { now = new Date() } = {}) {
  if (setup.state.startedAt) return null;
  const nowIso = new Date(now).toISOString();
  const patch = { startedAt: nowIso };
  if (setup.counts.tier1.complete) patch.tier1DoneAt = nowIso;
  return patch;
}

/* ─── What an admin can honestly say about someone else's setup ─── */

/**
 * The setup board is DERIVED from a physician's own records, and an admin
 * cannot read those: RLS is owner-scoped and that is the point. What does sync
 * is profiles.setup_state, the board's own stamps, and those are enough to say
 * where somebody is without seeing a single credential.
 *
 * Returns { label, detail, tone }, where tone is one of "none" | "started" |
 * "protected" | "complete". Never guesses: an account with no stamp reads as
 * not started, because that is all that is known.
 */
export function setupProgressSummary(setupState) {
  const s = normalizeSetupState(setupState);
  const taskCounts = Object.values(s.tasks || {}).reduce((acc, t) => {
    if (t?.s === "skipped") acc.skipped += 1;
    if (t?.s === "na") acc.na += 1;
    return acc;
  }, { skipped: 0, na: 0 });
  const declared = Object.keys(s.declared || {}).length;
  const aside = [
    taskCounts.skipped ? `${taskCounts.skipped} skipped` : "",
    taskCounts.na + declared ? `${taskCounts.na + declared} marked not applicable` : "",
  ].filter(Boolean).join(", ");

  if (s.tier2DoneAt) {
    return { tone: "complete", label: "Setup complete",
      detail: `Packet finished ${shortDate(s.tier2DoneAt)}${aside ? `, ${aside}` : ""}` };
  }
  if (s.tier1DoneAt) {
    return { tone: "protected", label: "Protected, packet in progress",
      detail: `Protected finished ${shortDate(s.tier1DoneAt)}${s.lastDone ? `, last did ${s.lastDone}` : ""}${aside ? `, ${aside}` : ""}` };
  }
  if (s.startedAt) {
    return { tone: "started", label: "Setup in progress",
      detail: `Started ${shortDate(s.startedAt)}${s.lastDone ? `, last did ${s.lastDone}` : ""}${aside ? `, ${aside}` : ""}` };
  }
  return { tone: "none", label: "Setup not started", detail: "No setup activity on this account yet" };
}
