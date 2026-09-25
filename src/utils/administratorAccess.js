// Pure helpers for the Administrator access screen (no React, no network).

export const formatDay = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "";
};

export const formatMoment = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};

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
