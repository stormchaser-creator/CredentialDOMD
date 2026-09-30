// Helpers for the billing, admin, support and public-site journeys
// (bill-admin-support-public*.spec.mjs). Lab-only; nothing here is imported by
// the app or by production.
//
// THE PUBLIC SITE IN THE LAB
//
// The lab's app server serves the QA build under /app/ only. The public site
// (landing page, the 51 state guides, /help/, /cme/, /locums, /privacy, /terms,
// /security, the administrator page /credential-access) is built by
// scripts/package-site.mjs in the deploy (.github/workflows/deploy-gh-pages.yml:
// `npm run build:site`), and production puts two Cloudflare Workers in front of
// it: cloudflare/credentialdomd-api/worker.js on /api/* (the waitlist, guide and
// visit-beacon relay) and scripts/cloudflare-private-headers-worker.mjs on
// /credential-access* (the private page's response headers).
//
// buildPublicSite() runs the deploy's own packager, unchanged, over a scratch
// root whose landing/, public/ and scripts/ are the repository's and whose dist/
// is the lab's QA app build, into qa-lab/.generated/public-site/ (gitignored).
// The public offer endpoint is built for a placeholder Supabase project
// (PUBLIC_SUPABASE_PLACEHOLDER): the packager and public/membership-offer.js
// accept only an https *.supabase.co origin, so the lab cannot name its own. A
// journey's browser context answers that placeholder from the LOCAL gateway
// (routePublicSite), the way the lab's API proxy answers the app: the request is
// presented with production's Origin, and production's Access-Control-Allow-Origin
// is renamed to the public site's. Nothing is ever sent to that host.
//
// startPublicSite() serves the result on 127.0.0.1 (a free port from 54395):
//   /api/*               production's relay worker, its three production
//                        constants (REST URL, functions URL, anon key) rewritten
//                        to the local gateway and the local anon key. The rewrite
//                        refuses to run if any production Supabase host survives.
//   /credential-access*  production's private-headers worker in front of the files.
//   /app/<page>          a navigation into the app goes to the lab app
//                        (302 to http://127.0.0.1:<app port>/app/...): the app on
//                        this origin could not reach the lab's API proxy, which
//                        answers the lab app's origin only. /app/privacy.html and
//                        /app/terms.html (packaged pages) and the app's static
//                        files (sw.js, assets) are served from the package.
//   everything else      the packaged files, resolved as GitHub Pages does
//                        (file, file.html, dir/index.html), 404.html otherwise.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { GENERATED_DIR, QA_APP_DIST, REPO_ROOT } from '../../lib/paths.mjs';
import { APP_PUBLIC_ORIGIN, SUPABASE_API_URL } from '../../lib/lab-config.mjs';
import { forwardRequestHeaders, returnResponseHeaders } from '../../lib/api-proxy.mjs';
import { supabaseStatus } from '../../lib/local-db.mjs';
import { freePort } from '../../lib/procs.mjs';
import { lab, lit, mockApi, row, rows, labExec, sleep, waitFor } from './lab.mjs';

/** The Supabase origin the public site is built for in the lab (never contacted: journeys answer it locally). */
export const PUBLIC_SUPABASE_PLACEHOLDER = 'https://qalabnotarealproject.supabase.co';
export const PUBLIC_SITE_DIR = path.join(GENERATED_DIR, 'public-site');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.bcmap': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

// ── Building ───────────────────────────────────────────────────────────────

/**
 * Packages the public site with scripts/package-site.mjs (the deploy's packager)
 * into qa-lab/.generated/public-site/site-<id>/site-dist. One build per call;
 * old builds (over an hour) are removed. Returns the site-dist folder.
 */
