// Three rule fixes from the CME shortfall audit. Synthetic records only (the
// repository is public).
//   1. Colorado: a license issued inside the current cycle cannot be a renewed
//      term, so the prorated first-cycle figure is the requirement
//      (C.R.S. 12-240-130.5(3)(c), "the board shall adjust proportionately").
//   2. North Dakota: a first renewal after the permanent license owes no CME,
//      however long it was held (N.D. Admin. Code 50-04-01-02(2)); the twenty
//      hours of 50-04-01-04(1) bind only a physician required to report, i.e.
//      the period after that renewal. The window starts at licensure.
//   3. MATE Act: a one-time DEA registration item (DEA letter to registrants,
//      MATE_Training_Letter_Final.pdf), shown once, and met by the affirmation
//      on any registration issued or renewed on or after 2023-06-27.
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCompliance, complianceListFor, mateAttestationDate, mateCardState, windowNotes,
} from "../src/utils/compliance.js";
import { mateStatusText } from "../src/utils/cmePresentation.js";
import { mateProgress } from "../src/utils/cmeCore.js";
import { loadAppRules } from "../src/utils/appRules.js";
import { STATE_REQS } from "../src/constants/stateRequirements.js";

const course = (hours, date, category = "AMA PRA Category 1", topics = []) => ({ id: `c-${date}-${hours}`, title: "Synthetic course", category, hours: String(hours), date, topics });
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("CO: a license issued inside the cycle owes the prorated first-cycle hours, total and Category 1", () => {
  const entries = [course(9.5, "2026-07-14", "AOA Category 1-A"), course(5.5, "2026-05-20")];
  // Issued 2026-03-12, expires 2027-03-31: 12 months licensed, the 12-18 band.
  const comp = computeCompliance(entries, "CO", "DO", { licenseExpiration: "2027-03-31", licenseIssued: "2026-03-12" });
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
  const comp = computeCompliance([course(16, "2026-06-01")], "CO", "MD", { licenseExpiration: "2027-03-31", licenseIssued: "2022-11-15" });
  assert.equal(comp.totalRequired, 30);
  assert.equal(comp.cat1Required, 30);
  assert.equal(comp.assessmentStatus, "needs-hours");
});

test("ND: a first renewal under one year licensed owes 0, counted from the issue date", () => {
  const entries = [course(6, "2026-01-10"), course(4, "2027-01-05")];
  // Issued 2026-10-15, expires 2027-09-30: 11 months licensed.
  const comp = computeCompliance(entries, "ND", "DO", { licenseExpiration: "2027-09-30", licenseIssued: "2026-10-15" });
  assert.equal(comp.firstCycleRule.applied, true);
  assert.equal(comp.firstCycleRule.months, 11);
  assert.equal(comp.totalRequired, 0);
  assert.equal(comp.cat1Required, 0);
  assert.equal(comp.assessmentStatus, "met");
  assert.equal(day(comp.windowStart), "2026-10-15", "the window never starts before the license issue date");
  assert.equal(comp.windowSource, "issue");
  assert.equal(comp.totalEarned, 4, "CME dated before licensure is not counted");
  const note = windowNotes(comp).find(n => n.startsWith("ND first renewal"));
  assert.ok(note && note.includes("0 hours required") && note.includes("50-04-01-02(2)") && !note.includes("50-04-01-04(1)"), note);
});

test("ND: a first renewal one year up to two years licensed still owes nothing (50-04-01-02(2))", () => {
  const entries = [course(3, "2025-06-01"), course(12, "2026-04-10")];
  // Issued 2025-11-01, expires 2027-09-30: 22 months licensed.
  const comp = computeCompliance(entries, "ND", "MD", { licenseExpiration: "2027-09-30", licenseIssued: "2025-11-01" });
  assert.equal(comp.firstCycleRule.applied, true);
  assert.equal(comp.firstCycleRule.months, 22);
  assert.equal(comp.totalRequired, 0);
  assert.equal(comp.cat1Required, 0);
  assert.equal(day(comp.windowStart), "2025-11-01");
  assert.equal(comp.totalEarned, 12, "CME dated before licensure is not counted");
  assert.notEqual(comp.assessmentStatus, "needs-hours");
  const note = windowNotes(comp).find(n => n.startsWith("ND first renewal"));
  assert.ok(note && note.includes("50-04-01-02(2)") && !note.includes("50-04-01-04(1)"), note);
});

test("ND: a hand-entered cycle start before licensure never counts CME from before the license", () => {
  const comp = computeCompliance([course(3, "2025-06-01"), course(5, "2026-12-01")], "ND", "MD", { licenseExpiration: "2027-09-30", licenseIssued: "2026-10-15", cycleStart: "2025-09-30" });
  assert.equal(day(comp.windowStart), "2026-10-15");
  assert.equal(comp.totalEarned, 5);
});

