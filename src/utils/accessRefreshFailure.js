/**
 * A failed membership check, as the operator sees it (ticket fe321c16).
 *
 * The report says where the check stopped (token, network, timeout, the
 * server's HTTP status, an unreadable answer) and nothing about who: no
 * account id, address, token, server text or record. The client error
 * reporter adds its usual envelope. One report per session per failure code,
 * so a phone that fails on every resume sends one row, not hundreds.
 */

const PHASES = new Set(["config", "session", "token", "network", "response", "http", "timeout"]);
const CODE = /^[a-z][a-z_]{0,63}$/;

/** The failure as a few fixed words and a status number. Never throws. */
export function describeAccessRefreshFailure(error) {
  const phase = PHASES.has(error?.phase) ? error.phase
    : /could not be verified/i.test(String(error?.message ?? "")) ? "invalid" : "unknown";
  const during = phase === "timeout" && PHASES.has(error?.during) ? error.during : null;
  const httpStatus = Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null;
  const code = typeof error?.code === "string" && CODE.test(error.code) ? error.code : null;
  return { phase, during, httpStatus, code };
}

/**
 * The reporter the refresh loop calls on every failure; it sends each code
 * once. Enrollment (bootstrap-launch-access) has its own reporter, named so,
 * with its own set of codes already sent.
 */
export function createAccessRefreshReporter(report, { label = "Membership check failed", event = "access_refresh_failed" } = {}) {
  const sent = new Set();
  return error => {
    const failure = describeAccessRefreshFailure(error);
    const key = [failure.phase, failure.during, failure.httpStatus, failure.code].filter(part => part != null).join(":");
    if (sent.has(key)) return false;
    sent.add(key);
    try {
      report(`${label} (${key})`, "error", { event, ...failure });
    } catch { /* Reporting must never stop the retry. */ }
    return true;
  };
}
