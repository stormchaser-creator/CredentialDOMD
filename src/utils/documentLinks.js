// Which document links are dead, and which dropped links can be put back.
//
// A document is filed by `linkedTo = "<collection>:<recordId>"`. At load, a
// link to a record that no longer exists is cleared so the file shows up in
// Files instead of pointing at nothing.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. Only clear a link whose prefix THIS version recognises. The previous sweep
//    cleared any link it could not match, in the cloud, which means an older
//    app version left open on a second device would unfile every document
//    filed into a collection newer than itself. A newer version's link is not
//    this version's to judge.
//
// 2. Put back what an older version cleared. A custom record lists the
//    documents Vera or the uploader filed in it (documentIds, stored as
//    custom_records.document_ids). If such a document arrives with an empty
//    link, the record's own list says where it belongs. Only EMPTY links are
//    restored: a document the physician has since filed somewhere else is never
//    pulled back. Files attached through a category's own form are not listed,
//    so for those an old version's clear still sends the file to Files: moved,
//    never lost.
//
// 3. Always clear a link no version ever writes: no colon, an empty id, or the
//    documents collection. Those can only be mistakes, and leaving them would
//    strand the file where neither the Link picker nor File with AI can reach it.
//
// Pure, so it runs under a plain node test and adds exactly one name to the
// load path in AppContext.

import { DEVICE_ONLY_SECTIONS } from "./pausedApplicationRecords.js";

export function reconcileDocumentLinks(data, collectionKeys, pausedLinks = []) {
  const keys = Array.isArray(collectionKeys) ? collectionKeys : [];
  const known = new Set([...keys.filter(k => k !== "documents"), ...Object.keys(DEVICE_ONLY_SECTIONS)]);

  const live = new Set(pausedLinks);
  for (const key of keys) {
    if (key === "documents") continue;
    for (const x of data?.[key] || []) if (x?.id) live.add(`${key}:${x.id}`);
  }

  // Back-references, first claim wins, only from records that still exist.
  const claimedBy = new Map();
  if (keys.includes("customRecords")) {
    for (const r of data?.customRecords || []) {
      if (!r?.id) continue;
      const ids = Array.isArray(r.documentIds) ? r.documentIds : [];
      for (const docId of ids) {
        if (typeof docId === "string" && docId && !claimedBy.has(docId)) claimedBy.set(docId, `customRecords:${r.id}`);
      }
    }
  }

  const cleared = [];
  const relinked = [];
  const documents = (data?.documents || []).map(d => {
    if (!d || typeof d !== "object") return d;
    const link = typeof d.linkedTo === "string" ? d.linkedTo : "";
    if (link) {
      const colon = link.indexOf(":");
      const prefix = colon > 0 ? link.slice(0, colon) : "";
      const malformed = colon <= 0 || colon === link.length - 1 || prefix === "documents";
      if (malformed || (known.has(prefix) && !live.has(link))) {
        const next = { ...d, linkedTo: "" };
        cleared.push(next);
        return next;
      }
      return d; // live, or written by a newer version: leave it alone
    }
    const home = claimedBy.get(d.id);
    if (home && live.has(home)) {
      const next = { ...d, linkedTo: home };
      relinked.push(next);
      return next;
    }
    return d;
  });

  return { documents, cleared, relinked };
}
