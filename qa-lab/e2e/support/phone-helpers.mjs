// Phone layouts: the two phone sizes the phone journeys run at, a guarded
// phone browser for two-device checks, the phone's own navigation (the fixed
// bottom tab bar has no landmark, so the desk helpers' goTab cannot find it),
// and the layout audit every phone screen gets.
//
// The audit (layoutAudit / auditScreen) measures, in the page:
//   * horizontal page scroll: the document, and the phone shell's own scroller
//     (App.jsx: on phone the content scrolls in one div, not the document);
//   * content past the phone's edges that nothing lets the physician scroll to
//     (html, body and #root clip overflow-x, so it is cut off, not scrollable);
//   * text cut off by its own box or an ancestor that hides overflow, and a
//     control whose label is shortened to an ellipsis ("Invoi…"); a long value
//     (an email address in a list) shortened with an ellipsis is by design and
//     only listed;
//   * every control on screen smaller than 32 x 32 CSS px (the tap-target
//     floor these journeys use; WCAG 2.2's minimum is 24 x 24).
// Primary controls are named per screen and each is scrolled to the middle of
// the screen and checked: on screen, at least 32 x 32, and the topmost element
// at its centre (not covered by the top bar, the bottom bar or anything else).
//
// Everything here drives the lab only (the guarded contexts of fixtures.mjs).
import { guardContext, watchPage } from './fixtures.mjs';
import {
  createPhysician, dismissInterruptions, lab, landing, profileOf, signIn, sleep, waitForMemberApp, waitForProfile,
} from './lab.mjs';

