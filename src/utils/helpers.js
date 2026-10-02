// Extension spelled out so pure-node test scripts can import this module
// (Vite resolves either way; node's ESM loader needs the ".js").
import { CERTIFICATION_TYPE, isInherentlyNonExpiringLicense } from "../constants/credentialTypes.js";
import { certBodyOf, DEGREE_LABELS, isAdvancedPractice, isPhysicianDegree, mayNotExpire } from "../constants/professions.js";
import { professionCopy } from "../constants/professionCopy.js";
import { buildReferenceText, referenceSentences } from "./referenceDraft.js";
import { scrubSsn, plainDashes, withDegree } from "./outgoingText.js";
import { LIFECYCLE_SECTIONS, lifecycleNote } from "./lifecycle.js";
import { daysUntilDate } from "./dateDays.js";

export const MS_PER_DAY = 86400000;

/**
 * The local calendar date as YYYY-MM-DD (src/utils/dateDays.js localToday).
 * `new Date().toISOString().slice(0, 10)` is the UTC date, which is already
 * tomorrow on a US evening: a case dictated at 6 pm in California was dated
 * the next day.
 */
export { localToday as localISODate } from "./dateDays.js";

/**
 * The two letters an avatar shows when there is no photo: the first letter of
 * each of the first two words of the member's name ("Nadia Navigate" is
 * "NN"), and "MD" before a name is set. The top bar, the desk sidebar and
 * Settings all draw it from here: the sidebar took the first two letters of
 * the name instead ("NA"), so one member had two avatars on one screen
 * (HOME-005).
 */
export function avatarInitials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "MD";
  return words.slice(0, 2).map(w => Array.from(w)[0]).join("").toUpperCase();
}

export function generateId() {
  // Use cryptographically secure UUID when available
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c === "x" ? 0 : 2);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Records that legitimately never expire (device/course certifications,
 * personal coverage) must not read as "missing a date": they show green
 * with "Does not expire" instead of gray.
 */
// A facility's short display label. If the full name matches a locum
// agreement that carries a short name (e.g. "ANMG" for "Arrowhead
// Neurosurgical Medical Group"), show that; otherwise show the full name.
// The stored value stays the full name — credentialing exports need it.
export function shortFacility(facility, contracts) {
  if (!facility || !Array.isArray(contracts)) return facility || "";
  const m = contracts.find(c => c && c.shortName && c.facility === facility);
  return m ? m.shortName : facility;
}

export function isNonExpiring(item, sectionKey) {
  if (!item || item.expirationDate) return false;
  const t = String(item.type || "");
  // The licenses form offers the "does not expire" checkbox on a board
  // certification and nowhere else, so under licenses only a board
  // certification may be silenced by it. Ticking the box and then editing the
  // record's type to a state license hid the checkbox but left the flag set,
  // and a dated credential dropped out of the missing-date banner and out of
  // dateless() with it: invisible to the one system Tier 1 exists to feed.
  // NCCPA and every NP certification expire, and their date anchors the
  // certification's CE window, so a stored "does not expire" never silences
  // one (certBodyOf, src/constants/professions.js).
  // A practice agreement or prescriptive authority record may be marked as
  // not expiring too (Ohio PA agreements do not expire).
  if (item.noExpiration === true && (sectionKey !== "licenses" || t === CERTIFICATION_TYPE || (/board certification/i.test(t) && !certBodyOf(t)) || mayNotExpire(t))) return true;
  if (sectionKey === "licenses" && isInherentlyNonExpiringLicense(t)) return true;
  if (sectionKey === "insurance" && /health insurance|dental|vision|life insurance|disability/i.test(t)) return true;
  if (sectionKey === "healthRecords" && /immune|titer/i.test(String(item.name || "") + " " + String(item.category || "")) && !item.expirationDate) return true;
  return false;
}

/**
 * Whether a work history record is the current position. The column is a
 * boolean and every write now stores one (recordWrite.js), but a cached row
 * from before may still hold the form's old "Yes"/"No", so every reader goes
 * through here rather than testing `=== "Yes"` or plain truthiness (a
 * cached "No" is a truthy string).
 */
export function isCurrentJob(v) {
  return isTicked(v) || /^(current|present)$/i.test(String(v ?? "").trim());
}

