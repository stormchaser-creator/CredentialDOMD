// Unit-style checks for src/utils/setupTasks.js, the whole Tier 1 board:
// the five completion rules against BOTH the MD and the DO license
// vocabularies, the derived/skipped/na/pending resolution order, the
// denominator arithmetic (skipped stays in, na leaves), prune-on-write, the
// deterministic ranker behind the Next card, and which form the Home card
// takes. Run: node scripts/setup-tasks.test.mjs
// Pure node, no test runner. Exit code 1 on any failure.
import {
  buildSetup, dateless, datable, normalizeSetupState, pruneSetupState, shortDate,
  withTask, withDeclared, withSnooze, withStarted, withTier1Done, withProSnapshot,
  homeCardForm, setupOwns, firstRenderPatch, CARD_FORM, CARD_PRIORITY, TASK_DEFS,
  isMedicalLicense, isDea, isCsr, isBoard, isLifeSupport,
  ladderState, LADDER, denominatorNarration, proSnapshot, proSnapshotMatches,
  evidenceQueue, runIntro, numberWord, secsPhrase, weekdayName,
  boardCounts, tier1Regressed,
} from "../src/utils/setupTasks.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const NOW = new Date("2026-09-10T17:00:00.000Z");
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// A physician the app can already warn: name, degree, state, a dated
// license, a dated DEA, reminders on.
const settledSettings = {
  name: "Eric Whitney", degreeType: "DO", primaryState: "CA",
  email: "eric@example.com", notifyEmail: true, reminderLeadDays: 90,
};
const doLicense = { id: "l1", type: "State Medical License (DO)", state: "CA", licenseNumber: "A1", expirationDate: "2027-06-30" };
const deaLicense = { id: "d1", type: "DEA Registration", state: "CA", licenseNumber: "BW1", expirationDate: "2027-01-31" };
const settled = () => ({ settings: { ...settledSettings }, licenses: [{ ...doLicense }, { ...deaLicense }], documents: [] });
const build = (data, opts = {}) => buildSetup(data, { now: NOW, ...opts });
const statusOf = (setup, id) => setup.byId[id].status;
// Tier 2 always has open rows, so "nothing next" now means nothing in Tier 1.
const t1next = (setup) => (setup.next && setup.next.tier === 1 ? setup.next : null);

// The same physician with the packet assembled as well: every free Tier 2
// row closed, every proof linked with the exact linkedTo CrudSection writes.
const packedSettings = { ...settledSettings, specialties: ["Neurological Surgery"], profilePhoto: "data:image/png;base64,AA" };
const packed = () => ({
  settings: { ...packedSettings },
  licenses: [
    { ...doLicense },
    { ...deaLicense },
    { id: "b1", type: "Board Certification (AOA)", name: "Neurological Surgery" },
    { id: "a1", type: "ACLS Certification", expirationDate: "2027-03-01" },
  ],
  documents: [
    { id: "g1", linkedTo: "licenses:l1" },
    { id: "g2", linkedTo: "licenses:d1" },
    { id: "g3", linkedTo: "licenses:b1" },
    { id: "g4", linkedTo: "licenses:a1" },
    { id: "g5", linkedTo: "education:e1" },
    { id: "g6", linkedTo: "travelDocs:t1" },
  ],
  cme: [{ id: "c1", hours: 20 }],
  education: [
    { id: "e1", type: "Doctor of Osteopathic Medicine (DO)" },
    { id: "e2", type: "Residency Certificate" },
  ],
  workHistory: [{ id: "w1", startDate: "2020-07-01" }],
  travelDocs: [{ id: "t1", type: "Passport", number: "X1234" }],
  professionalPhotos: [{ id: "ph1" }],
});

// ── Type matching: MD and DO vocabularies both, or a DO never completes ──
ok("MD medical license matches", isMedicalLicense({ type: "State Medical License" }));
ok("DO medical license matches", isMedicalLicense({ type: "State Medical License (DO)" }));
ok("DO MD-equivalent matches", isMedicalLicense({ type: "State Medical License (MD-equiv)" }));
ok("training license is not a medical license", !isMedicalLicense({ type: "Training License" }));
ok("DEA matches", isDea({ type: "DEA Registration" }));
ok("DEA is not a medical license", !isMedicalLicense({ type: "DEA Registration" }));
ok("CSR matches", isCsr({ type: "State Controlled Substance" }));
ok("ABMS board matches", isBoard({ type: "Board Certification (ABMS)" }));
ok("AOA board matches", isBoard({ type: "Board Certification (AOA)" }));
ok("ACLS by type matches life support", isLifeSupport({ type: "ACLS Certification" }));
ok("BLS by name matches life support", isLifeSupport({ type: "Certification", name: "BLS renewal" }));
ok("a laser permit is not life support", !isLifeSupport({ type: "Laser Safety Certificate", name: "" }));

// ── dateless(): licenses only, non-expiring excluded ──
eq("dateless picks up an undated medical license", dateless({ licenses: [{ id: "a", type: "State Medical License", state: "TX" }] }).map((l) => l.id), ["a"]);
eq("dateless picks up an undated DEA and CSR", dateless({ licenses: [
  { id: "a", type: "DEA Registration" }, { id: "b", type: "State Controlled Substance" },
] }).map((l) => l.id), ["a", "b"]);
eq("dateless ignores a course certification", dateless({ licenses: [{ id: "a", type: "Certification", name: "ACLS" }] }), []);
eq("dateless ignores a record marked non-expiring", dateless({ licenses: [{ id: "a", type: "Board Certification (AOA)", noExpiration: true }] }), []);
eq("dateless ignores a board certificate (no date is ever required)", dateless({ licenses: [{ id: "a", type: "Board Certification (AOA)" }] }), []);
eq("dateless never walks privileges or insurance", dateless({
  licenses: [], privileges: [{ id: "p" }], insurance: [{ id: "i" }], healthRecords: [{ id: "h", category: "TB Test" }],
}), []);

// ── T1 identity ──
{
  const s = (over) => build({ settings: { ...settledSettings, ...over }, licenses: [] });
  eq("identity done when name, degree and state are on file", statusOf(s({}), "identity"), "done");
  eq("identity pending without a name", statusOf(s({ name: "" }), "identity"), "pending");
  eq("identity pending without a degree", statusOf(s({ degreeType: "" }), "identity"), "pending");
  eq("identity rejects a degree that is neither MD nor DO", statusOf(s({ degreeType: "MBBS" }), "identity"), "pending");
  eq("identity pending without a primary state", statusOf(s({ primaryState: "" }), "identity"), "pending");
  eq("identity names what is missing", s({ name: "", primaryState: "" }).byId.identity.detail, "Still needed: your name, primary state.");
}

