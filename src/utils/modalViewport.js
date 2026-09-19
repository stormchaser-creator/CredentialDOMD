/** Keep modal geometry in the visual viewport without scrolling its ancestors. */
export function readModalViewport(win) {
  const vv = win.visualViewport;
  return {
    top: Math.max(0, vv?.offsetTop || 0),
    left: Math.max(0, vv?.offsetLeft || 0),
    height: vv?.height > 0 ? vv.height : win.innerHeight,
    width: vv?.width > 0 ? vv.width : win.innerWidth,
  };
}

/** Move only the form's scroll container, and only enough to reveal the field. */
export function revealModalField(body, field) {
  if (!field || !body.contains(field)) return;
  const bounds = body.getBoundingClientRect();
  const target = field.getBoundingClientRect();
  // Font-size settings zoom the card. DOM rects include that scale, while
  // scrollTop/clientHeight are in the element's own CSS pixels.
  const scale = body.offsetHeight ? bounds.height / body.offsetHeight : 1;
  if (!(scale > 0) || bounds.height <= 0) return;
  const gap = 8 * scale;
  const top = bounds.top + gap;
  const bottom = bounds.bottom - gap;
  let delta = 0;
  if (target.top < top || target.height > bottom - top) delta = target.top - top;
  else if (target.bottom > bottom) delta = target.bottom - bottom;
  const max = Math.max(0, body.scrollHeight - body.clientHeight);
  body.scrollTop = Math.max(0, Math.min(max, body.scrollTop + delta / scale));
}

const isField = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || "") || el?.isContentEditable;

/**
 * A very short viewport plus large text may not fit even the header and
 * buttons. Let the whole dialog scroll in that case; clipping the buttons
 * or shrinking the physician's chosen text size is not a useful fallback.
 */
export function fitModalScroll(card, body, previous = body) {
  if (!card) return body;
  const fixedHeight = Array.from(card.children)
    .filter(child => child !== body)
    .reduce((sum, child) => sum + child.offsetHeight, 0);
  const compact = card.clientHeight - fixedHeight < 80;
  const next = compact ? card : body;
  const position = previous.scrollTop;
  card.style.display = compact ? "block" : "flex";
  card.style.overflowY = compact ? "auto" : "hidden";
  body.style.overflowY = compact ? "visible" : "auto";
  body.style.overflowX = compact ? "visible" : "hidden";
  card.setAttribute("data-modal-scroll-mode", compact ? "dialog" : "body");
  if (next !== previous) {
    previous.scrollTop = 0;
    next.scrollTop = position;
  }
  return next;
}

/** Returns cleanup; delayed keyboard callbacks never survive blur or close. */
export function watchModalViewport({ win, overlay, body, card, isTop = () => true }) {
  const vv = win.visualViewport;
  const doc = body.ownerDocument;
  let viewport = readModalViewport(win);
  let frame = null;
  let focusTimer = null;
  let reveal = false;
  let disposed = false;
  let scroller = body;

  const update = () => {
    frame = null;
    if (disposed) return;
    const next = readModalViewport(win);
    overlay.style.top = `${next.top}px`;
    overlay.style.left = `${next.left}px`;
    overlay.style.width = `${next.width}px`;
    overlay.style.height = `${next.height}px`;
    overlay.style.setProperty("--modal-viewport-height", `${next.height}px`);
    overlay.style.setProperty("--modal-viewport-width", `${next.width}px`);
    scroller = fitModalScroll(card, body, scroller);
    // Expanding the viewport on keyboard dismissal must release the old
    // scroll limit, without re-centering a field the user finished editing.
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (scroller.scrollTop > max) scroller.scrollTop = max;
    if (reveal && isTop() && isField(doc.activeElement)) revealModalField(scroller, doc.activeElement);
    reveal = false;
    viewport = next;
  };
  const schedule = (showField = false) => {
    reveal = reveal || showField;
    if (frame == null) frame = win.requestAnimationFrame(update);
  };
  const onResize = () => {
    const next = readModalViewport(win);
    schedule(next.height < viewport.height || next.width !== viewport.width);
  };
  // Panning changes offsetTop even when height is unchanged. Follow it, but
  // don't fight a physician manually scrolling the form to its final fields.
  const onScroll = () => schedule();
  const clearFocusTimer = () => {
    if (focusTimer != null) win.clearTimeout(focusTimer);
    focusTimer = null;
  };
  const onFocus = (event) => {
    if (!isField(event.target) || !isTop()) return;
    clearFocusTimer();
    schedule(true);
    // Some WebKit versions finish keyboard animation after the last resize.
    const field = event.target;
    focusTimer = win.setTimeout(() => {
      focusTimer = null;
      if (doc.activeElement === field) schedule(true);
    }, 350);
  };
  const onBlur = () => {
    clearFocusTimer();
    reveal = false;
    schedule();
  };

  update();
  if (body.contains(doc.activeElement) && isField(doc.activeElement)) onFocus({ target: doc.activeElement });
  vv?.addEventListener("resize", onResize);
  vv?.addEventListener("scroll", onScroll);
  win.addEventListener("resize", onResize);
  body.addEventListener("focusin", onFocus);
  body.addEventListener("focusout", onBlur);
  return () => {
    disposed = true;
    clearFocusTimer();
    if (frame != null) win.cancelAnimationFrame(frame);
    vv?.removeEventListener("resize", onResize);
    vv?.removeEventListener("scroll", onScroll);
    win.removeEventListener("resize", onResize);
    body.removeEventListener("focusin", onFocus);
    body.removeEventListener("focusout", onBlur);
  };
}

// Nested modals share one lock, so closing the top sheet cannot unlock the
// document beneath the remaining sheet. Preserve the user's page position.
const locks = new WeakMap();
export function lockModalDocument(win, doc) {
  let lock = locks.get(doc);
  if (!lock) {
    const body = doc.body;
    const root = doc.documentElement;
    const x = win.scrollX, y = win.scrollY;
    const saved = [
      [body, ["position", "top", "left", "width", "overflow"]],
      [root, ["overflow"]],
    ].flatMap(([el, properties]) => properties.map(name =>
      [el, name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]));
    const width = root.clientWidth;
    body.style.position = "fixed";
    body.style.top = `${-y}px`;
    body.style.left = `${-x}px`;
    body.style.width = `${width}px`;
    body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    lock = { count: 0, restore: () => {
      for (const [el, name, value, priority] of saved) {
        if (value) el.style.setProperty(name, value, priority);
        else el.style.removeProperty(name);
      }
      win.scrollTo({ left: x, top: y, behavior: "instant" });
    } };
    locks.set(doc, lock);
  }
  lock.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lock.count === 0) {
      lock.restore();
      locks.delete(doc);
    }
  };
}
