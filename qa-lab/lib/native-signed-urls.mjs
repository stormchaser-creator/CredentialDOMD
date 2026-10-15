// Local-lab routing only. The edge SDK signs with Docker's internal origin;
// a native browser cannot resolve it. Preserve the signed path/query verbatim.
export const SIGNED_URL_ENDPOINTS = new Set([
  '/functions/v1/backup-link', '/functions/v1/ticket-attachment-url',
]);
const INTERNAL_PREFIX = 'http://kong:8000/storage/v1/object/sign/';
export const MAX_SIGNED_URL_JSON_BYTES = 2 * 1024 * 1024;

export function mapNativeSignedUrls(bytes, endpoint, apiOrigin) {
  if (!SIGNED_URL_ENDPOINTS.has(endpoint)) return bytes;
  if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin)) throw Error('native signed URLs need a loopback API origin');
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { return bytes; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bytes;
  let changed = false;
  const map = (value) => {
    if (typeof value !== 'string' || !value.startsWith(INTERNAL_PREFIX)) return value;
    changed = true;
    return apiOrigin + value.slice('http://kong:8000'.length);
  };
  data.url = map(data.url);
  if (endpoint.endsWith('/ticket-attachment-url')) {
    if (Array.isArray(data.urls)) data.urls = data.urls.map(map);
    if (data.replies && typeof data.replies === 'object' && !Array.isArray(data.replies)) {
      for (const [id, urls] of Object.entries(data.replies)) {
        if (Array.isArray(urls)) data.replies[id] = urls.map(map);
      }
    }
  }
  return changed ? Buffer.from(JSON.stringify(data)) : bytes;
}

/** Buffer only these small JSON contracts. Everything else stays a stream;
 * oversized or malformed answers pass through without inventing a success. */
export function pipeNativeSignedResponse(up, res, { endpoint, apiOrigin, headers, method }) {
  const sendOriginal = () => { res.writeHead(up.statusCode || 502, headers); up.pipe(res); };
  if (method !== 'POST' || !SIGNED_URL_ENDPOINTS.has(endpoint) || up.statusCode !== 200
    || !/^application\/json\b/i.test(String(headers['content-type'] || ''))
    || (headers['content-encoding'] && headers['content-encoding'] !== 'identity')
    || Number(headers['content-length']) > MAX_SIGNED_URL_JSON_BYTES) return sendOriginal();
  let chunks = [], size = 0, streaming = false;
  up.on('data', chunk => {
    if (streaming) return;
    chunks.push(chunk); size += chunk.length;
    if (size > MAX_SIGNED_URL_JSON_BYTES) {
      streaming = true;
      res.writeHead(up.statusCode, headers);
      res.write(Buffer.concat(chunks)); chunks = [];
      up.pipe(res);
    }
  });
  up.on('end', () => {
    if (streaming || res.destroyed) return;
    const original = Buffer.concat(chunks);
    const mapped = mapNativeSignedUrls(original, endpoint, apiOrigin);
    if (mapped !== original) {
      for (const name of ['content-length', 'etag', 'content-md5', 'digest']) delete headers[name];
      headers['content-length'] = String(mapped.length);
    }
    res.writeHead(up.statusCode, headers); res.end(mapped);
  });
  up.on('aborted', () => res.destroy());
  up.on('error', () => res.destroy());
}
