// National certification cards for a PA (NCCPA) and an NP (AANPCB, ANCC,
// PNCB, NCC, AACN), DESIGN 3.6. Each card is anchored on the member's own
// certification record, the way a state card is anchored on the licence:
// these cycles are per certificant, unlike the fixed AOA block.
//
// Only a record answered PA-C or NP certification gets a card; a record with
// no answer yet asks the question instead (professions.js
// certificationRoleOf). Every number comes from CERTIFICATION_RULES, which
// the generator fills only from verified facts; a rule that is not verified
// is shown as such with the certifier's link, never guessed.
import { CERTIFICATION_RULES } from "../constants/certificationRules.js";
import { PA_CERT_BODIES, NP_CERT_BODIES, certBodyOf, certificationRoleOf, professionOf } from "../constants/professions.js";
import { NCCPA_ACTIVITY_FIELD } from "../constants/credentialTypes.js";
import { QUESTION_FIELDS, forRenewalField } from "../constants/recordQuestions.js";
import { MS_PER_DAY, cmeTopics, inWindow, parseLocalDate, round2, showDate } from "./cmeCore.js";
import { pharmacologyHoursOf, UNACCREDITED_CATEGORIES } from "./appCompliance.js";
import { isInactive } from "./lifecycle.js";

const hours = (c) => parseFloat(c?.hours) || 0;
const sum = (list, f = hours) => round2(list.reduce((s, c) => s + f(c), 0));
const yes = (v) => v === true || v === "Yes";
const no = (v) => v === false || v === "No";

function perRenewal(record, field) {
  const a = record?.customFields || {};
  const v = a[field];
  if (v == null || v === "") return null;
  return a[forRenewalField(field)] === (record.expirationDate || "") ? v : null;
}

/** The window [start, end] for a certification, or null when it cannot be known. */
function windowFor(body, rule, record) {
  const exp = parseLocalDate(record.expirationDate);
  if (!exp) return null;
  const custom = parseLocalDate(record.cmeCycleStart);
  if (body === "NCCPA") {
    const ws = rule.windowStart;
    if (!ws) return null;
    const end = new Date(exp.getFullYear(), 11, 31);
    // NCCPA: the window opens May 1 of the year the CURRENT certification was
    // issued. A PA-C certified since 2014 often enters the original
    // certification date in the generic Issued field, which would stretch the
    // window across a whole career of CME, so the start never goes earlier
    // than May 1 two years before the expiration year (a two-year cycle).
    const issued = parseLocalDate(record.issuedDate);
    const earliest = exp.getFullYear() - ws.yearsBeforeExpiration;
    const year = issued ? Math.min(Math.max(issued.getFullYear(), earliest), exp.getFullYear()) : earliest;
    const standard = new Date(year, ws.month - 1, ws.day);
    const start = custom && custom < end ? custom : standard;
    return { start, end, standard, custom: !!(custom && custom < end), issued };
  }
  if (!rule.cycleYears) return null;
  const standard = new Date(exp);
  standard.setFullYear(standard.getFullYear() - rule.cycleYears);
  const start = custom && custom < exp ? custom : standard;
  return { start, end: exp, standard, custom: !!(custom && custom < exp) };
}

/**
 * The card's own counting test for one CME entry, kept on the card (not
 * enumerable, so the card stays plain data) for the certification transcript:
 * a row the card does not count is marked there, never listed as counted.
 */
const withCounts = (card, fn) => Object.defineProperty(card, "counts", { value: fn, enumerable: false, configurable: true });

function base(body, rule, record, now) {
  const exp = parseLocalDate(record.expirationDate);
  return {
    id: `CERT:${body}:${record.id || ""}`, source: body, code: body, body, recordId: record.id || null,
    name: record.name || body, label: `${rule?.name || body} certification${record.name ? ` (${record.name})` : ""}`,
    url: rule?.url || null, unit: rule?.unit || "hours", expirationDate: record.expirationDate || "",
    daysLeft: exp ? Math.ceil((exp - now) / MS_PER_DAY) : null,
    required: null, earned: null, met: false, status: "needs-confirmation",
    cat1aRequired: 0, assessment: "", notes: "", lines: [], unverified: [...(rule?.unverified || []).map((u) => u.item)],
    windowLabel: "", rulesVerified: !!rule && rule.status !== "unverified",
  };
}