const IPHONE_UA = (os) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1`;

/**
 * The phones. Full-screen sizes (the app installed to the home screen, the
 * way the PWA is meant to be used; Safari's own bars would take 180 px more).
 * Chromium with an iPhone user agent, touch and mobile viewport emulation.
 */
export const PHONES = {
  375: { name: '375x812', viewport: { width: 375, height: 812 }, screen: { width: 375, height: 812 }, userAgent: IPHONE_UA('17_6'), deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  390: { name: '390x844', viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: IPHONE_UA('18_6'), deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

/** Context options for test.use(): one phone. */
export function phoneUse(width) {
  const options = { ...PHONES[width] };
  delete options.name;
  return options;
}

/** The tap-target floor the phone journeys hold every control to. */
export const MIN_TAP = 32;

/** A second, clean phone browser (no storage shared with `page`), guarded like every journey's. */
export async function secondPhone(browser, report, width) {
  const context = await browser.newContext(phoneUse(width));
  await guardContext(context, report);
  const page = await context.newPage();
  watchPage(page, report);
  return { context, page };
}

// ── The phone's own navigation ───────────────────────────────────────────────

/**
 * The fixed bottom tab bar (App.jsx, phone only): the element that holds the
 * "Home" and "More" tab buttons and is fixed to the bottom of the screen.
 */
export function bottomBar(page) {
  return page.locator('div').filter({ has: page.getByRole('button', { name: /^Home$/ }) }).filter({ has: page.getByRole('button', { name: /^More$/ }) })
    .filter({ hasNot: page.locator('div').filter({ has: page.getByRole('button', { name: /^Home$/ }) }).filter({ has: page.getByRole('button', { name: /^More$/ }) }) }).last();
}

/** Taps a bottom-bar tab by its label ("Home", "Credentials", "Practice", "More"); `+` is the centre button. */
export async function phoneTab(page, name) {
  const bar = bottomBar(page);
  if (name === '+') return bar.locator('button').nth(2).tap();
  await bar.getByRole('button', { name: new RegExp(`^(\\S+ )?${name}$`) }).first().tap();
}

/** The top bar's Back button (a Credentials or More subpage). */
export function backButton(page) { return page.getByRole('button', { name: /^Back$/ }).first(); }

/** The row of Credentials' phone list for a section ("🪣 Licenses 0 items ›"). */
export function credentialsRow(page, section) {
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByRole('button', { name: new RegExp(`^\\S+ ${esc}( |$)`) }).first();
}

/** Credentials > <section> on the phone: the Credentials tab's grouped list, then the row. */
export async function phoneCredentials(page, section) {
  await phoneTab(page, 'Credentials');
  if (!section) return;
  const rowButton = credentialsRow(page, section);
  await rowButton.scrollIntoViewIfNeeded();
  await rowButton.tap();
}

/** More > <item> on the phone. */
export async function phoneMore(page, item) {
  await phoneTab(page, 'More');
  const b = page.getByRole('button', { name: new RegExp(`^(\\S+ )?${item}`) }).first();
  await b.scrollIntoViewIfNeeded();
  await b.tap();
}

/**
 * A fresh ACTIVE member on a phone, the way newMember() makes one (created on
 * the QA sign-in, founding offer paid on the Checkout stand-in, the app opened
 * again once active), with taps. The lab's founding places are shared by
 * every journey running at once; when the product answers
 * founding_capacity_pending ("Founding checkout is temporarily unavailable
 * while existing checkouts are resolved ... check again shortly") the
 * physician checks again, as the message asks, up to `attempts` times.
 */
export async function newPhoneMember(page, opts = {}, { attempts = 8, waitMs = 30000 } = {}) {
  const user = await createPhysician(opts);
  await signIn(page, user);
  const { where, seen } = await landOnGate(page);
  if (where !== 'gate') throw new Error(`a new physician should land on the membership gate, landed on: ${where} ${seen.join(', ')}`);
  const rt = lab();
  await reviewOffer(page, { attempts, waitMs });
  await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).tap();
  await page.getByRole('button', { name: 'Continue to secure payment' }).tap();
  const pay = page.getByTestId('qa-stripe-pay');
  await pay.waitFor({ timeout: 60000 });
  await pay.tap();
  await page.waitForURL((u) => u.origin === rt.urls.appOrigin && u.searchParams.get('billing') === 'complete', { timeout: 120000 });
  await waitForProfile(user.id, (p) => p.access_status === 'active', 90000);
  await waitForMemberApp(page);
  await page.goto(rt.urls.app, { waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  await dismissInterruptions(page);
  return { user, profile: profileOf(user.id) };
}

/**
 * After a sign-in: waits for the membership gate. When the lab's edge runtime,
 * busy with other agents' journeys, answered initialize-clerk-profile 503
 * ("Your account identity could not be verified ... H503"), taps Try again
 * (and reloads), as the screen asks, up to `attempts` times. Returns where the
 * page landed and the support references seen on the way.
 */
export async function landOnGate(page, { attempts = 4 } = {}) {
  const seen = [];
  for (let i = 1; ; i++) {
    const gate = page.getByRole('region', { name: 'Membership' });
    const retry = page.getByRole('button', { name: 'Try again' }).first();
    const where = await Promise.race([
      gate.waitFor({ timeout: 60000 }).then(() => 'gate'),
      retry.waitFor({ timeout: 60000 }).then(() => 'retry'),
    ]).catch(() => 'timeout');
    if (where === 'gate' || i >= attempts) return { where, seen };
    seen.push(((await page.locator('body').innerText().catch(() => '')).match(/Support reference: [A-Z0-9-]+/) || [where])[0]);
    if (where === 'retry') await retry.tap().catch(() => {});
    await sleep(4000);
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
  }
}

/**
 * From the membership gate: taps "Review ... offer" and waits for the offer
 * with its Continue button. When the product answers founding_capacity_pending
 * (the lab's shared founding places are held by checkouts of journeys running
 * at the same time), it checks again after `waitMs`, as the message asks.
 * Returns how many tries it took.
 */
export async function reviewOffer(page, { attempts = 8, waitMs = 30000 } = {}) {
  const rt = lab();
  for (let i = 1; ; i++) {
    // Under load (several agents' journeys at once) the lab's edge runtime can answer
    // initialize-clerk-profile 503 ("Your account identity could not be verified ... Reload to
    // try again"); the physician taps Try again, as the screen asks.
    const review = page.getByRole('button', { name: /Review .* offer/ }).first();
    const retry = page.getByRole('button', { name: 'Try again' }).first();
    const first = await Promise.race([
      review.waitFor({ timeout: 45000 }).then(() => 'gate'),
      retry.waitFor({ timeout: 45000 }).then(() => 'retry'),
    ]).catch(() => 'timeout');
    if (first !== 'gate') {
      if (i >= attempts) throw new Error(`the membership gate did not come back (${first}) after ${attempts} tries`);
      if (first === 'retry') await retry.tap().catch(() => {});
      await sleep(5000);
      await page.goto(rt.urls.app, { waitUntil: 'domcontentloaded' });
      await landing(page);
      continue;
    }
    await review.tap();
    const proceed = page.getByRole('button', { name: 'Continue to secure payment' });
    const busy = page.getByText(/temporarily unavailable while existing checkouts are resolved/).first();
    const state = await Promise.race([
      proceed.waitFor({ timeout: 60000 }).then(() => 'offer'),
      busy.waitFor({ timeout: 60000 }).then(() => 'busy'),
    ]).catch(() => 'timeout');
    if (state === 'offer') return i;
    if (i >= attempts) throw new Error(`the founding checkout stayed unavailable (${state}) after ${attempts} tries: the lab's shared founding places are held by running journeys`);
    await sleep(waitMs);
    await page.goto(rt.urls.app, { waitUntil: 'domcontentloaded' });
    await landing(page);
  }
}

