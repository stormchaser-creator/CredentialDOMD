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

/**
 * Does `next` hold different device-only records from `before`? A missing
 * section counts as empty. Used while this session could not read the
 * device's offline copy (storageScope.js offlineCopyUnread): the sections
 * then exist only in that copy, which nothing is saved over until a load has
 * read it, so a change to them would be saved nowhere (AppContext refuses it).
 */
export function deviceOnlySectionsChanged(before, next) {
  const rows = (value) => JSON.stringify(Array.isArray(value) ? value : []);
  return Object.keys(DEVICE_ONLY_SECTIONS).some(section => rows(before?.[section]) !== rows(next?.[section]));
}

/** Said when a change to a device-only section is refused for that reason. */
export const DEVICE_ONLY_UNREAD_MESSAGE = "This device's offline storage could not be read, so Protected Identity and the Answer Bank cannot be changed now: a change would not be saved anywhere. Reload the app to try again.";

/**
 * Said when a change to a device-only section is refused because the latest
 * save of the device's offline copy was taken by no store (storage.js
 * deviceOnlySaveBlocked): its storage is full.
 */
export const DEVICE_ONLY_UNSAVED_MESSAGE = "This device could not save its offline copy just now, so Protected Identity and the Answer Bank cannot be changed: a change would not be saved anywhere. Try again in a moment. If it still fails, free some storage on this device or reload the app.";

/**
 * The same, when the offline storage would not open (iOS takes it from an app
 * left in the background, and a reload opens it again, 2026-10-02): nothing
 * to free, so storage space is not mentioned.
 */
export const DEVICE_ONLY_CLOSED_MESSAGE = "This device's offline storage could not be opened just now, so Protected Identity and the Answer Bank cannot be changed: a change would not be saved anywhere. Reload the app to open it again.";

/** The message for a device-only change refused for `reason` (deviceOnlySaveBlocked). */
export function deviceOnlyBlockedMessage(reason) {
  if (reason === "unread") return DEVICE_ONLY_UNREAD_MESSAGE;
  if (reason === "unavailable") return DEVICE_ONLY_CLOSED_MESSAGE;
  return DEVICE_ONLY_UNSAVED_MESSAGE;
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