function nccpaCard(rule, record, cme, now) {
  const card = base("NCCPA", rule, record, now);
  const w = windowFor("NCCPA", rule, record);
  if (!w || !rule.total || !rule.cat1Min) {
    card.assessment = w ? "NCCPA rules not yet verified" : "Add the certification's expiration date";
    return card;
  }
  const entries = (cme || []).filter((c) => inWindow(c, w.start, w.end));
  const cat1Types = rule.cat1Accepted || [];
  const panreLa = "NCCPA PANRE-LA (Category 1 Self-Assessment)";
  let piUsed = 0;
  let raw = 0, weighted = 0, cat1Raw = 0, cat1Weighted = 0;
  // Oldest first, so "the first 20 PI-CME credits" is the first 20 logged.
  for (const c of [...entries].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const h = hours(c);
    raw += h;
    const cat1 = cat1Types.includes(c.category);
    const activity = c.customFields?.[NCCPA_ACTIVITY_FIELD];
    let credit = h;
    if (cat1 && (c.category === panreLa || activity === "Self-Assessment")) credit = h * (rule.saMultiplier || 1);
    else if (cat1 && activity === "PI-CME" && rule.piBonusCap) {
      const bonus = Math.min(h, Math.max(0, rule.piBonusCap - piUsed));
      piUsed += bonus;
      credit = h + bonus;
    }
    weighted += credit;
    if (cat1) { cat1Raw += h; cat1Weighted += credit; }
  }
  Object.assign(card, {
    required: rule.total, earned: round2(weighted), rawEarned: round2(raw),
    cat1Required: rule.cat1Min, cat1Earned: round2(cat1Weighted), cat1RawEarned: round2(cat1Raw),
    windowStart: w.start, windowEnd: w.end,
    windowLabel: `CME dated ${showDate(w.start)} through ${showDate(w.end)}`,
    deadline: rule.deadline ? `Log CME by ${rule.deadline}` : "",
    daysLeft: Math.ceil((new Date(w.end.getFullYear(), 11, 31, 23, 59) - now) / MS_PER_DAY),
  });
  withCounts(card, () => true);
  card.met = card.earned >= rule.total && card.cat1Earned >= rule.cat1Min;
  card.status = card.met ? "met" : "needs-hours";
  card.assessment = card.met ? "NCCPA credits met for this cycle" : `NCCPA credits: ${card.earned}/${rule.total}, Category 1: ${card.cat1Earned}/${rule.cat1Min}`;
  const examYear = parseInt(record.customFields?.[QUESTION_FIELDS.panreYear], 10);
  card.exam = Number.isFinite(examYear) ? `Pass PANRE or PANRE-LA by Dec 31, ${examYear}` : "Add the year your exam is due";
  if (w.issued && w.issued > w.standard && w.issued < w.end && !w.custom && rule.newCertificantNote) card.lines.push(rule.newCertificantNote);
  if (rule.category2Note) card.lines.push(rule.category2Note);
  return card;
}

function aanpcbCard(rule, record, cme, now) {
  const card = base("AANPCB", rule, record, now);
  const w = windowFor("AANPCB", rule, record);
  if (!w || !rule.total) { card.assessment = w ? "AANPCB rules not yet verified" : "Add the certification's expiration date"; return card; }
  const route = record.customFields?.[QUESTION_FIELDS.aanpcbRoute] || "CE and practice hours";
  const examOk = (rule.examRenewal || []).some((l) => String(record.name || "").toUpperCase().includes(l));
  card.windowStart = w.start; card.windowEnd = w.end;
  card.windowLabel = `CE dated ${showDate(w.start)} through ${showDate(w.end)}`;
  if (route === "Exam" && examOk) {
    card.route = "Exam";
    card.assessment = `Renewing by exam: pass the certification exam before ${showDate(w.end)}`;
    card.status = "needs-confirmation";
    return card;
  }
  const entries = (cme || []).filter((c) => inWindow(c, w.start, w.end));
  const acceptedVerified = Array.isArray(rule.accepted);
  const counts = (c) => (acceptedVerified ? rule.accepted.includes(c.category) : !UNACCREDITED_CATEGORIES.includes(c.category) && !(rule.mayCount || []).includes(c.category));
  const counted = entries.filter(counts);
  withCounts(card, counts);
  const pharm = sum(counted, pharmacologyHoursOf);
  const nonPharm = round2(sum(counted) - pharm);
  const preceptingAnswer = parseFloat(record.customFields?.[QUESTION_FIELDS.precepting]);
  const precepting = Number.isFinite(preceptingAnswer) ? Math.min(Math.max(preceptingAnswer, 0), rule.preceptingCap || 0) : 0;
  const practice = perRenewal(record, QUESTION_FIELDS.aanpcbPracticeHours);
  Object.assign(card, {
    route: "CE and practice hours", required: rule.total, earned: round2(pharm + nonPharm + precepting),
    pharmacology: { required: rule.pharmacology, earned: pharm },
    precepting, practiceHours: { required: rule.practiceHours, answer: practice },
    mayCountEarned: sum(entries.filter((c) => (rule.mayCount || []).includes(c.category))),
  });
  const hoursMet = card.earned >= rule.total && pharm >= (rule.pharmacology || 0);
  card.met = hoursMet && yes(practice) && acceptedVerified;
  card.status = !acceptedVerified || practice == null ? (hoursMet ? "needs-confirmation" : "needs-hours") : card.met ? "met" : "needs-hours";
  card.assessment = `Contact hours ${card.earned}/${rule.total}, pharmacology ${pharm}/${rule.pharmacology}`
    + (no(practice) ? `; needs ${Number(rule.practiceHours).toLocaleString("en-US")} practice hours` : practice == null ? `; answer the ${Number(rule.practiceHours).toLocaleString("en-US")} practice hours question` : "");
  if (card.mayCountEarned > 0) card.lines.push(`${card.mayCountEarned} hours of AMA PRA or AAPA Category 1 may count; not yet verified for AANPCB.`);
  if (!examOk && route === "Exam") card.lines.push("Exam renewal is offered for FNP, A-GNP, PMHNP and ENP certifications only.");
  return card;
}

