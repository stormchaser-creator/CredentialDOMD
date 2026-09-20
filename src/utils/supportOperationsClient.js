// Build flag only selects the new customer API. Server automation/mail gates stay independent.
export const SUPPORT_OPERATIONS_ENABLED = import.meta.env?.VITE_SUPPORT_OPERATIONS_ENABLED === "true";

export function supportActorLabel(message, ownProfileId = null) {
  if (message.identity_source === "support-operations") {
    return ({ automated: "CredentialDOMD Support · Automated", support: "Support team", you: "You", account: "Reply on your ticket", unknown: "Reply" })[message.actor_kind] || "Reply";
  }
  // Historical agents sometimes wrote under the ticket owner's ID. An admin flag
  // alone is not proof that Eric, or any particular human, wrote the message.
  if (ownProfileId && message.author_id === ownProfileId && !message.is_admin_reply) return "You";
  return "Reply";
}

export function supportMessageFromTeam(message) {
  return message.identity_source === "support-operations" && ["automated", "support"].includes(message.actor_kind);
}

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sessionUnavailable = () => new Error("Your sign-in changed. Reopen Support and try again.");

/** Separate client instance per account; pending requests live only in memory. */
export function createSupportOperationsClient({
  accountId, enabled = SUPPORT_OPERATIONS_ENABLED,
  url = import.meta.env?.VITE_SUPABASE_URL, anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session,
  fetchImpl = globalThis.fetch, uuid = () => crypto.randomUUID(),
} = {}) {
  const pending = new Map();
  const reconcile = rows => {
    const received = new Set(rows.map(row => row.request_id).filter(Boolean));
    for (const [key, entry] of pending) if (received.has(entry.requestId)) pending.delete(key);
  };
  async function request(input) {
    if (!enabled) throw new Error("The new support connection is not enabled.");
    if (!url || !anonKey) throw new Error("Support is not connected. Please try again later.");
    const session = getSession();
    if (!accountId || session?.user?.id !== accountId) throw sessionUnavailable();
    const token = await session.getToken();
    if (!token || getSession() !== session || session.user?.id !== accountId) throw sessionUnavailable();
    const response = await fetchImpl(`${url}/functions/v1/support-operations`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => null);
    if (getSession() !== session || session.user?.id !== accountId) throw sessionUnavailable();
    if (!response.ok || !data || data.error) {
      if (response.status === 401) throw sessionUnavailable();
      if (response.status === 404) throw new Error("This ticket is not available in your account.");
      throw new Error("Support could not confirm the request. Retry the same message or check Your tickets.");
    }
    return data;
  }
  async function submit(key, payload) {
    const fingerprint = JSON.stringify(payload);
    let entry = pending.get(key);
    if (entry && entry.fingerprint !== fingerprint) throw new Error("Your previous message may have been received. Retry it unchanged, or check Your tickets before starting a new message.");
    if (!entry) { entry = { requestId: uuid(), fingerprint }; pending.set(key, entry); }
    if (entry.promise) return entry.promise;
    entry.promise = (async () => {
      const data = await request({ ...payload, requestId: entry.requestId });
      if (data.state !== "queued" || !idPattern.test(data.ticket_id || "")) throw new Error("Support could not confirm receipt. Retry the same message or check Your tickets.");
      if (pending.get(key) === entry) pending.delete(key);
      return data;
    })();
    try { return await entry.promise; } finally { entry.promise = null; }
  }
  return {
    // Composer recovery after closing/reopening the modal. Return a fresh copy;
    // edits cannot alter the immutable payload or UUID of an uncertain request.
    createDraft: () => pending.has("create") ? JSON.parse(pending.get("create").fingerprint) : null,
    replyDraft: ticketId => pending.has(`reply:${ticketId}`) ? JSON.parse(pending.get(`reply:${ticketId}`).fingerprint) : null,
    create: ({ subject, body, category, priority }) => submit("create", { operation: "create_ticket", subject, body, category, priority }),
    reply: ({ ticketId, body }) => submit(`reply:${ticketId}`, { operation: "reply_ticket", ticketId, body }),
    async list() {
      const result = await request({ operation: "list_tickets" });
      if (!Array.isArray(result.tickets)) throw new Error("Could not load your tickets.");
      reconcile(result.tickets);
      return result.tickets;
    },
    async read(ticketId, beforeMessageId) {
      const result = await request({ operation: "read_ticket", ticketId, ...(beforeMessageId ? { beforeMessageId } : {}) });
      if (result.ticket?.id !== ticketId || !Array.isArray(result.messages) || result.messages.some(m => m.ticket_id !== ticketId)) throw new Error("Could not load this ticket.");
      reconcile([result.ticket, ...result.messages]);
      return { ...result, messages: result.messages.map(m => ({ ...m, identity_source: "support-operations" })) };
    },
  };
}
