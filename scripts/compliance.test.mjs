// Unit-style checks for src/utils/compliance.js (the CME compliance engine)
// and the state-topic tagging in src/utils/cmeImport.js. These pin the audit
// fixes: data-driven Category 1 counting, one-time / longer-period topic
// mandates, MATE Act topic scope, the cycle-window boundary, and intake
// tagging of state-only topics.
// Run: node scripts/compliance.test.mjs   (pure node, no test runner)
import { computeCompliance, windowNotes, topicPeriodLabel } from "../src/utils/compliance.js";
import { safeHttpUrl } from "../src/utils/safeUrl.js";
import { STATE_REQS } from "../src/constants/stateRequirements.js";
import { guessTopics } from "../src/utils/cmeImport.js";
import {
  aoaCategoryFor, cat1BucketLabel, cat1Breakdown, cat1RouteNote, logNoteFor,
  smallSpecialtyNote, providerAoaLine, equivalenceFor, TRAINING_CREDIT,
  SMALL_SPECIALTY_EXCEPTION, CAT1B_CONVERSION,
} from "../src/constants/creditEquivalence.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// Dates: `daysAgo` for in/out of the rolling cycle window; the boundary test
// anchors an explicit expiration so it is independent of "today".
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const cme = (category, hours, date, topics = []) => ({ category, hours: String(hours), date, topics });
const RECENT = isoDaysAgo(100);   // inside a 2-year cycle
const YR4 = isoDaysAgo(1400);     // ~3.8y: outside a 2y cycle, inside a 6y window
const YR7 = isoDaysAgo(2600);     // ~7.1y: outside a 6y window
const OLD = isoDaysAgo(2000);     // ~5.5y: outside a 2y cycle

// ── Finding 1: Category 1 counted from data, not a regex over the rule prose ──

// CO accepts AMA PRA Category 1 and AOA Category 1-A, NOT 1-B. The old
// heuristic read "...AOA Category 1-A..." as "1-A only" and dropped AMA hours.
const co = computeCompliance([cme("AMA PRA Category 1", 14.75, RECENT), cme("AOA Category 1-B", 5, RECENT)], "CO", "DO");
eq("CO cat1 keywords from data", co.cat1Keywords, ["AMA PRA Category 1", "AOA Category 1-A"]);
ok("CO cat1 marked data-driven", co.cat1FromData === true);
eq("CO DO counts AMA toward cat1 (was 0)", co.cat1Earned, 14.75);
ok("CO excludes AOA 1-B", !co.cat1Keywords.includes("AOA Category 1-B"));
const coMd = computeCompliance([cme("AMA PRA Category 1", 14.75, RECENT)], "CO", "MD");
eq("CO MD counts AMA toward cat1", coMd.cat1Earned, 14.75);

// CA/DO minimum is AOA 1-A or 1-B only; AMA must NOT inflate it (was over-counted).
const caDo = computeCompliance([cme("AMA PRA Category 1", 20, RECENT), cme("AOA Category 1-A", 12, RECENT)], "CA", "DO");
eq("CA DO cat1 keywords", caDo.cat1Keywords, ["AOA Category 1-A", "AOA Category 1-B"]);
eq("CA DO cat1 excludes AMA (12 not 32)", caDo.cat1Earned, 12);
ok("CA DO cat1 not met by AMA", caDo.cat1Met === false); // 12 < 20 required

// AZ/DO: the 24-hr minimum is AOA 1-A only; AMA (which fills the rest of the
// 40 total, capped at 16) does not count toward the minimum.
const azDo = computeCompliance([cme("AMA PRA Category 1", 16, RECENT), cme("AOA Category 1-A", 10, RECENT)], "AZ", "DO");
eq("AZ DO cat1 keywords", azDo.cat1Keywords, ["AOA Category 1-A"]);
eq("AZ DO cat1 counts only AOA 1-A", azDo.cat1Earned, 10);
ok("AZ DO cat1 not met by AMA", azDo.cat1Met === false); // 10 < 24 required

// A state without cat1Accepted still uses the heuristic fallback.
const txMd = computeCompliance([cme("AMA PRA Category 1", 24, RECENT)], "TX", "MD");
ok("TX MD uses heuristic fallback", txMd.cat1FromData === false);
eq("TX MD cat1 earned", txMd.cat1Earned, 24);

// ── Finding 2: one-time / longer-period mandates not re-demanded each cycle ──

