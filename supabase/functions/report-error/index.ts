/**
 * POST /functions/v1/report-error
 *
 * Client-side error sink. Deploy with --no-verify-jwt: it must accept a
 * report even when Clerk is broken (a crash at auth init has no token).
 *
 * Body (JSON, <= 8 KB): {
 *   kind: 'error' | 'unhandledrejection' | 'react',
 *   message, stack?, url?, user_agent?, build?, auth_user_id?, extra?
 * }
 * Response: { ok: true } | { error }
 *
 * Hard caps: body 8 KB, message 1000 chars, stack 4000 chars, extra 2 KB,
 * 30 rows per hashed IP per 10 minutes. Everything is scrubbed for
 * token-shaped strings before insert. Writes with the service role; the
 * table has no insert policy for any JWT role.
 *
 * DB only, no operator push here. The launchd iMessage notifier
 * (scripts/signup-notify.sh) polls the table for new rows, and Admin > Errors
 * lists them.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const MAX_BODY = 8 * 1024;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_URL = 500;
const MAX_UA = 300;
const MAX_BUILD = 64;
const MAX_EXTRA = 2048;
const MAX_USER_ID = 64;
const RATE_WINDOW_MIN = 10;
const RATE_MAX_ROWS = 30;
const KINDS = new Set(["error", "unhandledrejection", "react"]);

// Anything that looks like a credential is replaced before it touches the DB.
const SECRET_RE =
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|\bsk-[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{20,}|\bre_[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const scrub = (s: string) => s.replace(SECRET_RE, "[redacted]");

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return scrub(t.length > max ? t.slice(0, max) + "…" : t);
}

async function ipHash(req: Request): Promise<string | null> {
  // Trust the edge-set headers first; x-forwarded-for is client-spoofable and
  // is only the last resort.
  const fwd = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0].trim();
  if (!ip) return null;
  const pepper = Deno.env.get("ERROR_IP_PEPPER") || "credentialdomd-client-errors";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${pepper}|${ip}`));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Cheap size gate before reading. Content-Length can lie, so re-check after.
  const declared = parseInt(req.headers.get("content-length") || "0", 10);
  if (declared > MAX_BODY) return json({ error: "Payload too large" }, 413);

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json({ error: "Unreadable body" }, 400);
  }
  if (raw.length > MAX_BODY) return json({ error: "Payload too large" }, 413);

  // The client may send text/plain (sendBeacon, no preflight); parse regardless.
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid body" }, 400);

  const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : "error";
  const message = str(body.message, MAX_MESSAGE) || "(no message)";
  const stack = str(body.stack, MAX_STACK);
  const url = str(body.url, MAX_URL);
  const user_agent = str(body.user_agent, MAX_UA);
  const build = str(body.build, MAX_BUILD);

  // Clerk ids look like user_2abc...; anything else is dropped rather than stored.
  let auth_user_id: string | null = null;
  if (typeof body.auth_user_id === "string" && /^user_[A-Za-z0-9]{8,}$/.test(body.auth_user_id)) {
    auth_user_id = body.auth_user_id.slice(0, MAX_USER_ID);
  }

  let extra: Record<string, unknown> = {};
  if (body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)) {
    try {
      const s = JSON.stringify(body.extra);
      if (s.length <= MAX_EXTRA) extra = JSON.parse(scrub(s));
      else extra = { truncated: true };
    } catch {
      extra = {};
    }
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Naive per-IP cap: more than RATE_MAX_ROWS from the same hashed IP in the
  // window and we drop the row. A crash loop still leaves the first 30.
  const ip_hash = await ipHash(req);
  if (ip_hash) {
    const since = new Date(Date.now() - RATE_WINDOW_MIN * 60 * 1000).toISOString();
    const { count } = await db
      .from("client_errors")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", since);
    if ((count ?? 0) >= RATE_MAX_ROWS) return json({ error: "Rate limited" }, 429);
  }
  // Global ceiling regardless of IP visibility: a scripted flood cannot fill
  // the table even if it hides its address.
  {
    const since = new Date(Date.now() - RATE_WINDOW_MIN * 60 * 1000).toISOString();
    const { count } = await db
      .from("client_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if ((count ?? 0) >= 300) return json({ error: "Rate limited" }, 429);
  }

  // Best-effort profile resolution. auth_user_id is self-reported (no JWT
  // check here), so profile_id is diagnostic context, not an identity claim.
  let profile_id: string | null = null;
  if (auth_user_id) {
    const { data } = await db
      .from("profiles")
      .select("id")
      .eq("auth_user_id", auth_user_id)
      .maybeSingle();
    profile_id = data?.id ?? null;
  }

  const { error } = await db.from("client_errors").insert({
    kind, message, stack, url, user_agent, build, auth_user_id, profile_id, extra, ip_hash,
  });
  if (error) {
    console.error("report-error insert failed:", error.message);
    return json({ error: "Insert failed" }, 500);
  }
  return json({ ok: true });
});