/**
 * The delete confirmation for a record with files attached. Deleting a record
 * deletes the documents linked to it (AppContext deleteItemFn: the rows, their
 * stored files and a tombstone), which the generic "Delete this item?" never
 * said. `names`, when given, lists up to three of the files by name.
 */
export function deleteConfirmText(noun, fileCount = 0, { one = "attached file", many = "attached files", extra = "", names = [] } = {}) {
  const n = Number(fileCount) || 0;
  const tail = `${extra ? `${extra} ` : ""}This cannot be undone.`;
  if (n <= 0) return `Delete this ${noun}? ${tail}`;
  const word = n === 1 ? one : many;
  const short = (n === 1 ? one : many).replace(/^attached /, "");
  const listed = (Array.isArray(names) ? names : []).filter(Boolean);
  const named = listed.length ? ` (${listed.slice(0, 3).join(", ")}${listed.length > 3 ? ", ..." : ""})` : "";
  return `Delete this ${noun} and its ${n} ${word}${named}? The ${short} will be removed from Files too. ${tail}`;
}

/** A checkbox value: true, or a "Yes"/"true" a select used to store. */
export function isTicked(v) {
  if (v === true || v === 1) return true;
  return /^(yes|true)$/i.test(String(v ?? "").trim());
}

// Countdowns compare local calendar days (src/utils/dateDays.js): a bare
// YYYY-MM-DD parsed as UTC midnight expired a license at 5 pm Pacific on its
// last valid day.
//
// `lead` is the member's reminder lead time (reminderLeadDays(settings)), the
// window the ring, the tiles and Action Required count as expiring. Callers
// that grade a member's record pass it; left at 90, a lead of 30 showed a
// license 60 days out as Expiring beside a tile that counted it Active.
export function getStatusColor(expDate, lead = 90) {
  if (!expDate) return "gray";
  const days = daysUntilDate(expDate);
  if (days == null) return "gray";
  if (days < 0) return "red";
  if (days <= Math.min(30, lead)) return "orange";
  if (days <= lead) return "amber";
  return "green";
}

export function getStatusLabel(expDate) {
  if (!expDate) return "No date";
  const days = daysUntilDate(expDate);
  if (days == null) return "No date";
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  if (days === 0) return "Expires today";
  return `${days}d left`;
}

export function formatDate(s) {
  if (!s) return "\u2014";
  // For YYYY-MM-DD strings, append T00:00:00 to avoid timezone shift
  // For full ISO datetime strings, parse as-is
  const d = s.length === 10 ? new Date(s + "T00:00:00") : new Date(s);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// The assistant is instructed to write cover notes as short standalone
// sentences on separate lines, but an LLM can still return one
// semicolon-joined run-on line despite that instruction. This
// deterministically re-splits it so a slip on the model's part never
// reaches the user as a run-on paragraph. A run-on list has at least two
// semicolons; a single one is ordinary punctuation inside a sentence
// ("The DEA renewal is pending; I will send it next week.") and stays.
export function normalizeMultilineNote(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  const existingLines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  if (existingLines.length > 1) return existingLines.join("\n");
  const bySemicolon = raw.split(/;\s*/).map(s => s.trim()).filter(Boolean);
  return bySemicolon.length > 2 ? bySemicolon.join("\n") : raw;
}

// RFC 6068: a mailto body needs CRLF line breaks — a bare "\n" reads as one
// continuous line in several mail clients. Every mailto in the app goes
// through here so no send path can miss the conversion again. It is also
// where an SSN-shaped value is taken out of anything the app hands to a mail
// app (src/utils/outgoingText.js).
export function mailtoHref(email, subject, body) {
  return `mailto:${encodeURIComponent(email || "")}`
    + `?subject=${encodeURIComponent(scrubSsn(subject || ""))}`
    + `&body=${encodeURIComponent(scrubSsn(String(body || "")).replace(/\r?\n/g, "\r\n"))}`;
}

export function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  return daysUntilDate(dateStr) ?? Infinity;
}

// plainDashes lives in outgoingText.js (dependency-free, so the edge
// functions share it) and is re-exported here for the existing importers.
export { plainDashes };