// ── T2 licenses ──
{
  eq("licenses done on one DO medical license", statusOf(build({ settings: settledSettings, licenses: [doLicense] }), "licenses"), "done");
  eq("licenses done on one MD medical license", statusOf(build({ settings: { ...settledSettings, degreeType: "MD" }, licenses: [{ id: "x", type: "State Medical License" }] }), "licenses"), "done");
  eq("a DEA alone does not complete licenses", statusOf(build({ settings: settledSettings, licenses: [deaLicense] }), "licenses"), "pending");
  eq("licenses pending on an empty account", statusOf(build({ settings: settledSettings, licenses: [] }), "licenses"), "pending");
}

// ── T3 dates ──
{
  eq("dates done when every license carries one", statusOf(build(settled()), "dates"), "done");
  eq("dates pending with one undated license", statusOf(build({ settings: settledSettings, licenses: [doLicense, { id: "n", type: "State Medical License (DO)", state: "TX" }] }), "dates"), "pending");
  const empty = build({ settings: settledSettings, licenses: [] });
  eq("dates is not done on an empty account", statusOf(empty, "dates"), "pending");
  eq("dates is blocked by licenses on an empty account", empty.byId.dates.blockedBy, "licenses");
  eq("dates is unblocked once a license exists", build(settled()).byId.dates.blockedBy, null);
  const undatedPrivilege = build({ settings: settledSettings, licenses: [doLicense, deaLicense], privileges: [{ id: "p" }] });
  eq("an undated hospital privilege never blocks Protected", statusOf(undatedPrivilege, "dates"), "done");
  const three = build({ settings: settledSettings, licenses: [
    doLicense, { id: "a", type: "State Medical License (DO)", state: "TX" },
    { id: "b", type: "State Medical License (DO)", state: "NV" }, { id: "c", type: "DEA Registration", state: "CA" },
  ] });
  eq("dates counts the records, not the sections", three.byId.dates.detail, "3 records with no expiration date.");
  eq("dates estimate is ten seconds a record", three.byId.dates.secs, 30);
  eq("dates names one regressed record", build({ settings: settledSettings, licenses: [doLicense, { id: "a", type: "State Medical License (DO)", state: "TX" }] }).byId.dates.regressionLine, "your TX license lost its expiration date");
}

// ── T4 DEA, including the declared negative ──
{
  eq("dea done on a dated registration", statusOf(build(settled()), "dea"), "done");
  eq("dea pending when the registration has no date", statusOf(build({ settings: settledSettings, licenses: [doLicense, { id: "d", type: "DEA Registration", state: "CA" }] }), "dea"), "pending");
  const undatedDea = build({ settings: settledSettings, licenses: [doLicense, { id: "d", type: "DEA Registration", state: "CA" }] });
  eq("an undated DEA also appears in the dates list", statusOf(undatedDea, "dates"), "pending");
  const withProof = build({ settings: settledSettings, licenses: [doLicense, deaLicense], documents: [{ id: "doc", linkedTo: "licenses:d1" }] });
  eq("dea reads documented once the certificate is linked", statusOf(withProof, "dea"), "documented");
  eq("documented says so", withProof.byId.dea.detail, "Dated. Proof attached.");
  eq("done without proof says so", build(settled()).byId.dea.detail, "On file. No copy attached yet.");
  const noDea = { settings: { ...settledSettings, setupState: { declared: { noDea: true } } }, licenses: [doLicense] };
  eq("declared no DEA reads not applicable", statusOf(build(noDea), "dea"), "na");
  eq("declared no DEA carries its own sentence", build(noDea).byId.dea.detail, "Not applicable. You told us you do not hold a DEA registration.");
}

// ── T5 reminders ──
{
  const s = (over) => build({ settings: { ...settledSettings, ...over }, licenses: [doLicense] });
  eq("reminders done with email on, an address and a lead", statusOf(s({}), "reminders"), "done");
  eq("reminders pending with every channel off", statusOf(s({ notifyEmail: false, notifyBrowser: false, notifyText: false }), "reminders"), "pending");
  eq("reminders pending with no address", statusOf(s({ email: "" }), "reminders"), "pending");
  eq("reminders pending with a zero lead", statusOf(s({ reminderLeadDays: 0 }), "reminders"), "pending");
  eq("a browser channel alone is enough", statusOf(s({ notifyEmail: false, notifyBrowser: true }), "reminders"), "done");
  eq("no address is named as the problem", s({ email: "" }).byId.reminders.detail, "No address on file to warn.");
}

// ── Resolution order: derived beats na beats skipped ──
{
  const stateWith = (tasks, declared = {}) => ({ settings: { ...settledSettings, setupState: { tasks, declared } }, licenses: [doLicense, deaLicense], documents: [] });
  eq("a derived-done task ignores a stored skip", statusOf(build(stateWith({ dea: { s: "skipped", at: day(1) } })), "dea"), "done");
  eq("a derived-done task ignores a stored na", statusOf(build(stateWith({ dea: { s: "na", at: day(1) } })), "dea"), "done");
  const notDone = { settings: { ...settledSettings, setupState: { tasks: { dea: { s: "na", at: day(1) } } } }, licenses: [doLicense] };
  eq("na wins over skipped for the same task", statusOf(build({ ...notDone, settings: { ...notDone.settings, setupState: { tasks: { dea: { s: "na", at: day(1) } } } } }), "dea"), "na");
  eq("a skip shows its date", build({ settings: { ...settledSettings, setupState: { tasks: { dea: { s: "skipped", at: new Date(2026, 8, 4, 12).toISOString() } } } }, licenses: [doLicense] }).byId.dea.detail, "Skipped 4 Sep. Still on the list.");
  eq("the board is five protected rows and ten packet rows",
    [TASK_DEFS.filter((d) => d.tier === 1).length, TASK_DEFS.filter((d) => d.tier === 2).length], [5, 10]);
  ok("every task has a derived rule, so no checkbox can lie", TASK_DEFS.every((d) => typeof d.doneWhen === "function"));
}

