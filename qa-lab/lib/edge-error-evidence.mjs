// Supabase writes this informational line even for successful report-error
// requests. Its route name is not an error. Keep actual errors with that text.
export function edgeErrorEvidence(log) {
  const counts = new Map();
  for (const raw of String(log).split('\n')) {
    const line = raw.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '').trim();
    if (/^serving the request with supabase\/functions\/[a-z0-9-]+$/i.test(line)) continue;
    if (!/\b(error|uncaught|unhandled|exception)\b/i.test(line) || /console\.error\(\)|DeprecationWarning/.test(line)) continue;
    const key = line.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\s+/g, ' ').trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([line, n]) => ({ line, n })).sort((a, b) => b.n - a.n || a.line.localeCompare(b.line));
}
