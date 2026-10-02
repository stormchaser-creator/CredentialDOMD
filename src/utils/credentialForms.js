// The Licenses, Privileges and Insurance forms (CrudSection field lists).
//
// They live here rather than inline in App.jsx so the rules they encode can
// be tested under plain node: which date is required when, and that every
// key a form writes is a real column (tests/credential-schema-contract.test.mjs).
// The sync layer writes every key on a record as a column, and one the table
// lacks makes PostgREST reject the WHOLE row; the licence form's noExpiration
// checkbox did exactly that until migration 20260925030000.
//
// Type is required on all three: the column is NOT NULL, and a record saved on
// "Select..." was refused whole by the database (utils/syncRules.js).
//
// Pure: plain node tests import it.

import { STATES } from "../constants/states.js";
import { getLicenseTypes, ALL_LICENSE_TYPES, CERTIFICATION_TYPE, PRIVILEGE_TYPES, INSURANCE_TYPES, isInherentlyNonExpiringLicense } from "../constants/credentialTypes.js";
import { lifecycleFields, expirationWaived, PERSONAL_COVERAGE_RE } from "./lifecycle.js";
import { plainLabel } from "./helpers.js";
import { certBodyOf, licenseKindOf, mayNotExpire, isAdvancedPractice, isPracticeLicense } from "../constants/professions.js";

export { PERSONAL_COVERAGE_RE };

// The "does not expire" checkbox is for a lifetime diplomate's board
// certificate. NCCPA and the NP certifications expire, so their forms never
// offer it and a stored flag on them is ignored (helpers.js isNonExpiring).
const isBoardCert = (f) => /board certification/i.test(f.type || "") && !certBodyOf(f.type);
// A practice agreement or prescriptive authority record may have no end date
// (Ohio PA agreements do not expire), so its form offers the same answer.
const offersNoExpiration = (f) => isBoardCert(f) || mayNotExpire(f.type);
// Prescriptive authority and practice agreements are state instruments: the
// detail box needs the state's facts (PA and NP types only).
const STATE_INSTRUMENT_KINDS = new Set(["rx", "agreement"]);
// Practice licences and national certification records carry a CE window.
const CYCLE_START_KINDS = new Set(["pa", "aprn", "rn", "cert"]);
const namePlaceholder = (degreeType) => (degreeType === "PA" ? "e.g. CA Physician Assistant License" : degreeType === "NP" ? "e.g. CA APRN License" : "e.g. CA Medical License");

// The Licenses page's first type tab. MD and DO keep "Medical Licenses" with
// its exact test. A PA or NP sees "State Licenses" for her practice licences
// (and any medical licence still on file). A member with no profession is
// offered every profession's types (licenseFields below), so her tab is the
// profession neutral "State Licenses" and holds every practice kind: an RN or
// APRN licence never falls to "Other", a PA licence is never filed under
// "Medical Licenses".
const PHYSICIAN_TAB_RE = /medical license|physician|osteopathic|training license/i;
const ANY_PRACTICE_KINDS = new Set(["medical", "pa", "aprn", "rn"]);
export function licenseTypeTab(degreeType) {
  if (isAdvancedPractice(degreeType)) {
    return { key: "medical", label: "State Licenses", match: (i) => isPracticeLicense(i, degreeType) || /medical license|physician|osteopathic|training license|\b(rn|aprn|nurse)\b/i.test(i.type || "") };
  }
  if (!degreeType) {
    return { key: "medical", label: "State Licenses", match: (i) => ANY_PRACTICE_KINDS.has(licenseKindOf(i.type)) || PHYSICIAN_TAB_RE.test(i.type || "") };
  }
  return { key: "medical", label: "Medical Licenses", match: (i) => PHYSICIAN_TAB_RE.test(i.type || "") };
}

