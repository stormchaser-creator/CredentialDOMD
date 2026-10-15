// Vite config for QA-lab builds of the app. Never used by production.
//
//   vite build   --config qa-lab/app/vite.config.mjs   (qa:lab, production-mode bundle)
//   vite preview --config qa-lab/app/vite.config.mjs   (qa:lab default: serves that bundle)
//   vite         --config qa-lab/app/vite.config.mjs   (qa:lab --dev: hot reload)
//
// The production build uses the repository's vite.config.js, which this file
// only reads: it never changes it, and nothing in src/ imports anything from
// qa-lab/ (tests/qa-lab/public-repo-safety.test.mjs,
// tests/qa-lab/production-bundle.test.mjs). What a QA-lab build does differently:
//   1. "@clerk/clerk-react" resolves to ./clerk-shim.jsx (the QA sign-in).
//   2. Two production-pinned Clerk issuer literals, in exactly two modules, are
//      rewritten to the lab's issuers, and the three places that send the
//      browser to Stripe's hosted pages (checkout.stripe.com,
//      billing.stripe.com) send it to the mock's stand-ins on the app's own
//      origin instead (/__qa/mock/qa/stripe/hosted/...). The URL checks
//      themselves are untouched: the app still accepts only a Stripe-shaped
//      URL, and limited-checkout still refuses a session whose url is not
//      https://checkout.stripe.com/, so the mock keeps answering Stripe URLs.
//      The build fails if any rewritten text is missing (LAB_REWRITES).
//   3. The app server serves the build, proxies /__qa/mock to the mock server,
//      and relays /api/* the way production's Cloudflare worker does. The
//      Supabase API is NOT on this origin: the app calls the lab's API proxy
//      on its own port (qa-lab/lib/api-proxy.mjs), cross-origin as live, so
//      the browser enforces the functions' CORS headers.
//   4. Output goes to qa-lab/.generated/app-dist, never dist/.
//   5. The iOS Simulator profile (qa-lab/sim.mjs) builds into a folder of its
//      own under .generated/ (QA_LAB_APP_DIST), and serves it over TLS
//      (QA_LAB_TLS_CERT, QA_LAB_TLS_KEY) on its own port, with the API proxy's
//      https origin baked in. The running mock server sends the hosted
//      stand-ins' redirects to the plain-HTTP app it was started with
//      (QA_LAB_MOCK_APP_ORIGIN); this server renames that origin to its own
//      (QA_LAB_APP_ORIGIN) in those answers (rewriteMockAnswer).
// It refuses to run unless VITE_QA_LAB=1 and the Supabase URL is this machine
// on another origin than the app.
import { defineConfig } from 'vite';
import { createLocalUnsubscribeRelay } from '../lib/unsubscribe-relay.mjs';
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import baseConfig from '../../vite.config.js';
import { computeAppRulesUrls, computePrecacheUrls, stampAppRules, stampPrecache, verifyAppSplit, verifyPrecache } from '../../scripts/sw-precache.mjs';
import { GENERATED_DIR, QA_APP_DIST, REPO_ROOT } from '../lib/paths.mjs';
import { APP_PROXY, HOSTED_STAND_IN_PATH, LAB_ISSUER, LAB_LEGACY_ISSUER, PRODUCTION_ISSUER, PRODUCTION_LEGACY_ISSUER, SUPABASE_API_URL } from '../lib/lab-config.mjs';

const SHIM = fileURLToPath(new URL('./clerk-shim.jsx', import.meta.url));
const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const LOCAL = new Set(['127.0.0.1', 'localhost']);

/**
 * Where a Stripe hosted-page URL sends the browser in the QA build: the mock's
 * stand-in on the app's own origin (a path, so the build does not name a port).
 * Any other URL is left alone. Inlined as an expression at the call site.
 */
export const HOSTED_STAND_IN = `((u) => { const m = /^https:\\/\\/(checkout|billing)\\.stripe\\.com\\/(?:c\\/pay|p\\/session)\\/([A-Za-z0-9_]+)/.exec(String(u)); return m ? ${JSON.stringify(HOSTED_STAND_IN_PATH + '/')} + (m[1] === "checkout" ? "checkout/" : "portal/") + m[2] : u; })`;

