// What the host keeps of a model session besides its structured result: the
// CLI's stderr (runs/<run>/sessions/) and the last error line in the run
// record and the log. None of it may hold a credential, whatever the CLI or a
// program it ran printed there. redactSecrets() removes
//   - the exact values given (the runner's own model credential);
//   - token shapes: sk-ant-, sk-, sbp_, sb_secret_, gh?_, github_pat_, xox?-,
//     AKIA, AIza, Stripe sk_/pk_/rk_/whsec_, a JWT, a private key block;
//   - a value after "Bearer", "Basic" or a key, token, secret, password or
//     authorization name followed by ":" or "=";
//   - any other run of 24 or more letters, digits, "_", "+" or "=" holding
//     both a letter and a digit (an opaque key). Hyphens and slashes end a
//     run, so ids (UUIDs), paths and names survive.
// It is a filter for text written to disk and logs, not a secret scanner:
// the gates (gates/personal-data.mjs) are what keep secrets out of commits.
export const REDACTED = '[redacted]';
const SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:sbp|sb_secret|sb_publishable)_[A-Za-z0-9_]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{10,}/g,
];
const SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const NAMED = /([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|authorization|credentials?)["']?\s*[:=]\s*["']?)([^\s"',;&]{6,})/gi;
const OPAQUE = /[A-Za-z0-9_+=]{24,}/g;

export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const value = typeof secret === 'string' ? secret.trim() : '';
    if (value.length >= 8) out = out.split(value).join(REDACTED);
  }
  for (const shape of SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(SCHEME, (_, scheme) => `${scheme} ${REDACTED}`);
  out = out.replace(NAMED, (_, name, value) => (value === REDACTED ? `${name}${value}` : `${name}${REDACTED}`));
  return out.replace(OPAQUE, run => (/[A-Za-z]/.test(run) && /\d/.test(run) ? REDACTED : run));
}

// One line of it for the run record and the log: no control characters,
// redacted, at most max characters.
export function redactedLine(text, secrets = [], max = 300) {
  const line = redactSecrets(String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' '), secrets).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
