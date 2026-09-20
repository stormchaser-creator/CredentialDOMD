import { SUPPORT_OPERATIONS_ENABLED } from "./supportOperationsClient";

const SUPPORT_ACTOR_ID = "00000000-0000-4000-8000-000000000018";

/** Only the protected service columns establish an automated author. Historical
 * owner IDs/admin flags were also used by agents, so they do not prove "You". */
export function adminSupportActorLabel(message, protectedMetadata = false) {
  if (protectedMetadata && message.author_id === null &&
      message.support_actor_id === SUPPORT_ACTOR_ID && message.support_job_id) {
    return "CredentialDOMD Support · Automated";
  }
  return "Reply";
}

export async function loadAdminSupportThread(client, ticketId, enabled = SUPPORT_OPERATIONS_ENABLED) {
  const fields = "id,ticket_id,body,is_admin_reply,created_at,author_id,attachment_path,attachment_paths,support_actor_id,support_job_id";
  const result = await client.from(enabled ? "support_messages" : "ticket_thread")
    .select(enabled ? fields : "*").eq("ticket_id", ticketId)
    .order("created_at", { ascending: true }).order("id", { ascending: true });
  return { ...result, data: result.error ? null : (result.data || []).map(message => ({
    ...message, support_display_label: adminSupportActorLabel(message, enabled),
  })) };
}
