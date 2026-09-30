import { edgeErrorMessage } from "./edgeError.js";

// Baseline support text only, retained in this tab for at most 24 hours.
// No attachments, context payload, auth tokens, or queued send operations.
// A draft that was sent without a confirmed receipt also keeps the request
// key it went with and a one-way digest of what was sent (QA SUPPORT-001,
// review 2026-09-30), so the same text sent again after a reload is a retry
// the server answers with the row already saved, not a second ticket.
export const SUPPORT_DRAFT_BASE = "credentialdomd-support-drafts-v1";
export const SUPPORT_DRAFT_TTL = 24 * 60 * 60 * 1000;
const categories = new Set(["bug", "billing", "feature_request", "data_issue", "compliance", "feedback", "other"]);
const priorities = new Set(["low", "normal", "high", "urgent"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{28}$/;
const browserStorage = () => globalThis.window?.sessionStorage;

// cyrb53: a fast 53-bit string hash. Not a secret, only an equality check.
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The digest a draft keeps of what was sent: the text, and a fingerprint of
 * the files, which the draft itself never stores. 28 hex characters from two
 * seeds, so two different compositions matching is not a practical concern.
 */
export function supportRequestHash(text) {
  return [0, 1].map((seed) => cyrb53(String(text), seed).toString(16).padStart(14, "0")).join("");
}

const cleanRequest = (value) => (value && typeof value === "object" && uuid.test(value.id) && digest.test(value.hash)
  ? { id: value.id, hash: value.hash } : null);

export function clearSupportTextDrafts(accountId, storage = browserStorage) {
  if (!accountId) return;
  try { storage()?.removeItem(`${SUPPORT_DRAFT_BASE}:${accountId}`); } catch { /* unavailable */ }
}

export function supportReceiptConfirmed(data) {
  return data?.ok === true && typeof data.id === "string" && uuid.test(data.id);
}

export async function supportSubmissionError(error) {
  const uncertain = "We could not confirm receipt. Check Your tickets before retrying.";
  if (error?.context?.status === 401) return `We could not verify this support request. You may need to sign in again. ${uncertain}`;
  if (error?.context?.status === 504) return uncertain;
  const detail = await edgeErrorMessage(error, "");
  return detail ? `${detail} ${uncertain}` : uncertain;
}

export function createSupportTextDrafts({
  accountId, storage = browserStorage, now = Date.now,
  isCurrent = () => globalThis.window?.Clerk?.user?.id === accountId,
  revision = () => globalThis.crypto.randomUUID(),
} = {}) {
  const key = accountId ? `${SUPPORT_DRAFT_BASE}:${accountId}` : null;
  const allowed = () => Boolean(key && isCurrent());
  const clean = (value, isCreate) => {
    if (!value || typeof value.body !== "string" || value.body.length > 10000) return null;
    if (isCreate && (typeof value.subject !== "string" || value.subject.length > 200)) return null;
    const request = cleanRequest(value.request);
    return {
      ...(isCreate ? {
        subject: value.subject, body: value.body,
        category: categories.has(value.category) ? value.category : "other",
        priority: priorities.has(value.priority) ? value.priority : "normal",
      } : { body: value.body }),
      ...(request ? { request } : {}),
    };
  };
  const load = () => {
    const empty = { version: 1, drafts: {} };
    if (!allowed()) return empty;
    try {
      const raw = storage()?.getItem(key);
      if (!raw || raw.length > 4000000) return empty;
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.drafts || typeof parsed.drafts !== "object") return empty;
      for (const [slot, value] of Object.entries(parsed.drafts).slice(0, 51)) {
        if (slot !== "create" && !uuid.test(slot)) continue;
        const fields = clean(value, slot === "create");
        if (!fields || !uuid.test(value.revision) || !Number.isFinite(value.updatedAt)
          || value.updatedAt > now() || now() - value.updatedAt >= SUPPORT_DRAFT_TTL) continue;
        empty.drafts[slot] = { ...fields, revision: value.revision, updatedAt: value.updatedAt };
      }
      // Expired entries are removed when next accessed, without a background
      // timer that could write after an explicit purge.
      const sanitized = JSON.stringify(empty);
      if (sanitized !== raw) {
        if (Object.keys(empty.drafts).length) storage()?.setItem(key, sanitized);
        else storage()?.removeItem(key);
      }
    } catch { /* malformed or unavailable storage is never a draft */ }
    return empty;
  };
  const write = (envelope) => {
    if (!allowed()) return false;
    try {
      const target = storage();
      if (!target) return false;
      if (Object.keys(envelope.drafts).length) target.setItem(key, JSON.stringify(envelope));
      else target.removeItem(key);
      return true;
    } catch { return false; }
  };
  const validSlot = slot => slot === "create" || uuid.test(slot);
  return {
    read(slot = "create") { return validSlot(slot) ? load().drafts[slot] || null : null; },
    save(value, slot = "create") {
      if (!allowed() || !validSlot(slot)) return { saved: false, draft: null };
      const fields = clean(value, slot === "create");
      if (!fields) return { saved: false, draft: null };
      const envelope = load();
      let draft = null;
      if (fields.body || fields.subject) {
        // An edit keeps the key of the last send; the digest decides at the
        // next send whether it is still the same request.
        const request = fields.request || (value.request === undefined ? envelope.drafts[slot]?.request : null);
        draft = { ...fields, revision: revision(), updatedAt: now() };
        if (request) draft.request = request; else delete draft.request;
        envelope.drafts[slot] = draft;
        // Keep the current edit plus the most recent other drafts, bounded.
        const others = Object.keys(envelope.drafts).filter(k => k !== slot)
          .sort((a, b) => envelope.drafts[b].updatedAt - envelope.drafts[a].updatedAt);
        for (const old of others.slice(50)) delete envelope.drafts[old];
      } else delete envelope.drafts[slot];
      return { saved: write(envelope), draft };
    },
    clear(slot = "create", expectedRevision) {
      if (!allowed() || !validSlot(slot)) return false;
      const envelope = load();
      if (expectedRevision !== undefined && envelope.drafts[slot]?.revision !== expectedRevision) return false;
      delete envelope.drafts[slot];
      return write(envelope);
    },
  };
}
