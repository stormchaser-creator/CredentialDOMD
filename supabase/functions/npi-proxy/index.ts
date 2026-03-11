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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NPPES_BASE = "https://npiregistry.cms.hhs.gov/api/?version=2.1";

serve(async (req) => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // Forward all query params to NPPES
    const url = new URL(req.url);
    const params = url.searchParams.toString();
    const upstreamUrl = params ? `${NPPES_BASE}&${params}` : NPPES_BASE;

    const upstream = await fetch(upstreamUrl, {
      headers: {
        "User-Agent": "CredentialDOMD/1.0 (+https://credentialdomd.com)",
        "Accept": "application/json",
      },
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `NPPES returned ${upstream.status}` }),
        { status: upstream.status, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const data = await upstream.json();
    return new Response(JSON.stringify(data), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
