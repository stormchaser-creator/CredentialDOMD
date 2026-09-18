// These editors reached production before their cloud schema and restore
// path existed. Preserve this account's own cache without enrolling either
// collection in sync. Remove this exception only with a reviewed migration.
export const PAUSED_APPLICATION_SECTIONS = Object.freeze({
  answerBank: "Answer Bank",
  identityVault: "Protected Identity",
});

export function preservePausedApplicationRecords(merged, accountCache, tombstones = new Set()) {
  const preserved = { ...merged };
  for (const section of Object.keys(PAUSED_APPLICATION_SECTIONS)) {
    preserved[section] = Array.isArray(accountCache?.[section])
      ? accountCache[section].filter(record => record && typeof record === "object" &&
        typeof record.id === "string" && record.id && !tombstones.has(record.id))
      : [];
  }
  return preserved;
}

export function pausedApplicationLinks(data) {
  return Object.keys(PAUSED_APPLICATION_SECTIONS).flatMap(section =>
    (data[section] || []).map(record => `${section}:${record.id}`));
}
