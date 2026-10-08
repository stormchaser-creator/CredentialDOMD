import { reportError } from "../lib/errorReport.js";

// The steps between sign-up and payment, sent once per page each to the
// client event table (report-error, kind "info"), so a buyer who stops can be
// told apart from a page that stopped them. Before these, an unticked Continue
// tap, the price panel and the trip to Stripe were invisible: a hidden iPhone
// Continue bug would have looked exactly like a buyer who chose not to pay
// (signup review 2026-10-07).
//
// ID-free: the step, which offer and price phase was on screen, whether the
// account is pay-first, and the seconds since the page opened. Never a quote,
// session, checkout or Stripe id, an email, a name or a URL of our own. (The
// report carries the signed-in account and the page address like every
// client report; the page address never holds a Checkout id.)
export const FUNNEL_STEPS = Object.freeze({
  membership_page_shown: "Funnel: membership page shown",
  price_panel_shown: "Funnel: price shown",
  continue_tapped_unticked: "Funnel: Continue tapped before the box was ticked",
  checkout_redirected: "Funnel: sent to Stripe Checkout",
  billing_return_complete: "Funnel: back from Checkout, completed",
  billing_return_canceled: "Funnel: back from Checkout, canceled",
});
const OFFERS = new Set(["core", "core_locum"]);
const PHASES = new Set(["founding", "earlybird", "standard"]);

const sent = new Set();
let reporter = (message, extra) => reportError(message, "info", extra);
/** Tests only: where steps go, and a new page. */
export function setFunnelReporter(fn) { reporter = typeof fn === "function" ? fn : (message, extra) => reportError(message, "info", extra); sent.clear(); }

const pageSeconds = () => {
  try {
    const now = globalThis.performance?.now?.();
    return Number.isFinite(now) ? Math.round(now / 100) / 10 : null;
  } catch { return null; }
};

/** Once per page per step. Returns whether it was sent. */
export function reportFunnelStep(step, { offer, phase, payFirst } = {}) {
  if (!Object.hasOwn(FUNNEL_STEPS, step) || sent.has(step)) return false;
  sent.add(step);
  const extra = { event: `funnel_${step}`, step, pageSeconds: pageSeconds() };
  if (OFFERS.has(offer)) extra.offer = offer;
  if (PHASES.has(phase)) extra.phase = phase;
  if (typeof payFirst === "boolean") extra.payFirst = payFirst;
  try { reporter(FUNNEL_STEPS[step], extra); } catch { /* reporting never blocks */ }
  return true;
}
