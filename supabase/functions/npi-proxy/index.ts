/**
 * npi-proxy — Supabase Edge Function
 * Proxies NPPES NPI Registry API to bypass browser CORS restrictions.
 *
 * Deploy: supabase functions deploy npi-proxy --no-verify-jwt
 *
 * Usage (client):
 *   const res = await fetch(`${SUPABASE_URL}/functions/v1/npi-proxy?number=1234567890`);
 *   const data = await res.json();
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { fetchNppes } from "../_shared/nppes.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // Forward all query params to NPPES. The registry call itself (base URL,
    // User-Agent, timeout) lives in _shared/nppes.ts so public-record makes
    // the identical call.
    const url = new URL(req.url);
    const upstream = await fetchNppes(url.searchParams.toString());

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `NPPES returned ${upstream.status}` }),
        { status: upstream.status, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify(upstream.data), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
