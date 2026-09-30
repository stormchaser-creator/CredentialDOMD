import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5";
import { PRODUCTION_CLERK_ISSUER, readProductionIdentity, initializeProductionProfile, initializeRequest, mayLoadAccount } from "../_shared/clerkContinuity.ts";

const ISSUER = Deno.env.get("CLERK_ISSUER") || "";
const ENABLED = Deno.env.get("CLERK_CONTINUITY_ENABLED") === "true";
const SECRET = Deno.env.get("CLERK_SECRET_KEY") || "";
const jwks = createRemoteJWKSet(new URL(`${PRODUCTION_CLERK_ISSUER}/.well-known/jwks.json`));
const cors = { "Access-Control-Allow-Origin": "https://credentialdomd.com", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!ENABLED || ISSUER !== PRODUCTION_CLERK_ISSUER) return json(503, { error: "continuity_disabled" });
  if (req.headers.get("Origin") && req.headers.get("Origin") !== "https://credentialdomd.com") return json(403, { error: "origin_not_allowed" });
  let subject: string;
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"] });
    if (typeof payload.sub !== "string" || !/^user_[A-Za-z0-9]+$/.test(payload.sub)) throw new Error();
    subject = payload.sub;
  } catch { return json(401, { error: "not_signed_in" }); }
  try {
    // {} from every build before release/qa1; {"honorsDataDeletion":true}
    // from an app that purges its device copy for a receipt's dataDeletedAt.
    const request = initializeRequest(await req.text());
    if (!request) return json(400, { error: "empty_object_required" });
    const identity = await readProductionIdentity(subject, SECRET);
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const receipt = await initializeProductionProfile(db, identity, ISSUER, {
      sourceSecret: Deno.env.get("CLERK_CONTINUITY_SOURCE_SECRET_KEY"), sourceIssuer: Deno.env.get("CLERK_CONTINUITY_SOURCE_ISSUER"),
    });
    // An account whose data was deleted is never handed to a build that would
    // push its pre-deletion copy back into it (mayLoadAccount). That build
    // stops on its "could not be verified" screen, reporting
    // ID-INIT-UNAVAILABLE-H426, until its own update check loads the app.
    if (!mayLoadAccount(receipt, request)) return json(426, { error: "app_update_required" });
    return json(200, receipt);
  } catch (error) {
    const code = error instanceof Error ? error.message : "continuity_unavailable";
    const safe = ["identity_conflict", "account_unavailable", "verified_primary_required", "source_identity_unavailable"];
    return json(safe.includes(code) ? 409 : 503, { error: safe.includes(code) ? code : "continuity_unavailable" });
  }
});