// CA pain management is one-time (lifetime): an entry from ~5.5y ago still
// satisfies it, even though it falls outside the 2-year cycle window.
const caLife = computeCompliance([cme("AMA PRA Category 1", 12, OLD, ["Pain Management"])], "CA", "MD");
eq("CA old entry is outside the cycle window", caLife.totalEarned, 0);
const painRow = caLife.topicResults.find(t => t.topic === "Pain Management");
ok("CA pain mgmt marked lifetime", painRow.period === "lifetime");
eq("CA pain mgmt earned over all dates", painRow.earned, 12);
ok("CA pain mgmt met by old one-time entry", painRow.met === true);

// CT six topics run on a 6-year period: an entry ~3.8y ago (outside the 2y
// cycle) counts; one ~7.1y ago does not.
const ct4 = computeCompliance([cme("AMA PRA Category 1", 1, YR4, ["Sexual Assault"])], "CT", "MD");
const sa4 = ct4.topicResults.find(t => t.topic === "Sexual Assault");
ok("CT sexual assault period is years:6", sa4.period && sa4.period.years === 6);
eq("CT entry ~3.8y is outside the 2y cycle", ct4.totalEarned, 0);
ok("CT sexual assault met within 6y", sa4.met === true);
const ct7 = computeCompliance([cme("AMA PRA Category 1", 1, YR7, ["Sexual Assault"])], "CT", "MD");
const sa7 = ct7.topicResults.find(t => t.topic === "Sexual Assault");
ok("CT sexual assault not met beyond 6y", sa7.met === false);

// Default (no period) topics stay per-cycle; the period field surfaces in the row.
const flMd = computeCompliance([], "FL", "MD");
ok("FL controlled substances is per-cycle (period null)", flMd.topicResults.find(t => t.topic === "Controlled Substances").period === null);
ok("FL HIV/AIDS is lifetime", flMd.topicResults.find(t => t.topic === "HIV/AIDS").period === "lifetime");
ok("FL domestic violence is years:6", (r => r && r.years === 6)(flMd.topicResults.find(t => t.topic === "Domestic Violence").period));

// ── Finding 5: MATE Act needs opioid or SUD training, not generic pain CME ──
const mateOpioid = computeCompliance([cme("AMA PRA Category 1", 8, RECENT, ["Opioid Prescribing"])], "TX", "MD", { hasDEA: true });
ok("MATE met by opioid training", mateOpioid.mate.met === true);
const matePain = computeCompliance([cme("AMA PRA Category 1", 8, RECENT, ["Pain Management"])], "TX", "MD", { hasDEA: true });
ok("MATE NOT met by generic pain CME", matePain.mate.met === false);
const mateCs = computeCompliance([cme("AMA PRA Category 1", 8, RECENT, ["Controlled Substances"])], "TX", "MD", { hasDEA: true });
ok("MATE NOT met by controlled substances alone", mateCs.mate.met === false);
const mateSud = computeCompliance([cme("AMA PRA Category 1", 8, RECENT, ["Substance Use Disorders"])], "TX", "MD", { hasDEA: true });
ok("MATE met by SUD training", mateSud.mate.met === true);

// ── Finding 6: the first day of the cycle is in-window (local, not UTC) ──
// Window = 2027-06-30 minus the 2-year TX cycle = 2025-06-30. An entry dated
// on that first day must count; a bare YYYY-MM-DD used to parse as UTC
// midnight and land the evening before in US zones, dropping it.
const boundary = computeCompliance([cme("AMA PRA Category 1", 10, "2025-06-30")], "TX", "MD", { licenseExpiration: "2027-06-30" });
eq("cycle-start boundary day counts", boundary.totalEarned, 10);

// ── Finding 4: intake can tag state-only topics (not in CME_TOPICS) ──
eq("guessTopics tags a state-only topic when passed in", guessTopics("Organ and Tissue Donation Update", "", ["Organ and Tissue Donation"]), ["Organ and Tissue Donation"]);
eq("guessTopics cannot tag a state-only topic without it", guessTopics("Organ and Tissue Donation Update"), []);

// ── Cycle-start override: the window moves, the hour target never does ──
// Baseline for every case below: CA/DO, 50 hrs per 2-yr cycle, 20 of them AOA
// Cat 1-A/1-B, license expiring 2027-09-30. Derived window = 2025-09-30.
const CA_EXP = "2027-09-30";
const caArgs = (opts) => computeCompliance([
  cme("AOA Category 1-A", 20, "2025-07-01"),   // before the derived start
  cme("AMA PRA Category 1", 30, "2026-03-15"), // inside either window
], "CA", "DO", { licenseExpiration: CA_EXP, ...opts });