/** Signs `user` in on a phone and waits for the member app. */
export async function signInPhone(page, user) {
  await signIn(page, user);
  await waitForMemberApp(page);
  await dismissInterruptions(page);
  await sleep(800);
}

/** Reload and wait for the member app again (the phone's bottom bar). */
export async function reloadPhone(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  await sleep(800);
}

// ── Layout audit ─────────────────────────────────────────────────────────────

/**
 * Measures the screen as it is now. `scope` (a CSS selector) limits the
 * clipping and small-target sweep to one part of the page (e.g. an open
 * dialog); the page-scroll figures are always the whole page's.
 */
export async function layoutAudit(page, { scope = null, minTap = MIN_TAP } = {}) {
  return page.evaluate(({ scope, minTap }) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const doc = document.scrollingElement || document.documentElement;
    const cs = (el) => getComputedStyle(el);
    const shown = (el) => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const s = cs(n);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const text = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const box = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    const label = (el) => {
      const t = text(el);
      const tag = el.tagName.toLowerCase() + (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '') + (el.type && el.tagName === 'INPUT' ? `[type=${el.type}]` : '');
      return t ? `${tag} "${t}"` : `${tag} (no text; ${el.querySelector('svg') ? 'icon' : 'empty'})`;
    };
    // The phone shell's scroller: the tall div, as high as the screen, that scrolls the content.
    const shell = [...document.querySelectorAll('#root div')].find((d) => {
      const s = cs(d);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && Math.abs(d.clientHeight - vh) < 3 && d.parentElement && cs(d.parentElement).overflow === 'hidden';
    }) || null;
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return { vw, vh, error: `no element matches ${scope}` };
    const inScroller = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        if (n === shell) return null;
        const s = cs(n);
        if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) return n;
      }
      return null;
    };
    // The nearest ancestor that hides overflow, unless a scroll container sits in between (content
    // there can be scrolled into view; sideways overflow inside it is listed under scrollers).
    const clipper = (el) => {
      for (let n = el.parentElement; n && n !== document.body && n.id !== 'root'; n = n.parentElement) {
        if (n === shell) return null;
        const s = cs(n);
        if (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.overflow === 'hidden') return n;
        if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowX === 'auto' || s.overflowX === 'scroll') return null;
      }
      return null;
    };
    const hasOwnText = (el) => [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    const CONTROL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=link], [role=menuitem], [role=option]';

    const out = {
      vw, vh,
      page: { docScrollWidth: doc.scrollWidth, shellScrollWidth: shell?.scrollWidth ?? null, shellClientWidth: shell?.clientWidth ?? null, shellFound: !!shell },
      scrollers: [], offscreen: [], clipped: [], ellipsis: [], small: [], inline: [],
    };
    out.page.horizontalScroll = doc.scrollWidth > vw + 1 || (!!shell && shell.scrollWidth > shell.clientWidth + 1);

    const seen = new Set();
    for (const el of root.querySelectorAll('*')) {
      if (!shown(el)) continue;
      const s = cs(el);
      const r = el.getBoundingClientRect();
      // Horizontal scrollers other than the shell (carousels, wide tables): listed.
      if (el !== shell && (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
        out.scrollers.push({ el: label(el).slice(0, 80), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, snap: s.scrollSnapType !== 'none' });
      }
      const isControl = el.matches(CONTROL);
      const isText = hasOwnText(el);
      if (!isControl && !isText) continue;
      // Past the phone's edges, where no scroller can bring it back.
      if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) {
        const c = clipper(el);
        const key = `off:${label(el)}`;
        if (!seen.has(key)) { seen.add(key); out.offscreen.push({ el: label(el), box: box(r), clippedBy: c ? label(c).slice(0, 60) : null }); }
      }
      if (isText) {
        // Text cut off inside its own box.
        const hides = s.overflowX === 'hidden' || s.overflowX === 'clip' || s.overflow === 'hidden';
        if (hides && el.scrollWidth > el.clientWidth + 1) {
          const control = el.closest(CONTROL);
          (s.textOverflow === 'ellipsis' ? out.ellipsis : out.clipped).push({ el: label(el), box: box(r), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, how: 'own box', control: control ? label(control) : null });
        } else if (hides && el.scrollHeight > el.clientHeight + 2 && !/-webkit-box/.test(s.display)) {
          out.clipped.push({ el: label(el), box: box(r), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, how: 'own box (height)' });
        } else if (s.webkitLineClamp && s.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 2) {
          out.ellipsis.push({ el: label(el), box: box(r), how: `line clamp ${s.webkitLineClamp}` });
        }
        // Text cut off by an ancestor that hides overflow.
        const c = clipper(el);
        // An ancestor that truncates with an ellipsis is listed as that ellipsis already.
        if (c && cs(c).textOverflow !== 'ellipsis') {
          const cr = c.getBoundingClientRect();
          if (r.right > cr.right + 1 || r.left < cr.left - 1 || r.bottom > cr.bottom + 2 || r.top < cr.top - 2) {
            const cc = cs(c);
            if (!((cc.overflowY === 'auto' || cc.overflowY === 'scroll') && (r.bottom > cr.bottom || r.top < cr.top) && r.right <= cr.right + 1 && r.left >= cr.left - 1)) {
              out.clipped.push({ el: label(el), box: box(r), by: `${label(c).slice(0, 60)} ${JSON.stringify(box(cr))}`, how: 'ancestor' });
            }
          }
        }
      }
      if (isControl) {
        let t = el;
        // A checkbox or radio is tapped through its label.
        if (el.matches('input[type=checkbox], input[type=radio]')) t = el.closest('label') || el;
        const tr = t.getBoundingClientRect();
        // A link inside a sentence is exempt (WCAG 2.5.8's inline exception); listed apart.
        const inlineLink = el.matches('a') && s.display === 'inline' && el.parentElement && hasOwnText(el.parentElement);
        if (inlineLink && Math.min(tr.width, tr.height) < minTap - 0.5) { out.inline.push({ el: label(el), size: `${Math.round(tr.width)}x${Math.round(tr.height)}` }); continue; }
        if (Math.min(tr.width, tr.height) < minTap - 0.5) {
          const key = `small:${label(el)}:${box(tr).join(',')}`;
          if (!seen.has(key)) { seen.add(key); out.small.push({ el: label(el), size: `${Math.round(tr.width)}x${Math.round(tr.height)}`, box: box(tr) }); }
        }
      }
    }
    return out;
  }, { scope, minTap });
}