export async function buildPublicSite() {
  mkdirSync(PUBLIC_SITE_DIR, { recursive: true });
  for (const name of readdirSync(PUBLIC_SITE_DIR)) {
    const full = path.join(PUBLIC_SITE_DIR, name);
    try { if (/^site-/.test(name) && Date.now() - statSync(full).mtimeMs > 3600e3) rmSync(full, { recursive: true, force: true }); } catch { /* another run's */ }
  }
  if (!existsSync(path.join(QA_APP_DIST, 'index.html'))) throw new Error('the QA app build is missing (qa-lab/.generated/app-dist): start the lab with `npm run qa:lab`');
  const root = path.join(PUBLIC_SITE_DIR, `site-${process.pid}-${randomBytes(3).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  for (const dir of ['landing', 'public', 'scripts']) symlinkSync(path.join(REPO_ROOT, dir), path.join(root, dir));
  symlinkSync(QA_APP_DIST, path.join(root, 'dist'));
  const { packageSite } = await import(path.join(REPO_ROOT, 'scripts', 'package-site.mjs'));
  // The deploy passes VITE_CREDENTIAL_PORTAL_ENABLED=true (administrator access is live).
  const out = await packageSite(root, undefined, undefined, { supabaseUrl: PUBLIC_SUPABASE_PLACEHOLDER, portalEnabled: true });
  return out;
}

// ── Production's Workers, pointed at the lab ───────────────────────────────

let localAnon = null;
function anonKey() {
  if (localAnon) return localAnon;
  const s = supabaseStatus();
  if (!s?.ANON_KEY) throw new Error('the local stack is not running');
  return (localAnon = s.ANON_KEY);
}

/**
 * cloudflare/credentialdomd-api/worker.js with its production constants
 * replaced by the local gateway's. Refuses to load if the source moved or if a
 * production Supabase host would survive the rewrite.
 */
export async function loadRelayWorker() {
  const source = readFileSync(path.join(REPO_ROOT, 'cloudflare', 'credentialdomd-api', 'worker.js'), 'utf8');
  const swaps = [
    [/const SUPA = "https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1";/, `const SUPA = ${JSON.stringify(`${SUPABASE_API_URL}/rest/v1`)};`],
    [/const FUNCTIONS = "https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1";/, `const FUNCTIONS = ${JSON.stringify(`${SUPABASE_API_URL}/functions/v1`)};`],
    [/const ANON = "[A-Za-z0-9._-]+";/, `const ANON = ${JSON.stringify(anonKey())};`],
  ];
  let code = source;
  for (const [from, to] of swaps) {
    if ((code.match(new RegExp(from.source, 'g')) || []).length !== 1) throw new Error(`qa-lab: the relay worker no longer has exactly one ${from}; update bill-admin-support-public-helpers.mjs`);
    code = code.replace(from, to);
  }
  if (/https?:\/\/[a-z0-9-]+\.supabase\.(?:co|in)\b/i.test(code)) throw new Error('qa-lab: a Supabase host survived the relay worker rewrite; refusing to run it');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return mod.default;
}

async function loadPrivateHeadersWorker() {
  return (await import(path.join(REPO_ROOT, 'scripts', 'cloudflare-private-headers-worker.mjs'))).default;
}

// ── Serving ────────────────────────────────────────────────────────────────

const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });

function resolveFile(siteDir, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  const base = path.resolve(siteDir);
  const target = path.resolve(base, `.${rel}`);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  if (isFile(target)) return { file: target };
  if (!rel.endsWith('/') && isFile(`${target}.html`)) return { file: `${target}.html` };
  if (isDir(target)) {
    if (!rel.endsWith('/')) return { redirect: `${pathname}/` };
    if (isFile(path.join(target, 'index.html'))) return { file: path.join(target, 'index.html') };
  }
  return null;
}

async function toNode(response, res, method) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  const body = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  delete headers['content-encoding'];
  headers['content-length'] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(body);
}

/**
 * Serves a packaged site (buildPublicSite) on 127.0.0.1. Returns
 * { origin, port, siteDir, relayLog, close }. relayLog records every /api/* call
 * (path, status) the relay answered.
 */
export async function startPublicSite({ siteDir, port } = {}) {
  const dir = siteDir || await buildPublicSite();
  const rt = lab();
  const relay = await loadRelayWorker();
  const privateHeaders = await loadPrivateHeadersWorker();
  const originToken = randomBytes(12).toString('hex');
  let listenPort = port || await freePort(54395 + Math.floor(Math.random() * 40), { avoid: [rt.appPort, rt.mockPort, rt.apiPort] });
  let origin = `http://127.0.0.1:${listenPort}`;
  const relayLog = [];

  const serveStatic = (req, res, pathname) => {
    const found = resolveFile(dir, pathname);
    if (found?.redirect) { res.writeHead(301, { Location: found.redirect }); return res.end(); }
    const file = found?.file || path.join(dir, '404.html');
    const status = found?.file ? 200 : 404;
    const body = readFileSync(file);
    res.writeHead(status, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'max-age=600' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const { pathname } = url;
      if (req.headers['x-qa-lab-origin'] === originToken) return serveStatic(req, res, pathname);
      if (pathname.startsWith('/api/')) {
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
        const headers = { ...req.headers, 'cf-connecting-ip': req.socket.remoteAddress || '127.0.0.1' };
        delete headers.host; delete headers.connection; delete headers['content-length'];
        const response = await relay.fetch(new Request(`${APP_PUBLIC_ORIGIN}${pathname}${url.search}`, { method: req.method, headers, body }));
        relayLog.push({ at: new Date().toISOString(), method: req.method, path: pathname, status: response.status });
        return toNode(response, res, req.method);
      }
      if (/^\/credential-access(?:\.html|\/.*)?$/.test(pathname)) {
        const headers = { ...req.headers, 'x-qa-lab-origin': originToken };
        delete headers.host; delete headers.connection;
        const response = await privateHeaders.fetch(new Request(`${origin}${pathname}${url.search}`, { method: req.method, headers }));
        return toNode(response, res, req.method);
      }
      if (pathname === '/app' || pathname.startsWith('/app/')) {
        const packaged = ['/app/privacy.html', '/app/terms.html'].includes(pathname);
        const isPage = pathname === '/app' || pathname.endsWith('/') || pathname.endsWith('.html');
        if (!packaged && isPage) { res.writeHead(302, { Location: `${rt.urls.appOrigin}${pathname}${url.search}` }); return res.end(); }
      }
      return serveStatic(req, res, pathname);
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`qa-lab public site: ${e.message}`);
    }
  });
  // Several journeys start a site at once: a port taken between the check and the listen is retried.
  for (let tries = 0; ; tries++) {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || port || tries > 20) throw e;
      listenPort = await freePort(listenPort + 1, { avoid: [rt.appPort, rt.mockPort, rt.apiPort] });
      origin = `http://127.0.0.1:${listenPort}`;
    }
  }
  return {
    origin, port: listenPort, siteDir: dir, relayLog,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Prepares a browser context for the public site: the placeholder Supabase
 * project's public-membership-offer is answered from the LOCAL gateway (as the
 * public site's origin would be answered by production), and Google Fonts are
 * refused here (recorded in `thirdParty`) instead of by the lab's guard, so a
 * page that asks for its webfonts does not count as the app reaching out.
 * Anything else outside this machine is still refused and recorded by the guard.
 * `offer` controls the offer endpoint: 'live' (default), 'block', or an object
 * to answer with (a synthetic phase).
 */
export async function routePublicSite(context, site, { offer = 'live', thirdParty = [], offerLog = [] } = {}) {
  const placeholder = new URL(PUBLIC_SUPABASE_PLACEHOLDER);
  const state = { offer };
  await context.route((u) => u.hostname === placeholder.hostname, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    offerLog.push({ at: new Date().toISOString(), method: req.method(), path: u.pathname, mode: typeof state.offer === 'string' ? state.offer : 'fixed' });
    if (state.offer === 'block') return route.abort('failed');
    if (state.offer && typeof state.offer === 'object') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': site.origin, 'Cache-Control': 'no-store' }, body: JSON.stringify(state.offer) });
    }
    try {
      const headers = forwardRequestHeaders(await req.allHeaders(), { appOrigin: site.origin, target: SUPABASE_API_URL });
      delete headers.host;
      const r = await fetch(`${SUPABASE_API_URL}${u.pathname}${u.search}`, { method: req.method(), headers, body: req.postDataBuffer() || undefined });
      const out = {};
      r.headers.forEach((v, k) => { out[k] = v; });
      const translated = returnResponseHeaders(out, { appOrigin: site.origin });
      delete translated['content-encoding']; delete translated['content-length'];
      return route.fulfill({ status: r.status, headers: translated, body: Buffer.from(await r.arrayBuffer()) });
    } catch { return route.abort('failed'); }
  });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => { thirdParty.push(route.request().url().slice(0, 120)); return route.abort('blockedbyclient'); });
  return { setOffer(v) { state.offer = v; }, thirdParty, offerLog };
}

