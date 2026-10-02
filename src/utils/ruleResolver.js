// Which rule set governs a state, profession and licence kind (DESIGN 3.2).
//
// Physicians (and a blank profession) keep getStateEntry exactly as before;
// this returns null for them. A PA gets the state's PA rule set; an NP gets
// the state's RN or APRN rule set. Never the MD entry, never
// DEFAULT_STATE_REQ: a state with nothing verified is a board-only stub that
// reads "not yet verified" with the board link, and a state absent from the
// data gets a stub with no board at all.
//
// `rules` is injectable so the engine is testable with synthetic rule data.
//
// The PA and NP rule data (about 470 KB of the generated modules) is not in
// the app's entry bundle: every MD and DO downloaded and parsed it at launch
// and never read it (goal4, 2026-10-02). utils/appRules.js loads it as its own
// chunk for a member who needs it and installs it here (installAppRules); the
// app shows its loading screen until it is in, so a rule card never reads
// "not yet verified" for want of the data. Reaching the data before then is a
// fault, never an unverified state: it throws `app_rules_not_loaded`.
import { professionOf } from "../constants/professions.js";
import { STATE_NAMES } from "../constants/states.js";

let installed = null;

/** Put the generated PA and NP rule data in place (utils/appRules.js). */
export function installAppRules({ pa, np } = {}) {
  if (!pa || typeof pa !== "object" || !np || typeof np !== "object") throw new Error("PA and NP rule data are both required.");
  installed = Object.freeze({ pa, np });
}

/** True once the PA and NP rule data is in place. */
export const appRulesInstalled = () => installed !== null;

/** Tests only: back to the state before any member needed the data. */
export function _uninstallAppRules() { installed = null; }

function installedRules() {
  if (installed) return installed;
  const error = new Error("The PA and NP rule data is not loaded yet.");
  error.code = "app_rules_not_loaded";
  throw error;
}

// The generated rule data, once installed. Read only for a PA or NP (or a PA,
// RN or APRN licence held by a member with no physician degree).
export const DEFAULT_APP_RULES = Object.freeze({
  get pa() { return installedRules().pa; },
  get np() { return installedRules().np; },
});

const NOUN = { pa: "physician assistant license", rn: "RN license", aprn: "APRN license" };

/** The rule set used when a state is not in the data at all. */
export function missingRuleSet(profession, state, kind) {
  return {
    profession, kind, state, board: null, boardUrl: null, licenseTitle: null,
    status: "unverified", ceMode: "unverified", windowRule: "unverified",
    cycle: null, total: null, unit: kind === "pa" ? "hours" : "contact hours",
    cat1min: null, cat1note: "", cat1Accepted: [], cat1Unverified: [],
    totalAccepted: null, totalUnverified: null,
    certificationInLieu: null, certificationRequired: null, practiceHours: null, satisfiesRn: false, nlc: null,
    licenseCycle: null,
    topics: [], notes: [], source: "Not yet verified", sourceUrl: "", verified: null,
    unverified: [{ item: `Continuing education rules for the ${STATE_NAMES[state] || state} ${NOUN[kind] || "license"}`, boardUrl: null, why: "state not in the data" }],
    practice: null, prescribing: null, facts: {},
  };
}

/** The NP kind a licence kind maps to: "rn" stays RN, everything else is the APRN set. */
export const npKind = (kind) => (kind === "rn" ? "rn" : "aprn");

/**
 * The PA or NP rule set for a state, or null for physicians and a blank
 * profession (callers then use getStateEntry, unchanged).
 */
export function ruleSetFor(state, degreeType, kind, rules = DEFAULT_APP_RULES) {
  const p = professionOf(degreeType);
  if (p === "pa") {
    const set = Object.hasOwn(rules.pa || {}, state) ? rules.pa[state] : null;
    return set || missingRuleSet("pa", state, "pa");
  }
  if (p === "np") {
    const k = npKind(kind);
    const st = Object.hasOwn(rules.np || {}, state) ? rules.np[state] : null;
    return st?.[k] || missingRuleSet("np", state, k);
  }
  return null;
}

/** State-level NP data shared by the RN and APRN sets (practice, prescribing, board). */
export function npStateFor(state, rules = DEFAULT_APP_RULES) {
  return Object.hasOwn(rules.np || {}, state) ? rules.np[state] : null;
}

/**
 * The state's verified practice agreement facts for a PA licence or an
 * APRN licence, or null (physicians, RN licences, a state with no verified
 * agreement fact). `conditional` means the agreement depends on the
 * clinician (hours in practice, setting), so the app asks rather than
 * telling the member one is required (DESIGN decision 14).
 */
export function agreementFor(state, degreeType, kind, rules = DEFAULT_APP_RULES) {
  const p = professionOf(degreeType);
  let practice = null;
  if (p === "pa") practice = (Object.hasOwn(rules.pa || {}, state) ? rules.pa[state] : null)?.practice || null;
  else if (p === "np" && npKind(kind) === "aprn") practice = npStateFor(state, rules)?.practice || null;
  const a = practice?.agreement;
  if (!a || !a.text) return null;
  return {
    kind: a.kind || "agreement", text: a.text, conditional: a.conditional === true,
    cites: Array.isArray(a.cites) ? a.cites.filter((c) => c && c.url) : [],
    state, stateName: STATE_NAMES[state] || state,
  };
}
