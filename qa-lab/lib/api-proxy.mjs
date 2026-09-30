// The lab's API origin: what the QA-lab app calls as its Supabase URL.
//
// Why a separate origin: the live app (https://credentialdomd.com/app/) calls
// its Supabase project (https://<ref>.supabase.co) cross-origin, so the browser
// sends a preflight before every function call and hides any response whose
// CORS headers do not allow the app. If the lab app reached the stack through
// its own origin, the browser would never check any of that, and a function
// that answers an error without its CORS headers, or that does not allow a
// header the app sends, would pass every journey and fail live.
//
// So the app (http://127.0.0.1:<app port>) calls this proxy on another port
// (http://127.0.0.1:<api port>), which forwards everything to the local
// gateway (Kong, http://127.0.0.1:54321) and changes exactly two things:
//
//   * the request's Origin (and Referer), when it is the lab app's, is
//     presented as production's origin (https://credentialdomd.com), which
//     every function pins, as the live app's requests are;
//   * a response's Access-Control-Allow-Origin that names production's origin
//     is renamed to the lab app's origin, so the browser applies the function's
//     own decision to the lab app. "*" and every other value pass unchanged
//     (a function that refuses the origin is refused in the lab too), and the
//     Allow-Headers / Allow-Methods / Expose-Headers lists are never touched.
//
// Kong's own cors plugin is removed from /functions/v1/ in the lab stack
// (qa-lab/lib/stack.mjs), so preflights reach the functions and their headers
// reach this proxy, as on hosted Supabase. REST, Auth and Storage keep Kong's
// permissive CORS, as hosted Supabase does.
//
//   node qa-lab/lib/api-proxy.mjs --port 54385 --app-origin http://127.0.0.1:54390
import http from 'node:http';
import { parseArgs } from 'node:util';
import { APP_PUBLIC_ORIGIN, DEFAULT_API_PORT, SUPABASE_API_URL } from './lab-config.mjs';
import { isMain } from './paths.mjs';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

/** The headers sent on to the gateway (lowercase names, as node gives them). */
export function forwardRequestHeaders(headers, { appOrigin, target = SUPABASE_API_URL }) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  out.host = new URL(target).host;
  if (out.origin === appOrigin) out.origin = APP_PUBLIC_ORIGIN;
  if (typeof out.referer === 'string' && (out.referer === appOrigin || out.referer.startsWith(`${appOrigin}/`))) out.referer = APP_PUBLIC_ORIGIN + out.referer.slice(appOrigin.length);
  return out;
}

/** The headers returned to the browser: production's origin in Access-Control-Allow-Origin becomes the lab app's. */
export function returnResponseHeaders(headers, { appOrigin }) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (HOP_BY_HOP.has(name) && name !== 'transfer-encoding') continue;
    out[name] = v;
  }
  delete out['transfer-encoding'];
  if (out['access-control-allow-origin'] === APP_PUBLIC_ORIGIN) out['access-control-allow-origin'] = appOrigin;
  return out;
}

export function createApiProxy({ port = DEFAULT_API_PORT, appOrigin, target = SUPABASE_API_URL, log = (m) => console.log(`[api] ${m}`) } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(appOrigin || '')) throw new Error('the API proxy needs the lab app origin (http://127.0.0.1:<port>)');
  const upstream = new URL(target);
  if (!['127.0.0.1', 'localhost'].includes(upstream.hostname)) throw new Error(`refusing a gateway that is not this machine: ${upstream.hostname}`);
  const server = http.createServer((req, res) => {
    const out = http.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url,
      headers: forwardRequestHeaders(req.headers, { appOrigin, target }),
    }, (up) => {
      res.writeHead(up.statusCode || 502, returnResponseHeaders(up.headers, { appOrigin }));
      up.pipe(res);
    });
    out.on('error', (e) => {
      log(`${req.method} ${req.url.split('?')[0]}: ${e.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`qa-lab api proxy: ${e.message}`); } else res.destroy();
    });
    req.pipe(out);
  });
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); }) };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, 'app-origin': { type: 'string' } } });
  const port = Number(values.port || DEFAULT_API_PORT);
  const proxy = createApiProxy({ port, appOrigin: values['app-origin'] });
  proxy.listen().then(() => console.log(`[api] listening on http://127.0.0.1:${port} -> ${SUPABASE_API_URL} (browser origin ${values['app-origin']} presented as ${APP_PUBLIC_ORIGIN})`), (e) => { console.error(`[api] ${e.message}`); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { proxy.server.close(); process.exit(0); });
}
