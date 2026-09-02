/**
 * callsync-feed: relay for the ANMG CallSync calendar subscription.
 *
 * CallSync (the group's on-call scheduler, Next.js on Railway) publishes
 * each provider's shifts as a public iCal feed keyed by a per-user token:
 *   GET https://anmg-callsync-production.up.railway.app/api/ical?token=<uuid>
 * The feed sends no CORS headers, so the browser cannot read it directly.
 * This function fetches it server-side and hands the .ics text back.
 *
 * Deploy with --no-verify-jwt (Clerk RS256 tokens fail the gateway check;
 * the signature is verified in _shared/clerkAuth.ts).
 *
 *   POST /functions/v1/callsync-feed     Authorization: Bearer <Clerk JWT>
 *     Body: { url: "https://<callsync host>/api/ical?token=..." }
 *     200  { ics: "<text/calendar>" }
 *     400  { error: "bad_url" }        not a CallSync calendar link
 *     401  { error: "unauthorized" }   not signed in
 *     403  { error: "invalid_token" }  CallSync rejected the token
 *     502  { error: "upstream", status } | { error: "not_ics" } | { error: "too_large" }
 *     504  { error: "timeout" }
 *
 * Only the CallSync hosts are fetched, only /api/ical, only over https, and
 * only the token travels upstream. The token is never logged; there is
 * deliberately no console.log in this file.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The Railway host is what answers today; callsync.anmg-ca.com is the
// public CNAME CallSync's own docs name (not resolving as of 2026-09-02).
const ALLOWED_HOSTS = new Set([
  "anmg-callsync-production.up.railway.app",
  "callsync.anmg-ca.com",
]);
const TOKEN_SHAPE = /^[A-Za-z0-9-]{8,128}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** The upstream URL to fetch, rebuilt from scratch, or null when the input is not a CallSync feed link. */
function feedUrlFrom(input: unknown): URL | null {
  if (typeof input !== "string" || input.length > 512) return null;
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
  if (u.pathname.replace(/\/+$/, "") !== "/api/ical") return null;
  const token = u.searchParams.get("token") || "";
  if (!TOKEN_SHAPE.test(token)) return null;
  const clean = new URL(`https://${u.hostname.toLowerCase()}/api/ical`);
  clean.searchParams.set("token", token);
  return clean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });

  const user = await clerkProfile(req);
  if (!user) return json(401, { error: "unauthorized" });

  let body: { url?: unknown } | null = null;
  try { body = await req.json(); } catch { return json(400, { error: "bad_json" }); }
  const url = feedUrlFrom(body?.url);
  if (!url) return json(400, { error: "bad_url" });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), {
      headers: {
        Accept: "text/calendar",
        "User-Agent": "CredentialDOMD/1.0 (+https://credentialdomd.com)",
      },
      redirect: "manual",
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error)?.name === "AbortError";
    return json(aborted ? 504 : 502, { error: aborted ? "timeout" : "upstream" });
  }
  clearTimeout(timer);

  // CallSync answers 403 "Invalid or expired token" for a token it does not
  // know (regenerated in its dashboard, or mistyped) and 400 with no token.
  if (upstream.status === 403) return json(403, { error: "invalid_token" });
  if (upstream.status === 400) return json(400, { error: "bad_url" });
  if (!upstream.ok) return json(502, { error: "upstream", status: upstream.status });

  const text = await upstream.text();
  if (text.length > MAX_BYTES) return json(502, { error: "too_large" });
  if (!/BEGIN:VCALENDAR/i.test(text)) return json(502, { error: "not_ics" });
  return json(200, { ics: text });
});
