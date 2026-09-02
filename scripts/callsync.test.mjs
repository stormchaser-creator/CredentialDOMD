// Unit checks for src/utils/callsync.js: the CallSync calendar feed parsed
// into shifts, the feed link validated, the ANMG agreement found and priced,
// and the sync plan pinned to its invariants: a re-sync never duplicates a
// shift, a hand-made day is never touched, a future shift that left the
// published schedule comes off (inside the feed window only), the past is
// left alone, and a hand-adjusted dollar figure survives.
// Run: node scripts/callsync.test.mjs   (pure node, no test runner)

const {
  parseFeedUrl, parseICS, shiftsFromICS, shiftFromEvent, detectContract,
  gridHospitalFor, expectedForShift, planSync, syncWindow, isDueForAutoSync,
  describeSync, CALLSYNC_SOURCE, AUTO_SYNC_INTERVAL_MS, RETRY_INTERVAL_MS,
} = await import("../src/utils/callsync.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// ─── Feed link ────────────────────────────────────────────────
const TOKEN = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const RAILWAY = `https://anmg-callsync-production.up.railway.app/api/ical?token=${TOKEN}`;
eq("railway link accepted as-is", parseFeedUrl(RAILWAY), RAILWAY);
eq("public CNAME accepted", parseFeedUrl(`https://callsync.anmg-ca.com/api/ical?token=${TOKEN}`), `https://callsync.anmg-ca.com/api/ical?token=${TOKEN}`);
eq("scheme-less link gets https", parseFeedUrl(`anmg-callsync-production.up.railway.app/api/ical?token=${TOKEN}`), RAILWAY);
eq("bare token builds the railway link", parseFeedUrl(TOKEN), RAILWAY);
eq("whitespace trimmed", parseFeedUrl(`  ${RAILWAY}\n`), RAILWAY);
eq("extra query params dropped", parseFeedUrl(`${RAILWAY}&x=1`), RAILWAY);
eq("other host refused", parseFeedUrl(`https://evil.example.com/api/ical?token=${TOKEN}`), null);
eq("http refused", parseFeedUrl(`http://anmg-callsync-production.up.railway.app/api/ical?token=${TOKEN}`), null);
eq("other path refused", parseFeedUrl(`https://anmg-callsync-production.up.railway.app/api/schedule?token=${TOKEN}`), null);
eq("missing token refused", parseFeedUrl("https://anmg-callsync-production.up.railway.app/api/ical"), null);
eq("token shape enforced", parseFeedUrl("https://anmg-callsync-production.up.railway.app/api/ical?token=a%20b"), null);
eq("empty is null", parseFeedUrl(""), null);
eq("garbage is null", parseFeedUrl("not a link at all"), null);

// ─── iCal parsing (mirrors CallSync's buildICS: CRLF, folding, escapes) ──
const fold = (line) => {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let pos = 75;
  while (pos < line.length) { parts.push(" " + line.slice(pos, pos + 74)); pos += 74; }
  return parts.join("\r\n");
};
const vevent = (id, date, hosp, ct, role, phone = "(909) 555-0100") => [
  "BEGIN:VEVENT",
  `UID:${id}-${role.toLowerCase()}@callsync.anmg`,
  "DTSTAMP:20260902T160000Z",
  `DTSTART;VALUE=DATE:${date}`,
  `DTEND;VALUE=DATE:${String(Number(date) + 1)}`,
  `SUMMARY:ON CALL \u2014 ${hosp} ${ct} (${role})`,
  `DESCRIPTION:${ct} coverage\\, neurosurgery at ${hosp}\\nRole: ${role}\\nOn-call phone: ${phone}`,
  `CATEGORIES:${role.toUpperCase()} CALL`,
  role === "Primary" ? "COLOR:tomato" : "COLOR:steelblue",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
];
const calendar = (events) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ANMG CallSync//On-Call Schedule//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  "X-WR-CALNAME:On-Call Schedule \u2014 Eric Whitney",
  "BEGIN:VTIMEZONE", "TZID:America/Los_Angeles", "END:VTIMEZONE",
  ...events.flat(), "END:VCALENDAR",
].map(fold).join("\r\n") + "\r\n";