export function getSectionFacts(item, section) {
  const facts = [];
  // formatDate() of a missing date is an on-screen dash placeholder; a fact
  // with no value is left out instead of being sent as "Issued: <dash>".
  const noDate = formatDate("");
  const a = (k, v) => { if (v && v !== noDate) facts.push([k, v]); };

  if (section === "licenses") {
    a("Type", item.type); a("License #", item.licenseNumber); a("State", item.state);
    a("Issued", formatDate(item.issuedDate)); a("Expires", formatDate(item.expirationDate));
  } else if (section === "privileges") {
    a("Type", item.type); a("Facility", item.facility); a("State", item.state);
    a("Appointed", formatDate(item.appointmentDate)); a("Reappointment Due", formatDate(item.expirationDate));
  } else if (section === "insurance") {
    a("Policy Type", item.type); a("Carrier", item.provider); a("Policy #", item.policyNumber);
    a("Per Claim", item.coveragePerClaim); a("Aggregate", item.coverageAggregate);
    a("Effective", formatDate(item.effectiveDate)); a("Expires", formatDate(item.expirationDate));
  } else if (section === "cme") {
    a("Category", item.category); a("Hours", item.hours);
    a("Completed", formatDate(item.date)); a("Provider", item.provider);
    a("Certificate #", item.certificateNumber);
  } else if (section === "caseLogs") {
    a("Category", item.category); a("Date", formatDate(item.date));
    a("Facility", item.facility); a("Role", item.role); a("CPT", item.cptCodes);
  } else if (section === "healthRecords") {
    a("Category", item.category); a("Type", item.type);
    a("Date Administered", formatDate(item.dateAdministered)); a("Expires", formatDate(item.expirationDate));
    a("Result", item.result); a("Lot #", item.lotNumber); a("Facility", item.facility);
  } else if (section === "education") {
    a("Type", item.type); a("Institution", item.institution);
    a("Started", item.startDate ? formatDate(item.startDate) : "");
    a("Graduated", formatDate(item.graduationDate)); a("Field of Study", item.fieldOfStudy);
    a("Honors", item.honors);
  } else if (section === "publications") {
    a("Citation", item.citation); a("Year", item.year);
    a("DOI", item.doi); a("PMID", item.pmid); a("Link", item.url);
  } else if (section === "memberships") {
    a("Organization", item.organization); a("Membership", item.role);
    a("Member Since", item.startDate ? formatDate(item.startDate) : "");
    a("Ended", item.endDate ? formatDate(item.endDate) : "");
  } else if (section === "peerReferences") {
    a("Name", item.name); a("Degree/Credential", item.degree); a("Specialty", item.specialty);
    a("Institution", item.institution); a("Relationship", item.relationship);
    a("Known Since", item.knownSince ? formatDate(item.knownSince + "-01") : "");
    a("Email", item.email); a("Phone", item.phone);
  } else if (section === "malpracticeHistory") {
    a("Date of Incident", formatDate(item.dateOfIncident)); a("Date Filed", formatDate(item.dateFiled));
    a("State", item.state); a("Outcome", item.outcome); a("Settlement Amount", item.settlementAmount);
    a("Facility", item.facility); a("Insurance Carrier", item.insuranceCarrier);
    a("Date Resolved", formatDate(item.dateResolved)); a("Description", item.description);
  } else if (section === "workHistory") {
    a("Position", item.position); a("Employer", item.employer);
    a("Location", [item.city, item.state].filter(Boolean).join(", "));
    a("Start Date", formatDate(item.startDate));
    a("End Date", isCurrentJob(item.current) ? "Current" : formatDate(item.endDate));
    a("Reason for Leaving", item.reasonForLeaving); a("Description", item.description);
  } else if (section === "travelDocs") {
    a("Type", item.type); a("Provider", item.provider); a("Number", item.number);
    a("Expires", formatDate(item.expirationDate));
  } else if (section === "professionalPhotos") {
    a("Date Taken", formatDate(item.dateTaken));
  } else if (section === "answerBank") {
    a("Answer", item.answer); a("Confirmed", formatDate(item.confirmationDate));
    a("Scope", item.scope); a("Source", item.source);
  } else if (section === "identityVault") {
    // Deliberately not the encrypted fields (SSN, full DOB, legal name) —
    // this text feeds Send/email, and this record is never meant to travel
    // that way. Only non-sensitive record metadata is listed.
    a("Record Label", item.label); a("Verified Date", formatDate(item.verifiedDate));
  } else if (section === "screenings") {
    a("Type", item.type); a("Agency", item.agency); a("Requested By", item.requestedBy);
    a("Assignment", item.assignment); a("File #", item.fileNumber);
    a("Ordered", formatDate(item.orderDate)); a("Reported", formatDate(item.reportDate));
    a("Expires", formatDate(item.expirationDate)); a("Overall Result", item.result);
  }

  // A historical, superseded, provisional, pending or undated record says so
  // wherever it is sent, so nobody reads it as the credential in force.
  if (LIFECYCLE_SECTIONS.includes(section)) a("Status", lifecycleNote(item));

  return facts;
}