// 1. Unset behaves EXACTLY as before: window is expiration minus the cycle.
const noStart = caArgs({});
eq("no cycleStart: window start is expiration minus cycle", noStart.windowStart.toISOString().slice(0, 10), "2025-09-30");
eq("no cycleStart: pre-window entry excluded", noStart.totalEarned, 30);
eq("no cycleStart: source is the derived cycle", noStart.windowSource, "cycle");
ok("no cycleStart: window is neither short nor long", noStart.windowShort === false && noStart.windowLong === false);
ok("no cycleStart: no state proration surfaced", noStart.firstCycleRule === null);
// An unparseable value must fall back to the derived window, not empty it.
eq("garbage cycleStart falls back to the derived window", caArgs({ cycleStart: "not-a-date" }).windowStart.toISOString().slice(0, 10), "2025-09-30");

// 2. Set EARLIER widens the window. This is the owner's case and 16 CCR
//    1635(d)'s: a CA DO's first requirement period runs from initial licensure
//    to the first expiration and may exceed 24 months. The 20 hours he logged
//    on 2025-07-01 stop being discarded, and he still owes the full 50.
const wide = caArgs({ cycleStart: "2025-07-01" });
eq("earlier cycleStart widens the window", wide.windowStart.toISOString().slice(0, 10), "2025-07-01");
eq("earlier cycleStart counts the previously-dropped hours", wide.totalEarned, 50);
eq("earlier cycleStart counts them toward the AOA minimum too", wide.cat1Earned, 20);
ok("earlier cycleStart marks the window long", wide.windowLong === true && wide.windowShort === false);
eq("widening does NOT lower the hour target", wide.totalRequired, 50);
eq("widening does NOT lower the Cat 1 minimum", wide.cat1Required, 20);
eq("window label is plain text", wide.windowLabel, "Counting CME dated Jul 1, 2025 through Sep 30, 2027");

// 3. Set LATER narrows the window and drops entries before it.
const narrow = caArgs({ cycleStart: "2026-01-01" });
eq("later cycleStart narrows the window", narrow.windowStart.toISOString().slice(0, 10), "2026-01-01");
eq("entry dated before the cycle start is excluded", narrow.totalEarned, 30);
ok("later cycleStart marks the window short", narrow.windowShort === true && narrow.windowLong === false);
eq("narrowing does NOT lower the hour target", narrow.totalRequired, 50);
ok("CA has no firstCycle data, so no prorated number is invented", narrow.firstCycleRule === null);
ok("short CA window says the full requirement stands",
  windowNotes(narrow).some(n => n.includes("publishes no first-cycle proration")));

// 4. Boundary days are in-cycle at BOTH ends of an overridden window.
const bounds = computeCompliance([
  cme("AMA PRA Category 1", 4, "2026-01-01"),  // first day of the window
  cme("AMA PRA Category 1", 3, "2027-09-30"),  // last day (expiration)
  cme("AMA PRA Category 1", 9, "2025-12-31"),  // day before the start
], "CA", "DO", { licenseExpiration: CA_EXP, cycleStart: "2026-01-01" });
eq("both boundary days count, the day before does not", bounds.totalEarned, 7);

// 5. A cycle start on or after the window end is refused, not applied: it
//    would empty the window and silently discard every logged hour.
const bad = caArgs({ cycleStart: "2028-01-01" });
eq("cycleStart after the window end falls back to the derived window", bad.windowStart.toISOString().slice(0, 10), "2025-09-30");
ok("refused cycleStart is reported", bad.cycleStartIgnored === true && bad.windowSource === "cycle");
eq("refused cycleStart does not discard hours", bad.totalEarned, 30);

// ── First-cycle proration: state data only, keyed to the license issue date ──
// CO models it (C.R.S. 12-240-130.5 / DORA, 22/15/10/5/0). It is shown BESIDE
// the 30, never substituted for it, and a hand-entered cycle start can't reach it.
const coFirst = computeCompliance([], "CO", "MD", { licenseExpiration: "2027-09-30", licenseIssued: "2026-07-15" });
eq("CO first-cycle tier for 14 months licensed", coFirst.firstCycleRule.hours, 15);
eq("CO first-cycle months read from the license", coFirst.firstCycleRule.months, 14);
eq("CO proration does NOT move the requirement", coFirst.totalRequired, 30);
const coTiers = [["2027-08-15", 0], ["2027-04-15", 5], ["2027-01-15", 10], ["2026-06-15", 15], ["2026-02-15", 22]];
for (const [issued, hrs] of coTiers) {
  eq(`CO tier for issue date ${issued}`, computeCompliance([], "CO", "MD", { licenseExpiration: "2027-09-30", licenseIssued: issued }).firstCycleRule.hours, hrs);
}
ok("CO 24-month license gets no proration", computeCompliance([], "CO", "MD", { licenseExpiration: "2027-09-30", licenseIssued: "2025-09-30" }).firstCycleRule === null);
ok("a self-declared cycleStart cannot trigger CO proration",
  computeCompliance([], "CO", "MD", { licenseExpiration: "2027-09-30", cycleStart: "2027-06-01" }).firstCycleRule === null);

