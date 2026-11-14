// The marketing pages carry two layouts (public/membership-offer.js): elements
// marked data-founder-only show while founder places remain, elements marked
// data-after-founders once the founders are sold out. A browser hides the
// other set; these helpers do the same to rendered HTML so a test reads what
// a visitor reads in each state. Not a test file.
const OTHER = { founding: 'data-after-founders', soldout: 'data-founder-only' };

/** `html` without the elements a visitor does not see in `state` ('founding' or 'soldout'). */
export function inState(html, state) {
  const attribute = OTHER[state];
  if (!attribute) throw Error(`Unknown site state: ${state}`);
  let out = html;
  for (;;) {
    const open = out.match(new RegExp(`<([a-z0-9]+)\\b[^>]*\\s${attribute}\\b[^>]*>`));
    if (!open) return out;
    const tag = open[1];
    const walker = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    walker.lastIndex = open.index + open[0].length;
    let depth = 1, end = -1;
    for (let m; (m = walker.exec(out));) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) { end = m.index + m[0].length; break; }
    }
    if (end < 0) throw Error(`Unclosed ${attribute} element`);
    out = out.slice(0, open.index) + out.slice(end);
  }
}

/** The state membership-offer.js shows for a server phase. */
export const stateOf = phase => phase === 'founding' ? 'founding' : 'soldout';