/**
 * The degree as a credentialing office reads it: MD and DO spelled out, any
 * other stored degree as written, nothing when none is on the profile (it
 * used to print "Doctor of Medicine" for a blank degree, wrong for a DO who
 * had not picked one yet).
 */
export function degreeLongForm(deg) {
  const d = String(deg || "").trim();
  if (/^m\.?d\.?$/i.test(d)) return "Doctor of Medicine";
  if (/^d\.?o\.?$/i.test(d)) return "Doctor of Osteopathic Medicine";
  return d;
}

/** True when every part of a record's label is already one of its facts' values. */
export function labelRepeatsFacts(label, facts) {
  const values = new Set((facts || []).map(([, v]) => String(v).trim().toLowerCase()));
  const parts = String(label || "").split(/,\s*/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => values.has(p));
}

/** "Oct 1, 2026": the date outgoing text is stamped with, en-US on every phone. */
export const sentStamp = (date = new Date()) => formatDate(localDay(date));

export function buildCredentialText(item, section, settings, { footer = true } = {}) {
  if (section === "peerReferences") return buildReferenceText(item);
  const lines = [];
  const deg = settings.degreeType || "";
  // MD and DO read exactly as before. A PA or NP states their own profession;
  // a member who has not chosen one is not given a degree or an honorific,
  // since this text goes to a credentialing office (DESIGN 5.1 rule 2).
  const physician = isPhysicianDegree(deg);
  // ASCII, not a box-drawing glyph: Mail renders "\u2500" in a wide symbol font
  // that wraps onto its own line on an iPhone (see invoiceCover.js TEXT_RULE).
  const div = "-".repeat(30);

  lines.push("CREDENTIAL VERIFICATION", div);
  // No name on the profile: no "Physician: Dr." or "Name: Clinician" line.
  // MD and DO read "Physician:"; a PA or NP, or a member with no profession
  // chosen, reads "Name:" (DESIGN 5.1 rule 2).
  if (settings.name) lines.push(physician ? "Physician: " + withDegree(settings.name, deg) : "Name: " + withDegree(settings.name, isAdvancedPractice(deg) ? deg : ""));
  if (settings.npi) lines.push("NPI: " + settings.npi);
  if (settings.specialties?.length) {
    const names = settings.specialties.map(id => {
      const parts = id.split(":");
      return parts[parts.length - 1];
    });
    lines.push("Specialty: " + names.join(", "));
  }
  if (isAdvancedPractice(deg)) lines.push("Profession: " + DEGREE_LABELS[deg]);
  else if (degreeLongForm(deg)) lines.push("Degree: " + degreeLongForm(deg));
  // The record's heading ("State Medical License, CO") only when the facts
  // below do not already say all of it ("Type: State Medical License",
  // "State: CO" right under it read as the same line twice).
  const facts = getSectionFacts(item, section);
  const label = plainDashes(describeItem(item, settings.name, section));
  lines.push(div);
  if (!labelRepeatsFacts(label, facts)) lines.push(label, "");

  for (const [k, v] of facts) lines.push(k + ": " + v);

  if (item.components?.length) {
    lines.push("", "Searches Performed:");
    for (const c of item.components) {
      lines.push("- " + [c.name, c.scope, c.status].filter(Boolean).join(", ") + (c.date ? ` (${formatDate(c.date)})` : ""));
    }
  }

  // item.notes is the physician's own memo ("board portal login, fee paid on
  // AmEx", a staff-office phone tree, case details) and never goes out. The
  // Send sheet's Note field is where a per-send message belongs.
  // footer: false when the letter around this text signs off and stamps it.
  if (footer) lines.push("", div, "Sent via CredentialDOMD \u00b7 " + sentStamp());
  return lines.join("\n");
}

