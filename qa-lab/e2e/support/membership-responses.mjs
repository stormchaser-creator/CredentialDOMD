// Diagnostic evidence only: never classifies health errors or authorizes writes.
import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LAB_SECRETS_JSON } from '../../lib/paths.mjs';
import { PUBLIC_BILLING_POLICY } from '../../../supabase/functions/_shared/accessPolicy.mjs';

const ENDPOINT = '/functions/v1/billing-entitlements';
const SUBJECT = /^user_qa[A-Za-z0-9]{1,120}$/;
const STATES = new Set(['active', 'pending', 'revoked']);
const ERROR_CODES = new Set(['access_policy_unavailable', 'unauthorized', 'origin_not_allowed', 'method_not_allowed']);
const SCOPES = ['credential', 'practice'], OPERATIONS = ['read', 'write', 'export'];
const watched = new WeakMap();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const BODY_SHAPES = new Set(['unread', 'json_error_field', 'json_code_field', 'json_error_and_code_fields', 'json_object', 'json_array', 'json_scalar', 'html', 'non_json', 'oversized']);
// Field presence only: unknown gateway/provider strings are never copied.
const jsonShape = value => !object(value) ? Array.isArray(value) ? 'json_array' : 'json_scalar'
  : Object.hasOwn(value, 'error') ? Object.hasOwn(value, 'code') ? 'json_error_and_code_fields' : 'json_error_field'
    : Object.hasOwn(value, 'code') ? 'json_code_field' : 'json_object';