/** Module -> the production text it must contain, and what the lab build puts there instead (every occurrence). */
export const LAB_REWRITES = Object.freeze({
  // The lab serves loopback HTTP. WebKit otherwise upgrades these requests to
  // HTTPS, where no lab listener exists. Keep the production CSP untouched.
  'src/utils/appCsp.js': [['    "upgrade-insecure-requests",\n', '']],
  'src/utils/limitedLaunchClient.js': [[PRODUCTION_ISSUER, LAB_ISSUER], [PRODUCTION_LEGACY_ISSUER, LAB_LEGACY_ISSUER]],
  'src/utils/continuityRecovery.js': [[PRODUCTION_ISSUER, LAB_ISSUER], [PRODUCTION_LEGACY_ISSUER, LAB_LEGACY_ISSUER]],
  // Checkout (limited launch) and the billing portal.
  'src/components/pages/LimitedLaunchMembership.jsx': [['window.location.assign(result.url)', `window.location.assign(${HOSTED_STAND_IN}(result.url))`]],
  'src/hooks/useSubscription.js': [
    ['window.location.assign(result.url)', `window.location.assign(${HOSTED_STAND_IN}(result.url))`],
    ['window.location.href = res.data.url', `window.location.href = ${HOSTED_STAND_IN}(res.data.url)`],
  ],
});
/**
 * The served build answers without Vite's CORS middleware, as production's
 * static host does. That middleware (on by default in `vite preview`) adds
 * `Vary: Origin` to every response. Production's assets vary on
 * Accept-Encoding only (checked 2026-09-30 with a HEAD request to credentialdomd.com/app/assets/).
 * Under `Vary: Origin`, the service worker's precache (fetched without an
 * Origin header) never matches the page's `crossorigin` script and stylesheet
 * requests (sent with one), so a device that went offline before one page load
 * ran under the worker opened an unstyled shell with no app. That was a lab-only
 * failure, seen in offline-storage.spec.mjs SYNC-017. Nothing reads the app
 * origin cross-origin: the API is the proxy's origin, and the mock's pages are
 * proxied onto this one.
 */
export const PREVIEW_CORS = false;

/** Kept for callers of the step-2 name. */
export const ISSUER_REWRITES = LAB_REWRITES;

/** Applies LAB_REWRITES[rel] to `code`; throws naming the text that is missing. */
export function applyLabRewrites(rel, code) {
  const swaps = LAB_REWRITES[rel];
  if (!swaps) return null;
  let out = code;
  for (const [from, to] of swaps) {
    if (!out.includes(from)) throw new Error(`qa-lab: ${rel} no longer contains ${from}; update qa-lab/app/vite.config.mjs`);
    out = out.split(from).join(to);
  }
  return out;
}

function rewriteIssuers(command) {
  const done = new Set();
  return {
    name: 'qa-lab-issuers',
    enforce: 'pre',
    transform(code, id) {
      const rel = path.relative(REPO_ROOT, id.split('?')[0]).split(path.sep).join('/');
      if (!LAB_REWRITES[rel]) return null;
      let out;
      try { out = applyLabRewrites(rel, code); } catch (e) { this.error(e.message); }
      done.add(rel);
      return { code: out, map: null };
    },
    buildEnd(error) {
      if (command !== 'build' || error) return;
      for (const rel of Object.keys(LAB_REWRITES)) if (!done.has(rel)) this.error(`qa-lab: ${rel} was not part of the build; update qa-lab/app/vite.config.mjs`);
    },
  };
}

// Production's /api/* relay (cloudflare/credentialdomd-api/worker.js), pointed at the local stack.
const RPC_ROUTES = {
  '/api/waitlist': { rpc: 'waitlist_signup', args: { name: 'p_name', email: 'p_email', source: 'p_source', note: 'p_note', stage: 'p_stage', waitlist: 'p_waitlist' } },
  '/api/waitlist-attempt': { rpc: 'waitlist_attempt', args: { name: 'p_name', email: 'p_email', source: 'p_source', stage: 'p_stage' } },
  '/api/pv': { rpc: 'track_pv', args: { p: 'p_path', r: 'p_ref' } },
};
const readRequest = (req) => new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });

