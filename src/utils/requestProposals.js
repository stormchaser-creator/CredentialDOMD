import { buildProposal, catalogueFromRows } from "./requestPacket.js";
import { docMime, INBOX_DOC_TYPE, REQUEST_INBOX_DOC_TYPE } from "./inboxDocs.js";

// Proposals the server did not make, or made against a file that has since
// changed, rebuilt on the client.
//
// A document_requests row arrives without a proposal when the inbound
// function predates the matcher or the matcher threw. A proposal also goes
// stale the moment a newer document is uploaded (the COI that was "not on
// file" now is) or a proposed document is deleted (the expired DEA it would
// have attached). Both the Home banner and More > Requests read these rows,
// and for a while each rebuilt them with its own copy of this logic; the
// banner's button then said "Approve and send 1 document" while the inbox
// for the same row said "Nothing on file". One implementation, pure so
// scripts/request-packet-ui.test.mjs can run it under plain node, and the
// hook in hooks/useRequestProposals.js is the only place it meets React.
//
// Rebuilt proposals carry method "rules-client" so the two paths can be told
// apart in the data. Nothing here reads a clock unless the caller leaves
// `now` out, so the tests pin a date.

// Neither kind of emailed-in document is the physician's answer to a
// request, so neither reaches the matcher: the CV rule matches any unlinked
// file by name, and the requester's own "Provider_CV_Request_Form.pdf" was
// once proposed back to them as the CV. Same exclusion as email-inbound's
// loadCatalogue.
const INBOX_DOC_TYPES = new Set([REQUEST_INBOX_DOC_TYPE, INBOX_DOC_TYPE]);

// The matcher reads mime_type | mime and linked_to | linkedTo. App-state rows
// are camelCased (mimeType) or, for a file added on this device, carry the
// mime in `type`, so the field is named here once for both.
export const docForMatcher = (d) => ({
  id: d.id,
  name: d.name,
  mime: d.mimeType || docMime(d) || null,
  linkedTo: d.linkedTo || null,
  uploadedAt: d.uploadedAt || d.createdAt || null,
});

const docTime = (d) => {
  const t = new Date(d?.uploadedAt || d?.createdAt || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** The newest upload time in the file, as epoch ms; 0 when there is none. */
export function newestDocTime(documents) {
  return (documents || []).reduce((m, d) => Math.max(m, docTime(d)), 0);
}

/**
 * One string per document set. A proposal persisted under this key is not
 * written again until a document is added or deleted: the newest upload
 * time catches an addition, the count catches a deletion of anything but
 * the newest.
 */
export function documentSetKey(documents) {
  return `${newestDocTime(documents)}|${(documents || []).length}`;
}

// Only an open request is rebuilt: a replied row's proposal is the record
// of what was sent and must not move under it. The Home banner's rows come
// from a query that already filters on status and may not carry the column,
// so an absent status counts as open.
const isOpen = (r) => !!r && (r.status === undefined || r.status === null || r.status === "new");

/**
 * The open rows whose proposal is absent, older than the newest document
 * upload, or names a document id no longer on file. A proposal_at that does
 * not parse counts as older than everything: a row that cannot say when it
 * was built cannot claim to be current.
 *
 * The gone-id rule needs a document list to judge against. With none on
 * this device, a proposal that names documents is evidence that the
 * device's view is incomplete, not that the files are gone: a fresh laptop
 * whose cloud load failed once rebuilt a correct five-document proposal as
 * "nothing on file", wrote it back with a fresh proposal_at, and every other
 * device then showed the credentialer's request as unanswerable.
 */
export function staleRequests(rows, documents) {
  const list = Array.isArray(rows) ? rows : [];
  const newestAt = newestDocTime(documents);
  const onFile = new Set((documents || []).map((d) => String(d?.id)));
  return list.filter((r) => {
    if (!isOpen(r)) return false;
    const p = r.proposal;
    if (!p || typeof p !== "object") return true;
    if (newestAt) {
      const at = new Date(r.proposal_at || 0).getTime();
      if (Number.isNaN(at) || at < newestAt) return true;
    }
    if (!documents || !documents.length) return false;
    const ids = Array.isArray(p.docIds) ? p.docIds : [];
    return ids.some((id) => !onFile.has(String(id)));
  });
}

/**
 * { [rowId]: proposal } for every stale row in `rows`, matched against
 * data.documents with the same rules the server runs and marked
 * "rules-client". `data` is the app state: documents plus the record
 * sections (licenses, healthRecords, ...) that give a document its meaning,
 * and settings.name / settings.degreeType for the sign-off. A row whose
 * proposal cannot be built is left out and warned about, not thrown: one
 * unreadable email must not blank the board for the others.
 */
export function buildClientProposals(rows, data, { now } = {}) {
  const out = {};
  const d = data || {};
  const stale = staleRequests(rows, d.documents);
  if (!stale.length) return out;
  let catalogue;
  try {
    catalogue = catalogueFromRows((d.documents || []).filter((x) => x && !INBOX_DOC_TYPES.has(x.type)).map(docForMatcher), d);
  } catch (e) {
    console.warn("request packet: catalogue failed", e?.message || e);
    return out;
  }
  const physician = { name: d.settings?.name || "", degree: d.settings?.degreeType || "" };
  for (const r of stale) {
    try {
      const proposal = buildProposal(
        { subject: r.subject || "", body: r.body_text || "", fromName: r.from_name || "", fromAddr: r.from_addr || "" },
        catalogue, physician, now,
      );
      out[r.id] = { ...proposal, method: "rules-client" };
    } catch (e) {
      console.warn(`request packet: proposal failed for ${r.id}`, e?.message || e);
    }
  }
  return out;
}

/**
 * `rows` with each built proposal in place of the row's own. Rows that were
 * not rebuilt are returned as the same objects, and when nothing was built
 * the same array, so a memo keyed on the result does not churn.
 */
export function withProposals(rows, built) {
  const list = Array.isArray(rows) ? rows : [];
  if (!built || typeof built !== "object" || Object.keys(built).length === 0) return list;
  return list.map((r) => (r && built[r.id] ? { ...r, proposal: built[r.id] } : r));
}
