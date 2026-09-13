/**
 * NOT DEPLOYED (removed 2026-09-13).
 *
 * This reads public.onboarding_queue, and that table does not exist in this
 * database, so every invocation ended in an error. It was deployed with no
 * caller check of any kind (verify_jwt is satisfied by the public anon key)
 * while holding the service role and a Resend key, which made it an
 * unauthenticated way to ask the project to send mail. Nothing in the app or
 * in cron calls it. The deployment was deleted; the source stays for the
 * record, and the queue table would have to come back before it means
 * anything.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Find pending emails that are due
  const now = new Date().toISOString();
  const { data: pendingEmails, error: fetchError } = await supabase
    .from("onboarding_queue")
    .select("*")
    .eq("status", "pending")
    .lte("send_at", now)
    .order("send_at", { ascending: true })
    .limit(10);

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!pendingEmails || pendingEmails.length === 0) {
    return new Response(JSON.stringify({ processed: 0, message: "No pending emails" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results: Array<{ id: string; status: string; error?: string }> = [];

  for (const email of pendingEmails) {
    // Load the template for this venture + sequence number
    const { data: template } = await supabase
      .from("email_templates")
      .select("*")
      .eq("venture_slug", email.venture_slug)
      .eq("template_type", "onboarding")
      .eq("sequence_number", email.email_number)
      .single();

    if (!template) {
      await supabase
        .from("onboarding_queue")
        .update({ status: "error", error: "Template not found" })
        .eq("id", email.id);
      results.push({ id: email.id, status: "error", error: "Template not found" });
      continue;
    }

    // Render the template
    const customerName = String(email.customer_name || "").trim() || "Doctor";
    const subject = template.subject.replace(/\{name\}/g, customerName);
    const body = template.body_html.replace(/\{name\}/g, customerName);

    // For now, mark as "ready" — actual sending via Postmark/SendGrid/Resend
    // will be wired when the email provider is configured
    await supabase
      .from("onboarding_queue")
      .update({
        status: "ready",
        // sent_at stamps only after a real provider send; a stub that marks
        // rows sent would make the live provider silently skip them
      })
      .eq("id", email.id);

    results.push({ id: email.id, status: "ready" });
  }

  return new Response(
    JSON.stringify({
      processed: results.length,
      results,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
