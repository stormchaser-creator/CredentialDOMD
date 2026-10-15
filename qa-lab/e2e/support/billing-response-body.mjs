// Observe bytes the unchanged app actually reads. Chromium interception can
// discard its separate DevTools copy after a manually consumed stream.
import { randomUUID } from 'node:crypto';
import { verifiedSignupSessionSubject } from './profile-ready-signup.mjs';

export const BILLING_BODY_PATHS = ['/functions/v1/billing-quote', '/functions/v1/limited-checkout', '/functions/v1/limited-refund'];
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SUBJECT = /^user_qa[A-Za-z0-9]{1,120}$/;

/** Serialized into the test page; no imports, extra reads, clones or requests. */
export function instrumentBillingReads(settings) {
  'use strict';
  const { origin, binding, nonce } = settings;
  const paths = new Set(['/functions/v1/billing-quote', '/functions/v1/limited-checkout', '/functions/v1/limited-refund']);
  const nativeFetch = globalThis.fetch;
  // getRandomValues is available on the initial about:blank page too.
  const documentId = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let sequence = 0;
  const emit = value => { try { Promise.resolve(globalThis[binding]({ nonce, ...value })).catch(() => {}); } catch { /* Observation never changes the app. */ } };
  globalThis.fetch = function (...args) {
    let entry;
    try {
      const input = args[0], init = args[1], url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      if (url.origin === origin && paths.has(url.pathname) && !url.search && !url.hash && method === 'POST') {
        const session = globalThis.window?.Clerk?.session;
        entry = { id: `${documentId}:${++sequence}`, url: url.href, method, accountId: session?.user?.id, sessionId: session?.id, session };
        emit({ phase: 'start', id: entry.id, url: entry.url, method, accountId: entry.accountId, sessionId: entry.sessionId });
      }
    } catch { /* Leave malformed requests to native fetch. */ }
    let result;
    try { result = Reflect.apply(nativeFetch, this, args); }
    catch (error) { if (entry) emit({ phase: 'failed', id: entry.id, problem: 'fetch_threw' }); throw error; }
    if (!entry) return result;
    const failure = problem => emit({ phase: 'failed', id: entry.id, problem });
    Promise.resolve(result).then(response => {
      try {
        const body = response.body;
        if (!body || Number(response.headers.get('content-length')) > 65536) { failure('body_unavailable_or_oversized'); return; }
        const open = body.getReader;
        let opened = false, finished = false, size = 0;
        const chunks = [];
        body.getReader = function (...readerArgs) {
          const reader = Reflect.apply(open, this, readerArgs);
          if (opened) { failure('multiple_readers'); return reader; }
          opened = true;
          try {
          const read = reader.read;
          reader.read = function (...readArgs) {
            let readResult;
            try { readResult = Reflect.apply(read, this, readArgs); }
            catch (error) { failure('read_threw'); throw error; }
            Promise.resolve(readResult).then(part => {
              try {
                if (finished) return;
                if (globalThis.window?.Clerk?.session !== entry.session || entry.session?.user?.id !== entry.accountId) { finished = true; failure('session_changed'); return; }
                if (!part.done) {
                  if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > 65536) { finished = true; failure('body_oversized_or_invalid'); return; }
                  chunks.push(part.value.slice()); return;
                }
                finished = true;
                const bytes = new Uint8Array(size); let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                let text;
                try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { failure('invalid_utf8'); return; }
                emit({ phase: 'complete', id: entry.id, accountId: entry.accountId, sessionId: entry.sessionId, status: response.status, text, bytes: size });
              } catch { finished = true; failure('observation_failed'); }
            }, () => { finished = true; failure('read_rejected'); }).catch(() => {});
            return readResult;
          };
          } catch { failure('reader_observer_unavailable'); }
          return reader;
        };
      } catch { failure('observer_unavailable'); }
    }, () => failure('fetch_rejected')).catch(() => {});
    return result;
  };
}