/**
 * Share-sheet text for a credential. iOS Mail ignores the share title when
 * files are attached, promotes the FIRST LINE of text to the subject, and
 * strips every line break — so this must be ONE flowing paragraph whose
 * opening words read as a subject. The formatted letter goes to the
 * clipboard alongside (see ShareModal.doShare), and the SENDER is told so
 * there; this text goes to the recipient and never mentions the clipboard
 * (ticket 821d2f76). Broken into short sentences
 * (physician, then facts, then provenance) instead of one semicolon-joined
 * run-on — each fact is its own period-terminated sentence, not a "; "-joined
 * list, so it still reads as separate statements once line breaks are gone —
 * and skips the item summary line since it only restates fields already
 * listed in the facts below.
 */
export function buildCredentialBlurb(item, section, settings, hasDocs, note) {
  if (section === "peerReferences") {
    return [note?.trim().replace(/\s+/g, " "), referenceSentences(item), hasDocs ? "Supporting documentation is attached." : ""].filter(Boolean).join(" ");
  }
  const deg = settings.degreeType || "";
  const specialties = settings.specialties?.length
    ? settings.specialties.map(id => {
        const parts = id.split(":");
        return parts[parts.length - 1];
      }).join(", ")
    : "";
  // No name: "the physician" (MD, DO) or the chosen profession's noun, "the
  // clinician" when none is chosen; never "Dr." or a placeholder name.
  const physician = (settings.name ? withDegree(settings.name, deg) : `the ${professionCopy(deg, { audience: "third-party" }).noun}`)
    + (settings.npi ? " (NPI " + settings.npi + ")" : "")
    + (specialties ? ", " + specialties : "");
  const facts = getSectionFacts(item, section)
    .map(([k, v]) => `${k}: ${v}${/[.!?]$/.test(String(v).trim()) ? "" : "."}`).join(" ");

  return "Credential verification from " + physician + ". " + facts
    + (note ? " " + note.trim().replace(/\s+/g, " ") : "")
    + (hasDocs ? " Supporting documentation is attached." : "")
    + " Sent via CredentialDOMD \u00b7 " + sentStamp() + ".";
}

// The subject a credentialing office sees. It carries the record's canonical
// label ("DEA Registration, CO"), never the Display Name: scans put the
// physician's own name there, so three DEA shares went out headed with the
// physician's name, the physician's name again, and "DEA ND".
export function buildEmailSubject(item, section, settings) {
  if (section === "peerReferences") {
    // Whose reference it is: a credentialing office files it under the applicant.
    const who = settings?.name ? withDegree(settings.name, settings.degreeType) : "";
    return `Professional reference${who ? ` for ${who}` : ""}: ${item.name || "Reference"}`;
  }
  const label = plainLabel(item, settings?.name, section) || "Credential";
  // No name: "Physician" for an MD or DO, "Clinician" for a PA, an NP or a
  // member with no profession chosen, the invoice's own placeholders
  // (invoiceArgs.js physicianLabel), never a profession she did not choose.
  const physician = settings?.name || (isPhysicianDegree(settings?.degreeType) ? "Physician" : "Clinician");
  return `Credential Verification: ${label} - ${physician}`;
}

// A record's label for alerts and notification text: the same canonical label
// the cards use, written with a comma so it reads cleanly in plain text.
export function getItemLabel(item, physicianName, sectionKey) {
  if (!item) return "Credential";
  return plainLabel(item, physicianName, sectionKey || item._sec) || "Credential";
}

/**
 * A card's main line under its green type header: the canonical title
 * (describeItem) with the leading type and the separator after it removed,
 * so "State Medical License, CO" under STATE MEDICAL LICENSE reads "CO".
 * describeItem joins with ", " (an older title used an em dash); both go.
 * Empty when the title is only the type. A title that merely begins with
 * the same letters ("DEA Registration" under DEA) stays whole.
 */
