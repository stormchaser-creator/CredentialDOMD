// credentialdomd-api: same-origin relay for the waitlist. Hospital IT
// filters and content blockers kill third-party requests to supabase.co;
// first-party /api/* cannot be blocked without blocking the site itself.
//
// Route: credentialdomd.com/api/*  (zone 682edbf58b5b13fce0a6276768672152)
// Also carries the /api/pv pageview beacon (2026-08-27), same relay shape.
// Deploy: cloudflare/credentialdomd-api/deploy.sh (API upload, no wrangler).
//
// 2026-08-16: relays to the SECURITY DEFINER RPCs waitlist_signup /
// waitlist_attempt (supabase/migrations/20260816_ratelimit.sql) instead of
// inserting into the tables. Anon INSERT on both tables is revoked, so the
// DB enforces email shape, one row per address, and a global cap on
// signups (20 / 10 min, which is the cap on Resend welcome emails) and
// attempts (60 / 10 min). This Worker adds a per-IP layer in front of that.
//
// 2026-09-03: also carries GET /api/confirm-forwarding, the link in the
// forwarding-address confirmation email. Two reasons it is here and not on
// the function URL: the Supabase functions gateway rewrites any HTML response
// to text/plain under a sandbox CSP (a page served from *.supabase.co cannot
// render), and a link a physician opens from a hospital mailbox has to
// survive the same content filters the waitlist relay exists for. The Worker
// forwards the token, returns the function's page as first-party HTML, and
// keeps no copy of either.
//
// Per-IP limit is an in-memory Map per isolate: best-effort only. Cloudflare
// runs many isolates across many POPs and recycles them, so a determined
// client can exceed it; the DB caps are the real ceiling. Good enough to
// stop one browser tab from looping.

const SUPA = "https://hkpnnsjcwprrwobmpqyy.supabase.co/rest/v1";
const FUNCTIONS = "https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1";
// Supabase anon key: public by design (it ships in the landing page too).
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrcG5uc2pjd3BycndvYm1wcXl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTIwODksImV4cCI6MjA4NzY2ODA4OX0._8iVLrhaDshKbxWV4XIs9LuyuS_-25fmABwloazhB-U";

const WINDOW_MS = 10 * 60 * 1000;
const ROUTES = {
  // path -> { rpc, per-IP cap per WINDOW_MS, accepted body keys -> rpc args }
  "/api/waitlist": {
    rpc: "waitlist_signup",
    limit: 5,
    args: { name: "p_name", email: "p_email", source: "p_source", note: "p_note", stage: "p_stage", waitlist: "p_waitlist" },
  },
  "/api/waitlist-attempt": {
    rpc: "waitlist_attempt",
    limit: 15, // attempts precede signups; leave room for the trace of a blocked signup
    args: { name: "p_name", email: "p_email", source: "p_source", stage: "p_stage" },
  },
  // Pageview beacon (2026-08-27): landing pages sendBeacon {p, r} here; the
  // RPC whitelists the path, reduces the referrer to its registrable domain,
  // and upserts a (day, path, referrer_domain) counter. Counts only: no
  // cookies, no IP storage, no fingerprinting. See
  // supabase/migrations/20260827_page_views.sql.
  "/api/pv": {
    rpc: "track_pv",
    limit: 60, // one call per pageview; 60 pages / 10 min covers real browsing
    args: { p: "p_path", r: "p_ref" },
  },
};
const CORS = {
  "Access-Control-Allow-Origin": "https://credentialdomd.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// ip -> array of request timestamps inside the window (per route)
const hits = new Map();
function rateLimited(key, limit, now) {
  let arr = hits.get(key);
  if (!arr) { arr = []; hits.set(key, arr); }
  while (arr.length && now - arr[0] > WINDOW_MS) arr.shift();
  if (arr.length >= limit) return true;
  arr.push(now);
  // Keep the map from growing without bound on a long-lived isolate.
  if (hits.size > 5000) {
    for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k); }
  }
  return false;
}

// Accept both the RPC-shaped body ({p_email,...}, current landing) and the
// legacy table-shaped body ({email,...}, cached copies of the old landing).
// Anything else is dropped so PostgREST resolves the function by exact args.
function toRpcArgs(body, argMap) {
  const out = {};
  for (const [plain, rpcName] of Object.entries(argMap)) {
    const v = body[rpcName] !== undefined ? body[rpcName] : body[plain];
    if (v === undefined) continue;
    // Booleans stay booleans (p_waitlist is the guide-page opt-in checkbox:
    // false must reach the RPC as false, not as the string "false").
    out[rpcName] = v === null ? null : typeof v === "boolean" ? v : String(v).slice(0, 300);
  }
  return out;
}

/** The forwarding-address confirmation page, proxied so it renders as HTML. */
async function confirmForwarding(request, url) {
  const token = url.searchParams.get("token") || "";
  if (token.length > 100) return new Response("bad request", { status: 400 });
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // A confirmation link is opened once. This only stops a loop from guessing.
  if (rateLimited(`/api/confirm-forwarding|${ip}`, 20, Date.now())) {
    return new Response("rate limited", { status: 429, headers: { "Retry-After": "600" } });
  }
  const r = await fetch(`${FUNCTIONS}/forwarding-address?token=${encodeURIComponent(token)}`, {
    headers: { Accept: "text/html" },
  });
  const body = await r.text();
  return new Response(body, {
    status: r.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/confirm-forwarding") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("not found", { status: 404 });
      return await confirmForwarding(request, url);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const route = ROUTES[url.pathname];
    if (!route || request.method !== "POST") return new Response("not found", { status: 404, headers: CORS });

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(`${url.pathname}|${ip}`, route.limit, Date.now())) {
      return new Response("rate limited", { status: 429, headers: { ...CORS, "Retry-After": "600" } });
    }

    const raw = await request.text();
    if (raw.length > 2048) return new Response("too large", { status: 413, headers: CORS });
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("bad json", { status: 400, headers: CORS });

    const r = await fetch(`${SUPA}/rpc/${route.rpc}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}` },
      body: JSON.stringify(toRpcArgs(body, route.args)),
    });
    // Status passthrough only. PostgREST maps the RPC's SQLSTATE for us:
    // PT400 -> 400 (bad email), 23505 -> 409 (already listed), PT429 -> 429.
    return new Response(null, { status: r.status, headers: CORS });
  },
};
