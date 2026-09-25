// Record favorites.
//
// A star is the boolean column `favorite` on the record's own row, not a
// pointer in a separate collection. That choice is deliberate: a new TABLE_MAP
// key is load-bearing since assertCompleteAccountRecords throws when any
// COLLECTION_KEYS entry is missing, which fails the whole account load. A
// column touches no registry, and a star is created, edited and destroyed with
// the record it belongs to, so there are no orphans to sweep.
//
// This module is pure and imports nothing. It must stay importable by a plain
// node test with no React, because the one thing this project has proven about
// selection logic living inside App.jsx is that a test will reimplement it and
// the copy will drift (see scripts/cred-stats.test.mjs).

// Sections whose body is replaced by <ProGate> for a non-Pro account. The App
// used to declare this and never read it; the cross-section Favorites list is
// the first place that actually needs it, because those records sit in every
// user's store regardless of plan and only the per-section render gates them.
export const PRO_GATED = new Set([
  "privileges", "insurance", "caseLogs", "peerReferences", "malpracticeHistory",
]);

// Credentials sections that can be starred.
//
// Deliberately excluded:
//   answerBank, identityVault  device-only sections with no cloud table; a
//                              star is a cloud column write
//   matrix, findCme            tools, not collections, they hold no records
//   every Practice collection  the request was Credentials, and leaving them
//                              out keeps scopeForCollection's fall through
//                              correct for the star write
export const STARRABLE_SECTIONS = [
  "licenses", "privileges", "insurance",
  "cme", "education", "workHistory", "caseLogs",
  "healthRecords", "travelDocs", "screenings", "professionalPhotos",
  "publications", "memberships", "peerReferences", "malpracticeHistory",
  // Records in the physician's own categories. custom_records declares its
  // own favorite column (migration 20260925010000).
  "customRecords",
];

export function isStarrable(sectionKey) {
  return STARRABLE_SECTIONS.includes(sectionKey);
}

// A record is starred only on an explicit boolean true. The column is nullable
// and a legacy or wrongly typed value must not read as starred, so this is a
// strict check rather than a truthiness check: the string "false" is truthy.
export function isFavorite(record) {
  return record?.favorite === true;
}

// Every starred record across the starrable sections, newest activity first.
// Pro gated sections are omitted entirely for a non-Pro account: not shown
// locked, not counted, no upgrade row. Membership labels belong on Profile.
export function selectFavorites(data, { isPro } = {}) {
  const out = [];
  for (const section of STARRABLE_SECTIONS) {
    if (!isPro && PRO_GATED.has(section)) continue;
    const rows = data?.[section];
    if (!Array.isArray(rows)) continue;
    for (const record of rows) if (isFavorite(record)) out.push({ section, record });
  }
  return out.sort((a, b) => {
    const at = Date.parse(a.record?.updatedAt || "") || 0;
    const bt = Date.parse(b.record?.updatedAt || "") || 0;
    return bt - at;
  });
}

export function countFavorites(data, options) {
  return selectFavorites(data, options).length;
}