// ── AOA / AMA credit equivalence (src/constants/creditEquivalence.js) ──
// These pin the facts a physician can fail an audit on. Sources are cited on
// every row of the table itself.

// Modality decides the AOA letter, not the accreditor.
eq("ACCME AMA PRA Cat 1, live, is AOA 2-A", aoaCategoryFor("AMA PRA Category 1"), "2-A");
eq("ACCME AMA PRA Cat 1, real-time interactive, is AOA 2-A", aoaCategoryFor("AMA PRA Category 1", "liveOnline"), "2-A");
eq("ACCME AMA PRA Cat 1, on demand, is AOA 2-B", aoaCategoryFor("AMA PRA Category 1", "onDemand"), "2-B");
ok("AMA PRA Cat 1 is never AOA Category 1", !["1-A", "1-B"].includes(aoaCategoryFor("AMA PRA Category 1")));
ok("the on-demand 2-A/2-B split is flagged as ambiguous, not asserted",
  equivalenceFor("AMA PRA Category 1", "onDemand").aoaCategoryAmbiguous === true);

// AMA PRA Category 2 has no published AOA equivalence. Do not invent one.
eq("AMA PRA Cat 2 has no AOA category", aoaCategoryFor("AMA PRA Category 2"), null);
ok("AMA PRA Cat 2 is marked unverified", equivalenceFor("AMA PRA Category 2").unverified === true);

// Grand rounds: the sponsor decides. Default (non-osteopathic) is 1-B.
eq("non-osteopathic grand rounds default to AOA 1-B", aoaCategoryFor("Grand Rounds"), "1-B");

// The note a DO sees at the moment of logging.
const amaNote = logNoteFor("AMA PRA Category 1", "DO");
eq("DO logging AMA PRA Cat 1 sees the 2-A headline", amaNote.headline, "Counts as AOA Category 2-A.");
eq("and is told plainly it misses the Cat 1 minimum", amaNote.detail, "Does not satisfy an AOA Category 1-A or 1-B minimum.");
ok("the note names the conversion route", amaNote.lines.some(l => l.includes(CAT1B_CONVERSION.formName)));
ok("the note says CA pools 2-A and 2-B", amaNote.lines.some(l => l.includes("30-hour Category 2")));
ok("MDs get no AOA note", logNoteFor("AMA PRA Category 1", "MD") === null);
ok("no note for categories with no published equivalence", logNoteFor("Self-Assessment", "DO") === null);

// Training credit: no AOA form, and the form people cite is for something else.
ok("fellowship credit needs no AOA form", TRAINING_CREDIT.formRequired === false);
ok("the 1-B note tells a DO where fellowship credit lands", logNoteFor("AOA Category 1-B", "DO").lines.some(l => l.includes("20 AOA Category 1-B credits")));
ok("and that California waives rather than credits training", logNoteFor("AOA Category 1-B", "DO").lines.some(l => l.includes("waives")));

// Cat 1 bucket labels come from the state's accepted list, never the degree.
// The old hardcoded DO label said "Cat 1-A / AMA Cat 1", which for CA is wrong.
eq("CA/DO label names 1-A or 1-B", cat1BucketLabel(["AOA Category 1-A", "AOA Category 1-B"], "DO"), "AOA Category 1-A or 1-B minimum");
eq("AZ/DO label names 1-A only", cat1BucketLabel(["AOA Category 1-A"], "DO"), "AOA Category 1-A minimum");
eq("MD label names AMA PRA Cat 1", cat1BucketLabel(["AMA PRA Category 1"], "MD"), "AMA PRA Category 1 minimum");
ok("label never claims AMA counts when the state excludes it",
  !cat1BucketLabel(["AOA Category 1-A", "AOA Category 1-B"], "DO").includes("AMA"));

// The label must agree with what the engine actually counted.
const caDoLive = computeCompliance(
  [cme("AMA PRA Category 1", 20, RECENT), cme("AOA Category 1-A", 10.25, RECENT)],
  "CA", "DO", { licenseExpiration: "2027-09-30" }
);
eq("CA/DO earns only the AOA hours", caDoLive.cat1Earned, 10.25);
eq("label built from the engine's own keyword list", cat1BucketLabel(caDoLive.cat1Keywords, "DO"), "AOA Category 1-A or 1-B minimum");