/** The observer's JSON is corroborated by the real Playwright Request/Response. */
export async function installBillingBodyObserver(page, { origin, jwk, issuer, authorizedParty, timeoutMs = 60000 }) {
  const url = new URL(origin);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('Invalid bounded billing response wait');
  if (url.origin !== origin || !LOCAL.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw Error('Billing observation requires an exact local origin');
  const nonce = randomUUID(), binding = `qaBillingBody${randomUUID().replaceAll('-', '')}`;
  const waiting = new Map(), active = new Map();
  let stopped = false;
  const refuse = (entry, reason) => { if (!entry || entry.done) return; entry.done = true; clearTimeout(entry.timer); active.delete(entry.id); waiting.delete(entry.path); entry.reject(Error(`Billing response evidence unavailable: ${reason}`)); };
  const onRequest = request => {
    // Browser binding callbacks and network events can arrive in either order.
    const matches = [...waiting.values()].filter(entry => !entry.done && `${origin}${entry.path}` === request.url() && request.method() === 'POST');
    for (const entry of matches) {
      if (entry.request) refuse(entry, 'ambiguous request');
      else { entry.request = request; entry.requestAt = Date.now(); }
    }
  };
  page.on('request', onRequest);
  await page.exposeBinding(binding, async (source, message) => {
    if (stopped || source.page !== page || source.frame !== page.mainFrame() || message?.nonce !== nonce || !/^[a-f0-9]{32}:[1-9][0-9]*$/.test(message?.id || '')) return;
    if (message.phase === 'start') {
      let incoming; try { incoming = new URL(message.url); } catch { return; }
      const entry = waiting.get(incoming.pathname);
      if (!entry || message.url !== `${origin}${entry.path}` || message.method !== 'POST') return;
      if (entry.id !== undefined) { refuse(entry, 'overlapping request'); return; }
      if (message.accountId !== entry.accountId || !/^sess_qa[A-Za-z0-9]+$/.test(message.sessionId || '')) { refuse(entry, 'wrong current actor'); return; }
      Object.assign(entry, { id: message.id, url: message.url, sessionId: message.sessionId }); active.set(entry.id, entry); return;
    }
    const entry = active.get(message.id);
    if (!entry || entry.done) return;
    if (message.phase !== 'complete') { refuse(entry, 'incomplete body'); return; }
    if (entry.completing) { refuse(entry, 'duplicate completion'); return; }
    entry.completing = true;
    try {
      if (!entry.request || message.accountId !== entry.accountId || message.sessionId !== entry.sessionId || !Number.isInteger(message.status) || !entry.statuses.includes(message.status)
        || typeof message.text !== 'string' || !Number.isInteger(message.bytes) || message.bytes < 0 || message.bytes > 65536
        || Buffer.byteLength(message.text) !== message.bytes) throw Error('unmatched response');
      const response = await entry.request.response();
      if (!response || response.status() !== message.status || response.url() !== entry.url) throw Error('status mismatch');
      const accountId = verifiedSignupSessionSubject(await entry.request.headerValue('authorization'), {
        jwk, issuer, authorizedParty, sessionId: entry.sessionId, now: entry.requestAt,
      });
      if (accountId !== entry.accountId) throw Error('unverified request actor');
      const value = JSON.parse(message.text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid JSON shape');
      if (entry.done) return;
      entry.done = true; clearTimeout(entry.timer); active.delete(entry.id); waiting.delete(entry.path);
      // Same public interface the existing assertions/edge evidence consume;
      // all values are from this exact observed request, never from a DB read.
      entry.resolve({ status: () => response.status(), url: () => response.url(), request: () => entry.request,
        text: async () => message.text, json: async () => JSON.parse(message.text) });
    } catch { refuse(entry, 'verification failed'); }
  });
  const settings = { origin, binding, nonce };
  await page.addInitScript(instrumentBillingReads, settings);
  await page.evaluate(instrumentBillingReads, settings);
  return {
    next(path, accountId, statuses = [200]) {
      if (stopped || !BILLING_BODY_PATHS.includes(path) || !SUBJECT.test(accountId || '') || waiting.has(path)
        || !Array.isArray(statuses) || !statuses.length || statuses.some(status => ![200, 401, 409].includes(status))) throw Error('Invalid billing response wait');
      const promise = new Promise((resolve, reject) => {
        const entry = { path, accountId, statuses: [...statuses], resolve, reject };
        entry.timer = setTimeout(() => refuse(entry, 'timeout'), timeoutMs); waiting.set(path, entry);
      });
      // Callers arm before the click/sign-in; retain rejection until awaited.
      promise.catch(() => {}); return promise;
    },
    stop() { stopped = true; page.off('request', onRequest); for (const entry of waiting.values()) refuse(entry, 'observer stopped'); },
  };
}
