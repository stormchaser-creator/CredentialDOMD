// Ticket 29874d99: "Logging against" matches schedule rows against each
// contract's call day on its own facility's clock, and yesterday's day row
// at a Pacific contract no longer outranks a Central contract whose 7 AM has
// come. A call still running keeps rule 1.
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduledContractId } from "../src/utils/scheduledContract.js";

const contracts = [{ id: "il-contract", workState: "IL" }, { id: "ca-contract", workState: "CA" }];
// 7:05 AM in Illinois is 5:05 AM on this Pacific device.
const now = new Date("2026-11-06T13:05:00.000Z");

test("scheduledContractId defaults to the facility's own schedule row, not the device-clock one", () => {
  const scheduleDays = [
    { contractId: "il-contract", date: "2026-11-06", kind: "day" },
    { contractId: "ca-contract", date: "2026-11-05", kind: "day" },
  ];
  assert.equal(scheduledContractId(scheduleDays, contracts, now), "il-contract");
  assert.equal(scheduledContractId([...scheduleDays].reverse(), contracts, now), "il-contract");
});

test("a call still running in another zone outranks a day that just started", () => {
  const scheduleDays = [
    { contractId: "il-contract", date: "2026-11-06", kind: "day" },
    { contractId: "ca-contract", date: "2026-11-05", kind: "call" },
  ];
  assert.equal(scheduledContractId(scheduleDays, contracts, now), "ca-contract");
});