/**
 * One primary control, the way a thumb reaches it: scrolled to the middle of
 * the screen, then on screen, at least MIN_TAP x MIN_TAP, and the topmost
 * element at its centre.
 */
export async function tapTarget(locator, { minTap = MIN_TAP } = {}) {
  const handle = await locator.elementHandle({ timeout: 10000 }).catch(() => null);
  if (!handle) return { ok: false, found: false, why: 'not found' };
  return handle.evaluate((el, minTap) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let target = el;
    if (el.matches('input[type=checkbox], input[type=radio]')) target = el.closest('label') || el;
    const r = target.getBoundingClientRect();
    const onScreen = r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1 && r.width > 0 && r.height > 0;
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const hit = document.elementFromPoint(cx, cy);
    // A disabled button takes no tap; the app wraps some in a span that answers the tap instead
    // (LimitedLaunchMembership's consent gate), and hit testing returns that wrapper.
    const covered = !(hit && (target.contains(hit) || el.contains(hit) || hit === target || (el.disabled && hit.contains(el))));
    const describe = (n) => n ? `${n.tagName.toLowerCase()} "${(n.getAttribute('aria-label') || n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"` : 'nothing';
    const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    const bigEnough = r.width >= minTap - 0.5 && r.height >= minTap - 0.5;
    const why = [!onScreen && `off screen at ${Math.round(r.left)},${Math.round(r.top)} ${size}`, !bigEnough && `${size} (< ${minTap})`, covered && `covered by ${describe(hit)}`].filter(Boolean).join('; ');
    return { ok: onScreen && bigEnough && !covered, found: true, onScreen, bigEnough, covered, size, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], coveredBy: covered ? describe(hit) : null, why };
  }, minTap);
}