export function titleAfterType(title, type) {
  const full = String(title || "");
  // describeItem titles with the trimmed type; a stored "State Medical
  // License " (trailing space) must strip the same way.
  const lead = String(type || "").trim();
  if (!lead || !full.toLowerCase().startsWith(lead.toLowerCase())) return full;
  const rest = full.slice(lead.length);
  if (!rest.trim()) return "";
  const separated = rest.match(/^\s*(?:,|\u{2014}|\u{B7})\s*/u);
  return separated ? rest.slice(separated[0].length) : full;
}

/**
 * The one-line title of a card (the type, then the main line), for places
 * that print both on one line: the read-only records page and the Member
 * viewer's Home rows. A title that already leads with its type is whole
 * ("Tail, Tailored Risk Insurance"; "State Medical License"). Otherwise the
 * type goes in front, unless the title begins with the type as a whole word
 * ("DEA Registration, CO" under DEA). Letters alone are not the type:
 * "Tailored Risk Insurance" under Tail reads "Tail, Tailored Risk Insurance".
 */
export function titleWithType(title, type) {
  const full = String(title || "").trim();
  const lead = String(type || "").trim();
  if (!lead) return full;
  if (!full) return lead;
  if (titleAfterType(full, lead) !== full) return full;
  const next = full.slice(lead.length, lead.length + 1);
  const wordLead = full.toLowerCase().startsWith(lead.toLowerCase()) && !/[\p{L}\p{N}]/u.test(next);
  return wordLead ? full : `${lead}, ${full}`;
}

/** describeItem with its separators written as commas, for plain text and pickers. */
export function plainLabel(item, physicianName, sectionKey) {
  if (!item) return "";
  return String(describeItem(item, physicianName, sectionKey) || "").replace(/\s*\u{2014}\s*/gu, ", ");
}

/**
 * Descriptive label for lists. AI scans sometimes put the PHYSICIAN'S name in
 * item.name ("Rowan Testa"), which makes every row read the same. If name is
 * missing or just the physician's name, build a label from what the
 * credential actually is: type/title + state/facility/institution.
 */
/**
 * A scanned credential often carries the PHYSICIAN'S name in its name field
 * ("TESTA, ROWAN", "Rowan E. Testa, DO"), useless as a label. Detect any
 * variant of the person's name (case, commas, middle names/initials, degree
 * suffixes) and label by type + state instead.
 */
const NAME_SUFFIXES = new Set(["do", "md", "jr", "sr", "ii", "iii", "iv", "phd", "np", "pa"]);
const nameWords = (s) => String(s).toLowerCase().replace(/[.,()]/g, " ").split(/\s+/)
  .filter(t => t && !NAME_SUFFIXES.has(t));

export function isPersonName(name, physicianName) {
  if (!name || !physicianName) return false;
  const a = nameWords(name), b = nameWords(physicianName);
  if (!a.length || !b.length) return false;
  // Every word of the shorter name must appear in the longer one, allowing
  // middle initials to match full middle names ("e" ~ "ellis")
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Initials match full names in BOTH directions: a license reading
  // "Rowan Ellis Testa" is the person whose profile says "Rowan E. Testa"
  const matches = (t, u) => t === u
    || (t.length === 1 && u.startsWith(t))
    || (u.length === 1 && t.startsWith(u));
  return short.every(t => long.some(u => matches(t, u)));
}

// Sections whose Display Name is only ever noise when it is the physician's
// own name: every card in them titles by type and state, facility, carrier or
// school instead. Peer references are absent on purpose, the person IS the
// record there.
export const PERSON_NAME_SECTIONS = Object.freeze(["licenses", "privileges", "insurance", "education", "healthRecords", "travelDocs"]);

/**
 * The stricter test a write uses before it clears stored text. isPersonName
 * is a display heuristic: it lets an initial on either side match, so a lone
 * "ACLS" reads as "John A. Smith" and "Neurosurgery" as "N. Testa". Hiding
 * a title is cheap; erasing one on every save is not. Here the Display Name
 * must be the physician's name and nothing else:
 *   - two words or more (a lone "Mercy" or "Mayo" is a facility as often as
 *     a name), unless the physician's own name is a single word;
 *   - at least one word of two letters or more equal to one of the
 *     physician's (the surname, usually);
 *   - every word one of the physician's, or an initial of one of the
 *     physician's full words ("E. Testa"). A full word matches one of the
 *     physician's initials ("Jordan Alex Rivera" for "Jordan A. Rivera") only
 *     beside two exact full-word matches, so "Mercy Jones" is never read as
 *     "Mary M. Jones".
 */
