// Where a physician renews a licence, and what a licence card's one-line
// renewal box (RenewalInfo.jsx) shows.
//
// The MD/DO route selection lives here once. Vera's renewal evidence
// (assistantEvidence.js) and the card both read it, so the card can no longer
// send a DO to an MD-only renewal page that Vera already knew to avoid
// (Arizona's md-renewal-application, West Virginia's /practitioners/MD/renew/).
//
// Pure: plain node tests import it.

import { RENEWAL_INFO } from "../constants/renewalInfo.js";
import { STATE_REQS } from "../constants/stateRequirements.js";
import { ASSISTANT_SOURCES } from "../constants/assistantSources.js";
import { getStatusColor } from "./helpers.js";

export const DEA_PORTAL = "https://www.deadiversion.usdoj.gov/online_forms_apps.html";
// When the DEA fee text was last checked (added with the renewal links on
// 2026-08-19, alongside the state dataset's August 2026 review).
const DEA_RESEARCHED = "2026-08";
const LABEL_MAX = 60;

const degreeOf = (value) => (value === "MD" || value === "DO" ? value : null);
const https = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

/**
 * The board and portal for a state and degree. A DO in a state with a
 * separate osteopathic board goes to that board. A DO in a state whose rules
 * split by degree but whose DO route is not on file gets no board or portal at
 * all (unknownDORoute): only the state guide, never a guessed MD page.
 */
export function renewalRoute(jurisdiction, degree) {
  const r = Object.hasOwn(RENEWAL_INFO, jurisdiction) ? RENEWAL_INFO[jurisdiction] : null;
  if (!r) return null;
  const d = degreeOf(degree);
  const separateDO = !!(r.doBoardUrl && r.doBoardUrl !== r.boardUrl && r.doBoard && !/^null\b/i.test(r.doBoard));
  const splitRules = !!(STATE_REQS[jurisdiction]?.md || STATE_REQS[jurisdiction]?.do);
  const unknownDORoute = d === "DO" && splitRules && !separateDO;
  const useDO = d === "DO" && separateDO;
  return {
    jurisdiction, degree: d, separateDO, unknownDORoute,
    degreeSelectionNeeded: !d && splitRules,
    board: unknownDORoute ? null : useDO ? r.doBoard : r.board,
    boardUrl: unknownDORoute ? null : https(useDO ? r.doBoardUrl : r.boardUrl),
    portal: unknownDORoute ? null : https(useDO ? r.doBoardUrl : r.portalUrl),
    alternativeDOBoard: !d && separateDO ? { name: r.doBoard, url: https(r.doBoardUrl) } : null,
    guide: https(r.guideUrl),
  };
}

/** "Colorado Medical Board" from "Colorado Medical Board (Department of Regulatory Agencies, ...)". */
export function shortBoardName(board) {
  const s = String(board || "").replace(/\s+/g, " ").trim();
  const cut = s.indexOf(" (");
  return (cut > 0 ? s.slice(0, cut) : s).trim();
}

/** The portal button's label: the board's short name, or "Renew online" when that runs past 60 characters. */
export function portalLabel(board) {
  const short = shortBoardName(board);
  const label = short ? `Renew at ${short}` : "";
  return label && label.length <= LABEL_MAX ? label : "Renew online";
}

/**
 * The cycle's leading phrase, "Biennial (2 years)", for the one-line view.
 * The dataset writes whole sentences ("Biennial (2 years) for MDs. Annual
 * (1 year) for DOs."), so a stated degree picks its own phrase when the
 * sentence names one.
 */
export function shortCycle(cycle, degree) {
  const text = String(cycle || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const phrase = "(Annual|Biennial|Triennial)\\s*\\(([^)]*)\\)";
  const d = degreeOf(degree);
  if (d) {
    const own = text.match(new RegExp(`${phrase}\\s+for\\s+${d}s\\b`, "i"));
    if (own) return `${own[1]} (${own[2]})`;
  }
  const lead = text.match(new RegExp(`^${phrase}`, "i"));
  if (lead) return `${lead[1]} (${lead[2]})`;
  const first = text.split(/[.;,]/)[0].trim();
  return first.length <= 40 ? first : `${first.slice(0, 37).trimEnd()}...`;
}

/** "Aug 2026" from a recorded review such as "2026-08" or "2026-08 (single-source)". */
export function researchedLabel(recorded) {
  const m = String(recorded || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : null;
}

/**
 * Everything the renewal box shows for one licence, or null when it shows
 * nothing (not a licence or DEA, or no researched state data).
 *
 * The collapsed box is one line: "How to renew", the short cycle, and the
 * portal button only when the licence is urgent (inside the 90-day window or
 * past it). Due-date and fee prose never reach that line; the fee appears only
 * in the expansion, labelled with when it was last researched.
 */
export function renewalView(item, degree, { alertable = true } = {}) {
  if (!item || !/license|dea/i.test(item.type || "")) return null;
  const st = item.state;
  const info = st && Object.hasOwn(RENEWAL_INFO, st) ? RENEWAL_INFO[st] : null;
  if (!info) return null;
  const isDea = /dea/i.test(item.type || "");
  const color = getStatusColor(item.expirationDate);
  const urgent = alertable && (color === "red" || color === "orange" || color === "amber");
  const route = isDea ? null : renewalRoute(st, degree);
  const researched = researchedLabel(isDea ? DEA_RESEARCHED : ASSISTANT_SOURCES.renewalSources?.[st]?.recordedReview);
  const authority = isDea ? "the DEA" : "the board";

  const portal = isDea ? DEA_PORTAL : route.portal;
  // Degree unknown in a state with a separate osteopathic board: either board
  // could be the physician's, so neither goes on the line. Both are in the
  // expansion.
  const ambiguous = !isDea && !!route.alternativeDOBoard;
  const cycleShort = isDea ? "every 3 years" : shortCycle(info.cycle, degree);
  const cycleFull = isDea ? null : String(info.cycle || "").trim() || null;
  const fee = isDea ? "$888" : (info.fee || null);
  return {
    isDea, urgent,
    cycleShort,
    cycleFull: cycleFull && cycleFull !== cycleShort ? cycleFull : null,
    portal,
    portalLabel: isDea ? "Renew at the DEA" : portalLabel(route.board),
    showPortalOnLine: urgent && !!portal && !ambiguous,
    board: isDea ? null : shortBoardName(route.board) || null,
    alternativeBoard: isDea || !route.alternativeDOBoard?.url ? null
      : { name: shortBoardName(route.alternativeDOBoard.name), url: route.alternativeDOBoard.url },
    unknownDORoute: !isDea && route.unknownDORoute,
    guide: isDea ? null : route.guide,
    due: isDea ? null : (info.due || null),
    fee,
    feeCaption: fee ? `last researched ${researched || "on an unrecorded date"}, confirm with ${authority}` : null,
  };
}
