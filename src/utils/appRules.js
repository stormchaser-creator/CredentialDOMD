// The PA and NP rule data, loaded on demand (goal4, 2026-10-02).
//
// The generated rule modules were about 470 KB of the entry bundle (57 to 71
// KB compressed) that every member's iPhone downloaded and parsed at launch,
// MD and DO included, who never read them. They are a chunk of their own now
// (utils/appRulesData.js), loaded only for a member who needs them
// (needsAppRules), as early as that is known: the account's hint on this
// device before the network, the account's profile as it is read, a PA or NP
// choice about to be made. AppContext keeps the loading screen up until the
// data is in (useAppRulesReady), so a rule card never reads "not yet
// verified" for want of it. That loading screen is the launch's only: once
// the account is on screen, a change that needs the data (a PA or NP chosen,
// a PA, RN or APRN licence added by a member with no physician degree, a
// profession changed on another device) never takes the screen away from
// what the member is doing (review of e1f4b4c9: a CV scan and Vera's
// question were lost to it). The profession pickers load the data before the
// choice is saved (afterAppRules), and anything else is shown without what
// needs the data until it is in (withoutAppRuleNeeds, AppContext).
//
// Offline after an update: a device whose account needs the data keeps a
// flag in Cache Storage, and the service worker then precaches the new
// build's chunk with the rest of the app at install (public/sw.js
// APP_RULES_URLS). The page also asks the worker of its own build to cache
// the chunk (rememberAppRulesOnDevice), because on the first launch of a new
// build the flag can land after that worker's install looked for it. A
// device that never needed it never stores it.
import { installAppRules, appRulesInstalled } from "./ruleResolver.js";
import { DEGREE_LABELS, isPhysicianDegree, licenseKindOf, professionOf } from "../constants/professions.js";

// The Cache Storage flag the service worker reads at install (public/sw.js).
export const APP_RULES_FLAG_CACHE = "credentialdomd-flags";
export const APP_RULES_FLAG_URL = "./__app-rules-wanted";

// Licence kinds whose renewal board comes from the PA and NP data for a
// member with no physician degree (utils/renewalRoute.js appRoute).
const APP_LICENCE_KINDS = new Set(["pa", "rn", "aprn"]);

// What the member is told when the data cannot be loaded (no connection).
export const APP_RULES_UNAVAILABLE = "The PA and NP rules download once, the first time they are needed, and this device could not get them. Check your connection and try again.";

let loading = null;
let failed = false;
const listeners = new Set();
let importRules = () => import("./appRulesData.js");
const BUILD = typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : "dev";

export const appRulesReady = () => appRulesInstalled();
/** The last load failed and none has succeeded or started since. */
export const appRulesFailed = () => failed && !appRulesInstalled();

const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a listener never stops the others */ } } };