export function namesOnlyThePhysician(name, physicianName) {
  if (!name || !physicianName) return false;
  const a = nameWords(name), b = nameWords(physicianName);
  if (!a.length || !b.length) return false;
  if (a.length < 2 && b.length >= 2) return false;
  const full = b.filter(u => u.length >= 2);
  const exact = new Set(a.filter(t => t.length >= 2 && full.includes(t)));
  if (exact.size === 0) return false;
  const initials = b.filter(u => u.length === 1);
  return a.every(t => b.includes(t)
    || (t.length === 1 && full.some(u => u.startsWith(t)))
    || (exact.size >= 2 && initials.some(u => t.startsWith(u))));
}

/**
 * A board certification or a course certification is named by its Display
 * Name ("Neurosurgery", "ACLS": the "What Is It In?" answer, the specialty
 * the CV prints), so a write never clears it.
 */
const nameIsContent = (sectionKey, item) => sectionKey === "licenses"
  && (item.type === CERTIFICATION_TYPE || /board certification/i.test(item.type || ""));

/** True when a write clears this record's Display Name as the physician's own name. */
export function clearsPersonName(sectionKey, item, physicianName) {
  if (!item || typeof item !== "object" || !PERSON_NAME_SECTIONS.includes(sectionKey)) return false;
  if (typeof item.name !== "string" || nameIsContent(sectionKey, item)) return false;
  return namesOnlyThePhysician(item.name, physicianName);
}

/**
 * The record with a Display Name that is just the physician's own name
 * cleared, so the canonical label applies everywhere (share subjects,
 * notifications, pickers) and not only on the card. Anything else is
 * returned unchanged.
 */
export function withoutPersonName(sectionKey, item, physicianName) {
  return clearsPersonName(sectionKey, item, physicianName) ? { ...item, name: null } : item;
}

// Every category titles CANONICALLY — the same fields in the same order for
// every card in a section — so two DEA registrations, two policies, or two
// degrees always read alike. The physician's own name is never information:
// it appears on half the documents a scanner reads, and it never becomes a
// headline (peer references excepted — there the person IS the record).
// Free text the scanner stored stays visible in the detail view.
export function describeItem(item, physicianName, sectionKey) {
  const t = (v) => (v && String(v).trim()) || null;
  const notMe = (v) => (t(v) && !isPersonName(v, physicianName) ? String(v).trim() : null);
  const join = (...parts) => parts.filter(Boolean).join(", ");

  // Callers that know their section say so; the rest is inferred from the
  // fields only that section has, so alerts and share sheets match the cards.
  const sec = sectionKey
    || ("licenseNumber" in item ? "licenses" : null)
    || ("policyNumber" in item ? "insurance" : null)
    || ("appointmentDate" in item ? "privileges" : null)
    || ("employer" in item ? "workHistory" : null)
    || ("graduationDate" in item && "institution" in item ? "education" : null)
    || ("citation" in item ? "publications" : null)
    || ("organization" in item ? "memberships" : null);

  switch (sec) {
    case "licenses":
      return join(t(item.type) || "License", t(item.state));
    case "insurance":
      return join(t(item.type) || "Policy", t(item.provider));
    case "privileges":
      return join(t(item.type) || "Privileges", t(item.facility));
    case "workHistory":
      return join(t(item.position) || t(item.type) || "Position", t(item.employer));
    case "education":
      // The curated display name IS the information ("Skull Base
      // Fellowship") — type-first collapsed every card into "Residency,
      // Residency, Certification, Certification". Person names (a diploma
      // reads the graduate's name) still fall through to type — school.
      return notMe(item.name) || join(t(item.type) || "Education", t(item.institution));
    case "healthRecords":
      return join(t(item.type) || "Health record", notMe(item.name) || t(item.provider));
    case "malpracticeHistory":
      return join(t(item.outcome) || "Claim", t(item.facility) || t(item.state));
    case "answerBank":
      return join((t(item.question) || "Answer").slice(0, 70), t(item.answer));
    case "identityVault":
      return t(item.label) || "Protected Identity";
    case "memberships":
      // Organization leads — role-first made every card read "Member — …"
      return join(t(item.organization), t(item.role)) || "Membership";
    case "peerReferences":
      return join(t(item.name) || "Reference", t(item.degree));
    case "travelDocs":
      return join(t(item.type) || "Travel", t(item.provider) || notMe(item.name));
    case "travelExpenses":
      // A scanned receipt links here: category, then vendor
      return join(t(item.category) || "Expense", t(item.vendor));
    case "deductibles":
      return join(t(item.category) || "Deduction", t(item.merchant) || t(item.description));
    case "publications":
      return notMe(item.name)
        || (item.citation ? String(item.citation).split(".").slice(0, 2).join(".").slice(0, 90) : "Publication");
    case "caseLogs":
      return notMe(item.title) || t(item.category) || "Case";
    case "customRecords":
      // A record in one of the physician's own categories
      return join(notMe(item.name) || t(item.categoryName) || "Record", t(item.issuer));
    default:
      break;
  }

  // Sections without a canonical shape (documents, CME courses, photos…):
  // the record's own title is the information — unless it's a person's name.
  if (notMe(item.name)) return String(item.name).trim();
  if (item.citation) return String(item.citation).split(".").slice(0, 2).join(".").slice(0, 90);
  const base = item.type || item.title || item.category || "Credential";
  const where = item.state || item.facility || item.institution || item.provider || "";
  return where ? `${base}, ${where}` : base;
}

