// The Licenses, Privileges and Insurance forms (CrudSection field lists).
//
// They live here rather than inline in App.jsx so the rules they encode can
// be tested under plain node: which date is required when, and that every
// key a form writes is a real column (tests/credential-schema-contract.test.mjs).
// The sync layer writes every key on a record as a column, and one the table
// lacks makes PostgREST reject the WHOLE row; the licence form's noExpiration
// checkbox did exactly that until migration 20260925040000.
//
// Pure: plain node tests import it.

import { STATES } from "../constants/states.js";
import { getLicenseTypes, CERTIFICATION_TYPE, PRIVILEGE_TYPES, INSURANCE_TYPES } from "../constants/credentialTypes.js";
import { lifecycleFields, expirationWaived } from "./lifecycle.js";
import { plainLabel } from "./helpers.js";

/** Personal coverage (health, dental, vision, disability, life) has no credentialing expiration to chase. */
export const PERSONAL_COVERAGE_RE = /health insurance|dental|vision|life insurance|disability/i;

const isBoardCert = (f) => /board certification/i.test(f.type || "");

/** The licence form. `records` feed the "Replaced by" picker. */
export function licenseFields({ degreeType, records = [], physicianName } = {}) {
  const life = lifecycleFields({ records, labelOf: (r) => plainLabel(r, physicianName, "licenses"), dateNoun: "Expiration" });
  return [
    { key: "type", label: "Type", type: "select", options: getLicenseTypes(degreeType) },
    { key: "name", label: (f) => f.type === CERTIFICATION_TYPE ? "What Is It In?" : "Display Name", placeholder: (f) => f.type === CERTIFICATION_TYPE ? "e.g. ACLS, Da Vinci Robotic System" : "e.g. CA Medical License" },
    { key: "licenseNumber", label: "License #" },
    { key: "state", label: "State", type: "select", options: STATES, required: (f) => /license|dea/i.test(f.type || "") },
    { key: "issuedDate", label: "Issued", type: "date" },
    { key: "noExpiration", label: "Expiration", type: "checkbox", checkboxLabel: "This certificate does not expire", show: isBoardCert, hint: "A lifetime diplomate has no renewal date. Tick this and the app stops asking for one. Course and device certifications are already treated this way." },
    { key: "expirationDate", label: "Expires", type: "date", required: (f) => f.type !== CERTIFICATION_TYPE && !(f.noExpiration === true && isBoardCert(f)) && !expirationWaived(f) },
    // "Not known yet" is a different answer from "does not expire": a course
    // certification never expires, and a lifetime diplomate has said so.
    { ...life.dateUnknown, show: (f) => f.type !== CERTIFICATION_TYPE && !(f.noExpiration === true && isBoardCert(f)) },
    { key: "cmeCycleStart", label: "CME Cycle Start", type: "date", show: (f) => /medical license/i.test(f.type || ""), hint: "Leave blank for a normal renewal, and CME counts from one full state cycle back. Set it when your clock started somewhere else: your first renewal after training, or a first license whose CME period runs from the issue date. It changes which dates count, never how many hours you owe." },
    { key: "renewalCost", label: "Renewal Cost ($)", type: "currency", placeholder: "e.g. 450" },
    ...life.status,
    { key: "notes", label: "Notes", type: "textarea" },
  ];
}

/** The hospital privileges form. */
export function privilegeFields({ records = [], physicianName } = {}) {
  const life = lifecycleFields({ records, labelOf: (r) => plainLabel(r, physicianName, "privileges"), dateNoun: "Reappointment" });
  return [
    { key: "type", label: "Type", type: "select", options: PRIVILEGE_TYPES },
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
  const life = lifecycleFields({ records, labelOf: (r) => plainLabel(r, physicianName, "insurance"), dateNoun: "Expiration" });
  return [
    { key: "type", label: "Type", type: "select", options: INSURANCE_TYPES },
    { key: "name", label: "Display Name" },
    { key: "provider", label: "Carrier" },
    { key: "policyNumber", label: "Policy #" },
    { key: "coveragePerClaim", label: "Per Claim" },
    { key: "coverageAggregate", label: "Aggregate" },
    { key: "effectiveDate", label: "Effective", type: "date" },
    { key: "expirationDate", label: "Expires", type: "date", required: (f) => !PERSONAL_COVERAGE_RE.test(f.type || "") && !expirationWaived(f) },
    { ...life.dateUnknown, show: (f) => !PERSONAL_COVERAGE_RE.test(f.type || "") },
    ...life.status,
    { key: "notes", label: "Notes", type: "textarea" },
  ];
}