function gateway(anonKey) {
  const unsubscribe = createLocalUnsubscribeRelay({ apiOrigin: SUPABASE_API_URL });
  const middleware = async (req, res, next) => {
    const url = new URL(req.url, 'http://lab.invalid');
    try {
      if (url.pathname === '/' && req.method === 'GET') { res.writeHead(302, { Location: '/app/' }); return res.end(); }
      if (url.pathname === '/membership-offer.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(path.join(REPO_ROOT, 'public', 'membership-offer.js')));
      }
      if (url.pathname === '/api/confirm-forwarding' && ['GET', 'HEAD', 'POST'].includes(req.method)) {
        const post = req.method === 'POST';
        const body = post ? await readRequest(req) : undefined;
        const target = post ? `${SUPABASE_API_URL}/functions/v1/forwarding-address` : `${SUPABASE_API_URL}/functions/v1/forwarding-address?token=${encodeURIComponent(url.searchParams.get('token') || '')}`;
        const r = await fetch(target, { method: post ? 'POST' : 'GET', headers: post ? { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' } : { Accept: 'text/html' }, body });
        res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
        return res.end(await r.text());
      }
      if (url.pathname === '/api/unsubscribe') {
        const origin = process.env.QA_LAB_APP_ORIGIN || `http://127.0.0.1:${Number(process.env.QA_LAB_APP_PORT)}`;
        const headers = new Headers();
        // Node exposes HTTP/2 transport metadata as pseudo-headers. Fetch
        // Headers accepts only ordinary HTTP field names.
        for (const [name, value] of Object.entries(req.headers)) if (!name.startsWith(':') && typeof value === 'string') headers.set(name, value);
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRequest(req);
        const r = await unsubscribe(new Request(`${origin}${url.pathname}${url.search}`, { method: req.method, headers, ...(body === undefined ? {} : { body }) }));
        const answer = rewriteMockAnswer({ headers: Object.fromEntries(r.headers), body: Buffer.from(await r.text()) }, {
          from: `https://127.0.0.1:${Number(new URL(process.env.QA_LAB_MOCK_APP_ORIGIN || origin).port) + 5}`, to: origin,
        });
        res.writeHead(r.status, answer.headers); return res.end(answer.body);
      }
      const route = RPC_ROUTES[url.pathname];
      if (route && req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readRequest(req)) || '{}'); } catch { res.writeHead(400); return res.end('bad json'); }
        const args = {};
        for (const [plain, name] of Object.entries(route.args)) {
          const v = body?.[name] !== undefined ? body[name] : body?.[plain];
          if (v !== undefined) args[name] = v === null ? null : typeof v === 'boolean' ? v : String(v).slice(0, 300);
        }
        const r = await fetch(`${SUPABASE_API_URL}/rest/v1/rpc/${route.rpc}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` }, body: JSON.stringify(args) });
        res.writeHead(r.status); return res.end();
      }
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`qa-lab gateway: ${e.message}`);
    }
    next();
  };
  return {
    name: 'qa-lab-gateway',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

function proxies(mockUrl) {
  const strip = (prefix) => (p) => p.slice(prefix.length) || '/';
  // Only the mock server. The Supabase API is on the lab's API proxy (another origin).
  return {
    [APP_PROXY.mock]: { target: mockUrl, changeOrigin: true, rewrite: strip(APP_PROXY.mock) },
  };
}

function stampQaServiceWorker(buildId, outDir) {
  // The same stamping vite.config.js does for dist/, done for the lab's own output folder.
  return {
    name: 'qa-lab-stamp-sw',
    apply: 'build',
    closeBundle() {
      const swPath = path.join(outDir, 'sw.js');
      const manifestPath = path.join(outDir, '.vite', 'manifest.json');
      if (!existsSync(swPath) || !existsSync(manifestPath)) throw new Error('qa-lab: sw.js or the build manifest is missing from the QA build');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      // As vite.config.js: the precache list, then the PA/NP rule chunk list
      // (release/goal4 e1f4b4c9; verifyPrecache refuses an unstamped one).
      const sw = stampAppRules(stampPrecache(readFileSync(swPath, 'utf8').replaceAll('__BUILD_ID__', buildId), computePrecacheUrls(manifest)), computeAppRulesUrls(manifest));
      writeFileSync(swPath, sw);
      writeFileSync(path.join(outDir, 'version.json'), JSON.stringify({ build: buildId, qaLab: true }) + '\n');
      verifyPrecache(outDir);
      verifyAppSplit(outDir);
    },
  };
}

/**
 * Where the build goes: .generated/app-dist (qa:lab), or QA_LAB_APP_DIST, a
 * folder under qa-lab/.generated/ (the Simulator profile's own build, so the
 * running lab's files are never replaced under it).
 */
export function qaOutDir(env = process.env) {
  if (!env.QA_LAB_APP_DIST) return QA_APP_DIST;
  const out = path.resolve(REPO_ROOT, env.QA_LAB_APP_DIST);
  const rel = path.relative(GENERATED_DIR, out);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`qa-lab: QA_LAB_APP_DIST must be a folder under qa-lab/.generated/ (got ${env.QA_LAB_APP_DIST})`);
  return out;
}

