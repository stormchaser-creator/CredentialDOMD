// Collections kept only in this account's on-device cache. Neither is in
// TABLE_MAP (src/lib/supabase.js), so neither has a cloud table, and every
// write path refuses them (isSyncedCollection). Each cloud load rebuilds the
// data from the cloud, so these are carried over from the account's own cache
// before it is replaced. Remove an entry only with a reviewed migration.
//
// Protected Identity holds legal names and, encrypted with a device lock code,
// the full date of birth and SSN a physician application asks for. It stays
// on the device by decision (ticket d49088c7): CredentialDOMD keeps no SSN or
// full date of birth in the cloud, not even as ciphertext.
export const DEVICE_ONLY_SECTIONS = Object.freeze({
  answerBank: "Answer Bank",
  identityVault: "Protected Identity",
});

// Of those, the editors still paused: they reached production before their
// storage and restore path were decided. Protected Identity is live again,
// device only.
export const PAUSED_APPLICATION_SECTIONS = Object.freeze({
  answerBank: "Answer Bank",
});

export function isDeviceOnlySection(key) {
  return typeof key === "string" && Object.hasOwn(DEVICE_ONLY_SECTIONS, key);
}

// Of the device-only sections, the ones holding personal identifiers. They
// appear on their own screen and in the physician's full JSON backup, and
// nowhere else: no packet, no account export ZIP, no read-only view, no
// share or email picker.
export const IDENTITY_SECTIONS = Object.freeze(["identityVault"]);

export function isIdentitySection(key) {
  return IDENTITY_SECTIONS.includes(key);
}

/** A document link that points into an identity record (e.g. "identityVault:abc"). */
export function isIdentityLink(linkedTo) {
  return isIdentitySection(String(linkedTo || "").split(":")[0]);
}

/** A copy of data without the identity sections. */
export function withoutIdentityRecords(data) {
  const out = { ...(data || {}) };
  for (const key of IDENTITY_SECTIONS) delete out[key];
  return out;
}

export function preservePausedApplicationRecords(merged, accountCache, tombstones = new Set()) {
  const preserved = { ...merged };
  for (const section of Object.keys(DEVICE_ONLY_SECTIONS)) {
    preserved[section] = Array.isArray(accountCache?.[section])
      ? accountCache[section].filter(record => record && typeof record === "object" &&
        typeof record.id === "string" && record.id && !tombstones.has(record.id))
      : [];
  }
  return preserved;
}

export function pausedApplicationLinks(data) {
  return Object.keys(DEVICE_ONLY_SECTIONS).flatMap(section =>
    (data[section] || []).map(record => `${section}:${record.id}`));
}