/** Maps an absolute production link (https://credentialdomd.com/x) to the lab's public site; other hosts return null. */
export function labUrlFor(href, site) {
  let u;
  try { u = new URL(href, site.origin); } catch { return null; }
  if (u.origin === site.origin) return u.href;
  if (u.origin === APP_PUBLIC_ORIGIN) return `${site.origin}${u.pathname}${u.search}`;
  return null;
}

/** GETs a lab URL without following redirects: { status, location, type }. */
export async function probe(url) {
  const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  await r.arrayBuffer().catch(() => {});
  return { status: r.status, location: r.headers.get('location'), type: r.headers.get('content-type') };
}

/** The live public offer (public-membership-offer) as the public site asks for it, from the LOCAL function. */
export async function publicOffer() {
  const r = await fetch(`${SUPABASE_API_URL}/functions/v1/public-membership-offer`, { headers: { Origin: APP_PUBLIC_ORIGIN, Accept: 'application/json' } });
  return { status: r.status, body: await r.json().catch(() => null), headers: Object.fromEntries(r.headers) };
}

// ── Database fixtures and reads (LOCAL lab database only) ───────────────────

/** Today's page_views counters for one path (all referrers). */
export function pageViews(pathName) {
  return rows(`select day::text, path, referrer_domain, hits from public.page_views where path = ${lit(pathName)} order by day desc`);
}