const summarize = (list, n = 8) => list.slice(0, n).map((x) => `${x.el}${x.size ? ` ${x.size}` : ''}${x.box ? ` @${x.box.join(',')}` : ''}${x.by ? ` by ${x.by}` : ''}`).join(' | ') + (list.length > n ? ` | +${list.length - n} more` : '');

/**
 * The checks for one phone screen, recorded on the current checklist stretch:
 * no horizontal page scroll, nothing past the edges, no text cut off, every
 * control on screen at least 32 px, and each named primary control reachable.
 * `primary` is [[name, locator], ...]. `allowSmall` (a RegExp on the control's
 * description) exempts controls a journey has already reported as a bug or
 * found to be by design, so each is counted once; `allowScrollers` likewise for
 * an intentional horizontal scroller (a snap-scroll card row).
 * Returns the audit, with `.primary` results.
 */
export async function auditScreen(qa, page, name, { primary = [], scope = null, allowSmall = null, allowClipped = null, shotName } = {}) {
  await sleep(400);
  const audit = await layoutAudit(page, { scope });
  if (audit.error) { qa.check(`${name}: the screen is there`, false, audit.error); return audit; }
  audit.primary = [];
  qa.check(`${name}: no horizontal page scroll`, !audit.page.horizontalScroll,
    `document ${audit.page.docScrollWidth}px, content scroller ${audit.page.shellScrollWidth}/${audit.page.shellClientWidth}px, screen ${audit.vw}px`);
  qa.check(`${name}: nothing sits past the screen's edges`, audit.offscreen.length === 0, summarize(audit.offscreen));
  const cut = [...audit.clipped, ...audit.ellipsis.filter((e) => e.control).map((e) => ({ ...e, el: `${e.control} label cut to an ellipsis` }))];
  const clipped = cut.filter((c) => !(allowClipped && allowClipped.test(c.el)));
  const longValues = audit.ellipsis.filter((e) => !e.control);
  qa.check(`${name}: no text cut off`, clipped.length === 0, summarize(clipped) + (longValues.length ? ` (long values shortened with an ellipsis, by design: ${summarize(longValues, 4)})` : ''));
  const small = audit.small.filter((s) => !(allowSmall && allowSmall.test(s.el)));
  qa.check(`${name}: every control at least ${MIN_TAP}x${MIN_TAP}px`, small.length === 0, summarize(small, 12));
  for (const [label, locator] of primary) {
    const t = await tapTarget(locator);
    audit.primary.push({ label, ...t });
    qa.check(`${name}: "${label}" is on screen, ${MIN_TAP}px or larger and not covered`, t.ok, t.found ? `${t.size}${t.why ? `: ${t.why}` : ''}` : 'not found on this screen');
  }
  await qa.shot(shotName || name);
  return audit;
}

/**
 * An open dialog on the phone: it fits the screen (all four edges inside),
 * its close button is reachable, its body does not scroll sideways, and
 * `actions` (its primary buttons, [[name, locator]]) can be reached.
 */
