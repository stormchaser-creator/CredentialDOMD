import test from "node:test";
import assert from "node:assert/strict";
import { clearStateBanner } from "../src/utils/clearState.js";

// Dates are compared as YYYY-MM-DD strings by activeAckFor, so an ack is
// "active" while until >= today.
const future = "2099-10-05";
const untilFrom = (acks) => (id) => {
  const today = new Date().toISOString().slice(0, 10);
  const hit = acks.find(a => a.itemId === id && a.until && a.until >= today);
  return hit ? hit.until : null;
};
const ackFor = (id, until = future) => ({ itemId: id, until });

test("with nothing set aside it still says All Clear", () => {
  const b = clearStateBanner([], untilFrom([]));
  assert.equal(b.title, "All Clear");
  assert.match(b.detail, /nothing is set aside/);
});

test("it never claims All Clear while renewals are merely snoozed", () => {
  // This is the whole point: `urgent` excludes acknowledged items, so the old
  // banner read "No urgent items right now" on a screen that listed three
  // renewals due inside 90 days.
  const until = untilFrom([ackFor("a"), ackFor("b"), ackFor("c")]);
  const b = clearStateBanner([{ id: "a" }, { id: "b" }, { id: "c" }], until, d => d);
  assert.notEqual(b.title, "All Clear");
  assert.equal(b.title, "Nothing to do today");
  assert.match(b.detail, /3 items you set aside/);
  assert.match(b.detail, /back on 2099-10-05/);
});

test("it names the soonest return date, not an arbitrary one", () => {
  const until = untilFrom([ackFor("a", "2099-12-01"), ackFor("b", "2099-10-05"), ackFor("c", "2099-11-01")]);
  const b = clearStateBanner([{ id: "a" }, { id: "b" }, { id: "c" }], until, d => d);
  assert.match(b.detail, /back on 2099-10-05/);
});

test("one item reads as singular", () => {
  const b = clearStateBanner([{ id: "a" }], untilFrom([ackFor("a")]), d => d);
  assert.match(b.detail, /1 item you set aside/);
  assert.doesNotMatch(b.detail, /1 items/);
});

test("a snoozed item whose acknowledgement has expired contributes no date", () => {
  // activeAckFor returns null once until < today, so the count still stands but
  // the banner must not invent a return date.
  const b = clearStateBanner([{ id: "a" }], untilFrom([{ itemId: "a", until: "2000-01-01" }]), d => d);
  assert.match(b.detail, /1 item you set aside\./);
  assert.doesNotMatch(b.detail, /back on/);
});

test("it survives missing or malformed state", () => {
  assert.equal(clearStateBanner(undefined, untilFrom([])).title, "All Clear");
  assert.equal(clearStateBanner(null, null).title, "All Clear");
  assert.equal(clearStateBanner([{ id: "a" }], null).title, "Nothing to do today");
});
