import { VERA_SOURCE_VERSION, VERA_SOURCE_ORIGIN, VERA_FETCH_LIMITS, veraSource } from './veraSourceRegistry.mjs';

export async function readBoundedBody(response, limit, timeoutMs = 6500) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('body_limit'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { reject(Error('body_timeout')); void reader.cancel().catch(() => {}); }, timeoutMs); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw Error('body_limit'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return bytes;
}

const decodeText = text => text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|lsquo|rsquo|ldquo|rdquo|#\d{1,7}|#x[\da-f]{1,6});/gi, entity => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&lsquo;': '‘', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”' };
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
  const n = parseInt(entity.slice(entity[2].toLowerCase() === 'x' ? 3 : 2, -1), entity[2].toLowerCase() === 'x' ? 16 : 10);
  return n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
});

/** Text extraction only. Output is untrusted JSON text, never rendered as HTML. */
export function inertPageText(html) {
  const cleaned = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const tokens = cleaned.match(/<[^>]*>|[^<]+|</g) || [];
  let hidden = null; const parts = [];
  for (const token of tokens) {
    if (token.startsWith('<')) {
      const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
      if (!tag) continue;
      const name = tag[2].toLowerCase();
      if (hidden) { if (tag[1] && name === hidden) hidden = null; continue; }
      if (!tag[1] && ['head', 'script', 'style', 'noscript', 'svg', 'iframe', 'template'].includes(name)) { hidden = name; continue; }
      if (/^(?:p|div|h[1-6]|li|br|tr|section|article|main)$/.test(name)) parts.push('\n');
    } else if (!hidden) parts.push(decodeText(token));
  }
  return parts.join('').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function excerpts(text, source) {
  const marker = text.toLowerCase().indexOf(source.marker.toLowerCase());
  if (marker < 0) throw Error('source_identity_changed');
  const body = text.slice(marker);
  // Keep exact contiguous source spans. The pain clinic scope and obligations
  // need separate spans; dropping its definition would misstate applicability.
  const needles = source.topic === 'pain_clinic'
    ? ['"Pain management clinic" means', 'Each physician owner of a pain management clinic shall complete', 'Each physician who provides care']
    : source.topic === 'mate_training' ? ['Who is responsible', 'What is the deadline', 'How can practitioners'] : [source.marker];
  const max = VERA_FETCH_LIMITS.excerptChars;
  const spans = [];
  for (const needle of needles) {
    const position = body.toLowerCase().indexOf(needle.toLowerCase());
    if (position >= 0) spans.push({ start: marker + position, text: body.slice(position, position + Math.floor(max / needles.length)) });
  }
  if (!spans.length) spans.push({ start: marker, text: body.slice(0, max) });
  return spans.map((s, i) => ({ id: `excerpt-${i + 1}`, ...s, end: s.start + s.text.length }));
}

export function createPublicSourceFetcher({ fetch: fetcher = fetch, now = Date.now, crypto = globalThis.crypto } = {}) {
  const cache = new Map(), pending = new Map();
  return async function read(sourceId) {
    const source = veraSource(sourceId);
    if (!source) throw Error('unknown_source');
    const cached = cache.get(sourceId);
    if (cached && cached.expires > now()) return { ...cached.result, delivery: 'cache' };
    if (pending.has(sourceId)) return pending.get(sourceId);
    const task = (async () => {
      const base = { schemaVersion: 1, registryVersion: VERA_SOURCE_VERSION, sourceId, title: source.title, jurisdiction: source.jurisdiction, degrees: source.degrees, url: source.url,
        verification: 'page_fetch_not_legal_determination' };
      let result;
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), VERA_FETCH_LIMITS.timeoutMs);
      try {
        const request = fetcher(source.url, { method: 'GET', headers: { Accept: 'text/html, text/plain;q=0.8' }, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        const response = await Promise.race([request, new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('timeout')), { once: true }))]);
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw Error('redirect_not_approved'); }
        if (!response.ok || (response.url && response.url !== source.url)) { await response.body?.cancel(); throw Error('source_unavailable'); }
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!['text/html', 'text/plain'].includes(mime)) { await response.body?.cancel(); throw Error('unsupported_content'); }
        controller.signal.throwIfAborted();
        const bytes = await Promise.race([readBoundedBody(response, VERA_FETCH_LIMITS.bytes), new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('timeout')), { once: true }))]);
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const text = mime === 'text/html' ? inertPageText(decoded) : decoded;
        const selected = excerpts(text, source);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        result = { ...base, status: 'available', fetchedAt: new Date(now()).toISOString(), contentSha256: hash, excerpts: selected,
          completeness: 'selected_excerpts_only', effectiveDate: null, delivery: 'network' };
      } catch {
        result = { ...base, status: 'unavailable', fetchedAt: null, excerpts: [], reason: 'source_could_not_be_retrieved', delivery: 'network' };
      } finally { clearTimeout(timer); }
      cache.set(sourceId, { result, expires: now() + (result.status === 'available' ? VERA_FETCH_LIMITS.cacheMs : VERA_FETCH_LIMITS.failureCacheMs) });
      return result;
    })();
    pending.set(sourceId, task);
    try { return await task; } finally { pending.delete(sourceId); }
  };
}

export function createVeraSourceHandler(deps) {
  return async req => {
    const origin = req.headers.get('origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Vary: 'Origin',
      ...(origin === VERA_SOURCE_ORIGIN ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } : {}) };
    const answer = (status, body) => new Response(JSON.stringify(body), { status, headers });
    if (origin && origin !== VERA_SOURCE_ORIGIN) return answer(403, { error: 'origin' });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return answer(405, { error: 'method' });
    try {
      if (!deps.enabled()) return answer(503, { error: 'unavailable' });
      const owner = await deps.authenticate(req);
      if (!owner) return answer(401, { error: 'unauthorized' });
      if (!(req.headers.get('content-type') || '').startsWith('application/json')) return answer(400, { error: 'invalid_request' });
      let body;
      try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(req, 256, 2000))); } catch { return answer(400, { error: 'invalid_request' }); }
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !veraSource(body.sourceId)) return answer(400, { error: 'invalid_request' });
      const admission = await deps.admit(owner, body.sourceId);
      if (admission !== 'allowed') return answer(admission === 'quota' ? 429 : 403, { error: 'source_access_unavailable' });
      return answer(200, await deps.read(body.sourceId));
    } catch { return answer(503, { error: 'unavailable' }); }
  };
}
