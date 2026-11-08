// Three rule fixes from the CME shortfall audit. Synthetic records only (the
// repository is public).
//   1. Colorado: a license issued inside the current cycle cannot be a renewed
//      term, so the prorated first-cycle figure is the requirement
//      (C.R.S. 12-240-130.5(3)(c), "the board shall adjust proportionately").
//   2. North Dakota: physicians "who have not renewed their licenses for the
//      first time since being granted a regular permanent license" owe no CME
//      (N.D. Admin. Code 50-04-01-02(2)); the window starts at licensure.
//   3. MATE Act: a one-time DEA registration item (DEA letter to registrants,
//      MATE_Training_Letter_Final.pdf), shown once, and met by the affirmation
//      on any registration issued or renewed on or after 2023-06-27.
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCompliance, complianceListFor, mateAttestationDate, mateCardState, windowNotes,
} from "../src/utils/compliance.js";
import { mateStatusText } from "../src/utils/cmePresentation.js";

const course = (hours, date, category = "AMA PRA Category 1", topics = []) => ({ id: `c-${date}-${hours}`, title: "Synthetic course", category, hours: String(hours), date, topics });
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("CO: a license issued inside the cycle owes the prorated first-cycle hours, total and Category 1", () => {
  const entries = [course(10.25, "2026-08-19", "AOA Category 1-A"), course(5, "2026-06-23")];
  // Issued 2026-04-09, expires 2027-04-30: 12 months licensed, the 12-18 band.
  const comp = computeCompliance(entries, "CO", "DO", { licenseExpiration: "2027-04-30", licenseIssued: "2026-04-09" });
  assert.equal(comp.firstCycleRule.applied, true);
  assert.equal(comp.totalRequired, 15);
  assert.equal(comp.cat1Required, 15);
  assert.equal(comp.totalMet, true);
  assert.equal(comp.cat1Met, true);
  assert.equal(comp.assessmentStatus, "met");
  const note = windowNotes(comp).find(n => n.startsWith("CO first renewal"));
  assert.ok(note && note.includes("15 hours required") && note.includes("C.R.S. 12-240-130.5"), note);
});

test("CO: a license issued at or before the window start keeps the full 30", () => {
  const comp = computeCompliance([course(16, "2026-06-01")], "CO", "MD", { licenseExpiration: "2027-04-30", licenseIssued: "2023-04-30" });
  assert.equal(comp.totalRequired, 30);
  assert.equal(comp.cat1Required, 30);
  assert.equal(comp.assessmentStatus, "needs-hours");
});

test("ND: the first renewal after a regular license owes 0, counted from the issue date", () => {
  const entries = [course(6, "2026-01-10"), course(4, "2026-09-01")];
  const comp = computeCompliance(entries, "ND", "DO", { licenseExpiration: "2027-09-06", licenseIssued: "2026-07-31" });
  assert.equal(comp.firstCycleRule.applied, true);
  assert.equal(comp.totalRequired, 0);
  assert.equal(comp.cat1Required, 0);
  assert.equal(comp.assessmentStatus, "met");
  assert.equal(day(comp.windowStart), "2026-07-31", "the window never starts before the license issue date");
  assert.equal(comp.windowSource, "issue");
  assert.equal(comp.totalEarned, 4, "CME dated before licensure is not counted");
  const notes = windowNotes(comp);
  assert.ok(notes.some(n => n.includes("ND first renewal: 0 hours required") && n.includes("50-04-01-02(2)")), notes.join("\n"));
});

test("ND: a license issued before the cycle owes the 40 hours over the full two years", () => {
  const comp = computeCompliance([course(19.25, "2026-08-19")], "ND", "MD", { licenseExpiration: "2027-09-06", licenseIssued: "2019-02-01" });
  assert.equal(comp.totalRequired, 40);
  assert.equal(comp.cat1Required, 40);
  assert.equal(day(comp.windowStart), "2025-09-06");
  assert.equal(comp.windowSource, "cycle");
  assert.equal(comp.assessmentStatus, "needs-hours");
});

const lic = (over) => ({ type: "State Medical License (DO)", expirationDate: "2028-05-31", ...over });
const member = (licenses) => ({
  settings: { degreeType: "DO", primaryState: "CO", additionalStates: ["ND"] },
  licenses,
  cme: [course(2, "2026-02-01", "AMA PRA Category 1", ["Substance Use Disorders"])],
});

test("MATE: shown once, as met by the affirmation on a registration issued on or after 2023-06-27", () => {
  const data = member([
    lic({ id: "co", state: "CO", name: "CO Medical License", issuedDate: "2024-01-10" }),
    lic({ id: "nd", state: "ND", name: "ND Medical License", issuedDate: "2024-03-01" }),
    { id: "dea1", type: "DEA Registration", name: "DEA Registration", state: "CO", issuedDate: "2025-05-21", expirationDate: "2028-05-31" },
    { id: "dea2", type: "DEA Registration", name: "DEA Registration", state: "ND", issuedDate: "2025-08-24", expirationDate: "2028-05-31" },
  ]);
  assert.equal(mateAttestationDate(data.licenses), "2025-05-21");
  assert.equal(mateCardState(data), "CO");
  const cards = complianceListFor(data);
  const withMate = cards.filter(c => c.comp.mate);
  assert.equal(withMate.length, 1, "one DEA item, not one per state license");
  assert.equal(withMate[0].st, "CO");
  const mate = withMate[0].comp.mate;
  assert.equal(mate.met, true);
  assert.equal(mate.required, 0, "no hours demanded");
  assert.equal(mate.via, "registration");
  assert.equal(mateStatusText(mate), "Affirmed at DEA registration May 21, 2025: one time, done");
});

test("MATE: a registration from before 2023-06-27 keeps the 8-hour line with its topics", () => {
  const data = member([
    lic({ id: "co", state: "CO", name: "CO Medical License", issuedDate: "2024-01-10" }),
    lic({ id: "nd", state: "ND", name: "ND Medical License", issuedDate: "2024-03-01" }),
    { id: "dea1", type: "DEA Registration", name: "DEA Registration", state: "CO", issuedDate: "2023-06-26", expirationDate: "2026-12-31" },
  ]);
  assert.equal(mateAttestationDate(data.licenses), null);
  const withMate = complianceListFor(data).filter(c => c.comp.mate);
  assert.equal(withMate.length, 1);
  assert.deepEqual(withMate[0].comp.mate, { required: 8, earned: 2, met: false });
  assert.equal(mateStatusText(withMate[0].comp.mate), "2 / 8");
});

test("MATE: the cutoff day itself carries the affirmation; a past registration on file counts", () => {
  assert.equal(mateAttestationDate([
    { type: "DEA Registration", issuedDate: "2023-06-27", status: "historical" },
    { type: "DEA Registration", issuedDate: "" },
  ]), "2023-06-27");
});