// ── The denominator ──
{
  const base = { settings: { ...settledSettings }, licenses: [] };
  const empty = build(base);
  eq("an empty account is 5 tasks, 2 done", [empty.counts.tier1.total, empty.counts.tier1.done], [5, 2]);
  const skipped = build({ ...base, settings: { ...base.settings, setupState: { tasks: { dea: { s: "skipped", at: day(1) } } } } });
  eq("a skip stays in the denominator", [skipped.counts.tier1.total, skipped.counts.tier1.done, skipped.counts.tier1.skipped], [5, 2, 1]);
  eq("a skip never raises the score", skipped.counts.tier1.left, 3);
  const na = build({ ...base, settings: { ...base.settings, setupState: { tasks: { dea: { s: "na", at: day(1) } } } } });
  eq("not-applicable leaves the denominator", [na.counts.tier1.total, na.counts.tier1.done, na.counts.tier1.na], [4, 2, 1]);
  eq("not-applicable shrinks what is left", na.counts.tier1.left, 2);
  const declaredNoDea = build({ settings: { ...settledSettings, setupState: { declared: { noDea: true } } }, licenses: [doLicense], documents: [] });
  eq("declaring no DEA makes the board four items", declaredNoDea.counts.tier1.total, 4);
  eq("a settled account is complete", build(settled()).counts.tier1.complete, true);
  eq("an account with one open task is not complete", build(base).counts.tier1.complete, false);
  eq("skipping everything never reads as complete", build({ ...base, settings: { ...base.settings, setupState: { tasks: {
    identity: { s: "skipped", at: day(1) }, licenses: { s: "skipped", at: day(1) }, dates: { s: "skipped", at: day(1) },
    dea: { s: "skipped", at: day(1) }, reminders: { s: "skipped", at: day(1) },
  } } } }).counts.tier1.complete, false);
}

// ── The ranker ──
{
  eq("exposure order is fixed", CARD_PRIORITY, ["dates", "licenses", "dea", "reminders", "identity"]);
  const blank = build({ settings: {}, licenses: [] });
  eq("a blank account is offered About you and nothing else", blank.next.id, "identity");
  const noLicenses = build({ settings: { ...settledSettings }, licenses: [] });
  eq("with a degree but no licenses, the registry lookup ranks first", noLicenses.next.id, "licenses");
  eq("dates outranks everything once it is unblocked", build({ settings: { ...settledSettings, notifyEmail: false, notifyBrowser: false, notifyText: false }, licenses: [doLicense, { id: "n", type: "State Medical License (DO)", state: "TX" }] }).next.id, "dates");
  eq("the card sentence names the exposure", build({ settings: settledSettings, licenses: [doLicense, { id: "n", type: "State Medical License (DO)", state: "TX" }] }).next.cardLine,
    "1 license on file with no expiration date. Nothing will warn you about it.");
  eq("two undated licenses read as plural", build({ settings: settledSettings, licenses: [{ id: "a", type: "State Medical License (DO)", state: "CA" }, { id: "n", type: "State Medical License (DO)", state: "TX" }] }).next.cardLine,
    "2 licenses on file with no expiration date. Nothing will warn you about them.");
  eq("the button carries the task's verb", noLicenses.next.verb, "Import my licenses");
  eq("a settled account has nothing left in Tier 1", t1next(build(settled())), null);
  eq("and falls through to the packet", build(settled()).next.tier, 2);
  const skippedNow = build({ settings: { ...settledSettings, setupState: { tasks: { dea: { s: "skipped", at: day(1) } } } }, licenses: [doLicense] });
  eq("a fresh skip leaves the Next rotation", t1next(skippedNow), null);
  const skippedOld = build({ settings: { ...settledSettings, setupState: { tasks: { dea: { s: "skipped", at: day(8) } } } }, licenses: [doLicense] });
  eq("a week-old skip is offered once more", skippedOld.next.id, "dea");
  const skippedAncient = build({ settings: { ...settledSettings, setupState: { tasks: { dea: { s: "skipped", at: day(30) } } } }, licenses: [doLicense] });
  eq("an old skip stops fighting the physician every morning", t1next(skippedAncient), null);
}

// ── Writers and prune-on-write ──
{
  const st0 = normalizeSetupState(null);
  eq("an absent setupState reads as the empty shape", [st0.v, st0.startedAt, st0.tier1DoneAt, st0.declared, st0.tasks], [1, null, null, {}, {}]);
  eq("garbage reads as the empty shape", normalizeSetupState("nope").tasks, {});
  const st1 = withTask(st0, "dea", "skipped", { now: NOW });
  eq("a skip is stored with its date", st1.tasks.dea, { s: "skipped", at: NOW.toISOString() });
  const st2 = withTask(st1, "dea", "na", { why: "Solo practice", now: NOW });
  eq("na stores the optional reason", st2.tasks.dea, { s: "na", at: NOW.toISOString(), why: "Solo practice" });
  eq("clearing puts the task back", withTask(st2, "dea", null, {}).tasks, {});
  eq("declaring writes the negative", withDeclared(st0, "noDea", true).declared, { noDea: true });
  eq("undeclaring removes it", withDeclared(withDeclared(st0, "noDea", true), "noDea", false).declared, {});
  eq("the snooze is a date, not a dismissal", withSnooze(st0, "2026-09-24T00:00:00.000Z").hiddenUntil, "2026-09-24T00:00:00.000Z");
  eq("starting stamps the clock", withStarted(st0, NOW.toISOString()).startedAt, NOW.toISOString());
  eq("tier 1 stamps once", withTier1Done(st0, NOW.toISOString()).tier1DoneAt, NOW.toISOString());

  const dirty = { tasks: { dea: { s: "skipped", at: day(2) }, ghost: { s: "skipped", at: day(2) }, dates: { s: "na", at: day(2) } } };
  const pruned = pruneSetupState(dirty, { knownIds: ["identity", "licenses", "dates", "dea", "reminders"], doneIds: ["dea"] });
  eq("prune drops a skip the records have closed", "dea" in pruned.tasks, false);
  eq("prune drops an unknown task id", "ghost" in pruned.tasks, false);
  eq("prune keeps a live na", pruned.tasks.dates, { s: "na", at: day(2) });
  eq("prune with nothing to compare against changes nothing", pruneSetupState(dirty).tasks, dirty.tasks);
  eq("a write prunes on the way out", withTask(dirty, "reminders", "skipped", { now: NOW }, { knownIds: ["reminders", "dates"], doneIds: [] }).tasks,
    { dates: { s: "na", at: day(2) }, reminders: { s: "skipped", at: NOW.toISOString() } });
}