const LOCAL_APP_ORIGIN = /^https?:\/\/127\.0\.0\.1:\d+$/;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

/**
 * The mock server's answer for a hosted stand-in, with the app origin the mock
 * was started with (`from`) renamed to this server's (`to`): in Location and
 * Content-Security-Policy (form-action) and in the page's links. Nothing else
 * changes. Returns headers fit for HTTP/1.1 and HTTP/2 (no hop-by-hop names).
 */
export function rewriteMockAnswer({ headers, body }, { from, to }) {
  if (!LOCAL_APP_ORIGIN.test(from) || !LOCAL_APP_ORIGIN.test(to)) throw new Error('qa-lab: the mock answer rewrite takes two lab app origins');
  // A lab origin holds letters, digits, ':', '/' and '.'; the port must end where the origin does.
  const re = new RegExp(from.replace(/[./]/g, '\\$&') + '(?![0-9])', 'g');
  const swap = (v) => (typeof v === 'string' ? v.replace(re, to) : Array.isArray(v) ? v.map(swap) : v);
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (HOP_BY_HOP.has(name) || name.startsWith(':')) continue;
    out[name] = ['location', 'content-security-policy', 'refresh'].includes(name) ? swap(v) : v;
  }
  let text = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (/^text\/|json|javascript/.test(String(out['content-type'] || ''))) text = Buffer.from(swap(text.toString('utf8')), 'utf8');
  out['content-length'] = String(text.length);
  return { headers: out, body: text };
}