/** Verify with this lab's public key; a decoded/forged sub is never account evidence. */
export function verifiedMembershipSubject(authorization, { jwk, issuer, now = Date.now() }) {
  try {
    if (typeof authorization !== 'string' || authorization.length > 8192 || !authorization.startsWith('Bearer ')) return null;
    const parts = authorization.slice(7).split('.');
    if (parts.length !== 3 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const seconds = now / 1000;
    if (header.alg !== 'RS256' || header.kid !== jwk?.kid || jwk?.kty !== 'RSA' || claims.iss !== issuer
      || claims.aud !== 'authenticated' || claims.role !== 'authenticated' || !SUBJECT.test(claims.sub || '')
      || !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 5
      || !Number.isFinite(claims.nbf) || claims.nbf > seconds + 5) return null;
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    return verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')) ? claims.sub : null;
  } catch { return null; }
}

/** A deliberately small typed summary, not a claim that the app accepted every contract field. */
export function membershipBodySummary(status, body) {
  const bodyShape = jsonShape(body);
  if (!object(body)) return { bodyState: 'malformed_json_shape', bodyShape, snapshot: null, errorCode: null };
  if (status !== 200) return { bodyState: 'server_error', bodyShape, snapshot: null, errorCode: ERROR_CODES.has(body.error) ? body.error : null };
  if (body.schemaVersion !== 1 || body.policyVersion !== PUBLIC_BILLING_POLICY.version
    || !STATES.has(body.accessStatus) || typeof body.enforcementEnabled !== 'boolean' || typeof body.billingEnabled !== 'boolean'
    || typeof body.evaluatedAt !== 'string' || !Number.isFinite(Date.parse(body.evaluatedAt))
    || !SCOPES.every(scope => OPERATIONS.every(op => typeof body.capabilities?.[scope]?.[op] === 'boolean'))
    || body.accessStatus !== 'active' && SCOPES.some(scope => OPERATIONS.some(op => body.capabilities[scope][op]))) {
    return { bodyState: 'malformed_snapshot_summary', bodyShape, snapshot: null, errorCode: null };
  }
  return { bodyState: 'well_formed_snapshot_summary', bodyShape, errorCode: null, snapshot: {
    schemaVersion: 1, policyVersion: body.policyVersion, evaluatedAt: new Date(body.evaluatedAt).toISOString(),
    accessStatus: body.accessStatus, enforcementEnabled: body.enforcementEnabled, billingEnabled: body.billingEnabled,
    capabilities: Object.fromEntries(SCOPES.map(scope => [scope, Object.fromEntries(OPERATIONS.map(op => [op, body.capabilities[scope][op]]))])),
  } };
}

function publicKeyFromSavedLab() {
  // Read only. Never generate a key during observation or copy private fields into evidence.
  const key = JSON.parse(readFileSync(LAB_SECRETS_JSON, 'utf8')).signingKey;
  return { kty: key.kty, n: key.n, e: key.e, kid: key.kid };
}

/** All pages, including successful journeys, retain bounded response completion evidence. */
export function observeMembershipResponses(page, report, runtime, { jwk = publicKeyFromSavedLab(), now = Date.now, timeoutMs = 5000 } = {}) {
  const origins = new Set([runtime.urls.apiOrigin, runtime.urls.api, runtime.urls.appOrigin].filter(Boolean));
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Membership diagnostics require local lab origins');
  }
  const rows = report.membershipResponses ||= [], pending = new Set(), entries = new WeakMap();
  let disposed = false;
  const relevant = request => { try { const u = new URL(request.url()); return origins.has(u.origin) && u.pathname === ENDPOINT && !u.search; } catch { return false; } };
  const begin = (request, requestObserved = false) => {
    if (!relevant(request) || disposed) return null;
    if (entries.has(request)) return entries.get(request);
    const requestedAt = now();
    const row = { id: randomUUID(), method: ['POST', 'OPTIONS'].includes(request.method()) ? request.method() : 'OTHER', path: ENDPOINT,
      accountId: null, accountBinding: 'pending',
      requestObserved, observedAt: new Date(now()).toISOString(), startedAt: requestObserved ? new Date(now()).toISOString() : null, respondedAt: null, completedAt: null, status: null,
      completion: 'pending', bodyState: 'not_read', bodyShape: 'unread', snapshot: null, errorCode: null };
    entries.set(request, row); rows.push(row);
    // headers() may omit authentication fields. Read just this private header,
    // bounded separately, and keep verification tied to the request-time clock.
    let bindingTimer;
    const binding = Promise.resolve().then(() => request.headerValue('authorization')).then(authorization => {
      const subject = verifiedMembershipSubject(authorization, { jwk, issuer: runtime.issuer, now: requestedAt });
      return { accountId: subject, accountBinding: subject ? 'verified_local_signature' : 'unverified' };
    }).catch(() => ({ accountId: null, accountBinding: 'header_read_failed' }));
    const bindingJob = Promise.race([binding, new Promise(resolve => {
      bindingTimer = setTimeout(() => resolve({ accountId: null, accountBinding: 'header_read_timeout' }), timeoutMs);
    })]).then(value => Object.assign(row,value)).finally(() => { clearTimeout(bindingTimer); pending.delete(bindingJob); });
    pending.add(bindingJob);
    return row;
  };
  const onRequest = request => { begin(request, true); };
  const onFailed = request => { const row = entries.get(request) || begin(request); if (!row || row.completion !== 'pending') return; row.completion = 'request_failed'; row.completedAt = new Date(now()).toISOString(); };
  const onResponse = response => {
    const row = entries.get(response.request()) || begin(response.request());
    if (!row || row.respondedAt) return;
    row.respondedAt = new Date(now()).toISOString(); row.status = response.status();
    let timer;
    const capture = (async () => {
      if (await response.finished()) return { completion: 'response_failed', bodyState: 'not_read' };
      if (row.method !== 'POST') return { completion: 'finished', bodyState: 'not_applicable' };
      const text = await response.text();
      if (text.length > 65536) return { completion: 'finished', bodyState: 'body_too_large', bodyShape: 'oversized' };
      try { return { completion: 'finished', ...membershipBodySummary(row.status, JSON.parse(text)) }; }
      catch { return { completion: 'finished', bodyState: 'unreadable_json', bodyShape: /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(text) ? 'html' : 'non_json' }; }
    })().catch(() => ({ completion: 'capture_failed', bodyState: 'unavailable' }));
    const job = Promise.race([capture, new Promise(resolve => { timer = setTimeout(() => resolve({ completion: 'capture_timeout', bodyState: 'unavailable' }), timeoutMs); })])
      .then(result => { Object.assign(row, result, { completedAt: new Date(now()).toISOString() }); })
      .finally(() => { clearTimeout(timer); pending.delete(job); });
    pending.add(job);
  };
  page.on('request', onRequest); page.on('requestfailed', onFailed); page.on('response', onResponse);
  const observer = {
    async flush() { await Promise.all([...pending]); },
    async stop() {
      disposed = true;
      page.off('request', onRequest); page.off('requestfailed', onFailed); page.off('response', onResponse);
      await this.flush();
      for (const row of rows) if (row.completion === 'pending') { row.completion = 'unfinished_at_teardown'; row.completedAt = new Date(now()).toISOString(); }
    },
  };
  const group = watched.get(report) || new Set(); group.add(observer); watched.set(report, group);
  return observer;
}