// The breakdown makes the gap legible: the 20 AMA hours are shown, not hidden.
const bd = cat1Breakdown(
  [cme("AMA PRA Category 1", 20, RECENT), cme("AOA Category 1-A", 10.25, RECENT), cme("AMA PRA Category 2", 3, RECENT)],
  { start: caDoLive.windowStart, end: caDoLive.windowEnd, accepted: caDoLive.cat1Keywords, degreeType: "DO" }
);
eq("counted hours match the engine", bd.counted, [{ category: "AOA Category 1-A", hours: 10.25, reason: null }]);
eq("excluded AMA hours are itemised with the reason", bd.notCounted[0], { category: "AMA PRA Category 1", hours: 20, reason: "AOA Category 2-A" });
eq("excluded AMA Cat 2 says so honestly", bd.notCounted[1].reason, "no published AOA category");
ok("breakdown respects the cycle window",
  cat1Breakdown([cme("AOA Category 1-A", 9, "2020-01-01")], { start: caDoLive.windowStart, end: caDoLive.windowEnd, accepted: caDoLive.cat1Keywords, degreeType: "DO" }).counted.length === 0);

// The route out of a Cat 1 gap depends on what the requirement accepts.
ok("CA/DO gap points at the 2-A to 1-B conversion", cat1RouteNote(["AOA Category 1-A", "AOA Category 1-B"], "DO").body.includes("no equivalent osteopathic"));
ok("1-A-only states are told conversion will not help", cat1RouteNote(["AOA Category 1-A"], "DO").title.includes("1-A only"));
ok("states that accept AMA need no route note", cat1RouteNote(["AMA PRA Category 1", "AOA Category 1-A"], "DO") === null);
ok("MDs get no route note", cat1RouteNote(["AMA PRA Category 1"], "MD") === null);

// Small-specialty exception: surfaced, never applied, and never claimed to
// reach state licensure.
const sse = smallSpecialtyNote("DO");
eq("exception cap is 15 credits", SMALL_SPECIALTY_EXCEPTION.creditCap, 15);
eq("exception lists all three eligibility criteria", SMALL_SPECIALTY_EXCEPTION.criteria.length, 3);
ok("exception note says it does not reach state licensure", sse.caveats.some(c => c.includes("does not reach state licensure")));
ok("exception note routes to AOBS, not a nonexistent AOBNS", sse.body.includes("American Osteopathic Board of Surgery"));
ok("no repo text invents an AOBNS", !JSON.stringify(SMALL_SPECIALTY_EXCEPTION).includes("AOBNS"));
ok("MDs get no exception note", smallSpecialtyNote("MD") === null);

// Provider directory: the DO-facing line is derived, not per-provider prose.
ok("ACCME-only provider is called AOA Category 2",
  providerAoaLine({ accreditation: ["AMA PRA Category 1", "ABIM MOC"] }).includes("AOA Category 2"));
ok("AOA-accredited provider is called Category 1",
  providerAoaLine({ accreditation: ["AOA Category 1-A", "AMA PRA Category 1"] }).includes("AOA Category 1"));


// ══════════════════════════════════════════════════════════════════════════
// Per-rule verifiability: every mandated topic says how often it is owed and
// links to the rule that says so.
// ══════════════════════════════════════════════════════════════════════════

// ── Periodicity, in words ──
eq("one-time reads as one-time", topicPeriodLabel("lifetime", 2), "One time, not every cycle");
eq("multi-year reads as N years", topicPeriodLabel({ years: 6 }, 2), "Every 6 years");
eq("annual reads as annual", topicPeriodLabel({ years: 1 }, 3), "Every year");
eq("default is the renewal cycle", topicPeriodLabel(null, 2), "Every renewal cycle (2 yrs)");
eq("a 1-year cycle is not pluralised", topicPeriodLabel(null, 1), "Every renewal cycle (1 yr)");
eq("no cycle known", topicPeriodLabel(null, 0), "Every renewal cycle");

// The confusion that prompted this: a one-time 12-hour mandate and a recurring
// one looked identical on the row. They no longer do.
const caProv = computeCompliance([], "CA", "MD");
const caPain = caProv.topicResults.find(t => t.topic === "Pain Management");
eq("CA pain mgmt row says one time", caPain.periodLabel, "One time, not every cycle");
const caBias = caProv.topicResults.find(t => t.topic === "Implicit Bias");
eq("CA implicit bias row says every cycle", caBias.periodLabel, "Every renewal cycle (2 yrs)");