test("ND: a license issued before the cycle owes the 40 hours over the full two years", () => {
  const comp = computeCompliance([course(18.5, "2026-08-03")], "ND", "MD", { licenseExpiration: "2027-09-30", licenseIssued: "2019-02-01" });
  assert.equal(comp.totalRequired, 40);
  assert.equal(comp.cat1Required, 40);
  assert.equal(day(comp.windowStart), "2025-09-30");
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

// Review fixes.

test("CO: an issue date with no expiration on file keeps the full 30; the tier is not known", () => {
  const comp = computeCompliance([], "CO", "MD", { licenseIssued: day(new Date(Date.now() - 20 * 86400000)) });
  assert.equal(comp.firstCycleRule?.applied, false);
  assert.equal(comp.totalRequired, 30);
  assert.equal(comp.cat1Required, 30);
  assert.notEqual(comp.assessmentStatus, "met");
});

test("ND: the first-cycle note quotes 50-04-01-02(2) as written", () => {
  const note = STATE_REQS.ND.firstCycle.note;
  assert.ok(note.includes("physicians who have not renewed their licenses for the first time since being granted a regular permanent license by the board."), note);
  assert.doesNotMatch(note, /after that|thereafter/i);
});

test("MATE: a record that is not a DEA registration by type never carries the affirmation", () => {
  const licenses = [
    { type: "DEA Registration", name: "DEA Registration", issuedDate: "2022-05-31", expirationDate: "2026-12-31" },
    { type: "Hospital Privileges", name: "Beth Israel Deaconess Medical Center", issuedDate: "2024-02-01", expirationDate: "2026-12-31" },
  ];
  assert.equal(mateAttestationDate(licenses), null);
});

test("MATE: the CME page card reads met by the registration, with no hours demanded", () => {
  const entries = [course(1, "2026-02-01", "AMA PRA Category 1", ["Opioid Prescribing"])];
  const attested = mateProgress(entries, "2026-03-04");
  assert.equal(attested.met, true);
  assert.equal(attested.required, 0);
  assert.equal(mateStatusText(attested), "Affirmed at DEA registration Mar 4, 2026: one time, done");
  assert.deepEqual(mateProgress(entries, null), { required: 8, earned: 1, met: false });
});

const deaPre = { id: "dea", type: "DEA Registration", name: "DEA Registration", state: "TX", issuedDate: "2022-05-31", expirationDate: "2027-05-31" };

test("MATE: a PA in two states gets the line on one card only", async () => {
  await loadAppRules();
  const pa = (st) => ({ id: `pa-${st}`, state: st, type: "State Physician Assistant License", name: `${st} PA License`, issuedDate: "2020-01-01", expirationDate: "2028-03-31" });
  const data = { settings: { degreeType: "PA", primaryState: "TX", additionalStates: ["CO"] }, licenses: [pa("TX"), pa("CO"), deaPre], cme: [] };
  const withMate = complianceListFor(data).filter(c => c.comp.mate);
  assert.equal(withMate.length, 1, withMate.map(c => c.key).join(","));
  assert.equal(withMate[0].key, "TX:pa");
  assert.equal(withMate[0].comp.mate.required, 8);
});

test("MATE: an NP gets the line on one APRN card only, never on an RN card beside it", async () => {
  await loadAppRules();
  const l = (st, type) => ({ id: `${st}-${type}`, state: st, type, name: `${st} ${type}`, issuedDate: "2020-01-01", expirationDate: "2028-03-31" });
  const data = { settings: { degreeType: "NP", primaryState: "TX", additionalStates: ["CO"] }, licenses: [l("TX", "APRN License (NP)"), l("TX", "RN License"), l("CO", "APRN License (NP)"), deaPre], cme: [] };
  const withMate = complianceListFor(data).filter(c => c.comp.mate);
  assert.equal(withMate.length, 1, withMate.map(c => c.key).join(","));
  assert.equal(withMate[0].key, "TX:aprn");
});

test("MATE: carried by a card that can alert, not a pending primary licence beside an active one", () => {
  const data = {
    settings: { degreeType: "MD", primaryState: "CA", additionalStates: ["TX"] },
    licenses: [
      { id: "ca", state: "CA", type: "State Medical License (MD)", name: "CA Medical License", issuedDate: "2021-01-01", expirationDate: "2027-06-30", lifecycleStatus: "pending_confirmation" },
      { id: "tx", state: "TX", type: "State Medical License (MD)", name: "TX Medical License", issuedDate: "2020-01-01", expirationDate: "2028-08-31", lifecycleStatus: "active" },
      { id: "dea", type: "DEA Registration", name: "DEA Registration", state: "TX", issuedDate: "", expirationDate: "2027-05-31" },
    ],
    cme: [],
  };
  assert.equal(mateCardState(data), "TX");
  const withMate = complianceListFor(data).filter(c => c.comp.mate);
  assert.equal(withMate.length, 1);
  assert.equal(withMate[0].st, "TX");
  assert.equal(withMate[0].comp.mate.required, 8);
  assert.equal(withMate[0].comp.fullyCompliant, false, "the unmet one-time 8 hours keep the alerting card from reading compliant");
});

test("MATE: a PA's line moves to the card that can alert when the primary licence is pending", async () => {
  await loadAppRules();
  const pa = (st, over = {}) => ({ id: `pa-${st}`, state: st, type: "State Physician Assistant License", name: `${st} PA License`, issuedDate: "2020-01-01", expirationDate: "2028-03-31", ...over });
  const data = { settings: { degreeType: "PA", primaryState: "TX", additionalStates: ["CO"] }, licenses: [pa("TX", { lifecycleStatus: "pending_confirmation" }), pa("CO"), deaPre], cme: [] };
  const withMate = complianceListFor(data).filter(c => c.comp.mate);
  assert.equal(withMate.length, 1, withMate.map(c => c.key).join(","));
  assert.equal(withMate[0].key, "CO:pa");
});
