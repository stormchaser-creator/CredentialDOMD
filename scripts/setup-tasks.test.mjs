// Unit-style checks for src/utils/setupTasks.js, the whole Tier 1 board:
// the five completion rules against BOTH the MD and the DO license
// vocabularies, the derived/skipped/na/pending resolution order, the
// denominator arithmetic (skipped stays in, na leaves), prune-on-write, the
// deterministic ranker behind the Next card, and which form the Home card
// takes. Run: node scripts/setup-tasks.test.mjs
// Pure node, no test runner. Exit code 1 on any failure.
import {
  buildSetup, dateless, normalizeSetupState, pruneSetupState, shortDate,
  withTask, withDeclared, withSnooze, withStarted, withTier1Done,
  homeCardForm, setupOwns, firstRenderPatch, CARD_FORM, CARD_PRIORITY, TASK_DEFS,
  isMedicalLicense, isDea, isCsr, isBoard, isLifeSupport,
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
  eq("every task carries the escape", TASK_DEFS.length, 5);
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
  eq("a settled account has nothing next", build(settled()).next, null);
  const skippedNow = build({ settings: { ...settledSettings, setupState: { tasks: { dea: { s: "skipped", at: day(1) } } } }, licenses: [doLicense] });
  eq("a fresh skip leaves the Next rotation", skippedNow.next, null);
  const skippedOld = build({ settings: { ...settledSettings, setupState: { tasks: { dea: { s: "skipped", at: day(8) } } } }, licenses: [doLicense] });
  eq("a week-old skip is offered once more", skippedOld.next.id, "dea");
  const skippedAncient = build({ settings: { ...settledSettings, setupState: { tasks: { dea: { s: "skipped", at: day(30) } } } }, licenses: [doLicense] });
  eq("an old skip stops fighting the physician every morning", skippedAncient.next, null);
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
  const stamped = build({ ...settled(), settings: { ...settledSettings, setupState: { startedAt: day(3), tier1DoneAt: day(1) } } });
  eq("the Protected moment never replays", homeCardForm(stamped, { now: NOW }), CARD_FORM.D);
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
  eq("a skip leaves the task in the denominator", skipped.counts.tier1, { total: 5, done: 4, skipped: 1, na: 0, left: 1, complete: false });
  ok("a skip never stamps Tier 1 done", !skipped.state.tier1DoneAt);
  eq("the card stays on Form A", homeCardForm(skipped, { now: NOW }), CARD_FORM.A);
  eq("but it has nothing left to offer", skipped.next, null);
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
  const done = build({ ...settled(), settings: { ...settledSettings, setupState: { startedAt: day(30), tier1DoneAt: day(20) } } });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
