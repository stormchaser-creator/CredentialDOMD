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
//
// The iOS Simulator profile (qa-lab/sim.mjs) runs a second one over TLS for its
// HTTPS app origin, straight to the same gateway (the running proxy above
// renames only its own app origin, and is never restarted for it):
//
//   node qa-lab/lib/api-proxy.mjs --port 54396 --app-origin https://127.0.0.1:54395 --tls-cert <leaf.pem> --tls-key <leaf.key>
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { APP_PUBLIC_ORIGIN, DEFAULT_API_PORT, SUPABASE_API_URL } from './lab-config.mjs';
import { isMain } from './paths.mjs';
import { pipeNativeSignedResponse, SIGNED_URL_ENDPOINTS } from './native-signed-urls.mjs';

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

/** The lab app's origin on this machine: http (qa:lab) or https (the Simulator profile, qa:sim). */
export const LAB_APP_ORIGIN = /^https?:\/\/127\.0\.0\.1:\d+$/;

/**
 * `tls` ({ key, cert }, PEM) serves the proxy over HTTPS for an https app
 * origin (the Simulator profile); an https app origin needs it, since a page
 * served over TLS would not call a plain-HTTP API.
 */
export function createApiProxy({ port = DEFAULT_API_PORT, appOrigin, target = SUPABASE_API_URL, tls = null, log = (m) => console.log(`[api] ${m}`) } = {}) {
  if (!LAB_APP_ORIGIN.test(appOrigin || '')) throw new Error('the API proxy needs the lab app origin (http://127.0.0.1:<port>, or https:// for the Simulator profile)');
  if (appOrigin.startsWith('https:') !== Boolean(tls)) throw new Error(tls ? 'a TLS API proxy serves an https lab app origin only' : 'an https lab app origin needs the API proxy over TLS (--tls-cert, --tls-key)');
  const upstream = new URL(target);
  if (!['127.0.0.1', 'localhost'].includes(upstream.hostname)) throw new Error(`refusing a gateway that is not this machine: ${upstream.hostname}`);
  const handler = (req, res) => {
    const endpoint = req.url.split('?')[0];
    const headers = forwardRequestHeaders(req.headers, { appOrigin, target });
    // Safari offers gzip/br. These two tiny JSON contracts need origin mapping
    // before they reach the native browser; request plain bytes from the local
    // gateway. File downloads and all other routes keep their normal encoding.
    if (req.method === 'POST' && SIGNED_URL_ENDPOINTS.has(endpoint)) headers['accept-encoding'] = 'identity';
    const out = http.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url,
      headers,
    }, (up) => {
      pipeNativeSignedResponse(up, res, {
        endpoint, method: req.method,
        apiOrigin: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
        headers: returnResponseHeaders(up.headers, { appOrigin }),
      });
    });
    out.on('error', (e) => {
      log(`${req.method} ${req.url.split('?')[0]}: ${e.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`qa-lab api proxy: ${e.message}`); } else res.destroy();
    });
    req.pipe(out);
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); }) };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, 'app-origin': { type: 'string' }, 'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' } } });
  const port = Number(values.port || DEFAULT_API_PORT);
  const tls = values['tls-cert'] || values['tls-key'] ? { cert: readFileSync(values['tls-cert']), key: readFileSync(values['tls-key']) } : null;
  const proxy = createApiProxy({ port, appOrigin: values['app-origin'], tls });
  proxy.listen().then(() => console.log(`[api] listening on ${tls ? 'https' : 'http'}://127.0.0.1:${port} -> ${SUPABASE_API_URL} (browser origin ${values['app-origin']} presented as ${APP_PUBLIC_ORIGIN})`), (e) => { console.error(`[api] ${e.message}`); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { proxy.server.close(); process.exit(0); });
}