export async function finishMembershipResponses(report) {
  await Promise.all([...(watched.get(report) || [])].map(observer => observer.stop()));
  watched.delete(report);
}

export function allowingMembershipResponse(row, accountId, startedAtOrAfter) {
  return SUBJECT.test(accountId || '') && row?.accountId === accountId && row.accountBinding === 'verified_local_signature'
    && (startedAtOrAfter === undefined || Number.isFinite(startedAtOrAfter) && Date.parse(row.startedAt) >= startedAtOrAfter)
    && row.requestObserved === true && row.method === 'POST' && row.path === ENDPOINT && row.status === 200 && row.completion === 'finished'
    && row.bodyState === 'well_formed_snapshot_summary' && row.snapshot?.enforcementEnabled === true
    && row.snapshot.accessStatus === 'active' && row.snapshot.capabilities?.credential?.write === true;
}

/** Serialized diagnostics never retain arbitrary annotations, headers, bodies or provider text. */
export function safeMembershipEvidence(row) {
  const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
  const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const completions = new Set(['pending', 'finished', 'request_failed', 'response_failed', 'capture_failed', 'capture_timeout', 'unfinished_at_teardown']);
  const bodyStates = new Set(['not_read', 'malformed_json_shape', 'server_error', 'well_formed_snapshot_summary', 'malformed_snapshot_summary', 'body_too_large', 'unreadable_json', 'unavailable', 'not_applicable']);
  if (!row || !uuid(row.id) || row.path !== ENDPOINT || !['POST','OPTIONS','OTHER'].includes(row.method)
    || !completions.has(row.completion) || !bodyStates.has(row.bodyState) || !time(row.observedAt) || typeof row.requestObserved !== 'boolean'
    || row.requestObserved && !time(row.startedAt)
    || !['pending','unverified','verified_local_signature','header_read_failed','header_read_timeout'].includes(row.accountBinding)
    || row.status !== null && (!Number.isInteger(row.status) || row.status < 100 || row.status > 599)) {
    return { completion: 'malformed_evidence', accountId: null, snapshot: null };
  }
  const accountId = row.accountBinding === 'verified_local_signature' && SUBJECT.test(row.accountId || '') ? row.accountId : null;
  const summary = row.snapshot ? membershipBodySummary(200,row.snapshot) : null;
  return { id: row.id, method: row.method, path: ENDPOINT, accountId,
    accountBinding: accountId ? 'verified_local_signature' : row.accountBinding === 'verified_local_signature' ? 'unverified' : row.accountBinding,
    requestObserved: row.requestObserved, observedAt: time(row.observedAt), startedAt: row.requestObserved ? time(row.startedAt) : null, respondedAt: time(row.respondedAt), completedAt: time(row.completedAt), status: row.status,
    completion: row.completion, bodyState: row.bodyState, bodyShape: BODY_SHAPES.has(row.bodyShape) ? row.bodyShape : 'unread',
    snapshot: summary?.snapshot || null, errorCode: ERROR_CODES.has(row.errorCode) ? row.errorCode : null };
}
