// send-welcome — fires from a DB trigger on every new waitlist signup and
// sends the founding-list welcome via Resend. The physician's first touch
// after "Join the list" arrives in their inbox within seconds.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const SECRET = Deno.env.get("WELCOME_HOOK_SECRET")!;
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const welcomeText = (first: string, position: number | null) => `Hi ${first},

You're on the list.${position ? ` You're number ${position}, and order matters here: founding spots come with founding terms when the doors open.` : ' Order matters here: founding spots come with founding terms when the doors open.'}

Quick background so you know what you joined. I'm a neurosurgeon working locums, and I built this because I was tracking licenses in a spreadsheet, chasing CME totals across four states, and finding out the hard way that an agency's remittance didn't match my own numbers. Now the app runs my actual practice every day: my licenses, my call schedules, my invoices, my case log.

One question, and I read every reply: what's the most painful part of credentialing or locums paperwork for you right now? Hit reply and tell me in one sentence. It genuinely shapes what I build next.

One email when early access opens. That's the deal.

Eric

--
Whit Whitney, DO
CredentialDOMD: credential tracking for physicians, by a physician
https://credentialdomd.com`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (req.headers.get("x-hook-secret") !== SECRET) return new Response("auth", { status: 401 });
  let record: Record<string, unknown> = {};
  try { record = (await req.json()).record || {}; } catch { /* bad body */ }
  const email = String(record.email || "").trim();
  const id = record.id as string | undefined;
  if (!email) return new Response("no email", { status: 400 });
  if (record.welcomed_at) return new Response("already welcomed", { status: 200 });

  const { count } = await supabase
    .from("early_access_leads")
    .select("*", { count: "exact", head: true })
    .lte("created_at", record.created_at as string);
  const tokens = String(record.name || "").trim().split(/\s+/)
    .filter((t, i) => !(i === 0 && /^(dr\.?|mr\.?|ms\.?|mrs\.?)$/i.test(t)));
  const first = tokens[0] || "Doctor";
  const position = count || null;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Eric Whitney, DO <whit@credentialdomd.com>",
      to: [email],
      reply_to: "stormchaser@elryx.com",
      subject: position ? `You're #${position} on the CredentialDOMD founding list` : "You're on the CredentialDOMD founding list",
      text: welcomeText(first, position),
    }),
  });
  const body = await r.text();
  if (r.ok && id) {
    const { error: upErr } = await supabase
      .from("early_access_leads")
      .update({ welcomed_at: new Date().toISOString() })
      .eq("id", id);
    if (upErr) console.error("welcomed_at stamp failed:", upErr.message);
  }
  if (!r.ok) console.error("resend failed:", r.status, body.slice(0, 300));
  return new Response(JSON.stringify({ sent: r.ok }), { headers: { "Content-Type": "application/json" } });
});