function mockOriginRewrite(mockUrl, from, to) {
  // Only the hosted stand-ins name the app origin (stripe.mjs: their redirects, links and form-action).
  const prefix = `${HOSTED_STAND_IN_PATH}/`;
  const upstream = new URL(mockUrl);
  const middleware = (req, res, next) => {
    if (!req.url.startsWith(prefix)) return next();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(':') && !HOP_BY_HOP.has(k) && k !== 'accept-encoding') headers[k] = v;
    headers.host = upstream.host;
    const out = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url.slice(APP_PROXY.mock.length), headers }, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const answer = rewriteMockAnswer({ headers: up.headers, body: Buffer.concat(chunks) }, { from, to });
        res.writeHead(up.statusCode || 502, answer.headers);
        res.end(answer.body);
      });
      up.on('error', () => res.destroy());
    });
    out.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`qa-lab mock proxy: ${e.message}`); } else res.destroy(); });
    req.pipe(out);
  };
  return {
    name: 'qa-lab-mock-origin',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

/** TLS for the served build (the Simulator profile): QA_LAB_TLS_CERT and QA_LAB_TLS_KEY, both or neither. */
function tlsOptions(env = process.env) {
  if (!env.QA_LAB_TLS_CERT && !env.QA_LAB_TLS_KEY) return null;
  if (!env.QA_LAB_TLS_CERT || !env.QA_LAB_TLS_KEY) throw new Error('qa-lab: QA_LAB_TLS_CERT and QA_LAB_TLS_KEY go together');
  return { cert: readFileSync(env.QA_LAB_TLS_CERT), key: readFileSync(env.QA_LAB_TLS_KEY) };
}

export default defineConfig(({ command }) => {
  if (process.env.VITE_QA_LAB !== '1') throw new Error('qa-lab/app/vite.config.mjs builds the QA lab app only: set VITE_QA_LAB=1 (npm run qa:lab does).');
  let supabaseUrl;
  try { supabaseUrl = new URL(process.env.VITE_SUPABASE_URL || ''); } catch { throw new Error('qa-lab: VITE_SUPABASE_URL must be the lab app server URL'); }
  if (!LOCAL.has(supabaseUrl.hostname)) throw new Error(`qa-lab: refusing a Supabase URL that is not this machine (${supabaseUrl.hostname})`);
  const mockUrl = process.env.QA_LAB_MOCK_URL || '';
  if (command === 'serve' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(mockUrl)) throw new Error('qa-lab: QA_LAB_MOCK_URL must be the local mock server (http://127.0.0.1:<port>)');
  const port = Number(process.env.QA_LAB_APP_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('qa-lab: QA_LAB_APP_PORT must be the lab app port');
  // Cross-origin, as live: the browser must check the functions' CORS headers.
  if (['http', 'https'].some((scheme) => [`${scheme}://127.0.0.1:${port}`, `${scheme}://localhost:${port}`].includes(supabaseUrl.origin))) throw new Error('qa-lab: the Supabase URL must be the lab API proxy, another origin than the app (qa-lab/lib/api-proxy.mjs)');
  const outDir = qaOutDir();
  const tls = command === 'serve' ? tlsOptions() : null;
  // The Simulator profile: served over TLS, its app origin, and the origin the running mock redirects to.
  const appOrigin = process.env.QA_LAB_APP_ORIGIN || '';
  const mockAppOrigin = process.env.QA_LAB_MOCK_APP_ORIGIN || '';
  if (tls) {
    if (appOrigin !== `https://127.0.0.1:${port}`) throw new Error(`qa-lab: served over TLS, QA_LAB_APP_ORIGIN must be https://127.0.0.1:${port}`);
    if (supabaseUrl.protocol !== 'https:') throw new Error('qa-lab: served over TLS, the build must call an https API proxy (a page on https cannot call plain HTTP)');
  }
  if (mockAppOrigin && (!LOCAL_APP_ORIGIN.test(mockAppOrigin) || !LOCAL_APP_ORIGIN.test(appOrigin))) throw new Error('qa-lab: QA_LAB_MOCK_APP_ORIGIN and QA_LAB_APP_ORIGIN must be lab app origins (http(s)://127.0.0.1:<port>)');
  const renameMockOrigin = command === 'serve' && mockAppOrigin && mockAppOrigin !== appOrigin ? [mockOriginRewrite(mockUrl, mockAppOrigin, appOrigin)] : [];
  const buildId = `${JSON.parse(baseConfig.define.__APP_BUILD_ID__)}-qalab`;
  const plugins = baseConfig.plugins.filter((p) => !(p && !Array.isArray(p) && ['stamp-build-id', 'assert-precache'].includes(p.name)));
  return {
    root: REPO_ROOT,
    base: '/app/',
    // Only the environment qa:lab passes: no .env file (which may name production) is read.
    envDir: APP_DIR,
    plugins: [...plugins, rewriteIssuers(command), gateway(process.env.VITE_SUPABASE_ANON_KEY || ''), ...renameMockOrigin, stampQaServiceWorker(buildId, outDir)],
    resolve: { alias: [{ find: /^@clerk\/clerk-react$/, replacement: SHIM }] },
    define: { ...baseConfig.define, __APP_BUILD_ID__: JSON.stringify(buildId) },
    build: { outDir, emptyOutDir: true, manifest: true },
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { ...(baseConfig.server?.proxy || {}), ...proxies(mockUrl) } },
    // No CORS middleware on the served build (PREVIEW_CORS, below).
    preview: { host: '127.0.0.1', port, strictPort: true, proxy: proxies(mockUrl), cors: PREVIEW_CORS, ...(tls ? { https: tls } : {}) },
    clearScreen: false,
  };
});
