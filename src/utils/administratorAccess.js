// Pure helpers for the Administrator access screen (no React, no network).

export const formatDay = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "";
};

export const formatMoment = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};

/** The browser's IANA zone, for the invitation's end date and time. */
export const localTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
};

/**
 * A grant's file activity. The server counts it over every audit row
 * (documentActivity); the recent-events list it also sends is capped, so it is
 * only a fallback for an older response.
 */
export function grantFileActivity(grant) {
  if (!Array.isArray(grant?.documentActivity)) return documentActivity(grant?.audit || []);
  return grant.documentActivity.map(row => ({
    name: row.documentName || "A file you have since deleted",
    views: Number(row.views) || 0, downloads: Number(row.downloads) || 0, refused: Number(row.refused) || 0, last: row.last || null,
  })).sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

/** Visits to a grant: the server's full count, or the recent list as a fallback. */
export const grantVisitCount = grant => Number.isInteger(grant?.visitCount) ? grant.visitCount
  : (grant?.audit || []).filter(e => e.event === "session_verified").length;

/** Per-document activity, grouped by the owner's own document names. */
export function documentActivity(audit = []) {
  const byDocument = new Map();
  for (const event of audit) {
    if (!event.documentId || !["document_response_prepared", "download_refused"].includes(event.event)) continue;
    const entry = byDocument.get(event.documentId) || { name: event.documentName || "A file you have since deleted", views: 0, downloads: 0, refused: 0, last: null };
    if (event.event === "download_refused") entry.refused++;
    else if (event.intent === "download") entry.downloads++;
    else entry.views++;
    if (!entry.last || Date.parse(event.createdAt) > Date.parse(entry.last)) entry.last = event.createdAt;
    byDocument.set(event.documentId, entry);
  }
  return [...byDocument.values()].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}
