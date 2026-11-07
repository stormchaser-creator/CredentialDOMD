// Ticket 29874d99: a contract's call day turns over on the facility's clock,
// not this device's. A Pacific phone read a Central contract's 7:00 AM at
// 7:00 AM Pacific, so 7:05 AM at the facility filed under the day before, and
// a contract that splits calls at the day start cut them at the wrong moment.
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentCallDay, deriveCallDay, callDayCuts, callDayZone, splitAtCallDay } from "../../src/utils/billing.js";

const il = { workState: "IL" };

test("currentCallDay uses the facility's zone, not this device's, for an ordinary contract", () => {
  // 7:05 AM Central is 5:05 AM on this Pacific device.
  assert.equal(currentCallDay(il, new Date("2026-11-06T13:05:00.000Z")), "2026-11-06");
  // 6:55 AM Central is still the day before.
  assert.equal(currentCallDay(il, new Date("2026-11-06T12:55:00.000Z")), "2026-11-05");
});

test("a contract with no state keeps this device's clock", () => {
  assert.equal(callDayZone({}), "");
  assert.equal(deriveCallDay("2026-11-06T13:05:00.000Z", {}), "2026-11-05");
});

test("a bare hour still reads this device's clock", () => {
  assert.equal(deriveCallDay("2026-11-06T13:05:00.000Z", 7), "2026-11-05");
  assert.equal(deriveCallDay("2026-11-06T13:05:00.000Z", 7, "America/Chicago"), "2026-11-06");
});

test("the call day turns over at the facility's 7:00 across the November fall-back", () => {
  // Sunday Nov 1 2026: Central falls back at 2:00 AM. 6:30 AM CST is 12:30Z.
  assert.equal(deriveCallDay("2026-11-01T12:30:00.000Z", il), "2026-10-31");
  assert.equal(deriveCallDay("2026-11-01T13:00:00.000Z", il), "2026-11-01");
});

test("splits cut at the facility's 7:00 and each piece is filed on that clock", () => {
  // 6:45 to 7:15 AM Central (4:45 to 5:15 AM Pacific): one cut, at 7:00 Central.
  const s = Date.parse("2026-11-06T12:45:00.000Z"), en = Date.parse("2026-11-06T13:15:00.000Z");
  assert.deepEqual(callDayCuts(il, s, en), [Date.parse("2026-11-06T13:00:00.000Z")]);
  // 8:45 to 9:15 AM Central (6:45 to 7:15 AM Pacific): no call day starts inside.
  assert.deepEqual(callDayCuts(il, Date.parse("2026-11-06T14:45:00.000Z"), Date.parse("2026-11-06T15:15:00.000Z")), []);
  const contract = { ...il, splitAtDayStart: true, callStipend: 500, incrementMinutes: 15 };
  const pieces = splitAtCallDay({
    id: "e1", startTime: new Date(s).toISOString(), endTime: new Date(en).toISOString(),
    durationMin: 30, billedMin: 30, callDay: "2026-11-05", type: "Callback",
  }, contract);
  assert.deepEqual(pieces.map(p => p.callDay), ["2026-11-05", "2026-11-06"]);
});

test("the zone the contract's timed blocks state wins over the facility guess", () => {
  const c = { workState: "IL", coveragePeriods: [{ start: "2026-12-01", end: "2026-12-03", startTime: "07:00", endTime: "07:00", tz: "America/Denver" }] };
  assert.equal(callDayZone(c), "America/Denver");
});