// ── Per-topic citation and link ──
// CA's rule-set citation is 16 CCR 1336 (the 50-hour total). The pain
// management line is B&P 2190.5 and now links there, not at the 50-hour rule.
ok("CA pain mgmt cites 2190.5, not 1336", caPain.cite.includes("2190.5") && !caPain.cite.includes("1336"));
ok("CA pain mgmt links to leginfo", caPain.url.includes("leginfo.legislature.ca.gov"));
ok("CA pain mgmt link is its own, not inherited", caPain.sourceInherited === false && caPain.citeInherited === false);

// A topic with no source of its own inherits the rule set's, and says so, so
// the UI can label the link "Board page" instead of implying it points at the
// sentence that states the requirement.
const caGeri = caProv.topicResults.find(t => t.topic === "Geriatric Medicine");
eq("CA geriatrics inherits the board URL", caGeri.url, STATE_REQS.CA.md.sourceUrl);
ok("CA geriatrics is marked inherited", caGeri.sourceInherited === true);
ok("CA geriatrics still carries its own citation", caGeri.citeInherited === false && caGeri.cite.length > 0);

// Coverage invariant: no mandated topic anywhere is unverifiable. Every row a
// physician can be shown must carry a citation and a usable http(s) link.
{
  const bad = [];
  for (const st of Object.keys(STATE_REQS)) {
    for (const deg of ["MD", "DO"]) {
      for (const t of computeCompliance([], st, deg).topicResults) {
        if (!t.cite) bad.push(`${st}/${deg}/${t.topic}: no citation`);
        if (!safeHttpUrl(t.url)) bad.push(`${st}/${deg}/${t.topic}: no safe URL`);
        if (!t.periodLabel) bad.push(`${st}/${deg}/${t.topic}: no periodicity`);
      }
    }
  }
  ok("every mandated topic carries citation, link and periodicity", bad.length === 0, bad.slice(0, 5).join("; "));
}

// safeHttpUrl fails closed: rule data is hand-edited, so a non-http value must
// never become an anchor.
eq("javascript: URL is refused", safeHttpUrl("javascript:alert(1)"), "");
eq("data: URL is refused", safeHttpUrl("data:text/html,x"), "");
eq("relative path is refused", safeHttpUrl("/boards/cme"), "");
eq("https is kept and trimmed", safeHttpUrl("  https://example.gov/cme  "), "https://example.gov/cme");

// ══════════════════════════════════════════════════════════════════════════
// Corrected rules. Each of these was demanding hours the board does not ask
// for, or failing to ask for hours it does.
// ══════════════════════════════════════════════════════════════════════════

const topicOf = (st, deg, name) => computeCompliance([], st, deg).topicResults.find(t => t.topic === name);

// MI: R 338.7004 wants 1 hr of implicit bias FOR EACH YEAR of the cycle.
// Michigan renews every 3 years, so a renewal owes 3, not 1. This was the
// under-demand: a physician logging 1 hr showed compliant while LARA wanted 3.
eq("MI MD implicit bias is 3 hrs per 3-yr cycle", topicOf("MI", "MD", "Implicit Bias").required, 3);
eq("MI DO implicit bias is 3 hrs per 3-yr cycle", topicOf("MI", "DO", "Implicit Bias").required, 3);
ok("MI implicit bias cites the rule", topicOf("MI", "MD", "Implicit Bias").cite.includes("338.7004"));
ok("MI human trafficking is one-time", topicOf("MI", "MD", "Human Trafficking").period === "lifetime");
ok("MI opioid awareness is one-time", topicOf("MI", "DO", "Opioid Awareness").period === "lifetime");

// LA: the largest over-demand in the file. A one-time 3-hr CDS course on a
// 1-year cycle was being asked for every single year.
const laCds = computeCompliance([cme("AMA PRA Category 1", 3, OLD, ["Controlled Substances"])], "LA", "MD")
  .topicResults.find(t => t.topic === "Controlled Substances");
ok("LA CDS course is one-time", laCds.period === "lifetime");
ok("LA CDS met by a course taken years ago", laCds.met === true);
eq("LA nutrition runs on a 4-year clock", topicOf("LA", "MD", "Nutrition / Metabolic Health").period, { years: 4 });
eq("LA sickle cell runs on a 3-year clock", topicOf("LA", "MD", "Sickle Cell (Emergency Medicine)").period, { years: 3 });