export async function auditDialog(qa, page, name, dialog, { actions = [], allowSmall = null } = {}) {
  await sleep(500);
  const vp = page.viewportSize();
  const r = await dialog.boundingBox();
  qa.check(`${name}: the dialog fits the screen`, !!r && r.x >= -1 && r.y >= -1 && r.x + r.width <= vp.width + 1 && r.y + r.height <= vp.height + 1,
    r ? `dialog ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} on ${vp.width}x${vp.height}` : 'no dialog box');
  const inner = await dialog.evaluate((d) => {
    const body = d.querySelector('[data-modal-body]') || d;
    return { bodyScrollWidth: body.scrollWidth, bodyClientWidth: body.clientWidth };
  });
  qa.check(`${name}: the dialog body does not scroll sideways`, inner.bodyScrollWidth <= inner.bodyClientWidth + 1, `${inner.bodyScrollWidth}/${inner.bodyClientWidth}px`);
  const id = await dialog.evaluate((d) => { d.setAttribute('data-qa-phone-audit', '1'); return true; });
  const audit = await layoutAudit(page, { scope: '[data-qa-phone-audit="1"]' });
  await dialog.evaluate((d) => d.removeAttribute('data-qa-phone-audit')).catch(() => {});
  if (!audit.error && id) {
    qa.check(`${name}: nothing in the dialog sits past the screen's edges`, audit.offscreen.length === 0, summarize(audit.offscreen));
    qa.check(`${name}: no text cut off in the dialog`, audit.clipped.length === 0, summarize(audit.clipped));
    const small = audit.small.filter((s) => !(allowSmall && allowSmall.test(s.el)));
    qa.check(`${name}: every control in the dialog at least ${MIN_TAP}x${MIN_TAP}px`, small.length === 0, summarize(small, 12));
  }
  const close = dialog.getByRole('button', { name: 'Close dialog' }).first();
  if (await close.count()) {
    const t = await tapTarget(close);
    qa.check(`${name}: the close button is reachable`, t.ok, `${t.size}${t.why ? `: ${t.why}` : ''}`);
  }
  const results = [];
  for (const [label, locator] of actions) {
    const t = await tapTarget(locator);
    results.push({ label, ...t });
    qa.check(`${name}: "${label}" can be reached in the dialog`, t.ok, t.found ? `${t.size}${t.why ? `: ${t.why}` : ''}` : 'not found in the dialog');
  }
  await qa.shot(`${name} dialog`);
  return { box: r, audit, actions: results };
}

/** Closes a dialog with its own close button (a tap) and checks it went away. */
export async function closeDialog(qa, name, dialog) {
  const close = dialog.getByRole('button', { name: 'Close dialog' }).first();
  const cancel = dialog.getByRole('button', { name: /^(Cancel|Close|Done|Not now)$/ }).first();
  const control = (await close.count()) ? close : cancel;
  if (!(await control.count())) { qa.check(`${name}: the dialog has a close or Cancel button`, false); return false; }
  await control.tap();
  const gone = await dialog.waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false);
  qa.check(`${name}: a tap on close closes the dialog`, gone);
  return gone;
}

// ── Recording what the audits find ───────────────────────────────────────────

/**
 * Controls that sit on many screens and are checked (and reported) once, on
 * the screen that owns them: the top bar's Back (HOME-004, phone navigation)
 * and Practice's sub-tab strip (checked on Practice > Work). Other screens'
 * sweeps leave them out so each finding is counted against one checklist id.
 */
export const CHROME = {
  back: /^button "Back"$/,
  practiceTabs: /^button "(Work|RVUs|Sched\.|Invoices|Contracts|Exp\.|To do)"( label cut to an ellipsis)?$/,
};
export const exceptChrome = (...keep) => {
  const parts = Object.entries(CHROME).filter(([k]) => !keep.includes(k)).map(([, r]) => r.source);
  return parts.length ? new RegExp(parts.map((p) => `(?:${p})`).join('|')) : null;
};
/** Joins RegExps (null ignored) into one that matches any of them. */
export const anyOf = (...res) => {
  const parts = res.filter(Boolean).map((r) => `(?:${r.source})`);
  return parts.length ? new RegExp(parts.join('|')) : null;
};

const filed = new Set();
/**
 * Bugs are filed from the 375 px journey only, so a run lists each once
 * (Playwright starts a new worker after a failed test, so a per-worker
 * memory would file them again at 390 px). The 390 px journey records the
 * same checks; a layout bug seen only there is filed explicitly.
 */
export const FILING_PHONE = PHONES[375].name;

