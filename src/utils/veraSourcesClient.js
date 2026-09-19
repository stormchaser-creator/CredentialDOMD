import { VERA_SOURCE_VERSION, VERA_SOURCES, veraSource } from '../../supabase/functions/_shared/veraSourceRegistry.mjs';
import { mentionedJurisdictions } from './assistantEvidence.js';

const ENV = import.meta.env || {};
export const VERA_SOURCE_RETRIEVAL_ENABLED = ENV.VITE_VERA_SOURCE_RETRIEVAL_ENABLED === 'true';
const MAX_CONTEXT_BYTES = 12000;
const REQUEST_TIMEOUT_MS = 9000;

async function withinSourceDeadline(request) {
  const controller = new AbortController();
  const expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
  const checkDeadline = () => {
    // Parsing is synchronous: also check the clock in case the timeout task
    // cannot run until after decoding/JSON parsing has finished.
    if (Date.now() >= expiresAt) controller.abort();
    controller.signal.throwIfAborted();
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error('source_timeout')); }, REQUEST_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([request({ signal: controller.signal, checkDeadline }), timeout]);
    checkDeadline();
    return result;
  } finally { clearTimeout(timer); }
}

export function sourceIdsForQuestion(history = [], snapshot = {}) {
  const text = String(history.filter(m => m.role === 'user').at(-1)?.text || '').slice(0, 12000);
  if (!/\b(?:CME|renew(?:al|ing)?|credits?|training|MATE|DEA|compliance|compliant|requirements?|pain.clinic)\b/i.test(text)) return [];
  const mentioned = mentionedJurisdictions([{ role: 'user', text }]);
  const states = mentioned.length ? mentioned : snapshot.physician?.states || [];
  const ids = [];
  if (states.includes('OH')) ids.push('oh-cme-general', 'oh-pain-clinic');
  if (/\b(?:MATE|DEA)\b/i.test(text)) ids.push('dea-mate');
  return ids;
}

export function validateSourceResponse(value, sourceId, now = Date.now()) {
  const source = veraSource(sourceId);
  if (!source || value?.schemaVersion !== 1 || value.registryVersion !== VERA_SOURCE_VERSION || value.sourceId !== sourceId
    || value.url !== source.url || value.verification !== 'page_fetch_not_legal_determination') return null;
  if (value.status === 'unavailable') return { sourceId, title: source.title, url: source.url, status: 'unavailable', fetchedAt: null, excerpts: [] };
  const stamp = Date.parse(value.fetchedAt);
  if (value.status !== 'available' || !Number.isFinite(stamp) || stamp > now + 60000 || now - stamp > 3700000
    || !/^[a-f0-9]{64}$/.test(value.contentSha256) || !Array.isArray(value.excerpts) || !value.excerpts.length || value.excerpts.length > 3) return null;
  let chars = 0;
  const excerpts = [];
  for (const [i, e] of value.excerpts.entries()) {
    if (e?.id !== `excerpt-${i + 1}` || typeof e.text !== 'string' || !e.text.trim() || !Number.isSafeInteger(e.start) || e.start < 0 || e.end !== e.start + e.text.length) return null;
    chars += e.text.length; if (chars > 2400) return null;
    excerpts.push({ id: e.id, text: e.text, start: e.start, end: e.end });
  }
  return { sourceId, title: source.title, url: source.url, status: 'available', fetchedAt: value.fetchedAt, contentSha256: value.contentSha256,
    delivery: value.delivery === 'cache' ? 'cache' : 'network', jurisdiction: source.jurisdiction, degrees: source.degrees,
    verification: value.verification, completeness: 'selected_excerpts_only', excerpts };
}