// IA: four topics with multi-year clocks were all being counted in the 2-year
// cycle. An opioid course ~3.8y old satisfies the 5-year rule.
eq("IA child abuse every 3 yrs", topicOf("IA", "MD", "Child Abuse Recognition").period, { years: 3 });
eq("IA dependent adult abuse every 3 yrs", topicOf("IA", "MD", "Dependent Adult Abuse").period, { years: 3 });
eq("IA opioid prescribing every 5 yrs", topicOf("IA", "MD", "Opioid Prescribing").period, { years: 5 });
eq("IA end-of-life every 5 yrs", topicOf("IA", "MD", "End-of-Life Care").period, { years: 5 });
ok("IA opioid met by a course inside the 5-year window",
  computeCompliance([cme("AMA PRA Category 1", 2, YR4, ["Opioid Prescribing"])], "IA", "MD")
    .topicResults.find(t => t.topic === "Opioid Prescribing").met === true);

// TX: three rules the notes described correctly but the engine ignored.
eq("TX human trafficking every 6 yrs", topicOf("TX", "MD", "Human Trafficking").period, { years: 6 });
eq("TX opioid prescribing every 8 yrs", topicOf("TX", "MD", "Opioid Prescribing").period, { years: 8 });
ok("TX Life of the Mother Act is one-time", topicOf("TX", "MD", "Life of the Mother Act").period === "lifetime");
// The pain-clinic rule is stated annually by TMB 195.3(d); the encoding now
// matches the note instead of contradicting it.
eq("TX pain clinic hours run on a 1-year clock", topicOf("TX", "MD", "Pain Management").period, { years: 1 });
eq("TX pain clinic row says annual", topicOf("TX", "MD", "Pain Management").periodLabel, "Every year");

// PA: 49 Pa. Code 16.19 says the organ donation CE is a one-time requirement.
ok("PA MD organ donation is one-time", topicOf("PA", "MD", "Organ and Tissue Donation").period === "lifetime");
ok("PA DO organ donation is one-time", topicOf("PA", "DO", "Organ and Tissue Donation").period === "lifetime");

// IL: two 6-year topics were demanded every 3-year cycle, and the mandated
// reporter training had no row at all, so it was never checked.
eq("IL cultural competency every 6 yrs", topicOf("IL", "MD", "Cultural Competency").period, { years: 6 });
eq("IL dementia CE every 6 yrs", topicOf("IL", "MD", "Alzheimer's Disease and Other Dementias").period, { years: 6 });
ok("IL mandated reporter training is now a checked row", !!topicOf("IL", "MD", "Mandated Reporter Training"));
eq("IL mandated reporter every 6 yrs", topicOf("IL", "MD", "Mandated Reporter Training").period, { years: 6 });

// NY: PHL 3309-a runs on 3 years; child abuse coursework is pre-licensure.
eq("NY pain management every 3 yrs", topicOf("NY", "MD", "Pain Management").period, { years: 3 });
ok("NY child abuse is one-time pre-licensure", topicOf("NY", "MD", "Child Abuse Recognition").period === "lifetime");
eq("NY infection control every 4 yrs", topicOf("NY", "MD", "Infection Control").period, { years: 4 });

// MD: implicit bias and structural racism are two separate one-time trainings.
// Bundled, a physician who had done one showed compliant for both.
ok("MD implicit bias is one-time", topicOf("MD", "MD", "Implicit Bias").period === "lifetime");
ok("MD structural racism has its own row", !!topicOf("MD", "MD", "Structural Racism"));
ok("MD structural racism is one-time", topicOf("MD", "MD", "Structural Racism").period === "lifetime");
ok("MD controlled substance CE is one-time", topicOf("MD", "MD", "Controlled Substances").period === "lifetime");
{
  // Implicit bias done, structural racism not: the two must not cancel out.
  const c = computeCompliance([cme("AMA PRA Category 1", 1, RECENT, ["Implicit Bias"])], "MD", "MD");
  ok("MD implicit bias alone does not satisfy structural racism",
    c.topicResults.find(t => t.topic === "Implicit Bias").met === true &&
    c.topicResults.find(t => t.topic === "Structural Racism").met === false);
}

// MS: an 8-hour one-time federal training was demanded every 2-year cycle.
ok("MS DEA training is one-time", topicOf("MS", "MD", "Controlled Substances").period === "lifetime");