/**
 * Files each layout bug once (from the 375 px journey): `defs` are { key,
 * feature, kind: 'small' | 'clipped' | 'offscreen', match: RegExp on the
 * audit's control description, title, expected, actual, severity }. Returns
 * the keys found (at either size).
 */
export function fileLayoutBugs(qa, audit, defs, phoneName) {
  const found = [];
  for (const d of defs) {
    const pool = d.kind === 'clipped'
      ? [...(audit.clipped || []), ...(audit.ellipsis || []).filter((e) => e.control).map((e) => ({ ...e, el: `${e.control} label cut to an ellipsis` }))]
      : d.kind === 'offscreen' ? (audit.offscreen || []) : (audit.small || []);
    const hits = pool.filter((x) => d.match.test(x.el));
    if (!hits.length) continue;
    found.push(d.key);
    if (phoneName !== FILING_PHONE || filed.has(d.key)) continue;
    filed.add(d.key);
    const measured = [...new Set(hits.map((h) => `${h.el}${h.size ? ` ${h.size}` : ''}`))].slice(0, 8).join('; ');
    qa.bug({ feature: d.feature, title: d.title, step: `${d.step || ''} (phone ${phoneName})`.trim(), expected: d.expected, actual: `${d.actual} Measured at ${phoneName}: ${measured}.`, severity: d.severity || 'low' });
  }
  return found;
}

/** Files one bug once, from the 375 px journey (a behaviour the audit cannot see, e.g. a tap that does nothing). */
export function fileBugOnce(qa, key, bug, phoneName = FILING_PHONE) {
  if (phoneName !== FILING_PHONE || filed.has(key)) return false;
  filed.add(key);
  qa.bug(bug);
  return true;
}

/** WCAG 2.2's minimum target size (2.5.8, level AA), in CSS px. */
export const WCAG_MIN_TAP = 24;

/**
 * Controls under the lab's 32 px floor that were verified not to be a bug
 * (the floor is these journeys' own; WCAG 2.2 asks for 24 px): each must still
 * be at least WCAG's 24 x 24 (a failed check otherwise), and the difference is
 * recorded once per screen with qa.byDesign and the verdict. Exempt them from
 * the screen's own 32 px check (`allowSmall`) and file no bug for them.
 * Returns the controls found under 32 px.
 */
export function smallByDesign(qa, audit, { id, match, what, why }) {
  const hits = (audit?.small || []).filter((s) => match.test(s.el));
  if (!hits.length) return hits;
  const dims = (s) => String(s.size || '').split('x').map(Number);
  const under = hits.filter((s) => Math.min(...dims(s)) < WCAG_MIN_TAP - 0.5);
  const sizes = [...new Set(hits.map((s) => `${s.el} ${s.size}`))].slice(0, 8).join('; ');
  qa.check(`${what}: at least WCAG 2.2's ${WCAG_MIN_TAP} x ${WCAG_MIN_TAP} px`, under.length === 0, under.length ? under.map((s) => `${s.el} ${s.size}`).join('; ') : sizes);
  qa.byDesign(id, `${what}: under the lab's ${MIN_TAP} px floor (${sizes})`, why);
  return hits;
}

/**
 * Which bottom-bar tab carries the active dot (App.jsx draws a 4 x 4 dot
 * under the active tab), and the bar's box.
 */
export async function barState(page) {
  return bottomBar(page).evaluate((bar) => {
    const r = bar.getBoundingClientRect();
    const active = [...bar.querySelectorAll('button')].find((b) => [...b.querySelectorAll('div')].some((d) => { const q = d.getBoundingClientRect(); return Math.round(q.width) === 4 && Math.round(q.height) === 4; }));
    return { active: active ? active.innerText.replace(/\s+/g, ' ').trim() : null, top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), vh: window.innerHeight };
  });
}

/** Scrolls the phone's content scroller by `dy` px the way a swipe would (wheel over the content). */
export async function scrollContent(page, dy) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.wheel(0, dy);
  await sleep(600);
  return page.evaluate(() => {
    const shell = [...document.querySelectorAll('#root div')].find((d) => { const s = getComputedStyle(d); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && Math.abs(d.clientHeight - window.innerHeight) < 3; });
    return shell ? shell.scrollTop : null;
  });
}