function anccCard(rule, record, cme, now) {
  const card = base("ANCC", rule, record, now);
  const w = windowFor("ANCC", rule, record);
  if (!w || !rule.total) { card.assessment = w ? "ANCC rules not yet verified" : "Add the certification's expiration date"; return card; }
  const entries = (cme || []).filter((c) => inWindow(c, w.start, w.end));
  const formal = rule.formallyApproved || [];
  const totalOnly = rule.totalOnly || [];
  const countsAncc = (c) => formal.includes(c.category) || totalOnly.includes(c.category);
  const counted = entries.filter(countsAncc);
  withCounts(card, countsAncc);
  const formalHours = sum(entries.filter((c) => formal.includes(c.category)));
  const pharm = sum(counted, pharmacologyHoursOf);
  const development = perRenewal(record, QUESTION_FIELDS.anccDevelopment);
  Object.assign(card, {
    windowStart: w.start, windowEnd: w.end, windowLabel: `CE dated ${showDate(w.start)} through ${showDate(w.end)}`,
    required: rule.total, earned: sum(counted), formallyApproved: { required: rule.formallyApprovedMin, earned: formalHours },
    pharmacology: { required: rule.pharmacology, earned: pharm }, development,
  });
  const hoursMet = card.earned >= rule.total && formalHours >= (rule.formallyApprovedMin || 0) && pharm >= (rule.pharmacology || 0);
  card.met = hoursMet && yes(development);
  card.status = card.met ? "met" : hoursMet && development == null ? "needs-confirmation" : "needs-hours";
  // The professional development category is named whenever it is open, so
  // a card short only on it never alerts with a line of met figures.
  card.assessment = `Contact hours ${card.earned}/${rule.total}, formally approved ${formalHours}/${rule.formallyApprovedMin}, pharmacology ${pharm}/${rule.pharmacology}`
    + (no(development) ? "; needs one of the professional development categories" : development == null ? "; answer the professional development category question" : "");
  if (rule.developmentNote) card.lines.push(rule.developmentNote);
  if (rule.upcoming && record.expirationDate >= rule.upcoming.date) card.lines.push(rule.upcoming.text);
  return card;
}

function pncbCard(rule, record, cme, now) {
  const card = base("PNCB", rule, record, now);
  card.assessment = "Counting period for the yearly contact hours not yet verified";
  if (rule.annualHours) card.lines.push(`${rule.annualHours} contact hours every year${rule.annualPracticeHoursCap ? `; practice hours may cover up to ${rule.annualPracticeHoursCap}` : ""}.`);
  if (rule.sevenYear) card.lines.push(rule.sevenYear);
  return card;
}

