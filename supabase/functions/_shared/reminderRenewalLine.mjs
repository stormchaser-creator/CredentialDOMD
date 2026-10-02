// The "where to renew" line under each licence in the reminder email.
//
// Pulled out of send-reminders/index.ts so node tests can pin it. MD and DO
// get exactly the line they always got. A PA, RN or APRN licence (held by a
// PA, an NP or a member who has not chosen a profession) gets its own board's
// link, "Board: <url>", from appBoardLinks.json, which scripts/generate-app-
// rules.mjs writes from the PA and NP rule data: never the medical board's
// portal. A PA or NP member's other rows get no line, except the DEA one, and
// neither does a PA or NP only record (certification, prescriptive authority,
// practice agreement) of a member with no profession chosen.
//
// Plain JavaScript so the Deno function and the node tests share one copy.
import { licenseKindOf } from './app/constants/professions.js';

export const DEA_RENEW_URL = 'https://www.deadiversion.usdoj.gov/online_forms_apps.html';
const APP_KINDS = new Set(['pa', 'rn', 'aprn']);
// Records only a PA or an NP holds: a national certification (NCCPA, an NP
// certifier), prescriptive authority, a practice agreement. Intake and the
// scanner can file one for a member with no profession chosen; the medical
// board's portal is never where it renews, so such a row gets no line.
const APP_ONLY_KINDS = new Set(['cert', 'rx', 'agreement']);

/**
 * item: { isDea, isLicense, state, type }; degree: profiles.degree_type.
 * renewalLinks: send-reminders/renewalLinks.json; appBoardLinks: appBoardLinks.json.
 */
export function renewalLineFor(item, degree, { renewalLinks = {}, appBoardLinks = {} } = {}) {
  if (item.isDea) return `\n      Renew: ${DEA_RENEW_URL}`;
  if (!item.isLicense || !item.state) return '';
  const physician = degree === 'MD' || degree === 'DO';
  const kind = licenseKindOf(item.type);
  if (!physician && APP_KINDS.has(kind)) {
    const link = appBoardLinks[item.state]?.[kind === 'pa' ? 'pa' : 'np'];
    const url = link?.url;
    // A PA working with a DO may be licensed by the osteopathic board
    // (Pennsylvania, Nevada, Maine, West Virginia): the board name says so.
    const osteopathic = kind === 'pa' && /osteopathic/i.test(link?.board || '') ? `\n      ${link.board}` : '';
    return url ? `\n      Board: ${url}${osteopathic}` : '';
  }
  if (degree === 'PA' || degree === 'NP') return '';
  if (!physician && APP_ONLY_KINDS.has(kind)) return '';
  const r = renewalLinks[item.state];
  if (!r?.portal) return '';
  return `\n      Renew: ${r.portal}${r.guide ? `\n      Steps and fees: ${r.guide}` : ''}`;
}