/** The licence form. `records` feed the "Replaced by" picker. */
export function licenseFields({ degreeType, records = [], physicianName } = {}) {
  const life = lifecycleFields({ sectionKey: "licenses", records, labelOf: (r) => plainLabel(r, physicianName, "licenses"), dateNoun: "Expiration" });
  return [
    // No profession chosen: every profession's types, never the physician
    // list alone, so a PA or NP licence is never filed as a medical one
    // (intake reads a blank member the same way, ALL_LICENSE_TYPES).
    { key: "type", label: "Type", type: "select", options: degreeType ? getLicenseTypes(degreeType) : ALL_LICENSE_TYPES, required: true },
    { key: "name", label: (f) => f.type === CERTIFICATION_TYPE ? "What Is It In?" : "Display Name", placeholder: (f) => f.type === CERTIFICATION_TYPE ? "e.g. ACLS, Da Vinci Robotic System" : namePlaceholder(degreeType) },
    { key: "licenseNumber", label: "License #" },
    { key: "state", label: "State", type: "select", options: STATES, required: (f) => /license|dea/i.test(f.type || "") || STATE_INSTRUMENT_KINDS.has(licenseKindOf(f.type)) },
    { key: "issuedDate", label: "Issued", type: "date" },
    { key: "noExpiration", label: "Expiration", type: "checkbox",
      checkboxLabel: (f) => (licenseKindOf(f.type) === "agreement" ? "This agreement does not expire" : licenseKindOf(f.type) === "rx" ? "This authority does not expire" : "This certificate does not expire"),
      show: offersNoExpiration,
      hint: (f) => (mayNotExpire(f.type)
        ? "Some states set no end date for this (an Ohio PA's practice agreement does not expire). Tick this and the app stops asking for one."
        : "A lifetime diplomate has no renewal date. Tick this and the app stops asking for one. Course and device certifications are already treated this way.") },
    { key: "expirationDate", label: "Expires", type: "date", required: (f) => !isInherentlyNonExpiringLicense(f.type) && !(f.noExpiration === true && offersNoExpiration(f)) && !expirationWaived(f) },
    // "Not known yet" is a different answer from "does not expire": a course
    // certification never expires, and a lifetime diplomate has said so
    // (lifecycle.dateUnknownApplies, which the save path enforces too).
    life.dateUnknown,
    { key: "cmeCycleStart", label: "CME Cycle Start", type: "date", show: (f) => /medical license/i.test(f.type || "") || CYCLE_START_KINDS.has(licenseKindOf(f.type)), hint: "Leave blank for a normal renewal, and CME counts from one full state cycle back. Set it when your clock started somewhere else: your first renewal after training, or a first license whose CME period runs from the issue date. It changes which dates count, never how many hours you owe." },
    { key: "renewalCost", label: "Renewal Cost ($)", type: "currency", placeholder: "e.g. 450" },
    ...life.status,
    { key: "notes", label: "Notes", type: "textarea" },
  ];
}

/** The hospital privileges form. */
export function privilegeFields({ records = [], physicianName } = {}) {
  const life = lifecycleFields({ sectionKey: "privileges", records, labelOf: (r) => plainLabel(r, physicianName, "privileges"), dateNoun: "Reappointment" });
  return [
    { key: "type", label: "Type", type: "select", options: PRIVILEGE_TYPES, required: true },
    { key: "name", label: "Display Name" },
    { key: "facility", label: "Facility" },
    { key: "city", label: "City" },
    { key: "state", label: "State", type: "select", options: STATES },
    { key: "appointmentDate", label: "Appointed", type: "date" },
    // An appointment known before its letter arrives is saved without a
    // made-up date: tick "not yet known" or mark it pending confirmation.
    { key: "expirationDate", label: "Reappointment Due", type: "date", required: (f) => !expirationWaived(f) },
    life.dateUnknown,
    { key: "portalUrl", label: "Credentialing / portal URL", type: "url", placeholder: "medstaff.hospital.org" },
    { key: "loginUsername", label: "Portal username" },
    { key: "loginSecret", label: "Portal password", type: "secret", hint: "Encrypted with your lock code before it syncs. Show it from the record's detail view." },
    ...life.status,
    { key: "notes", label: "Notes", type: "textarea", placeholder: "Medical staff office contact, reappointment steps, badge, parking, dictation line..." },
  ];
}

/** The insurance form. */
export function insuranceFields({ records = [], physicianName } = {}) {
  const life = lifecycleFields({ sectionKey: "insurance", records, labelOf: (r) => plainLabel(r, physicianName, "insurance"), dateNoun: "Expiration" });
  return [
    { key: "type", label: "Type", type: "select", options: INSURANCE_TYPES, required: true },
    { key: "name", label: "Display Name" },
    { key: "provider", label: "Carrier" },
    { key: "policyNumber", label: "Policy #" },
    { key: "coveragePerClaim", label: "Per Claim" },
    { key: "coverageAggregate", label: "Aggregate" },
    { key: "effectiveDate", label: "Effective", type: "date" },
    { key: "expirationDate", label: "Expires", type: "date", required: (f) => !PERSONAL_COVERAGE_RE.test(f.type || "") && !expirationWaived(f) },
    life.dateUnknown,
    ...life.status,
    { key: "notes", label: "Notes", type: "textarea" },
  ];
}
