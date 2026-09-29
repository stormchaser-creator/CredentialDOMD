// Small HTTP helpers for the mock server (no framework).

export const MAX_BODY_BYTES = 30 * 1024 * 1024;

export async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

export function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isText ? (headers['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export const json = (res, status, body, headers) => send(res, status, body, headers);

export function html(res, status, body, headers = {}) {
  send(res, status, body, {
    'Content-Type': 'text/html; charset=utf-8',
    // The lab's own pages: inline styles and scripts only, nothing remote.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'",
    ...headers,
  });
}

/** Escapes text for HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class HttpError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

/**
 * A tiny router: add(method, pattern, handler) where pattern is a path with
 * :params. Handlers get (req, res, { params, url }).
 */
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const names = [];
      const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === ':' ? c : '\\' + c)).replace(/:([A-Za-z_]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
      routes.push({ method, re, names, handler });
    },
    match(method, pathname) {
      let allowed = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) { allowed = true; continue; }
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        return { handler: r.handler, params };
      }
      return allowed ? { methodNotAllowed: true } : null;
    },
  };
}
