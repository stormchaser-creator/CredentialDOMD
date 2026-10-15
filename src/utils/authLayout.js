// Room kept for the offer box and Clerk's card before they arrive, so the
// screen does not jump as each loads (signup review 2026-10-07: 162 px, a
// layout shift of 0.4 on a phone). Heights as the live screen draws them
// (WebKit, 2026-10-07): the offer box 186 px at 320 px wide, 147 px at 393,
// 108 px on a desktop; the card 333 px at 320 wide, 309 px elsewhere. With
// the price line and the renewal sentence (funnel 2026-10-14, measured the
// same way): 292 px, 234 px and 176 px.
export function reservedAuthHeights(width) {
  const w = Number.isFinite(width) ? width : 1024;
  return { offer: w <= 360 ? 292 : w <= 480 ? 234 : 176, widget: w <= 360 ? 333 : 309 };
}