// ── The Home card ──
{
  const open = build({ settings: { ...settledSettings, setupState: { startedAt: day(3) } }, licenses: [] });
  eq("an unfinished board shows the bordered card", homeCardForm(open, { now: NOW }), CARD_FORM.A);
  const snoozed = build({ settings: { ...settledSettings, setupState: { startedAt: day(3), hiddenUntil: new Date(NOW.getTime() + 86400000).toISOString() } }, licenses: [] });
  eq("Not now hides it for the snooze", homeCardForm(snoozed, { now: NOW }), CARD_FORM.NONE);
  const expired = build({ settings: { ...settledSettings, setupState: { startedAt: day(30), hiddenUntil: day(1) } }, licenses: [] });
  eq("the snooze runs out", homeCardForm(expired, { now: NOW }), CARD_FORM.A);
  const protectedNow = build({ ...settled(), settings: { ...settledSettings, setupState: { startedAt: day(3) } } });
  eq("finishing Tier 1 shows the Protected moment", homeCardForm(protectedNow, { now: NOW }), CARD_FORM.B);
  const stamped = build({ ...packed(), settings: { ...packedSettings, setupState: { startedAt: day(3), tier1DoneAt: day(1) } } });
  eq("the Protected moment never replays", homeCardForm(stamped, { now: NOW }), CARD_FORM.D);
  const stampedWithPacketLeft = build({ ...settled(), settings: { ...settledSettings, setupState: { startedAt: day(3), tier1DoneAt: day(1) } } });
  eq("a stamped board with packet work left is the quiet packet line", homeCardForm(stampedWithPacketLeft, { now: NOW }), CARD_FORM.C);
  const neverSeen = build(settled());
  eq("an account that was already set up is never congratulated on first render", homeCardForm(neverSeen, { now: NOW }), CARD_FORM.NONE);
  eq("...and is stamped complete in the same pass instead", firstRenderPatch(neverSeen, { now: NOW }).tier1DoneAt, NOW.toISOString());
  const brandNewUnfinished = build({ settings: {}, licenses: [] });
  eq("a genuinely new account still gets the card on its first render", homeCardForm(brandNewUnfinished, { now: NOW }), CARD_FORM.A);
  const regressed = build({ settings: { ...settledSettings, setupState: { startedAt: day(30), tier1DoneAt: day(20) } }, licenses: [doLicense, { id: "n", type: "State Medical License (DO)", state: "TX" }] });
  eq("a later regression never brings the bordered card back", homeCardForm(regressed, { now: NOW }), CARD_FORM.D);
  eq("the regression names itself", regressed.next.regressionLine, "your TX license lost its expiration date");
}

// ── Who owns the sentence: setup, or the older Home banners ──
// Home suppresses its missing-expiration and profile-gap banners only while
// setupOwns() is true. A skip keeps the task in the denominator forever, so
// tier1DoneAt never lands, so a "setup is finished" test would suppress
// those banners for the life of the account.
{
  const undatedTx = { id: "tx", type: "State Medical License (DO)", state: "TX" };

  const live = build({
    ...settled(),
    licenses: [{ ...doLicense }, { ...deaLicense }, { ...undatedTx }],
    settings: { ...settledSettings, setupState: { startedAt: day(1) } },
  });
  eq("with a date still open the card is the bordered form", homeCardForm(live, { now: NOW }), CARD_FORM.A);
  eq("...and dates is the task it is offering", live.next.id, "dates");
  ok("setup owns the date sentence while it is actually saying it", setupOwns(live, "dates", { now: NOW }));

  // The Fowler shape: three licenses on file, the date task set aside.
  const skipped = build({
    ...settled(),
    licenses: [{ ...doLicense }, { ...deaLicense }, { ...undatedTx }],
    settings: { ...settledSettings, setupState: { startedAt: day(30), tasks: { dates: { s: "skipped", at: day(30) } } } },
  });
  eq("a skip leaves the task in the denominator", skipped.counts.tier1, { total: 5, done: 4, skipped: 1, na: 0, left: 1, complete: false, locked: 0 });
  ok("a skip never stamps Tier 1 done", !skipped.state.tier1DoneAt);
  eq("the card stays on Form A", homeCardForm(skipped, { now: NOW }), CARD_FORM.A);
  eq("but it has nothing left to offer in Tier 1", t1next(skipped), null);
  eq("the task reads as skipped, not pending", statusOf(skipped, "dates"), "skipped");
  ok("so setup no longer owns the date sentence and the banner comes back", !setupOwns(skipped, "dates", { now: NOW }));

  // Same board, still inside the re-offer window: setup is speaking again.
  const reoffered = build({
    ...settled(),
    licenses: [{ ...doLicense }, { ...deaLicense }, { ...undatedTx }],
    settings: { ...settledSettings, setupState: { startedAt: day(30), tasks: { dates: { s: "skipped", at: day(9) } } } },
  });
  eq("a skip re-enters the rotation for one week", reoffered.next.id, "dates");
  ok("but a re-offered skip still does not silence the banner", !setupOwns(reoffered, "dates", { now: NOW }));

  // "Not now": the card is gone for 14 days, so nothing is saying it.
  const snoozed = build({
    ...settled(),
    licenses: [{ ...doLicense }, { ...deaLicense }, { ...undatedTx }],
    settings: { ...settledSettings, setupState: { startedAt: day(1), hiddenUntil: new Date(NOW.getTime() + 13 * 86400000).toISOString() } },
  });
  eq("Not now takes the card off Home", homeCardForm(snoozed, { now: NOW }), CARD_FORM.NONE);
  eq("the task itself is untouched by the snooze", statusOf(snoozed, "dates"), "pending");
  ok("a snoozed card owns nothing, so the banner speaks for those 14 days", !setupOwns(snoozed, "dates", { now: NOW }));

  // The profile gate rides the same rule.
  const noProfile = build({
    licenses: [{ ...doLicense }],
    documents: [],
    settings: { degreeType: "DO", email: "e@x.com", notifyEmail: true, reminderLeadDays: 90, setupState: { startedAt: day(1) } },
  });
  ok("setup owns the profile sentence while About you is open", setupOwns(noProfile, "identity", { now: NOW }));
  const profileSkipped = build({
    licenses: [{ ...doLicense }],
    documents: [],
    settings: { degreeType: "DO", email: "e@x.com", notifyEmail: true, reminderLeadDays: 90, setupState: { startedAt: day(30), tasks: { identity: { s: "skipped", at: day(30) } } } },
  });
  ok("a skipped About you hands the profile banner back", !setupOwns(profileSkipped, "identity", { now: NOW }));

  // Once Tier 1 is stamped the card is Form D, which owns nothing either.
  const done = build({ ...packed(), settings: { ...packedSettings, setupState: { startedAt: day(30), tier1DoneAt: day(20) } } });
  eq("a finished board is Form D", homeCardForm(done, { now: NOW }), CARD_FORM.D);
  ok("and Form D owns nothing", !setupOwns(done, "dates", { now: NOW }));
}

// ── First render ──
{
  const fresh = build({ settings: { ...settledSettings }, licenses: [] });
  eq("a new board stamps its start", firstRenderPatch(fresh, { now: NOW }), { startedAt: NOW.toISOString() });
  const already = build(settled());
  eq("an already-set-up account is stamped complete in the same pass and never interrupted",
    firstRenderPatch(already, { now: NOW }), { startedAt: NOW.toISOString(), tier1DoneAt: NOW.toISOString() });
  const seen = build({ settings: { ...settledSettings, setupState: { startedAt: day(5) } }, licenses: [] });
  eq("a board that has been seen is never re-stamped", firstRenderPatch(seen, { now: NOW }), null);
}

