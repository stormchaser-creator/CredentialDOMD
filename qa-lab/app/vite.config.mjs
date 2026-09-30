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
// It refuses to run unless VITE_QA_LAB=1 and the Supabase URL is this machine
// on another origin than the app.
import { defineConfig } from 'vite';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import baseConfig from '../../vite.config.js';
import { computePrecacheUrls, stampPrecache, verifyPrecache } from '../../scripts/sw-precache.mjs';
import { QA_APP_DIST, REPO_ROOT } from '../lib/paths.mjs';
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
  'src/utils/limitedLaunchClient.js': [[PRODUCTION_ISSUER, LAB_ISSUER], [PRODUCTION_LEGACY_ISSUER, LAB_LEGACY_ISSUER]],
  'src/utils/continuityRecovery.js': [[PRODUCTION_ISSUER, LAB_ISSUER], [PRODUCTION_LEGACY_ISSUER, LAB_LEGACY_ISSUER]],
  // Checkout (limited launch) and the billing portal.
  'src/components/pages/LimitedLaunchMembership.jsx': [['window.location.assign(result.url)', `window.location.assign(${HOSTED_STAND_IN}(result.url))`]],
  'src/hooks/useSubscription.js': [
    ['window.location.assign(result.url)', `window.location.assign(${HOSTED_STAND_IN}(result.url))`],
    ['window.location.href = res.data.url', `window.location.href = ${HOSTED_STAND_IN}(res.data.url)`],
  ],
});
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

function stampQaServiceWorker(buildId) {
  // The same stamping vite.config.js does for dist/, done for the lab's own output folder.
  return {
    name: 'qa-lab-stamp-sw',
    apply: 'build',
    closeBundle() {
      const swPath = path.join(QA_APP_DIST, 'sw.js');
      const manifestPath = path.join(QA_APP_DIST, '.vite', 'manifest.json');
      if (!existsSync(swPath) || !existsSync(manifestPath)) throw new Error('qa-lab: sw.js or the build manifest is missing from the QA build');
      const sw = stampPrecache(readFileSync(swPath, 'utf8').replaceAll('__BUILD_ID__', buildId), computePrecacheUrls(JSON.parse(readFileSync(manifestPath, 'utf8'))));
      writeFileSync(swPath, sw);
      writeFileSync(path.join(QA_APP_DIST, 'version.json'), JSON.stringify({ build: buildId, qaLab: true }) + '\n');
      verifyPrecache(QA_APP_DIST);
    },
  };
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
  if (supabaseUrl.origin === `http://127.0.0.1:${port}` || supabaseUrl.origin === `http://localhost:${port}`) throw new Error('qa-lab: the Supabase URL must be the lab API proxy, another origin than the app (qa-lab/lib/api-proxy.mjs)');
  const buildId = `${JSON.parse(baseConfig.define.__APP_BUILD_ID__)}-qalab`;
  const plugins = baseConfig.plugins.filter((p) => !(p && !Array.isArray(p) && ['stamp-build-id', 'assert-precache'].includes(p.name)));
  return {
    root: REPO_ROOT,
    base: '/app/',
    // Only the environment qa:lab passes: no .env file (which may name production) is read.
    envDir: APP_DIR,
    plugins: [...plugins, rewriteIssuers(command), gateway(process.env.VITE_SUPABASE_ANON_KEY || ''), stampQaServiceWorker(buildId)],
    resolve: { alias: [{ find: /^@clerk\/clerk-react$/, replacement: SHIM }] },
    define: { ...baseConfig.define, __APP_BUILD_ID__: JSON.stringify(buildId) },
    build: { outDir: QA_APP_DIST, emptyOutDir: true, manifest: true },
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { ...(baseConfig.server?.proxy || {}), ...proxies(mockUrl) } },
    preview: { host: '127.0.0.1', port, strictPort: true, proxy: proxies(mockUrl) },
    clearScreen: false,
  };
});
