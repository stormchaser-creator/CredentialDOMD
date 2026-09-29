const ENV = import.meta.env || {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const when = value => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What the administrator reads for each refusal. Every one says whether anything was sent. */
function message(code, extra = {}) {
  switch (code) {
    case "admin_required": return "Only an authorized administrator can send invitations. Nothing was sent.";
    case "unauthorized": return "Your sign-in could not be verified. Reopen Admin and try again. Nothing was sent.";
    case "session_changed": return "Your sign-in changed. Reopen Admin and try again. Nothing was sent.";
    case "invalid_email": return "Enter a valid email address. Nothing was sent.";
    case "invalid_name": return "Use letters, spaces and . , ' ( ) - in the name, up to 120 characters, or leave it blank. Nothing was sent.";
    case "inviter_incomplete": return "Add your name and email in Profile & settings first: the invitation says who it is from and replies go to you. Nothing was sent.";
    case "offer_unavailable": return "The current membership price could not be confirmed, so the invitation was not written. Nothing was sent. Try again in a minute.";
    case "preview_stale": return "The wording changed since your preview (usually because the public offer changed). Review the new text below, then send. Nothing was sent.";
    case "recently_invited": return `This address was already invited${date(extra.lastSentAt) ? ` on ${when(extra.lastSentAt)}` : ""}. Nothing was sent. To send it again anyway, tick "Send again" and send.`;
    case "send_in_progress": return "An invitation to this address is being sent right now. Nothing new was sent. Refresh the list in a minute.";
    case "daily_cap": return `The daily limit of ${Number.isInteger(extra.dailyCap) ? extra.dailyCap : 20} invitations is used up${date(extra.capResetsAt) ? `; the next one can go at ${when(extra.capResetsAt)}` : ""}. Nothing was sent.`;
    case "provider_refused": return "The email service refused this invitation, so it was not sent. Check the address and try again.";
    case "provider_unconfirmed": return "The email service did not confirm this invitation. It may or may not have gone out, so check with the person before sending again.";
    case "not_configured": return "Invitation email is not set up on the server yet. Nothing was sent.";
    default: return "The invitation could not be confirmed. Nothing is known to have been sent. Refresh the list before trying again.";
  }
}
function failure(code, extra) {
  const error = new Error(message(code, extra));
  error.code = code || "invite_unavailable";
  error.extra = extra || {};
  return error;
}
export const normalizeInviteAddress = value => (typeof value === "string" ? value.trim().toLowerCase() : "");
const tidyName = value => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
function checkedEmail(value) {
  const e = value && typeof value === "object" ? value : null;
  if (!e || ![e.from, e.to, e.replyTo, e.subject, e.text].every(v => typeof v === "string" && v.length > 0)) throw failure();
  return { from: e.from, to: e.to, replyTo: e.replyTo, subject: e.subject, text: e.text };
}

/** Authorization lives on the server. This transport pins the signed-in admin and stores nothing. */
export function createInviteToJoinClient({
  accountId, url = ENV.VITE_SUPABASE_URL, anonKey = ENV.VITE_SUPABASE_ANON_KEY,
  getSession = () => globalThis.window?.Clerk?.session, isCurrent = () => true,
  fetchImpl = globalThis.fetch, timeoutMs = 45000,
} = {}) {
  async function request(body) {
    const session = getSession();
    const current = () => isCurrent() && getSession() === session && session?.user?.id === accountId;
    if (!accountId || !url || !anonKey || !current()) throw failure("session_changed");
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); });
    try {
      const token = await Promise.race([session.getToken(), deadline]);
      if (!token || !current()) throw failure("session_changed");
      const response = await Promise.race([fetchImpl(`${url}/functions/v1/invite-to-join`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      }), deadline]);
      const text = await Promise.race([response.text(), deadline]);
      if (!current()) throw failure("session_changed");
      if (text.length > 65536) throw failure();
      let value;
      try { value = JSON.parse(text); } catch { throw failure(); }
      if (!response.ok || value?.error) {
        const { error: code, ...extra } = value || {};
        throw failure(typeof code === "string" ? code : undefined, extra);
      }
      if (value?.schemaVersion !== 1) throw failure();
      return value;
    } catch (error) { throw error?.code ? error : failure(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    /** The exact message that would be sent, and this address's history. Sends nothing. */
    async preview({ email, name } = {}) {
      const address = normalizeInviteAddress(email);
      if (address.length < 6 || address.length > 254 || !EMAIL.test(address)) throw failure("invalid_email");
      const who = tidyName(name);
      const value = await request({ action: "preview", email: address, ...(who ? { name: who } : {}) });
      const h = value.history || {};
      return {
        email: checkedEmail(value.email), name: who,
        history: { lastSentAt: date(h.lastSentAt) ? h.lastSentAt : null, cooldownUntil: date(h.cooldownUntil) ? h.cooldownUntil : null,
          sentInWindow: Number.isInteger(h.sentInWindow) ? h.sentInWindow : null, dailyCap: Number.isInteger(h.dailyCap) ? h.dailyCap : null },
      };
    },
    /** Send exactly the reviewed preview. Resolves only on a confirmed provider send. */
    async send(preview, { resend = false } = {}) {
      const email = checkedEmail(preview?.email);
      const value = await request({ action: "send", email: email.to, ...(preview.name ? { name: preview.name } : {}),
        subject: email.subject, text: email.text, ...(resend ? { resend: true } : {}) });
      if (value.state !== "sent" || !UUID.test(value.id || "") || value.to !== email.to
        || typeof value.providerId !== "string" || !value.providerId || !date(value.sentAt)) throw failure();
      return { id: value.id, to: value.to, providerId: value.providerId, sentAt: value.sentAt };
    },
    async list() {
      const value = await request({ action: "list" });
      if (!Array.isArray(value.sends)) throw failure();
      return value.sends.map(s => {
        if (!UUID.test(s?.id || "") || !EMAIL.test(s.email || "") || !date(s.createdAt)) throw failure();
        return { id: s.id, email: s.email, name: typeof s.name === "string" ? s.name : "", status: s.status,
          explicitResend: s.explicitResend === true, createdAt: s.createdAt, sentAt: date(s.sentAt) ? s.sentAt : null };
      });
    },
  };
}