// ── shortDate ──
eq("shortDate", shortDate(new Date(2026, 8, 4, 12).toISOString()), "4 Sep");
eq("shortDate of nothing", shortDate(null), "");
eq("shortDate of garbage", shortDate("not a date"), "");


/* ══ TIER 2 ══════════════════════════════════════════════════════════
 * The packet rows: their completion rules, their evidence rules, the Pro
 * denominator in both directions, and the ladder that decides what the card
 * says after a physician has been away.
 */

// ── Completion rules, one row at a time ──
{
  const t2 = (patch, opts) => build({ ...packed(), ...patch }, opts);
  const st = (setup, id) => setup.byId[id].status;

  // proof: every medical licence and DEA record needs its copy, and an empty
  // account is not vacuously finished.
  eq("proof is documented when every licence and DEA carries a copy", st(build(packed()), "proof"), "documented");
  eq("one licence without a copy reopens proof",
    st(t2({ documents: packed().documents.filter((d) => d.linkedTo !== "licenses:d1") }), "proof"), "pending");
  eq("an account with no licences is not vacuously proved",
    st(build({ settings: { ...packedSettings }, licenses: [], documents: [] }), "proof"), "pending");
  eq("proof is blocked by licences, so it never outranks them",
    build({ settings: { ...packedSettings }, licenses: [], documents: [] }).byId.proof.blockedBy, "licenses");
  eq("a board certificate is not a licence copy",
    build({ settings: { ...packedSettings }, licenses: [{ id: "b1", type: "Board Certification (AOA)" }], documents: [] }).byId.proof.status, "pending");

  // boards: the record AND the specialty, never a date.
  eq("boards needs a specialty as well as the certificate",
    st(t2({ settings: { ...packedSettings, specialties: [] } }), "boards"), "pending");
  eq("an AOA certificate closes boards for a DO", st(build(packed()), "boards"), "documented");
  eq("an ABMS certificate closes boards for an MD", st(build({
    ...packed(), settings: { ...packedSettings, degreeType: "MD" },
    licenses: [{ id: "b1", type: "Board Certification (ABMS)" }],
    documents: [{ id: "g", linkedTo: "licenses:b1" }],
  }), "boards"), "documented");
  ok("a lifetime diplomate is never asked for a board expiration date",
    build({ ...packed(), licenses: [{ id: "b1", type: "Board Certification (AOA)" }] }).byId.boards.status !== "pending");

  // lifeSupport: dated card, by type or by name.
  eq("an ACLS card with a date closes life support", st(build(packed()), "lifeSupport"), "documented");
  eq("an undated card does not",
    st(t2({ licenses: packed().licenses.map((l) => (l.id === "a1" ? { ...l, expirationDate: "" } : l)) }), "lifeSupport"), "pending");
  eq("BLS named on a generic certification counts", st(build({
    ...packed(), licenses: [{ id: "x", type: "Certification", name: "BLS renewal", expirationDate: "2027-01-01" }],
  }), "lifeSupport"), "done");

  // cme, work: presence is the whole rule.
  eq("one CME entry closes the CME row", st(build(packed()), "cme"), "done");
  eq("no CME leaves it open", st(t2({ cme: [] }), "cme"), "pending");
  ok("the CME row takes no evidence", !build(packed()).byId.cme.hasEvidence);
  eq("one position closes work history", st(build(packed()), "work"), "done");
  eq("an empty work history does not", st(t2({ workHistory: [] }), "work"), "pending");

  // education: both halves, in either vocabulary.
  eq("school and training together close education", st(build(packed()), "education"), "documented");
  eq("school alone does not", st(t2({ education: [{ id: "e1", type: "Doctor of Medicine (MD)" }] }), "education"), "pending");
  eq("training alone does not", st(t2({ education: [{ id: "e2", type: "Fellowship Certificate" }] }), "education"), "pending");
  eq("an MD degree closes the school half", st(build({
    ...packed(), education: [{ id: "e1", type: "Doctor of Medicine (MD)" }, { id: "e2", type: "Internship Certificate" }], documents: [],
  }), "education"), "done");

  // idPhoto: an ID with a number, plus a headshot from either place.
  eq("a passport with a number and a headshot close it", st(build(packed()), "idPhoto"), "documented");
  eq("a passport with no number is not an ID on file",
    st(t2({ travelDocs: [{ id: "t1", type: "Passport" }] }), "idPhoto"), "pending");
  eq("a loyalty card is not a photo ID",
    st(t2({ travelDocs: [{ id: "t1", type: "Airline loyalty", number: "99" }] }), "idPhoto"), "pending");
  eq("the profile photo counts as the headshot", st(build({
    ...packed(), professionalPhotos: [], settings: { ...packedSettings, profilePhoto: "data:image/png;base64,AA" },
  }), "idPhoto"), "documented");
  eq("neither photo anywhere leaves it open", st(build({
    ...packed(), professionalPhotos: [], settings: { ...packedSettings, profilePhoto: "" },
  }), "idPhoto"), "pending");
}