/**
 * Seals a lab-only free-beta cohort holding one synthetic address, as the
 * owner sealed the historical no-card cohort, so that address signs up into
 * a 30-day free beta (bootstrap_limited_signup_before_founding). Returns the cohort id.
 */
export function sealBetaCohort(email, tag) {
  if (!/@qa\.credentialdomd\.test$/.test(email)) throw new Error('beta cohorts in the lab take synthetic addresses only');
  const id = `qa_lab_journey_beta_${tag.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)}`;
  const canonical = JSON.stringify([email.toLowerCase()]);
  const hash = createHash('sha256').update(canonical).digest('hex');
  labExec(`select public.seal_limited_free_beta_cohort('${id}', '${hash}', '${canonical}'::jsonb, 'QA lab journey fixture: one synthetic test address')`);
  return id;
}

/**
 * Moves one member's Practice trial (access_grants kind trial) so that it ends at `whenSql`
 * (a SQL expression). A trial is always 720 hours (access_grants_check), so its start moves too.
 */
export function setTrialEnd(profileId, whenSql) {
  return labExec(`update public.access_grants set starts_at = (${whenSql}) - interval '720 hours', ends_at = (${whenSql}) where profile_id = '${profileId}' and kind = 'trial' and scope = 'practice'`);
}

/** Every Stripe subscription the mock holds for a member's customer. */
export async function subscriptionsFor(subject) {
  const sessions = (await mockApi(`/qa/stripe/sessions?subject=${encodeURIComponent(subject)}`)).sessions;
  return sessions.map((s) => s.subscription).filter(Boolean);
}

/** Cancels a member's subscription on the mock Stripe (immediately, or at period end), sending the webhook. */
export async function cancelSubscription(subscriptionId, { atPeriodEnd = false } = {}) {
  return mockApi(`/qa/stripe/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { method: 'POST', body: { atPeriodEnd } });
}

/** The founding places left (100 minus every live slot row), as the runner counts them. */
export function foundingPlacesLeft() {
  const r = row('select 100 - count(*)::int as places from public.limited_founding_slots where livemode');
  return r?.places ?? 0;
}

export { sleep, waitFor };

// ── Members without a founding place ───────────────────────────────────────

/**
 * An ACTIVE member for journeys that are not about paying (the owner's admin
 * accounts, a member who files a ticket): created on the QA sign-in, signed in
 * once (so initialize-clerk-profile makes the profile, pending), then given
 * free lifetime Credential and Practice access, the state the owner's lifetime
 * gift leaves (access_grants kind lifetime, profile active), written as a lab
 * fixture under the same database switch the product's grant functions set.
 * Paying the founding offer instead would take one of the lab's 96 public
 * founding places, which parallel journeys run out of. The page ends on the
 * member app. Returns { user, profile }.
 */
export async function lifetimeMember(page, opts = {}) {
  const { createPhysician, signIn, landing, waitForProfile, waitForMemberApp, dismissInterruptions, profileOf } = await import('./lab.mjs');
  const user = await createPhysician(opts);
  await signIn(page, user);
  await landing(page);
  const p = await waitForProfile(user.id, () => true, 60000);
  labExec(`begin;
    select set_config('credentialdomd.access_grant', '1', true);
    insert into public.access_grants (profile_id, clerk_subject, livemode, scope, kind, source_key, starts_at)
      values ('${p.id}', ${lit(user.id)}, true, 'credential', 'lifetime', 'qa-lab-journey-fixture', now()),
             ('${p.id}', ${lit(user.id)}, true, 'practice', 'lifetime', 'qa-lab-journey-fixture', now())
      on conflict do nothing;
    update public.profiles set access_status = 'active' where id = '${p.id}' and access_status = 'pending';
    commit;`);
  await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  await dismissInterruptions(page);
  return { user, profile: profileOf(user.id) };
}

/**
 * Waits until the lab has at least `need` public founding places (100 minus
 * every live slot row), running the lab's own founding reset (places journeys
 * took more than 15 minutes ago) while it waits. Parallel journeys use the
 * places up; the reset never frees a younger place.
 */
export async function ensureFoundingPlaces(need = 2, timeoutMs = 10 * 60 * 1000) {
  const { execFileSync } = await import('node:child_process');
  const left = () => foundingPlacesLeft();
  const until = Date.now() + timeoutMs;
  while (left() < need) {
    try { execFileSync(process.execPath, [path.join(REPO_ROOT, 'qa-lab', 'founding-reset.mjs')], { stdio: 'ignore', timeout: 120000 }); } catch { /* another reset holds the lock */ }
    if (left() >= need) break;
    if (Date.now() > until) throw new Error(`only ${left()} public founding place(s) left after ${Math.round(timeoutMs / 60000)} minutes (parallel journeys are using them)`);
    await sleep(20000);
  }
  return left();
}