const ICS = calendar([
  vevent("slot-a", "20260905", "ARMC", "NSx", "Primary"),
  vevent("slot-b", "20260905", "RCH", "NSx", "Backup"),
  vevent("slot-c", "20260912", "ARMC", "NSx", "Primary"),
  vevent("slot-d", "20260601", "EMC", "Neuro ICU", "Primary"),
]);

const events = parseICS(ICS);
eq("four events parsed", events.length, 4);
eq("date from DTSTART;VALUE=DATE", events[0].date, "2026-09-05");
eq("summary unescaped", events[0].summary, "ON CALL \u2014 ARMC NSx (Primary)");
ok("folded description reassembled and unescaped", events[0].description.includes("NSx coverage, neurosurgery at ARMC\nRole: Primary\nOn-call phone: (909) 555-0100"), events[0].description);
eq("uid kept", events[1].uid, "slot-b-backup@callsync.anmg");
const escaped = parseICS("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260905\r\nSUMMARY:a\\; b\\, c\\\\n d\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
eq("semicolon, comma, and escaped backslash unescape in one pass", escaped[0].summary, "a; b, c\\n d");
eq("DTSTART with a time still yields the date", parseICS("BEGIN:VEVENT\r\nDTSTART:20261231T070000Z\r\nEND:VEVENT\r\n")[0].date, "2026-12-31");

const shifts = shiftsFromICS(ICS);
eq("four shifts, key order", shifts.map(s => s.key), [
  "2026-06-01|emc|neuro icu|primary",
  "2026-09-05|armc|nsx|primary",
  "2026-09-05|rch|nsx|backup",
  "2026-09-12|armc|nsx|primary",
]);
eq("shift fields", { ...shifts[1], uid: undefined }, { key: "2026-09-05|armc|nsx|primary", date: "2026-09-05", hospital: "ARMC", coverage: "NSx", role: "primary", label: "ARMC NSx", uid: undefined });
eq("multi-word coverage kept", shifts[0].label, "EMC Neuro ICU");
eq("ascii dash in the title also parses", shiftFromEvent({ date: "2026-09-05", summary: "ON CALL - ARMC NSx (Backup)" }).key, "2026-09-05|armc|nsx|backup");
eq("description fallback when the title changes", shiftFromEvent({ date: "2026-09-05", summary: "Call", description: "NSx at RUHS\nRole: Primary" }).key, "2026-09-05|ruhs|nsx|primary");
eq("category fallback for the role", shiftFromEvent({ date: "2026-09-05", summary: "Call", description: "NSx at RUHS", categories: "BACKUP CALL" }).role, "backup");
eq("no date, no shift", shiftFromEvent({ summary: "ON CALL \u2014 ARMC NSx (Primary)" }), null);
eq("unrelated event skipped", shiftFromEvent({ date: "2026-09-05", summary: "Dentist" }), null);
eq("empty feed, no shifts", shiftsFromICS("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"), []);
eq("duplicate events collapse to one shift", shiftsFromICS(calendar([vevent("x", "20260905", "ARMC", "NSx", "Primary"), vevent("y", "20260905", "ARMC", "NSx", "Primary")])).length, 1);

// ─── Contract detection + pricing ─────────────────────────────
const ANMG = {
  id: "c-anmg", facility: "Arrowhead Neurosurgical Medical Group", shortName: "ANMG", payModel: "daily",
  dayRate: 2060.09, callStipend: 0,
  callRateGrid: [
    { hospital: "Arrowhead Regional Medical Center (ARMC)", primary: 1250, backup: 500 },
    { hospital: "Riverside Community Hospital", primary: 1500, backup: 600 },
    { hospital: "EMC", primary: 2500, backup: 1000 },
  ],
};
const PENROSE = { id: "c-pen", facility: "Penrose Hospital", callStipend: 3000 };
const OLD_ANMG = { ...ANMG, id: "c-anmg-old", customFields: { archivedAt: "2026-01-01T00:00:00Z" } };
eq("ANMG found by short name", detectContract([PENROSE, ANMG])?.id, "c-anmg");
eq("ANMG found by facility", detectContract([PENROSE, { id: "z", facility: "Arrowhead Neurosurgical" }])?.id, "z");
eq("active ANMG beats archived", detectContract([OLD_ANMG, ANMG])?.id, "c-anmg");
eq("archived ANMG when it is the only one", detectContract([OLD_ANMG])?.id, "c-anmg-old");
eq("no ANMG, null", detectContract([PENROSE]), null);
eq("no contracts, null", detectContract(undefined), null);

eq("grid row by parenthesized abbreviation", gridHospitalFor(ANMG, "ARMC"), "Arrowhead Regional Medical Center (ARMC)");
eq("grid row by initials", gridHospitalFor(ANMG, "RCH"), "Riverside Community Hospital");
eq("grid row by exact string", gridHospitalFor(ANMG, "emc"), "EMC");
eq("unknown hospital, null", gridHospitalFor(ANMG, "RUHS"), null);
eq("no grid, null", gridHospitalFor(PENROSE, "ARMC"), null);
eq("primary priced from the grid", expectedForShift(ANMG, shifts[1]), 1250);
eq("backup priced from the grid", expectedForShift(ANMG, shifts[2]), 600);
eq("unknown hospital falls back to the stipend", expectedForShift({ ...ANMG, callStipend: 800 }, { hospital: "RUHS", role: "primary" }), 800);
eq("nothing known prices at zero", expectedForShift(ANMG, { hospital: "RUHS", role: "primary" }), 0);
eq("stipend contract prices from the stipend", expectedForShift(PENROSE, shifts[1]), 3000);

// ─── Planning ─────────────────────────────────────────────────
let nextId = 0;
const makeId = () => `id-${++nextId}`;
const TODAY = "2026-09-02";
const WINDOW = syncWindow(new Date(2026, 8, 2));
eq("feed window, pulled in by a couple of days", WINDOW, { start: "2026-06-03", end: "2027-09-28" });

const priced = (shift) => expectedForShift(ANMG, shift);
const base = { contractId: ANMG.id, expectedFor: priced, dayRate: ANMG.dayRate, today: TODAY, window: WINDOW, makeId };

const hand = { id: "hand-1", date: "2026-09-05", contractId: ANMG.id, kind: "day", expected: 2060 };
const vacation = { id: "vac-1", date: "2026-09-12", kind: "vacation", note: "family" };

const first = planSync({ ...base, shifts, scheduleDays: [hand, vacation] });
eq("first sync adds every shift", first.adds.length, 4);
eq("first sync updates nothing", first.updates.length, 0);
eq("first sync removes nothing", first.removals.length, 0);
const added = first.adds.find(e => e.sourceKey === "2026-09-05|armc|nsx|primary");
eq("added entry shape", added, {
  id: added.id, date: "2026-09-05", contractId: "c-anmg", kind: "call", expected: 1250,
  note: "ARMC NSx primary call (CallSync)", source: CALLSYNC_SOURCE, sourceKey: "2026-09-05|armc|nsx|primary",
});
ok("ids are fresh", new Set(first.adds.map(e => e.id)).size === 4);

// Re-sync with the same feed: nothing changes, nothing duplicates.
const after = [hand, vacation, ...first.adds];
const second = planSync({ ...base, shifts, scheduleDays: after });
eq("re-sync adds nothing", second.adds.length, 0);
eq("re-sync updates nothing", second.updates.length, 0);
eq("re-sync removes nothing", second.removals.length, 0);
eq("re-sync counts every shift as unchanged", second.unchanged, 4);

// A shift leaves the published schedule (swap): only that entry goes, and
// the hand-made day and the vacation on the same dates stay.
const swapped = shifts.filter(s => s.key !== "2026-09-05|armc|nsx|primary");
const third = planSync({ ...base, shifts: swapped, scheduleDays: after });
eq("swapped-away shift removed", third.removals.map(e => e.sourceKey), ["2026-09-05|armc|nsx|primary"]);
ok("hand-made day untouched", !third.removals.some(e => e.id === "hand-1") && !third.updates.some(e => e.id === "hand-1"));
ok("vacation untouched", !third.removals.some(e => e.id === "vac-1") && !third.updates.some(e => e.id === "vac-1"));

// The past is history: a June shift missing from the feed (period archived) stays.
const noJune = shifts.filter(s => s.date !== "2026-06-01");
const fourth = planSync({ ...base, shifts: noJune, scheduleDays: after });
eq("past shift not removed", fourth.removals.length, 0);
// Neither is anything beyond the feed window.
const farFuture = { id: "far", date: "2027-12-01", contractId: ANMG.id, kind: "call", expected: 1250, source: CALLSYNC_SOURCE, sourceKey: "2027-12-01|armc|nsx|primary" };
const fifth = planSync({ ...base, shifts, scheduleDays: [...after, farFuture] });
eq("entry beyond the window not removed", fifth.removals.length, 0);
// An empty (but valid) feed clears the future inside the window, keeps the past.
const sixth = planSync({ ...base, shifts: [], scheduleDays: after });
eq("empty feed removes the future synced shifts only", sixth.removals.map(e => e.sourceKey).sort(), [
  "2026-09-05|armc|nsx|primary", "2026-09-05|rch|nsx|backup", "2026-09-12|armc|nsx|primary",
]);

// A hand-adjusted dollar figure survives; an empty one is filled in.
const adjusted = after.map(e => e.sourceKey === "2026-09-05|armc|nsx|primary" ? { ...e, expected: 1400 } : e);
const seventh = planSync({ ...base, shifts, scheduleDays: adjusted });
eq("adjusted amount left alone", seventh.updates.length, 0);
const blanked = after.map(e => e.sourceKey === "2026-09-05|armc|nsx|primary" ? { ...e, expected: 0 } : e);
const eighth = planSync({ ...base, shifts, scheduleDays: blanked });
eq("blank amount filled from the grid", eighth.updates.map(e => [e.sourceKey, e.expected]), [["2026-09-05|armc|nsx|primary", 1250]]);

// Contract re-pick moves every synced entry; the same entry ids are kept.
const ninth = planSync({ ...base, contractId: "c-anmg-2", shifts, scheduleDays: after });
eq("contract change updates every synced entry", ninth.updates.length, 4);
ok("updates keep their ids", ninth.updates.every(e => after.some(a => a.id === e.id)));
eq("still nothing added", ninth.adds.length, 0);

// Two devices synced the same minute: the duplicate goes, one stays.
const dup = { ...added, id: "dup-1" };
const tenth = planSync({ ...base, shifts, scheduleDays: [...after, dup] });
eq("duplicate synced entry removed", tenth.removals.map(e => e.id), ["dup-1"]);
eq("original kept without an update", tenth.updates.length, 0);

// Legacy synced row without a key is left alone (never matched, never removed).
const legacy = { id: "legacy", date: "2026-10-01", contractId: ANMG.id, kind: "call", expected: 1, source: CALLSYNC_SOURCE };
const eleventh = planSync({ ...base, shifts, scheduleDays: [...after, legacy] });
ok("keyless synced row untouched", !eleventh.removals.some(e => e.id === "legacy") && !eleventh.updates.some(e => e.id === "legacy"));

// ─── Day-rate contract: call cannot land without a work day ───
// No hand entry at all for the date: the sync prices the whole day, day
// rate plus the grid call amount, not call alone.
const addedFuture = first.adds.find(e => e.sourceKey === "2026-09-12|armc|nsx|primary");
eq("nothing logged for the date: day+call, the day rate plus the grid", addedFuture, {
  id: addedFuture.id, date: "2026-09-12", contractId: "c-anmg", kind: "day+call", expected: 3310,
  note: "ARMC NSx primary call (CallSync)", source: CALLSYNC_SOURCE, sourceKey: "2026-09-12|armc|nsx|primary",
});

// A hand-made day+call already covers the date (the physician logged the
// whole day themselves): a sync must add nothing there, and a stale synced
// entry from before they logged it by hand comes off — the double-count
// this ticket reported (a $3060 hand entry plus a redundant synced call).
const handDayCall = { id: "hdc-1", date: "2026-09-05", contractId: ANMG.id, kind: "day+call", expected: 3310 };
const staleSynced = { id: "stale-1", date: "2026-09-05", contractId: ANMG.id, kind: "call", expected: 1250, source: CALLSYNC_SOURCE, sourceKey: "2026-09-05|armc|nsx|primary" };
const twelfth = planSync({ ...base, shifts, scheduleDays: [handDayCall, staleSynced] });
eq("hand day+call fully covers both shifts that date: nothing added there", twelfth.adds.map(e => e.sourceKey).sort(), [
  "2026-06-01|emc|neuro icu|primary", "2026-09-12|armc|nsx|primary",
]);
eq("stale synced entry under a now hand-covered date is removed", twelfth.removals.map(e => e.id), ["stale-1"]);

// The physician already logged the call by hand (the exact-duplicate case
// this ticket reported, a $1000 hand call next to a $1000 synced call): the
// sync must not add a second call, only the day that is still missing.
const handCallOnly = { id: "hc-1", date: "2026-09-05", contractId: ANMG.id, kind: "call", expected: 1250 };
const thirteenth = planSync({ ...base, shifts: [shifts[1]], scheduleDays: [handCallOnly] });
const dayAdded = thirteenth.adds.find(e => e.sourceKey === "2026-09-05|armc|nsx|primary");
eq("hand already has the call: sync fills only the missing day", dayAdded, {
  id: dayAdded.id, date: "2026-09-05", contractId: "c-anmg", kind: "day", expected: 2060,
  note: "ARMC NSx primary call (CallSync)", source: CALLSYNC_SOURCE, sourceKey: "2026-09-05|armc|nsx|primary",
});

// A stipend contract has no day rate to add; a hand-made call already
// covers the date, so the sync adds nothing at all.
const penroseHandCall = { id: "ph-1", date: "2026-09-05", contractId: PENROSE.id, kind: "call", expected: 3000 };
const fourteenth = planSync({
  contractId: PENROSE.id, expectedFor: (s) => expectedForShift(PENROSE, s), dayRate: 0,
  shifts: [shifts[1]], scheduleDays: [penroseHandCall], today: TODAY, window: WINDOW, makeId,
});
eq("stipend contract, hand already logged the call: nothing added", fourteenth.adds.length, 0);

// ─── Once-a-day gate ──────────────────────────────────────────
const NOW = Date.parse("2026-09-02T16:00:00Z");
eq("never synced: due", isDueForAutoSync(null, NOW), true);
eq("synced an hour ago: not due", isDueForAutoSync({ lastOkAt: new Date(NOW - 3600e3).toISOString(), lastAttemptAt: new Date(NOW - 3600e3).toISOString() }, NOW), false);
eq("synced 25h ago: due", isDueForAutoSync({ lastOkAt: new Date(NOW - 25 * 3600e3).toISOString(), lastAttemptAt: new Date(NOW - 25 * 3600e3).toISOString() }, NOW), true);
eq("exactly a day: due", isDueForAutoSync({ lastOkAt: new Date(NOW - AUTO_SYNC_INTERVAL_MS).toISOString() }, NOW), true);
eq("failed five minutes ago: wait", isDueForAutoSync({ lastAttemptAt: new Date(NOW - 5 * 60e3).toISOString(), ok: false }, NOW), false);
eq("failed, retry window passed: due", isDueForAutoSync({ lastAttemptAt: new Date(NOW - RETRY_INTERVAL_MS).toISOString(), ok: false }, NOW), true);
eq("corrupt timestamp: due", isDueForAutoSync({ lastOkAt: "garbage" }, NOW), true);

// ─── Status line ──────────────────────────────────────────────
eq("plain count", describeSync({ total: 14 }), "14 call days on the calendar");
eq("singular", describeSync({ total: 1 }), "1 call day on the calendar");
eq("with changes", describeSync({ total: 14, added: 2, removed: 1 }), "14 call days on the calendar (2 added, 1 removed)");
eq("zero changes omitted", describeSync({ total: 3, added: 0, updated: 0, removed: 0 }), "3 call days on the calendar");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
