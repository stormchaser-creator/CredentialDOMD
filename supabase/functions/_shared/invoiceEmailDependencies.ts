/**
 * send-invoice-email, the I/O: Clerk identity, the service-role database,
 * Storage and Resend. Every decision is in invoiceEmailHandler.mjs; this file
 * only answers its questions, so the rules are tested without any of this.
 *
 * Tables touched (service role):
 *   profiles, invoices, travel_expenses, documents      read
 *   invoices.last_emailed_at / last_emailed_to          written alone after a confirmed send
 *   invoice_email_sends                                 the sent-once ledger (migration 20260925130000)
 *   send_reservations via reserve_send()                the hourly cap shared with send-packet-email
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clerkProfile } from "./clerkAuth.ts";
import { storageSubjects } from "./clerkContinuity.ts";

const BUCKET = "documents";
const SENDS_PER_HOUR = 30;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export function invoiceEmailDependencies() {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const resendApi = (env("RESEND_API_BASE") || "https://api.resend.com").replace(/\/$/, "");
  let client: SupabaseClient | null = null;
  const db = () => client ||= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // The same shape credentialPortalDependencies.ts uses: an error is thrown,
  // and the handler answers it as "could not reach your invoice" (503).
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>, what: string): Promise<unknown> => {
    const { data, error } = await query;
    if (error) throw new Error(`${what} failed: ${(error as { message?: string })?.message ?? String(error)}`);
    return data;
  };

  return {
    configured: () => !!(env("RESEND_API_KEY") && env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY")),

    async authenticate(req: Request) {
      const who = await clerkProfile(req);
      return who ? { profileId: who.profileId, clerkSubject: who.clerkSubject } : null;
    },

    // accessWriteDecision calls credentialdo_service_write_snapshot through this.
    accessDb: { rpc: (name: string, args: Record<string, unknown>) => db().rpc(name, args) },

    reserveSend: (profileId: string, since: string) =>
      db().rpc("reserve_send", { p_user: profileId, p_limit: SENDS_PER_HOUR, p_since: since }),

    /** Size of one Storage object, without reading its bytes; null when it is not there. */
    async probeFile(path: string): Promise<{ size: number } | null> {
      const bucket = db().storage.from(BUCKET) as unknown as {
        info?: (p: string) => Promise<{ data: { size?: number } | null; error: unknown }>;
        list: (p: string, o: Record<string, unknown>) => Promise<{ data: Row[] | null; error: unknown }>;
      };
      // info() (a HEAD-like read of the object's row) when this client has
      // it; any failure falls through to a folder listing, so an older
      // storage API reports a present receipt as present.
      if (typeof bucket.info === "function") {
        try {
          const { data, error } = await bucket.info(path);
          if (!error && data && Number(data.size) > 0) return { size: Number(data.size) };
        } catch { /* fall through to list */ }
      }
      const slash = path.indexOf("/");
      const folder = path.slice(0, slash);
      const name = path.slice(slash + 1);
      const { data, error } = await bucket.list(folder, { search: name, limit: 10 });
      if (error || !Array.isArray(data)) return null;
      const hit = data.find((o) => o?.name === name);
      const size = Number(hit?.metadata?.size);
      return hit && size > 0 ? { size } : null;
    },

    /** The object's bytes, or null when it cannot be read or is over `limit`. */
    async readFile(path: string, limit: number): Promise<Uint8Array | null> {
      const { data, error } = await db().storage.from(BUCKET).download(path);
      if (error || !data) {
        console.error(`send-invoice-email: storage download failed for ${path}: ${(error as { message?: string })?.message ?? "no data"}`);
        return null;
      }
      if (data.size > limit) return null;
      return new Uint8Array(await data.arrayBuffer());
    },

    /**
     * One POST to Resend. "sent" with the id, "failed" when Resend answered
     * that it did not take the message, "unknown" when it may have (no answer,
     * a timeout, a server error, an idempotency conflict).
     */
    async sendMail(payload: Record<string, unknown>, idempotencyKey: string) {
      let response: Response;
      try {
        response = await fetch(`${resendApi}/emails`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env("RESEND_API_KEY")}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        console.error("send-invoice-email: Resend gave no answer:", err instanceof Error ? err.message : String(err));
        return { state: "unknown" };
      }
      let text = "";
      try { text = await response.text(); } catch { /* the status still says what happened */ }
      if (response.ok) {
        let id: string | null = null;
        try { id = (JSON.parse(text) as { id?: string }).id ?? null; } catch { /* body not JSON */ }
        return { state: "sent", providerId: id };
      }
      console.error("send-invoice-email: Resend refused:", response.status, text.slice(0, 300));
      return { state: [400, 401, 403, 404, 422, 429].includes(response.status) ? "failed" : "unknown" };
    },

    store: {
      profile: (id: string) => checked(db().from("profiles")
        .select("id, name, degree_type, email, verified_email, auth_user_id").eq("id", id).maybeSingle(), "profile read"),

      invoice: (profileId: string, id: string) => checked(db().from("invoices")
        .select("id, user_id, number, kind, entry_ids, contract_id, last_emailed_at, last_emailed_to")
        .eq("id", id).eq("user_id", profileId).maybeSingle(), "invoice read"),

      expenses: (profileId: string, invoiceId: string) => checked(db().from("travel_expenses")
        .select("id, invoice_id").eq("user_id", profileId).eq("invoice_id", invoiceId), "expense read"),

      receiptDocuments: (profileId: string, links: string[]) => checked(db().from("documents")
        .select("id, user_id, name, mime_type, type, storage_path, size_bytes, linked_to")
        .eq("user_id", profileId).in("linked_to", links), "receipt read"),

      storageSubjects: (profileId: string) => storageSubjects(db(), profileId),

      lastSend: (profileId: string, invoiceId: string) => checked(db().from("invoice_email_sends")
        .select("sent_at, recipient").eq("user_id", profileId).eq("invoice_id", invoiceId).eq("status", "sent")
        .order("sent_at", { ascending: false }).limit(1).maybeSingle(), "last send read"),

      findSend: (profileId: string, requestId: string) => checked(db().from("invoice_email_sends")
        .select("*").eq("user_id", profileId).eq("client_request_id", requestId).maybeSingle(), "send ledger read"),

      async insertSend(row: Row) {
        const { data, error } = await db().from("invoice_email_sends").insert(row).select("*").single();
        if (error && (error as { code?: string }).code === "23505") return { conflict: true };
        if (error) throw new Error(`send ledger insert failed: ${(error as { message?: string }).message}`);
        return data;
      },

      // Only a FAILED attempt is taken again, and only if nobody took it first.
      async reclaimSend(existing: Row, fields: Row) {
        const data = (await checked(db().from("invoice_email_sends")
          .update({ ...fields, status: "sending", attempts: existing.attempts + 1, provider_id: null, updated_at: new Date().toISOString() })
          .eq("id", existing.id).eq("status", "failed").eq("attempts", existing.attempts)
          .select("*"), "send ledger reclaim")) as Row[] | null;
        return data?.[0] ?? null;
      },

      // Only the attempt that claimed the row may finish it.
      finishSend: (claim: Row, status: string, extra: { providerId?: string | null; sentAt?: string } = {}) => checked(db().from("invoice_email_sends")
        .update({
          status, updated_at: new Date().toISOString(),
          ...(extra.providerId !== undefined ? { provider_id: extra.providerId } : {}),
          ...(extra.sentAt ? { sent_at: extra.sentAt } : {}),
        })
        .eq("id", claim.id).eq("attempts", claim.attempts).eq("status", "sending"), "send ledger finish"),

      // The two columns alone, updated_at untouched, never moved backwards.
      stampInvoice: (profileId: string, invoiceId: string, at: string, to: string) => checked(db().from("invoices")
        .update({ last_emailed_at: at, last_emailed_to: to })
        .eq("id", invoiceId).eq("user_id", profileId)
        .or(`last_emailed_at.is.null,last_emailed_at.lt."${at}"`), "invoice stamp"),
    },
  };
}
