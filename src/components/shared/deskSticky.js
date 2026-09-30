/**
 * What sticks at desk width, and how far.
 *
 * The desk top bar is 56px tall and sticks at the top of the window. Below it,
 * inside the content that the text size zooms, DeskTable headers and the side
 * rails (the Credentials section rail, the Setup task rail) stick under it.
 * A length inside a zoomed subtree is scaled by the zoom, a viewport height
 * too (100vh at XXL is 135% of the window), so the shell publishes both
 * already divided by the zoom:
 *
 *   --desk-sticky-top   the bar's height: 56 / 1.2 = 46.67 zoomed px at XL
 *   --desk-viewport-h   the window's height: 100 / 1.35 = 74.07svh at XXL
 *
 * A rail is taller than a laptop window: the Credentials rail holds a Setup
 * button, seven groups and over twenty sections, about 1,050px at M and more
 * at XXL, and the Setup rail twenty task rows. Once .cmd-content-area stopped
 * being a scroll container (SETTINGS-013) the rails really stuck, so a rail
 * taller than the window hung from the bar with its lower sections (Peer
 * References, Answer Bank, Protected Identity, New category) below the fold,
 * out of reach until the very end of the page. A rail is now never taller
 * than the window below the bar, and scrolls on its own.
 */
export const DESK_TOP_BAR_H = 56;
/** Room between the bar and a stuck rail, and between the rail and the window's foot. */
export const DESK_RAIL_GAP = 16;
// The rail scrolls, so it clips whatever spills past its edges, which is where
// a focused button draws its ring. This much padding keeps the ring whole; the
// negative margin gives the room back, so the rail takes the width it names.
const RING_ROOM = 3;

/** The custom properties the shell puts on the zoomed content wrapper. */
export function deskStickyVars(fontZoom = 1) {
  const zoom = fontZoom > 0 ? fontZoom : 1;
  return {
    "--desk-sticky-top": `${(DESK_TOP_BAR_H / zoom).toFixed(2)}px`,
    // svh, the window with any browser toolbar shown, so the rail's foot is
    // never under one.
    "--desk-viewport-h": `${(100 / zoom).toFixed(4)}svh`,
  };
}

/** A side rail `width` px wide that sticks under the top bar and scrolls within the window. */
export function deskRailStyle(width) {
  return {
    width: width + 2 * RING_ROOM, flexShrink: 0,
    margin: -RING_ROOM, padding: RING_ROOM,
    position: "sticky",
    top: `calc(var(--desk-sticky-top, ${DESK_TOP_BAR_H}px) + ${DESK_RAIL_GAP}px)`,
    maxHeight: `calc(var(--desk-viewport-h, 100svh) - var(--desk-sticky-top, ${DESK_TOP_BAR_H}px) - ${2 * DESK_RAIL_GAP}px)`,
    overflowY: "auto",
    // Scrolling the rail to its end does not carry on into the page.
    overscrollBehavior: "contain",
  };
}