// ── The three Pro rows ──
{
  const pro = (patch) => build({ ...packed(), ...patch }, { isPro: true });
  const privileged = { privileges: [{ id: "p1", expirationDate: "2027-01-01" }] };

  eq("dated privileges close the row", pro(privileged).byId.privileges.status, "done");
  eq("one undated privilege reopens it",
    pro({ privileges: [{ id: "p1", expirationDate: "2027-01-01" }, { id: "p2" }] }).byId.privileges.status, "pending");
  eq("a linked reappointment letter lights the proof dot", pro({
    ...privileged, documents: [...packed().documents, { id: "d", linkedTo: "privileges:p1" }],
  }).byId.privileges.status, "documented");

  eq("a dated malpractice policy closes the row",
    pro({ insurance: [{ id: "i1", type: "Medical Malpractice (Claims-Made)", expirationDate: "2027-01-01" }] }).byId.malpractice.status, "done");
  eq("tail coverage counts as malpractice",
    pro({ insurance: [{ id: "i1", type: "Tail Coverage", expirationDate: "2027-01-01" }] }).byId.malpractice.status, "done");
  eq("health insurance does not",
    pro({ insurance: [{ id: "i1", type: "Health Insurance (personal)", expirationDate: "2027-01-01" }] }).byId.malpractice.status, "pending");
  eq("an undated policy does not",
    pro({ insurance: [{ id: "i1", type: "Tail Coverage" }] }).byId.malpractice.status, "pending");

  const refs = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Ref ${i}`, email: `r${i}@x.com` }));
  eq("three reachable references close the row", pro({ peerReferences: refs(3) }).byId.references.status, "done");
  eq("two do not", pro({ peerReferences: refs(2) }).byId.references.status, "pending");
  eq("a reference with no way to reach them does not count",
    pro({ peerReferences: [...refs(2), { id: "r9", name: "Ref 9" }] }).byId.references.status, "pending");
  ok("a reference is a contact, not a certificate, so it takes no proof",
    !pro({ peerReferences: refs(3) }).byId.references.hasEvidence);
}

// ── The Pro denominator, and the beta ──
{
  const free = build(packed());
  eq("a free account counts seven packet rows", [free.counts.tier2.total, free.counts.tier2.done], [7, 7]);
  eq("and its packet is complete with the three Pro rows still locked", free.counts.tier2.complete, true);
  eq("the Pro rows are still on the board, just locked", free.counts.tier2.locked, 3);
  ok("every locked row is a Pro row", free.tier2.filter((t) => t.locked).every((t) => t.pro));
  ok("a locked row never becomes the next action", !free.open.some((t) => t.locked));

  const pro = build(packed(), { isPro: true });
  eq("Pro counts ten", pro.counts.tier2.total, 10);
  eq("and reopens the board", pro.counts.tier2.complete, false);
  eq("the ranker offers a Pro row once the account can reach it", pro.next.pro, true);

  // While the free beta runs, the Pro rows are live and counted for
  // everyone, tagged rather than sold: PricingModal CTAs are hidden, so an
  // upgrade link would lead nowhere.
  const beta = build(packed(), { isPro: true, isFreeBeta: true, hasSubscription: false });
  ok("beta rows are unlocked", !beta.tier2.some((t) => t.locked));
  eq("beta rows carry the tag", beta.tier2.filter((t) => t.betaTag).length, 3);
  const subscriber = build(packed(), { isPro: true, isFreeBeta: true, hasSubscription: true });
  ok("a real subscriber is never tagged Free beta", !subscriber.tier2.some((t) => t.betaTag));

  // na leaves the denominator; a skip stays in it. Same rule as Tier 1.
  const naCme = build({ ...packed(), settings: { ...packedSettings, setupState: { tasks: { cme: { s: "na", at: day(1) } } } }, cme: [] });
  eq("a packet row marked inapplicable leaves the total", naCme.counts.tier2.total, 6);
  const skippedCme = build({ ...packed(), settings: { ...packedSettings, setupState: { tasks: { cme: { s: "skipped", at: day(1) } } } }, cme: [] });
  eq("a skipped packet row stays in the total", [skippedCme.counts.tier2.total, skippedCme.counts.tier2.done], [7, 6]);
}

// ── The denominator, narrated ──
{
  const withPro = (n, betaCounted) => build({
    ...packed(),
    settings: { ...packedSettings, setupState: { startedAt: day(9), proCounted: n, betaCounted } },
  }, { isPro: true });

  eq("a board that has never been recorded says nothing", denominatorNarration(build(packed())), null);
  eq("an unchanged board says nothing", denominatorNarration(withPro(3, false), { isFreeBeta: false }), null);
  eq("Pro arriving is narrated", denominatorNarration(withPro(0, false), { isFreeBeta: false }),
    "Pro added 3 items to your board.");

  const betaEnded = build({
    ...packed(),
    settings: { ...packedSettings, setupState: { startedAt: day(9), proCounted: 3, betaCounted: true } },
  }, { isPro: false, isFreeBeta: false });
  eq("the beta ending is narrated in its own words", denominatorNarration(betaEnded, { isFreeBeta: false }),
    "The free beta has ended, so 3 Pro items left your total. Nothing you entered was removed.");

  const lapsed = build({
    ...packed(),
    settings: { ...packedSettings, setupState: { startedAt: day(9), proCounted: 3, betaCounted: false } },
  }, { isPro: false, isFreeBeta: false });
  eq("a plain drop does not blame the beta", denominatorNarration(lapsed, { isFreeBeta: false }),
    "3 Pro items left your total. Nothing you entered was removed.");

  const snap = proSnapshot(build(packed(), { isPro: true, isFreeBeta: true }), { isFreeBeta: true });
  eq("the snapshot records the count and why", snap, { proCounted: 3, betaCounted: true });
  ok("a fresh board does not match a null record", !proSnapshotMatches(build(packed()), { isFreeBeta: false }));
  const recorded = withProSnapshot({ startedAt: day(1) }, { proCounted: 0, betaCounted: false });
  eq("recording it survives normalization", [recorded.proCounted, recorded.betaCounted], [0, false]);
  ok("recorded, it matches", proSnapshotMatches(build({
    ...packed(), settings: { ...packedSettings, setupState: recorded },
  }), { isFreeBeta: false }));
}

// ── The re-engagement ladder ──
{
  // A physician mid-setup: licences imported, none of them dated.
  const stalled = (lastTouched, lastDone) => build({
    settings: {
      ...settledSettings,
      setupState: { startedAt: day(40), lastTouched, lastDone },
    },
    licenses: [
      { id: "a", type: "State Medical License (DO)", state: "CA", expirationDate: "2027-01-01" },
      { id: "b", type: "State Medical License (DO)", state: "TX" },
    ],
    documents: [],
  });

  eq("with nothing touched yet the card names the exposure", ladderState(stalled(null), { now: NOW }).bucket, LADDER.FRESH);
  eq("and that sentence is the task's own", ladderState(stalled(null), { now: NOW }).text,
    "1 license on file with no expiration date. Nothing will warn you about it.");
  eq("yesterday is still day zero", ladderState(stalled(day(1), "licenses"), { now: NOW }).bucket, LADDER.FRESH);

  const cont = ladderState(stalled(day(3), "licenses"), { now: NOW });
  eq("three days out leads with continuity", cont.bucket, LADDER.CONTINUITY);
  eq("naming what they finished and what is next", cont.text,
    `You finished your licenses on ${weekdayName(day(3))}. Next: the expiration date on your Texas license.`);
  eq("continuity with no record of what closed falls back", ladderState(stalled(day(3), null), { now: NOW }).bucket, LADDER.FRESH);

  const cost = ladderState(stalled(day(10), "licenses"), { now: NOW });
  eq("a week out states the cost", cost.bucket, LADDER.COST);
  eq("counted out of their own file, never a statistic about physicians", cost.text,
    "1 of your 2 licenses has no expiration date on file. No reminder can fire for it until it does.");

  // Nothing true and specific to say at this rung: fall back to day zero.
  const noCost = build({
    settings: { ...settledSettings, setupState: { startedAt: day(40), lastTouched: day(10), lastDone: "identity" } },
    licenses: [],
  });
  eq("with nothing quantifiable the cost rung falls back", ladderState(noCost, { now: NOW }).bucket, LADDER.FRESH);

  const one = ladderState(stalled(day(40), "licenses"), { now: NOW });
  eq("a month out shrinks to one line", one.bucket, LADDER.ONE_THING);
  eq("offering the cheapest thing left", one.text, "One thing, about ten seconds: the expiration date on your Texas license.");
  eq("with a button that just does it", one.verb, "Add it");
  eq("and it is the cheapest, not the most important", stalled(day(40), "licenses").cheapest.id, "dates");

  eq("a board with nothing open has no ladder at all", ladderState(build({
    ...packed(),
    settings: { ...packedSettings, setupState: { startedAt: day(40), lastTouched: day(40), lastDone: "cme" } },
  }), { now: NOW }), null);

  // The Home card and the page's Next card are the TIER 1 card while Tier 1
  // is unfinished. With the last open Tier 1 row skipped outside its re-offer
  // window the tier-scoped ladder has nothing to say, and the card falls back
  // to "set aside" rather than naming a packet row under a Tier 1 header.
  const t1AllSkipped = build({
    settings: {
      ...settledSettings,
      setupState: {
        startedAt: day(40),
        tasks: { dates: { s: "skipped", at: day(40) } },
      },
    },
    licenses: [
      { id: "a", type: "State Medical License (DO)", state: "CA", expirationDate: "2027-01-01" },
      { id: "b", type: "State Medical License (DO)", state: "TX" },
      { ...deaLicense },
    ],
    documents: [],
  });
  eq("every open Tier 1 row skipped leaves the Tier 1 ladder silent",
    ladderState(t1AllSkipped, { now: NOW, tier: 1 }), null);
  ok("while the unscoped ladder still finds a packet rung",
    ladderState(t1AllSkipped, { now: NOW })?.taskId != null &&
    t1AllSkipped.byId[ladderState(t1AllSkipped, { now: NOW }).taskId].tier === 2);

  // Day 30 shrinks to the cheapest thing in the POOL it was given, never to a
  // packet row the tier-scoped card cannot open.
  const t1Cheap = ladderState(stalled(day(40), "licenses"), { now: NOW, tier: 1 });
  eq("the tier-scoped day-30 rung stays inside Tier 1",
    [t1Cheap.bucket, stalled(day(40), "licenses").byId[t1Cheap.taskId].tier], [LADDER.ONE_THING, 1]);
}

// ── The phrase builders the ladder and the run depend on ──
{
  eq("numbers are words up to twelve", [numberWord(1), numberWord(8), numberWord(12), numberWord(13)], ["one", "eight", "twelve", "13"]);
  eq("the run intro counts in words", runIntro(8),
    "Eight licenses need two things: the date they expire and a copy of the certificate. Photograph them one after another and the app reads both off the page.");
  eq("one record reads as one record", runIntro(1),
    "One license needs two things: the date it expires and a copy of the certificate. Photograph it and the app reads both off the page.");
  eq("the run intro takes the section's own noun", runIntro(2, "privileges", "privilege").slice(0, 14), "Two privileges");
  // A board certificate and a diploma carry no expiration, so the run must
  // not claim one and must not offer to write one.
  eq("a dateless row asks for one thing", runIntro(1, "records", "record", false),
    "One record needs one thing: a copy of the certificate. Photograph it and the app reads it off the page.");
  eq("and says so in the plural too", runIntro(2, "records", "record", false),
    "Two records need one thing: a copy of the certificate. Photograph them one after another and the app reads them off the page.");
  ok("no dateless intro asserts an expiration",
    !/expire/i.test(runIntro(1, "records", "record", false) + runIntro(3, "records", "record", false)));
  eq("estimates are words, mid-sentence", [secsPhrase(10), secsPhrase(20), secsPhrase(45), secsPhrase(90)],
    ["about ten seconds", "about twenty seconds", "under a minute", "a minute or two"]);
  eq("a weekday reads as a weekday", weekdayName("2026-09-07T12:00:00.000Z").length > 0, true);
  eq("garbage has no weekday", weekdayName("not a date"), "");
  eq("datable is dateless plus the ones already dated", datable(packed()).length, 2);
}

// ── The capture queues ──
{
  const q = evidenceQueue(packed(), "proof");
  eq("a fully proved account has an empty proof queue", [q.section, q.records.length], ["licenses", 0]);
  const missing = evidenceQueue({ ...packed(), documents: [] }, "proof");
  eq("the queue is exactly the records still missing their copy",
    [missing.section, missing.records.map((r) => r.id)], ["licenses", ["l1", "d1"]]);
  eq("the privileges queue walks privileges",
    evidenceQueue({ ...packed(), privileges: [{ id: "p1" }] }, "privileges").records.map((r) => r.id), ["p1"]);
  eq("the ID queue walks travel documents",
    evidenceQueue({ ...packed(), documents: [] }, "idPhoto").records.map((r) => r.id), ["t1"]);
  eq("a row that takes no proof has no queue", evidenceQueue(packed(), "cme"), { section: null, records: [] });
  // The drawer's manual button opens the add form, so it carries its own
  // label; every other row reuses the card's verb.
  const verbs = build(packed()).byId;
  eq("the proof row's manual button is not the camera verb",
    [verbs.proof.verb, verbs.proof.addVerb], ["Photograph them", "Add a license by hand"]);
  ok("every other row's manual button is its own verb",
    TASK_DEFS.every((d) => d.id === "proof" || verbs[d.id].addVerb === verbs[d.id].verb));
  eq("an empty file gives an empty queue, never a crash", evidenceQueue(null, "proof").records.length, 0);
}

// ── The terminal state: what Home says once Tier 1 is stamped ──
{
  // packed() closes every FREE packet row. The three Pro rows need records
  // too, or "everything resolved" is never reachable on a Pro account.
  const fullyPacked = () => {
    const d = packed();
    return {
      ...d,
      privileges: [{ id: "p1", facility: "Arrowhead", expirationDate: "2027-05-01" }],
      insurance: [{ id: "i1", type: "Malpractice", expirationDate: "2027-08-01" }],
      peerReferences: [
        { id: "r1", name: "A Smith, MD", email: "a@x.com" },
        { id: "r2", name: "B Jones, DO", phone: "555-0101" },
        { id: "r3", name: "C Lee, MD", email: "c@x.com" },
      ],
      documents: [...d.documents, { id: "g7", linkedTo: "privileges:p1" }, { id: "g8", linkedTo: "insurance:i1" }],
    };
  };
  const stamped = (data) => ({
    ...data,
    settings: { ...data.settings, setupState: { v: 1, startedAt: day(30), tier1DoneAt: day(20) } },
  });

  // Everything resolved: one line of navigation, counted across the WHOLE
  // board, not Tier 1 alone. "5 of 5" while the packet is half empty would
  // be a true number saying a false thing.
  const done = build(stamped(fullyPacked()), { isPro: true });
  eq("the packet is finished", done.counts.tier2.complete, true);
  eq("Form D is the terminal form", homeCardForm(done, { now: NOW }), CARD_FORM.D);
  const all = boardCounts(done);
  eq("the terminal line counts the whole board", [all.done, all.total], [15, 15]);
  eq("nothing is left", all.left, 0);
  eq("nothing regressed", tier1Regressed(done), null);

  // Free beta ended, so the three Pro rows are locked and out of the total.
  const free = build(stamped(fullyPacked()), { isPro: false });
  eq("locked Pro rows leave the terminal total too", boardCounts(free).total, 12);

  // A record deleted months later un-completes Tier 1. The bordered card
  // never comes back; the terminal line names what changed.
  const undated = stamped(fullyPacked());
  undated.licenses = undated.licenses.map((l) => (l.id === "l1" ? { ...l, expirationDate: "" } : l));
  const regressed = build(undated, { isPro: true });
  eq("a lost date reopens Tier 1", regressed.counts.tier1.complete, false);
  eq("but never the bordered card", homeCardForm(regressed, { now: NOW }), CARD_FORM.D);
  eq("and the line names the record", tier1Regressed(regressed)?.regressionLine, "your CA license lost its expiration date");
  eq("and links to the task that fixes it", tier1Regressed(regressed)?.id, "dates");

  // Exposure order, not page order: a physician who lost a date AND turned
  // reminders off is told about the date.
  const both = stamped(fullyPacked());
  both.licenses = both.licenses.map((l) => (l.id === "l1" ? { ...l, expirationDate: "" } : l));
  both.settings = { ...both.settings, notifyEmail: false };
  eq("the date outranks the reminder", tier1Regressed(build(both, { isPro: true }))?.id, "dates");
  const off = stamped(fullyPacked());
  off.settings = { ...off.settings, notifyEmail: false };
  eq("reminders off is named when it is the only thing", tier1Regressed(build(off, { isPro: true }))?.regressionLine, "reminders are off");

  // A stale skip is not an open task, so the line must not be read off
  // setup.next: it would name a packet row, or nothing at all.
  const skipped = stamped(fullyPacked());
  skipped.licenses = skipped.licenses.map((l) => (l.id === "l1" ? { ...l, expirationDate: "" } : l));
  skipped.settings = {
    ...skipped.settings,
    setupState: { v: 1, startedAt: day(30), tier1DoneAt: day(20), tasks: { dates: { s: "skipped", at: day(1) } } },
  };
  const withSkip = build(skipped, { isPro: true });
  eq("the skipped task is not open, so there is no next task", withSkip.next, null);
  eq("but the regression is still named", tier1Regressed(withSkip)?.id, "dates");
  eq("and still names the record", tier1Regressed(withSkip)?.regressionLine, "your CA license lost its expiration date");

  // A regression clause names the field that is actually blank. Identity
  // completes on three fields, so a cleared name must not be reported as a
  // blank degree, and a deleted DEA must not be reported as an undated one.
  const noName = stamped(fullyPacked());
  noName.settings = { ...noName.settings, name: "" };
  eq("a cleared name names itself", tier1Regressed(build(noName, { isPro: true }))?.regressionLine, "your name is blank");
  const noDegree = stamped(fullyPacked());
  noDegree.settings = { ...noDegree.settings, degreeType: "" };
  eq("a cleared degree still names the degree", tier1Regressed(build(noDegree, { isPro: true }))?.regressionLine, "your degree is blank");
  const deaGone = stamped(fullyPacked());
  deaGone.licenses = deaGone.licenses.filter((l) => l.id !== "d1");
  eq("a deleted DEA is not an undated DEA",
    tier1Regressed(build(deaGone, { isPro: true }))?.regressionLine, "your DEA registration is no longer on file");
  const deaUndated = stamped(fullyPacked());
  deaUndated.licenses = deaUndated.licenses.map((l) => (l.id === "d1" ? { ...l, expirationDate: "" } : l));
  eq("an undated DEA still reads as undated",
    build(deaUndated, { isPro: true }).byId.dea.regressionLine, "your DEA registration has no expiration date");

  // Every Tier 1 task can name what it lost, or the terminal line falls
  // back to a count and says nothing about what changed.
  ok("every Tier 1 task carries a regression clause",
    TASK_DEFS.filter((d) => d.tier === 1).every((d) => typeof d.regressionLine === "function"),
    TASK_DEFS.filter((d) => d.tier === 1 && !d.regressionLine).map((d) => d.id).join(", "));
  ok("no regression clause carries an em dash",
    TASK_DEFS.filter((d) => d.tier === 1).every((d) => !String(build(stamped({ settings: {}, licenses: [] })).byId[d.id].regressionLine || "").includes("—")));
}

// ── A lifetime board certificate ──
{
  // isNonExpiring reads item.noExpiration, and until the licenses form grew
  // a checkbox nothing set it. A diplomate with no renewal date must not be
  // counted as a record owing one.
  const life = packed();
  life.licenses = [...life.licenses, { id: "b2", type: "Board Certification (ABMS)", noExpiration: true }];
  eq("a declared non-expiring record is not dateless", dateless(life).map((l) => l.id), []);
  eq("and is not in the datable denominator either", datable(life).map((l) => l.id), ["l1", "d1"]);
  // Without the flag a board certificate is still not a Tier 1 date task:
  // T3 is scoped to medical licenses, DEA and CSR on purpose.
  const noFlag = packed();
  noFlag.licenses = [...noFlag.licenses, { id: "b3", type: "Board Certification (ABMS)" }];
  eq("a board certificate never blocks Protected", build(noFlag).byId.dates.status, "done");

  // The checkbox is only offered on a board certification. Tick it, then edit
  // the record's type to a state license: the box is hidden but the flag is
  // still on the form, and a dated credential silently left the reminder
  // system. The flag is now scoped to the type it was written for.
  const switched = packed();
  switched.licenses = [...switched.licenses, { id: "b4", type: "State Medical License (DO)", state: "TX", noExpiration: true }];
  eq("a stale flag cannot silence a state license", dateless(switched).map((l) => l.id), ["b4"]);
  eq("and it stays in the denominator", datable(switched).map((l) => l.id), ["l1", "d1", "b4"]);
  // The course/device certification the flag was already true for is untouched.
  const course = packed();
  course.licenses = [...course.licenses, { id: "b5", type: "Certification", name: "Da Vinci", noExpiration: true }];
  eq("a course certification is still non-expiring", dateless(course).map((l) => l.id), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
