// Complete local provider evidence. The inbox keeps only 500 recent attempts;
// this journal keeps every attempt until an explicit mock reset. A durable
// start marker precedes the HTTP request, so a crash or failed append cannot
// silently turn an unrecorded provider answer into a complete audit.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const badWindow = () => Object.assign(new Error('delivery audit requires an ISO since/until window of at most 24 hours'), { status: 400 });
const attemptShape = row => row && instant(row.at) && /^evt_[A-Za-z0-9]+$/.test(row.event) && typeof row.type === 'string' && row.type.length > 0 && /^[a-z][a-z0-9-]+$/.test(row.endpoint) && Number.isSafeInteger(row.attempt) && row.attempt >= 0;
const deliveryShape = row => attemptShape(row) && (row.status === null && row.dropped === true || Number.isInteger(row.status) && row.status >= 0 && row.status <= 599) && typeof row.response === 'string' && row.response.length <= 1000 && (row.object === null || typeof row.object === 'string') && (row.customer === null || typeof row.customer === 'string') && typeof row.willRetry === 'boolean' && typeof row.final === 'boolean';

export function createDeliveryAudit(file, { now = () => new Date().toISOString(), appendText = appendFileSync } = {}) {
  let failed = false, sequence = 0;
  const reset = () => { writeFileSync(file, JSON.stringify({ version: 1, startedAt: now() }) + '\n', { mode: 0o600 }); failed = false; sequence = 0; };
  const write = value => {
    try { appendText(file, JSON.stringify(value) + '\n', { mode: 0o600 }); }
    catch (error) { failed = true; throw error; }
  };
  if (!existsSync(file)) reset();
  for (const line of readFileSync(file, 'utf8').trimEnd().split('\n').slice(1)) {
    const row = JSON.parse(line);
    if (row.kind === 'attempt') {
      if (row.sequence !== sequence + 1) throw new Error('invalid delivery audit sequence');
      sequence = row.sequence;
    }
  }
  const begin = record => {
    const { event, type, endpoint, at, attempt } = record;
    if (!attemptShape(record)) throw new Error('invalid delivery audit attempt');
    const auditId = randomUUID();
    write({ kind: 'attempt', auditId, sequence: ++sequence, event, type, endpoint, at, attempt });
    return auditId;
  };
  return {
    reset, begin,
    append(record, auditId = null) {
      // Allow only evidence fields: never provider headers, tokens or bodies.
      const { event, type, endpoint, status, response, at, object, customer, attempt, willRetry, final, dropped } = record;
      if (!deliveryShape(record)) throw new Error('invalid delivery audit record');
      const id = auditId ?? begin(record); // dropped plans have no network request
      write({ kind: 'delivery', auditId: id, event, type, endpoint, status, response, at, object, customer, attempt, willRetry, final, ...(dropped ? { dropped: true } : {}) });
    },
    read({ since, until = now() } = {}) {
      if (failed) throw new Error('delivery audit write failed; evidence is incomplete');
      if (!instant(since) || !instant(until) || since > until || Date.parse(until) - Date.parse(since) > 86400000 || until > now()) throw badWindow();
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
      const head = JSON.parse(lines.shift());
      if (head.version !== 1 || !instant(head.startedAt)) throw new Error('invalid delivery audit header');
      const pending = new Map(), completed = new Set(), deliveries = [];
      let observedSequence = 0, crossingAttempts = 0;
      for (const line of lines) {
        const row = JSON.parse(line);
        if (!row.auditId || !attemptShape(row)) throw new Error('invalid delivery audit entry');
        if (row.kind === 'attempt') {
          if (pending.has(row.auditId) || completed.has(row.auditId) || row.sequence !== ++observedSequence) throw new Error('duplicate or unordered delivery audit attempt');
          pending.set(row.auditId, row);
        } else if (row.kind === 'delivery') {
          const started = pending.get(row.auditId);
          if (!deliveryShape(row) || !started || ['event', 'type', 'endpoint', 'attempt'].some(key => started[key] !== row[key]) || row.at < started.at) throw new Error('invalid delivery audit completion');
          pending.delete(row.auditId); completed.add(row.auditId);
          if (started.at <= until && row.at > until) crossingAttempts++;
          const { kind, auditId, ...delivery } = row;
          deliveries.push({ ...delivery, auditId, sequence: started.sequence, attemptStartedAt: started.at });
        } else throw new Error('invalid delivery audit entry kind');
      }
      const incompleteAttempts = crossingAttempts + [...pending.values()].filter(row => row.at <= until).length;
      return { since, until, startedAt: head.startedAt, complete: head.startedAt <= since && incompleteAttempts === 0, incompleteAttempts, deliveries: deliveries.filter(row => row.at >= since && row.at <= until) };
    },
  };
}
