import { hasSsnShape } from "./outgoingText.js";

/**
 * Protected Identity (ticket d49088c7): the legal name, full date of birth
 * and SSN a physician application asks for, kept on this device only.
 *
 * The two identifiers are stored as "enc1:" ciphertext (secretBox.js) under a
 * lock code of at least IDENTITY_LOCK_MIN characters. The records never sync,
 * never go into a packet, a share, the read-only view or the credential
 * portal. The one deliberate way out is the physician's own full JSON backup,
 * and this module is what reads them back in from one.
 *
 * Pure: no React, no storage, no crypto. The component and the restore path
 * both use it, and a node test holds it.
 */

export const SECTION = "identityVault";

/** Encrypted before they are saved; revealed only with the identity lock code. */
export const SECRET_FIELDS = ["fullDob", "ssn"];

/** Plain text fields, in form order. None may hold an SSN-shaped value. */
export const PLAIN_FIELDS = ["label", "legalFirstName", "legalMiddleName", "legalLastName", "suffix", "source", "verifiedDate", "notes"];

const META_FIELDS = ["id", "createdAt", "updatedAt"];
const KEEP = new Set([...META_FIELDS, ...PLAIN_FIELDS, ...SECRET_FIELDS]);
const MAX_LEN = { notes: 2000, label: 200 };
const DEFAULT_MAX = 200;
const ENC = "enc1:";

export const FIELD_LABELS = {
  label: "Record label",
  legalFirstName: "Legal first name",
  legalMiddleName: "Legal middle name",
  legalLastName: "Legal last name",
  suffix: "Suffix",
  fullDob: "Full date of birth",
  ssn: "Social Security number",
  source: "Source",
  verifiedDate: "Verified date",
  notes: "Notes",
};

export const isCiphertext = (v) => typeof v === "string" && v.startsWith(ENC);

/** The sentence to show before saving, or null when the form may be saved. */
export function identityFormError(form) {
  if (!String(form?.label || "").trim()) return "Give this record a label, for example the application it is for.";
  for (const key of PLAIN_FIELDS) {
    if (hasSsnShape(form?.[key])) {
      return `${FIELD_LABELS[key]} holds a number shaped like an SSN. It belongs in the Social Security number field, where it is encrypted.`;
    }
  }
  return null;
}

/** The plain fields of a form, trimmed and clipped, ready to save. */
export function plainValues(form) {
  const out = {};
  for (const key of PLAIN_FIELDS) {
    const v = String(form?.[key] ?? "").trim();
    if (v) out[key] = v.slice(0, MAX_LEN[key] || DEFAULT_MAX);
  }
  return out;
}

/** Masked display for a secret that is set. */
export function maskedSecret(field) {
  const dot = "\u{2022}";
  return field === "ssn" ? `${dot.repeat(3)}-${dot.repeat(2)}-${dot.repeat(4)}` : `${dot.repeat(2)}/${dot.repeat(2)}/${dot.repeat(4)}`;
}

/**
 * One record from a backup file, reduced to the fields this section has.
 * Returns { record, droppedPlainSecret } or null when it is not a record.
 * An SSN or date of birth that is not ciphertext is dropped rather than
 * stored in the clear; a plain field holding an SSN-shaped value is dropped
 * the same way.
 */
export function sanitizeIdentityRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 100) return null;
  const record = {};
  let droppedPlainSecret = false;
  for (const [key, value] of Object.entries(raw)) {
    if (!KEEP.has(key) || typeof value !== "string") continue;
    if (SECRET_FIELDS.includes(key)) {
      if (!value) continue;
      if (isCiphertext(value) && value.length <= 2000) record[key] = value;
      else droppedPlainSecret = true;
      continue;
    }
    if (PLAIN_FIELDS.includes(key) && hasSsnShape(value)) { droppedPlainSecret = true; continue; }
    record[key] = key === "id" ? value : value.slice(0, MAX_LEN[key] || DEFAULT_MAX);
  }
  return { record, droppedPlainSecret };
}

/**
 * Restore from a backup: records already on this device stay exactly as they
 * are, and records from the file whose id is new are added. Never a
 * replacement, so a stale backup cannot overwrite a newer edit.
 */
export function mergeIdentityRestore(current, incoming) {
  const have = Array.isArray(current) ? current : [];
  const ids = new Set(have.map((r) => r?.id));
  const added = [];
  let droppedPlainSecret = false;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const clean = sanitizeIdentityRecord(raw);
    if (!clean) continue;
    if (clean.droppedPlainSecret) droppedPlainSecret = true;
    if (ids.has(clean.record.id)) continue;
    ids.add(clean.record.id);
    added.push(clean.record);
  }
  return { records: [...have, ...added], added: added.length, droppedPlainSecret };
}
