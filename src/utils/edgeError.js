/**
 * What an edge function actually said when it failed.
 *
 * supabase-js throws a FunctionsHttpError on any non-2xx and sets
 * `error.message` to the fixed string "Edge Function returned a non-2xx
 * status code". The function's real message ({ error: "..." }) is on
 * `error.context`, the raw Response. Code that reads `error.message`
 * therefore shows the user a sentence that names no cause and gives the
 * operator nothing to debug with, while the useful text sits one property
 * away. That is what a support ticket failing with "Edge Function returned
 * a non-2xx status code" looks like from the inside.
 *
 * `edgeErrorMessage` reads the body and falls back through the status line
 * to a caller-supplied default. It never throws: an error path that can
 * itself fail is worse than the bug it reports.
 */

const GENERIC = /non-2xx status code/i;

const BY_STATUS = {
  401: "You are signed out. Sign in and try again.",
  403: "Your account does not have access to that.",
  404: "That feature is not available on this build yet.",
  413: "That file is too large.",
  429: "Too many requests just now. Try again in a minute.",
  500: "The server hit an error handling that.",
  503: "The server is busy. Try again shortly.",
};

/**
 * @param {object} error  the `error` from supabase.functions.invoke
 * @param {string} fallback  what to say when the function said nothing useful
 * @returns {Promise<string>}
 */
export async function edgeErrorMessage(error, fallback = "That did not go through.") {
  if (!error) return fallback;

  const status = error.context?.status;

  // The function's own message wins: it is written for this exact failure.
  // The exception is a bare status word ("Unauthorized", "Forbidden"), which
  // is protocol jargon rather than something a physician can act on; there
  // the plain-language line for that status is the better answer.
  const BARE = /^(unauthorized|forbidden|not found|bad request|error)\.?$/i;
  try {
    const body = await error.context?.json?.();
    const said = body?.error || body?.message;
    if (said && typeof said === "string" && !BARE.test(said.trim())) return said;
    if (said && BARE.test(said.trim()) && status && BY_STATUS[status]) return BY_STATUS[status];
    if (said && typeof said === "string") return said;
  } catch { /* body was not JSON, or was already consumed */ }

  if (status && BY_STATUS[status]) return BY_STATUS[status];
  if (status) return `${fallback} (server said ${status})`;

  // Only fall back to error.message when it carries information. The generic
  // supabase-js string does not.
  if (error.message && !GENERIC.test(error.message)) return error.message;
  return fallback;
}

/**
 * The same unwrapping for callers that want the status and parsed body,
 * not just a sentence. Never throws; a transport failure comes back as
 * status 0.
 */
export async function invokeFn(supabase, name, options = {}) {
  try {
    const { data, error } = await supabase.functions.invoke(name, options);
    if (error) {
      let body = null;
      try { body = await error.context?.json?.(); } catch { /* not JSON */ }
      return {
        ok: false,
        status: error.context?.status || 0,
        data: body,
        message: await edgeErrorMessage({ ...error, context: { status: error.context?.status, json: async () => body } }),
      };
    }
    return { ok: true, status: 200, data, message: "" };
  } catch (e) {
    return { ok: false, status: 0, data: null, message: e?.message || "Could not reach the server." };
  }
}
