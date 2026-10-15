// Attach only controlled offline harness output. Never attach environment maps,
// provider payloads, or the command's arbitrary extra properties.
import { redact } from '../../lib/report-safety.mjs';
import { redactSecrets } from '../../../scripts/ticket-fix/redact.mjs';

const CREDENTIAL = /(?:key|token|secret|password|authorization|credential)/i;
const PAYLOAD = /(?:\b(?:raw|provider)[ _.-]+(?:request|response|payload|body)\b|["']?\b(?:headers|body|payload|messages|content)["']?\s*[:=])/i;

export function sanitizeHostOutput(value, env = {}) {
  const secrets = Object.entries(env).filter(([name, value]) => CREDENTIAL.test(name) && typeof value === 'string' && value.length).map(([, value]) => value);
  let text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Exact environment values supplement the common credential shapes; short
  // credentials are removed too, even at the cost of less readable diagnostics.
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  text = redact(redactSecrets(text));
  let payloadIndent = null;
  let jsonDepth = 0, quote = null, escaped = false;
  const consumeJson = line => {
    for (const char of line) {
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{' || char === '[') jsonDepth += 1;
      else if (char === '}' || char === ']') jsonDepth -= 1;
    }
  };
  return text.split('\n').map(line => {
    const indent = line.match(/^\s*/)[0].length;
    if (jsonDepth > 0) {
      consumeJson(line);
      if (jsonDepth <= 0) { jsonDepth = 0; quote = null; payloadIndent = null; }
      return '[provider payload omitted]';
    }
    if (payloadIndent !== null) {
      // Pretty-printed JSON often opens at the label's indentation, not one
      // level deeper. Retain suppression through its balanced closing brace.
      if (/^\s*[{[]/.test(line)) {
        consumeJson(line);
        if (jsonDepth <= 0) { jsonDepth = 0; quote = null; payloadIndent = null; }
        return '[provider payload omitted]';
      }
      if (line.trim() && indent > payloadIndent) return '[provider payload omitted]';
      payloadIndent = null;
    }
    if (PAYLOAD.test(line)) {
      payloadIndent = indent;
      const start = line.search(/[{[]/);
      if (start >= 0) consumeJson(line.slice(start));
      if (jsonDepth < 0) jsonDepth = 0;
      return '[provider payload omitted]';
    }
    return line;
  }).join('\n');
}

/** Preserve both full streams, exit/signal/timeout evidence, without changing verdicts. */
export function hostCommandDiagnostics(result, { command, env = {} } = {}) {
  return {
    scope: 'local offline test harness; sanitized diagnostic output',
    command: Array.isArray(command) ? command.map(x => sanitizeHostOutput(x, env)) : [],
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: typeof result?.signal === 'string' ? sanitizeHostOutput(result.signal, env) : null,
    durationMs: Number.isFinite(result?.ms) ? result.ms : null,
    error: result?.error ? sanitizeHostOutput(result.error, env) : null,
    stdout: sanitizeHostOutput(result?.stdout, env),
    stderr: sanitizeHostOutput(result?.stderr, env),
  };
}