/** Called each time the data goes in or a load fails; returns the unsubscribe. */
export function onAppRules(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * This device's account needs the data (AppContext, once it is in): the
 * flag the service worker reads at install, and a word to the worker of this
 * page's build (whichever state it is in) to cache the chunk now. Without
 * the word, the first launch after an update could end with the chunk in no
 * cache: the old worker cached it in the old build's cache, the new
 * worker's install looked for the flag before it was written, and its
 * activation deleted the old cache (review of e1f4b4c9).
 */
export function rememberAppRulesOnDevice() {
  try {
    const store = globalThis.caches;
    if (store && typeof store.open === "function" && typeof globalThis.Response === "function") {
      store.open(APP_RULES_FLAG_CACHE).then(cache => cache.put(APP_RULES_FLAG_URL, new Response("1"))).then(tellWorkers, tellWorkers);
    } else tellWorkers();
  } catch { /* no Cache Storage: the chunk is cached as it is fetched */ }
}

function tellWorkers() {
  try {
    const sw = globalThis.navigator?.serviceWorker;
    if (!sw || typeof sw.getRegistration !== "function") return;
    const message = { type: "APP_RULES_WANTED", build: BUILD };
    Promise.resolve(sw.getRegistration()).then((registration) => {
      const workers = new Set([registration?.installing, registration?.waiting, registration?.active, sw.controller].filter(Boolean));
      for (const worker of workers) { try { worker.postMessage(message); } catch { /* a worker going away */ } }
    }).catch(() => {});
  } catch { /* no service worker */ }
}

/**
 * Load and install the PA and NP rule data (once; a failed load can be tried
 * again). Resolves true once it is in.
 */
export function loadAppRules() {
  if (appRulesInstalled()) return Promise.resolve(true);
  if (!loading) {
    failed = false;
    loading = importRules().then((module) => {
      installAppRules({ pa: module.PA_STATE_RULES, np: module.NP_STATE_RULES });
      notify();
      return true;
    }, (error) => { loading = null; failed = true; notify(); throw error; });
  }
  return loading;
}

/**
 * Runs `apply` once the data the profession `degreeType` reads is in: at
 * once (returning what `apply` returns) when it needs none or has it, else
 * after loading it (returning null meanwhile; `waiting(true)` then
 * `waiting(false)` around the load). A load that fails calls `unavailable`
 * and applies nothing: the choice is not saved, and nothing that follows it
 * runs on rules the app does not have.
 */
export function afterAppRules(degreeType, apply, { unavailable = () => {}, waiting = () => {} } = {}) {
  if (!degreeNeedsAppRules(degreeType) || appRulesInstalled()) return apply();
  waiting(true);
  loadAppRules().then(() => { waiting(false); apply(); }, () => { waiting(false); unavailable(); });
  return null;
}

/** Start loading without waiting; a failure is tried again by whoever needs it. */
export function preloadAppRules() {
  loadAppRules().catch(() => {});
}

/** A PA or NP. */
export const degreeNeedsAppRules = (degreeType) => {
  const p = professionOf(degreeType);
  return p === "pa" || p === "np";
};

/**
 * Whether these records read the PA and NP rule data: a PA or NP, or a member
 * with no physician degree holding a PA, RN or APRN licence (that licence's
 * renewal board). An MD or DO never does, nor a member with no profession and
 * none of those licences.
 */
export function needsAppRules(data) {
  const degree = data?.settings?.degreeType;
  if (degreeNeedsAppRules(degree)) return true;
  if (isPhysicianDegree(degree)) return false;
  return (Array.isArray(data?.licenses) ? data.licenses : []).some(l => l && APP_LICENCE_KINDS.has(licenseKindOf(l.type)));
}

/**
 * What a screen already showing the account shows while the data `data`
 * needs is not in: everything but what needs it. A PA or NP profession
 * reads as the one shown before (`shownDegree`, which needed none), and with
 * no physician degree a PA, RN or APRN licence waits off the screen. Nothing
 * is changed or lost: the records stay as saved, and show in full once the
 * data is in.
 */
export function withoutAppRuleNeeds(data, shownDegree = "") {
  if (!needsAppRules(data)) return data;
  let out = data;
  if (degreeNeedsAppRules(out?.settings?.degreeType)) {
    out = { ...out, settings: { ...out.settings, degreeType: degreeNeedsAppRules(shownDegree) ? "" : (shownDegree || "") } };
  }
  if (needsAppRules(out)) {
    out = { ...out, licenses: (Array.isArray(out.licenses) ? out.licenses : []).filter(l => !(l && APP_LICENCE_KINDS.has(licenseKindOf(l.type)))) };
  }
  return out;
}

/**
 * The line a kept screen shows while it waits for the data
 * (components/shared/AppRulesNotice.jsx; AppContext appRulesWaiting). A PA or
 * NP profession saved elsewhere shows as the earlier one meanwhile, with that
 * profession's rules (withoutAppRuleNeeds): the line names both, so they are
 * never taken for hers (review of f06d9276).
 */
export function appRulesWaitingLine(waiting) {
  const failed = waiting?.failed === true;
  const saved = DEGREE_LABELS[waiting?.profession];
  if (saved) {
    const shown = DEGREE_LABELS[waiting.shownProfession];
    const onScreen = shown ? `the rules on screen are for ${shown}` : "the rules on screen are not the ones for it";
    return failed
      ? `Your profession is now ${saved}. Until the PA and NP rules load, ${onScreen}. ${APP_RULES_UNAVAILABLE}`
      : `Your profession is now ${saved}. Loading the PA and NP rules; until then, ${onScreen}.`;
  }
  return failed
    ? `Your change is saved. What needs the PA and NP rules shows once they load. ${APP_RULES_UNAVAILABLE}`
    : "Loading the PA and NP rules. What needs them shows in a moment.";
}

/** Tests only: the loader the next load uses, and a clean slate. */
export function _setAppRulesImporter(fn) { importRules = fn; loading = null; failed = false; }