// Every share letter and message the app copies goes through here, so an
// SSN-shaped value is removed on the way out. (Protected Identity's own Copy
// is the one deliberate copy of an SSN and does not use this.)
export async function copyToClipboard(raw) {
  const text = scrubSsn(raw);
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand("copy"); }
    finally { document.body.removeChild(ta); }
  }
}

export const STATUS_COLORS = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#eab308",
  green: "#22c55e",
  gray: "#94a3b8",
};

// Downscale a photo for the profile avatar — full-res photos are megabytes;
// the avatar syncs inside the profile row, so keep it small.
export function downscalePhoto(dataUrl, max = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** The device's local calendar day as YYYY-MM-DD (not the UTC day toISOString gives). */
export function localDay(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/**
 * The local day an invoice was sent (YYYY-MM-DD), or "" without one. sentAt
 * is a moment: its first ten characters are the UTC day, which reads as the
 * next day for an invoice sent on a US evening (and for one recorded with
 * Mark as sent today). A plain YYYY-MM-DD is already a day, and localDay would
 * move it back one in the Americas (it parses as UTC midnight). Every screen,
 * the export and the printed "Issued" date read the day through this.
 */
export function sentDay(sentAt) {
  if (!sentAt) return "";
  const s = String(sentAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return Number.isNaN(new Date(s).getTime()) ? s.slice(0, 10) : localDay(s);
}

// Invoice numbers must never repeat — an AP department treats the number as
// identity. Count-based numbering (invoices.length + 1) reissued a number
// whenever an earlier invoice was deleted; this scans what actually exists.
//
// `kind` is the prefix: "INV" for work, "EXP" for an expense invoice, each
// its own sequence, checked against the exact string that gets saved (an EXP
// number used to be an INV one renamed after the check, so two expense
// invoices on one day were both -01). The date is the physician's local day.
// The next number is one past the highest suffix issued today, so a gap left
// by a deleted invoice is never refilled; `retired` adds numbers no longer
// on the list (deleted invoices) that must not come back either.
export function nextInvoiceNumber(invoices, kind = "INV", { retired = [] } = {}) {
  const prefix = `${kind}-${localDay().replaceAll("-", "")}-`;
  const taken = new Set([...(invoices || []).map(i => String(i?.number || "")), ...retired.map(String)]);
  let high = 0;
  for (const n of taken) {
    if (!n.startsWith(prefix)) continue;
    const m = n.slice(prefix.length).match(/^(\d+)/);
    if (m) high = Math.max(high, parseInt(m[1], 10));
  }
  let seq = high + 1;
  let num;
  do {
    num = `${prefix}${String(seq).padStart(2, "0")}`;
    seq += 1;
  } while (taken.has(num));
  return num;
}
