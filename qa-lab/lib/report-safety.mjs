// Shared by machine health assessments and human reports. Never render a
// provider credential copied into an otherwise useful error message.
export function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/\b(?:[spr]k_(?:live|test)_|sk-ant-|sb_(?:secret|publishable)_|whsec_|AIza)[A-Za-z0-9_-]+/g, '[REDACTED KEY]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED KEY]')
    .replace(/\bBearer\s+[^\s"'<>,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|AUTHORIZATION)[A-Z0-9_]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;<>]+)/gi, '$1[REDACTED]')
    .replace(/\b(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@');
}
export const escapeHtml = value => redact(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
