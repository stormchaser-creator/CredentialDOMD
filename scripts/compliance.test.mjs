// Unit-style checks for src/utils/compliance.js (the CME compliance engine)
// and the state-topic tagging in src/utils/cmeImport.js. These pin the audit
// fixes: data-driven Category 1 counting, one-time / longer-period topic
// mandates, MATE Act topic scope, the cycle-window boundary, and intake
// tagging of state-only topics.
// Run: node scripts/compliance.test.mjs   (pure node, no test runner)
import { computeCompliance } from "../src/utils/compliance.js";
import { guessTopics } from "../src/utils/cmeImport.js";

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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