function nccCard(rule, record, cme, now) {
  const card = base("NCC", rule, record, now);
  const exp = parseLocalDate(record.expirationDate);
  const cca = parseLocalDate(record.customFields?.[QUESTION_FIELDS.nccCca]);
  const plan = parseFloat(record.customFields?.[QUESTION_FIELDS.nccPlanTotal]);
  if (rule.ccaNote) card.lines.push(rule.ccaNote);
  if (!exp) { card.assessment = "Add the certification's expiration date"; return card; }
  if (!cca || !Number.isFinite(plan) || plan < (rule.planMin || 0) || plan > (rule.planMax || Infinity)) {
    card.assessment = "Add your CCA date and your education plan total";
    return card;
  }
  const excluded = (rule.excludedCategories || []).map((x) => x.toLowerCase());
  const lifeSupport = (c) => excluded.some((x) => String(c.title || "").toLowerCase().includes(x) || cmeTopics(c).some((t) => t.toLowerCase() === x));
  const countsNcc = (c) => !lifeSupport(c) && !UNACCREDITED_CATEGORIES.includes(c.category);
  const entries = (cme || []).filter((c) => inWindow(c, cca, exp) && countsNcc(c));
  withCounts(card, countsNcc);
  Object.assign(card, {
    windowStart: cca, windowEnd: exp, windowLabel: `CE dated ${showDate(cca)} through ${showDate(exp)}`,
    required: plan, earned: round2(sum(entries) + (rule.ccaCredit || 0)), ccaCredit: rule.ccaCredit || 0,
  });
  card.met = card.earned >= plan;
  card.status = card.met ? "met" : "needs-hours";
  card.assessment = `Education plan ${card.earned}/${plan} hours, including ${rule.ccaCredit} for the CCA`;
  return card;
}

function aacnCard(rule, record, cme, now) {
  const card = base("AACN", rule, record, now);
  card.url = null;
  card.assessment = "AACN renewal rules not yet verified";
  return card;
}

const BUILDERS = { NCCPA: nccpaCard, AANPCB: aanpcbCard, ANCC: anccCard, PNCB: pncbCard, NCC: nccCard, AACN: aacnCard };

/**
 * The member's national certification cards. A PA gets NCCPA; an NP gets one
 * per certification they hold (DESIGN 1.4: a dual-certified NP has two
 * records and two cards, even from one certifier: FNP-BC and PMHNP-BC). Two
 * records of the same certification (the old certificate and its renewal)
 * are one card, the record expiring last. A record whose role is not answered
 * yet returns { needsRole: true } in place of a card. Physicians and a blank
 * profession get none.
 */
const certKey = (body, record) => (body === "NCCPA" ? body : `${body}|${String(record?.name || "").trim().toUpperCase().replace(/\s+/g, " ")}`);

export function certificationCards(data, { rules = CERTIFICATION_RULES, now = new Date() } = {}) {
  const profession = professionOf(data?.settings?.degreeType);
  if (profession !== "pa" && profession !== "np") return [];
  const bodies = profession === "pa" ? PA_CERT_BODIES : NP_CERT_BODIES;
  const licenses = (data.licenses || []).filter((l) => l && !isInactive(l));
  const out = [];
  const byBody = new Map();
  for (const l of licenses) {
    const body = certBodyOf(l.type);
    if (!body || !bodies.includes(body)) continue;
    const role = certificationRoleOf(l, data.licenses);
    if (!role) { out.push({ id: `CERT:${body}:${l.id || ""}:role`, body, recordId: l.id || null, needsRole: true, label: `${body} certification${l.name ? ` (${l.name})` : ""}`, question: "What is this certification?" }); continue; }
    if (role !== "PA-C" && role !== "NP certification") continue;
    const key = certKey(body, l);
    const prev = byBody.get(key);
    if (!prev || String(l.expirationDate || "") > String(prev.record.expirationDate || "")) byBody.set(key, { body, record: l });
  }
  for (const { body, record } of byBody.values()) {
    const rule = rules?.[body] || null;
    if (rule) { out.push(BUILDERS[body](rule, record, data.cme || [], now)); continue; }
    const card = base(body, null, record, now);
    card.assessment = `${body} renewal rules not yet verified`;
    out.push(card);
  }
  return out;
}

/**
 * The certification cards that count like a state card: in the Home ring and
 * in the alerts, with their own deadline (NCCPA: December 31 of the
 * expiration year). Only a card with a verified credit target counts: met or
 * short ("needs-hours"); a card waiting on a question stays on Home only.
 * Shape: the stateComps entries standingScore reads.
 */
export function certificationRingComps(data, opts = {}) {
  return certificationCards(data, opts)
    .filter((c) => !c.needsRole && c.required != null && (c.status === "met" || c.status === "needs-hours"))
    .map((c) => ({
      st: c.body, kind: "cert", key: c.id,
      comp: { fullyCompliant: c.status === "met", daysLeft: c.daysLeft, assessmentStatus: c.status, certCard: c },
    }));
}
