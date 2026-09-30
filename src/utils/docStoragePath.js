// A document uploaded this session learns where its file went.
//
// insertItem (src/lib/supabase.js) uploads the bytes, writes the row with
// storage_path, and answers with that path. Until the document on the device
// carries it too, every screen that asks "is this file in the account yet"
// (the email sheet's "still uploading to your account", the Send sheet's
// downloads) answers no until the next reload. Pure: plain node tests import it.

/**
 * `docs` with storagePath set on document `id`, or `docs` itself when there
 * is nothing to do: the document is gone (the patient-record screen removed
 * it, or the physician deleted it meanwhile) or already knows a path. No
 * updatedAt stamp: learning where the file is is not an edit, and a stamp
 * would make this device's copy win over a newer edit made elsewhere.
 */
export function withStoragePath(docs, id, path) {
  const list = Array.isArray(docs) ? docs : [];
  if (!id || !path) return docs;
  const i = list.findIndex((d) => d && d.id === id);
  if (i < 0 || list[i].storagePath) return docs;
  const next = list.slice();
  next[i] = { ...list[i], storagePath: path };
  return next;
}