/** Each transport body contains one public enum ID and nothing from the chat. */
export async function loadVeraSources(history, snapshot, options = {}) {
  const sourceIds = sourceIdsForQuestion(history, snapshot);
  const enabled = options.enabled ?? VERA_SOURCE_RETRIEVAL_ENABLED;
  if (!sourceIds.length || !enabled) return { mode: 'saved_references', sources: [], attempted: false };
  const request = options.request || (async (sourceId, { signal, checkDeadline }) => {
    const session = globalThis.window?.Clerk?.session;
    const sessionId = session?.id;
    const token = await session?.getToken();
    // Clerk's token promise cannot be cancelled. If it resolves after our
    // deadline, stop here instead of making an abandoned, quota-consuming fetch.
    checkDeadline();
    if (!token || !ENV.VITE_SUPABASE_URL || globalThis.window?.Clerk?.session?.id !== sessionId) throw Error('source_unavailable');
    const response = await fetch(`${ENV.VITE_SUPABASE_URL}/functions/v1/vera-sources`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId }),
      cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    });
    const reader = response.body?.getReader();
    const cancelBody = () => { void reader?.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancelBody, { once: true });
    const chunks = []; let bytes = 0, bodyFinished = false;
    try {
      checkDeadline();
      if (!response.ok || globalThis.window?.Clerk?.session?.id !== sessionId || !reader
        || Number(response.headers.get('content-length')) > 16000) throw Error('source_unavailable');
      while (true) {
        const { done, value } = await reader.read();
        checkDeadline();
        if (done) { bodyFinished = true; break; }
        bytes += value.byteLength; if (bytes > 16000) throw Error('source_unavailable');
        chunks.push(value);
      }
      const buffer = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      checkDeadline();
      if (globalThis.window?.Clerk?.session?.id !== sessionId) throw Error('source_unavailable');
      const parsed = JSON.parse(text);
      checkDeadline();
      return parsed;
    } finally {
      signal.removeEventListener('abort', cancelBody);
      if (!bodyFinished) cancelBody();
      reader?.releaseLock();
    }
  });
  const sources = await Promise.all(sourceIds.map(async sourceId => {
    try {
      const value = await withinSourceDeadline(deadline => request(sourceId, deadline));
      return validateSourceResponse(value, sourceId, options.now?.() ?? Date.now()) || unavailable(sourceId);
    }
    catch { return unavailable(sourceId); }
  }));
  const context = { mode: sources.some(s => s.status === 'available') ? 'official_page_excerpts' : 'saved_references', attempted: true, sources };
  // Bound the additional model input independently of the private snapshot.
  if (new TextEncoder().encode(JSON.stringify(context)).length > MAX_CONTEXT_BYTES) return { mode: 'saved_references', attempted: true, sources: sourceIds.map(unavailable) };
  return context;
}
function unavailable(sourceId) { const s = VERA_SOURCES[sourceId]; return { sourceId, title: s.title, url: s.url, status: 'unavailable', fetchedAt: null, excerpts: [] }; }

export function validatedSourceCitations(citations, context, reply) {
  if (!Array.isArray(citations) || typeof reply !== 'string') return [];
  return citations.slice(0, 6).flatMap(c => {
    const source = context.sources.find(s => s.status === 'available' && s.sourceId === c?.sourceId);
    const excerpt = source?.excerpts.find(e => e.id === c.excerptId);
    if (!excerpt || typeof c.quote !== 'string' || c.quote.trim().length < 12 || c.quote.length > 300 || !excerpt.text.includes(c.quote)
      || typeof c.claim !== 'string' || !c.claim.trim() || c.claim.length > 400 || !reply.includes(c.claim)) return [];
    return [{ sourceId: source.sourceId, excerptId: excerpt.id, quote: c.quote, claim: c.claim }];
  });
}

export function sourceCheckReceipt(context, citations = [], reply = '') {
  return { mode: context.mode, attempted: context.attempted, sources: context.sources.map(({ sourceId, title, url, status, fetchedAt, delivery }) => ({ sourceId, title, url, status, fetchedAt, delivery })),
    citations: validatedSourceCitations(citations, context, reply) };
}
