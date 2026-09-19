export const CROP_FRAME = 280;
export const CROP_OUTPUT = 640;
const limit = (n, low, high) => Math.min(high, Math.max(low, n));

export function cropDimensions(natural, zoom = 1) {
  const scale = CROP_FRAME / Math.min(natural.w, natural.h) * zoom;
  return { scale, w: natural.w * scale, h: natural.h * scale };
}

export function clampCrop(crop, natural) {
  const zoom = limit(crop.zoom, 1, 3);
  const { w, h } = cropDimensions(natural, zoom);
  return { zoom, x: limit(crop.x, CROP_FRAME - w, 0), y: limit(crop.y, CROP_FRAME - h, 0) };
}

export function initialCrop(natural) {
  const { w, h } = cropDimensions(natural);
  return { zoom: 1, x: (CROP_FRAME - w) / 2, y: (CROP_FRAME - h) / 2 };
}

// Use frame coordinates, including when app text scaling or a narrow phone
// changes its rendered size. Saved pixels and the preview share this space.
export function cropPoint(clientX, clientY, rect) {
  return { x: (clientX - rect.left) * CROP_FRAME / rect.width,
    y: (clientY - rect.top) * CROP_FRAME / rect.height };
}

export function zoomCrop(crop, nextZoom, natural, from = { x: 140, y: 140 }, to = from) {
  const zoom = limit(nextZoom, 1, 3);
  const ratio = zoom / crop.zoom;
  return clampCrop({ zoom, x: to.x - (from.x - crop.x) * ratio,
    y: to.y - (from.y - crop.y) * ratio }, natural);
}

const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function moveCrop(crop, before, after, natural) {
  if (!before.length || before.length !== after.length) return crop;
  if (before.length === 1) return clampCrop({ ...crop,
    x: crop.x + after[0].x - before[0].x,
    y: crop.y + after[0].y - before[0].y }, natural);
  const previousDistance = distance(before[0], before[1]);
  if (previousDistance < 1) return crop;
  return zoomCrop(crop, crop.zoom * distance(after[0], after[1]) / previousDistance,
    natural, midpoint(before[0], before[1]), midpoint(after[0], after[1]));
}

export function cropSourceRect(crop, natural) {
  const { scale } = cropDimensions(natural, crop.zoom);
  return { x: -crop.x / scale, y: -crop.y / scale, side: CROP_FRAME / scale };
}
