import assert from "node:assert/strict";
import test from "node:test";
import { CROP_FRAME, initialCrop, moveCrop, zoomCrop, cropPoint, cropSourceRect } from "../src/utils/headshotCrop.js";
const square = { w: 1200, h: 1200 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("a two-finger spread doubles zoom and preserves the photo point at its midpoint", () => {
  const result = moveCrop(initialCrop(square), [{ x: 90, y: 140 }, { x: 190, y: 140 }],
    [{ x: 40, y: 140 }, { x: 240, y: 140 }], square);
  assert.deepEqual(result, { zoom: 2, x: -140, y: -140 });
  assert.deepEqual(cropSourceRect(result, square), { x: 300, y: 300, side: 600 });
});

test("pinching and moving the midpoint together keeps the same image point under the fingers", () => {
  const previous = { zoom: 1.5, x: -80, y: -100 };
  const result = moveCrop(previous, [{ x: 80, y: 100 }, { x: 160, y: 100 }],
    [{ x: 80, y: 120 }, { x: 200, y: 120 }], square);
  close((120 - previous.x) / previous.zoom, (140 - result.x) / result.zoom);
  close((100 - previous.y) / previous.zoom, (120 - result.y) / result.zoom);
});

test("one finger pans after lifting a second finger, with no jump", () => {
  const zoomed = { zoom: 2, x: -140, y: -140 };
  const remaining = [{ x: 200, y: 150 }];
  assert.deepEqual(moveCrop(zoomed, remaining, remaining, square), zoomed);
  assert.deepEqual(moveCrop(zoomed, remaining, [{ x: 225, y: 160 }], square), { zoom: 2, x: -115, y: -130 });
});

test("lifting, canceling or adding fingers never calculates a delta across different touch counts", () => {
  const crop = { zoom: 2, x: -140, y: -140 };
  const p = { x: 100, y: 100 };
  assert.equal(moveCrop(crop, [], [p], square), crop);
  assert.equal(moveCrop(crop, [p], [p, { x: 180, y: 100 }], square), crop);
  assert.equal(moveCrop(crop, [p], [], square), crop);
});

test("zoom stops at limits, reverses immediately, and a coincident pinch stays finite", () => {
  const start = [{ x: 100, y: 140 }, { x: 180, y: 140 }];
  const far = [{ x: 0, y: 140 }, { x: 280, y: 140 }];
  const max = moveCrop(initialCrop(square), start, far, square);
  assert.equal(max.zoom, 3);
  const reversed = moveCrop(max, far, [{ x: 14, y: 140 }, { x: 266, y: 140 }], square);
  close(reversed.zoom, 2.7);
  assert.deepEqual(zoomCrop(max, -2, square), initialCrop(square));
  assert.equal(moveCrop(max, [start[0], start[0]], far, square), max);
});

test("pointer coordinates account for app scaling and responsive crop width", () => {
  assert.deepEqual(cropPoint(240, 160, { left: 100, top: 20, width: 280, height: 280 }), { x: 140, y: 140 });
  assert.deepEqual(cropPoint(324, 244, { left: 100, top: 20, width: 448, height: 448 }), { x: 140, y: 140 });
  assert.deepEqual(cropPoint(200, 120, { left: 100, top: 20, width: 200, height: 200 }), { x: 140, y: 140 });
});

test("slider zoom uses the center and saved crop stays within portrait/landscape image bounds", () => {
  for (const natural of [square, { w: 400, h: 1200 }, { w: 1800, h: 600 }]) {
    const initial = initialCrop(natural);
    const result = zoomCrop(initial, 2, natural);
    close((CROP_FRAME / 2 - initial.x), (CROP_FRAME / 2 - result.x) / 2);
    close((CROP_FRAME / 2 - initial.y), (CROP_FRAME / 2 - result.y) / 2);
    for (const zoom of [0.01, 1, 1.5, 3, 200]) {
      for (const d of [-10000, -10, 0, 20, 10000]) {
        const moved = moveCrop(zoomCrop(initial, zoom, natural), [{ x: 0, y: 0 }], [{ x: d, y: -d }], natural);
        const source = cropSourceRect(moved, natural);
        assert.ok(source.x >= -1e-8 && source.y >= -1e-8);
        assert.ok(source.x + source.side <= natural.w + 1e-8);
        assert.ok(source.y + source.side <= natural.h + 1e-8);
      }
    }
  }
});