// MA: five one-time trainings the file already described as one-time.
for (const t of ["End-of-Life Care", "Implicit Bias", "Child Abuse Recognition", "Domestic Violence", "Geriatric Medicine"]) {
  ok(`MA ${t} is one-time`, topicOf("MA", "MD", t).period === "lifetime");
}
// EHR is left per-cycle on purpose: published summaries disagree and BORIM
// Policy 17-05 could not be read. Counting it each cycle over-asks rather than
// showing a physician compliant when the board may not agree.
ok("MA EHR left on the cycle while its periodicity is unresolved", topicOf("MA", "MD", "Electronic Health Records").period === null);
ok("MA EHR row says the periodicity is unresolved", topicOf("MA", "MD", "Electronic Health Records").cite.includes("unresolved"));

// KY, RI, AL, WY, DE, NV: the rest of the periodicity fixes.
ok("KY domestic violence is one-time", topicOf("KY", "MD", "Domestic Violence").period === "lifetime");
ok("KY abusive head trauma is one-time", topicOf("KY", "MD", "Pediatric Abusive Head Trauma").period === "lifetime");
ok("RI dementia CE is one-time", topicOf("RI", "MD", "Geriatric Medicine").period === "lifetime");
eq("AL controlled substances every 2 yrs on a 1-yr cycle", topicOf("AL", "MD", "Controlled Substances").period, { years: 2 });
eq("AL boundaries course is 2 hrs, not a bare checkbox", topicOf("AL", "MD", "Ethics").required, 2);
ok("AL boundaries course is one-time", topicOf("AL", "MD", "Ethics").period === "lifetime");
eq("WY controlled substances on its own 2-yr clock", topicOf("WY", "MD", "Controlled Substances").period, { years: 2 });
ok("DE one-time state law course has its own row", !!topicOf("DE", "MD", "Delaware Controlled Substance Law"));
ok("DE state law course is one-time", topicOf("DE", "MD", "Delaware Controlled Substance Law").period === "lifetime");
eq("NV MD suicide prevention every 4 yrs", topicOf("NV", "MD", "Suicide Prevention").period, { years: 4 });
ok("NV MD HIV stigma is one-time", topicOf("NV", "MD", "HIV Stigma").period === "lifetime");
ok("NV MD SBIRT has its own row", !!topicOf("NV", "MD", "Substance Use Disorders"));
eq("NV DO suicide prevention every 4 yrs on a 1-yr cycle", topicOf("NV", "DO", "Suicide Prevention").period, { years: 4 });
eq("NV DO ethics/pain is every other year", topicOf("NV", "DO", "Pain Management").period, { years: 2 });
eq("NV DO cultural competency is biennial", topicOf("NV", "DO", "Cultural Competency").period, { years: 2 });
eq("OK MD opioid hour is checked on a 1-year clock", topicOf("OK", "MD", "Opioid Prescribing").period, { years: 1 });

// ── Things a later pass must NOT "fix" ──

// CA pain management was not repealed and is genuinely one-time. Both halves
// matter: dropping it would under-state a live mandate, and making it
// recurring would demand 12 hours a physician does not owe.
ok("CA MD pain management still on the books", topicOf("CA", "MD", "Pain Management").required === 12);
ok("CA DO pain management still on the books", topicOf("CA", "DO", "Pain Management").required === 12);
ok("CA pain management stays one-time", topicOf("CA", "DO", "Pain Management").period === "lifetime");
// The MD note was missing two facts the DO note already had.
ok("CA MD note carries the pathology/radiology exemption", /pathology and radiology/i.test(topicOf("CA", "MD", "Pain Management").note));
ok("CA MD note carries the 4-year prong", /4 yrs of initial licensure/i.test(topicOf("CA", "MD", "Pain Management").note));
ok("CA note carries the 2190.6 buprenorphine alternative", /2190\.6/.test(topicOf("CA", "MD", "Pain Management").note));

// AB 241 binds course providers, not physicians. It must never become an hour
// requirement, on either board.
eq("CA MD implicit bias demands no hours", topicOf("CA", "MD", "Implicit Bias").required, 0);
eq("CA DO implicit bias demands no hours", topicOf("CA", "DO", "Implicit Bias").required, 0);
// CA DO's 1-hr Schedule II hour is the one CA topic that IS every cycle.
ok("CA DO Schedule II hour stays per cycle", topicOf("CA", "DO", "Substance Use Disorders").period === null);
eq("CA DO Schedule II row says every cycle", topicOf("CA", "DO", "Substance Use Disorders").periodLabel, "Every renewal cycle (2 yrs)");

// The OMBC PDF that a DO clicks through to must be the one that resolves; the
// bare /licensees/cme path returned HTTP 300.
ok("CA DO board link points at the CME document", STATE_REQS.CA.do.sourceUrl.endsWith(".pdf"));


console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
