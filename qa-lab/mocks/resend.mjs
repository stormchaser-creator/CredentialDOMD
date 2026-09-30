// Mock Resend: every email a lab function sends is kept here and shown in the
// lab inbox. Nothing is delivered anywhere.
//
//   POST /resend/emails, /resend/emails/batch     Resend's send API (Bearer = the lab's Resend key)
//   GET  /resend/emails/:id                       Resend's retrieve API
//   GET  /resend/emails/receiving/:id(/attachments) the Receiving API email-inbound reads
//   GET  /qa/emails, /qa/emails/:id, DELETE /qa/emails   the lab's JSON API
//   GET  /qa/inbox                                the inbox page
//   POST /qa/inbound                              simulate mail arriving at an @credentialdomd.com
//                                                 address: stored for the Receiving API, then a
//                                                 Svix-signed email.received webhook to email-inbound
import { createHash, randomUUID } from 'node:crypto';
import { randomAlnum } from '../lib/lab-secrets.mjs';
import { svixHeaders } from './signing.mjs';
import { HttpError, esc, html, json, readJson, send } from './http.mjs';

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);

/** How long Resend remembers an Idempotency-Key. */
export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
/** A stable hash of a request payload (key order ignored), to tell a retry from a different request under the same key. */
export function payloadHash(body) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return createHash('sha256').update(JSON.stringify(canon(body))).digest('hex');
}
/** Resend's answer to a key reused with a different payload within 24 hours. */
const idempotencyMismatch = () => new HttpError(409, 'Same idempotency key used with a different request payload.', {
  statusCode: 409, name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different request payload. Change your idempotency key or payload.',
});
const addressOf = (v) => (/<([^>]+)>/.exec(v)?.[1] || v || '').trim().toLowerCase();

export function createResendMock({ store, secrets, supabaseUrl, dockerBaseUrl, log = console.log }) {
  const auth = (req) => {
    if ((req.headers.authorization || '') !== `Bearer ${secrets.resend.apiKey}`) {
      throw new HttpError(401, 'API key is invalid', { statusCode: 401, name: 'validation_error', message: 'API key is invalid' });
    }
  };

  function validate(body) {
    if (!body || typeof body !== 'object') throw new HttpError(422, 'invalid body', { statusCode: 422, name: 'validation_error', message: 'Invalid body' });
    const to = list(body.to);
    if (!body.from || !to.length || typeof body.subject !== 'string') {
      throw new HttpError(422, 'from, to and subject are required', { statusCode: 422, name: 'validation_error', message: 'Missing `from`, `to` or `subject` field.' });
    }
  }
  // Resend: a repeat of an Idempotency-Key within 24 hours with the SAME payload
  // returns the first answer and sends nothing; with a DIFFERENT payload it is
  // refused 409 invalid_idempotent_request (and nothing is sent).
  const fresh = (at) => Date.now() - Date.parse(at) < IDEMPOTENCY_TTL_MS;
  function priorSend(idempotencyKey, hash) {
    const prior = store.state.emails.find((e) => e.idempotencyKey === idempotencyKey && fresh(e.created_at));
    if (!prior) return null;
    // Emails captured before payload hashes were kept count as the same payload.
    if (prior.idempotencyHash && prior.idempotencyHash !== hash) throw idempotencyMismatch();
    return { id: prior.id, duplicate: true };
  }

  function accept(body, idempotencyKey) {
    validate(body);
    const to = list(body.to);
    const hash = idempotencyKey ? payloadHash(body) : null;
    if (idempotencyKey) {
      const prior = priorSend(idempotencyKey, hash);
      if (prior) return prior;
    }
    const id = randomUUID();
    const email = {
      id, object: 'email', created_at: new Date().toISOString(), idempotencyKey: idempotencyKey || null,
      from: String(body.from), to, cc: list(body.cc), bcc: list(body.bcc), reply_to: list(body.reply_to ?? body.replyTo),
      subject: body.subject, html: typeof body.html === 'string' ? body.html : null, text: typeof body.text === 'string' ? body.text : null,
      headers: body.headers && typeof body.headers === 'object' ? body.headers : {}, tags: Array.isArray(body.tags) ? body.tags : [],
      attachments: (Array.isArray(body.attachments) ? body.attachments : []).map((a) => ({
        filename: a.filename || null, content_type: a.content_type || a.contentType || null,
        size: typeof a.content === 'string' ? Buffer.from(a.content, 'base64').length : null, content: typeof a.content === 'string' ? a.content : null, path: a.path || null,
      })),
      last_event: 'delivered',
    };
    store.putEmail(email);
    // The index keeps the idempotency key, so a retried send returns the first id (as Resend does).
    store.update((s) => { s.emails.unshift({ id, created_at: email.created_at, from: email.from, to: email.to, subject: email.subject, tags: email.tags, attachments: email.attachments.length, idempotencyKey: email.idempotencyKey, idempotencyHash: hash }); });
    log(`resend: captured "${email.subject}" to ${email.to.join(', ')}`);
    return { id };
  }

  function summary(meta) { return meta; }
  function matches(meta, q) {
    const to = q.get('to')?.toLowerCase();
    if (to && !meta.to.some((t) => addressOf(t) === to || t.toLowerCase().includes(to))) return false;
    const subject = q.get('subject')?.toLowerCase();
    if (subject && !meta.subject.toLowerCase().includes(subject)) return false;
    const since = q.get('since');
    if (since && Date.parse(meta.created_at) < Date.parse(since)) return false;
    const tag = q.get('tag');
    if (tag && !meta.tags.some((t) => `${t.name}=${t.value}` === tag || t.name === tag)) return false;
    return true;
  }

  // ── Inbound (Receiving API) ───────────────────────────────────────────────
  function inbound(body) {
    const from = String(body.from || '').trim();
    const to = list(body.to);
    if (!from || !to.length) throw new HttpError(400, 'from and to are required');
    const id = randomUUID();
    const now = new Date().toISOString();
    const messageId = body.messageId || `<qa-${randomAlnum(16)}@mx.qa.credentialdomd.test>`;
    const headers = { 'message-id': messageId, from, to: to.join(', '), subject: body.subject || '', date: new Date().toUTCString(), ...(body.headers || {}) };
    const attachments = (Array.isArray(body.attachments) ? body.attachments : []).map((a) => ({
      id: randomUUID(), filename: a.filename || 'file', content_type: a.content_type || a.contentType || 'application/octet-stream',
      content_disposition: a.inline ? 'inline' : 'attachment', content_id: a.content_id || null,
      content: typeof a.content === 'string' ? a.content : Buffer.from(String(a.text || '')).toString('base64'),
    }));
    const email = { id, from, to, cc: list(body.cc), bcc: [], reply_to: list(body.reply_to), subject: body.subject || '', html: body.html || null, text: body.text || null, headers, message_id: messageId, created_at: now, attachments };
    store.update((s) => { s.inbound[id] = email; });
    const event = { type: 'email.received', created_at: now, data: {
      email_id: id, created_at: now, from, to, cc: email.cc, bcc: [], received_for: to, message_id: messageId, subject: email.subject,
      attachments: attachments.map(({ id: aid, filename, content_type, content_disposition, content_id }) => ({ id: aid, filename, content_type, content_disposition, content_id })),
    } };
    return { email, event };
  }
  async function deliverInbound(event) {
    const payload = JSON.stringify(event);
    const headers = { 'Content-Type': 'application/json', ...svixHeaders(secrets.resend.webhookSecret, payload, { id: `msg_qa${randomAlnum(24)}` }) };
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/email-inbound`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(120000) });
      return { status: r.status, response: (await r.text()).slice(0, 2000) };
    } catch (e) { return { status: 0, response: `network: ${e.message}` }; }
  }
  const received = (id) => {
    const e = store.state.inbound[id];
    if (!e) throw new HttpError(404, 'not found', { statusCode: 404, name: 'not_found', message: 'Email not found' });
    return e;
  };
  const rawMessage = (e) => [
    ...Object.entries(e.headers).map(([k, v]) => `${k}: ${v}`), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', e.text || '',
  ].join('\r\n');

  function inboxPage(q) {
    const rows = store.state.emails.filter((m) => matches(m, q)).slice(0, 300);
    const selected = q.get('id') ? store.getEmail(q.get('id')) : null;
    const item = (m) => `<a class="row${selected?.id === m.id ? ' on' : ''}" href="?id=${esc(m.id)}${q.get('to') ? `&to=${esc(q.get('to'))}` : ''}"><b>${esc(m.subject)}</b><span>${esc(m.to.join(', '))}</span><small>${esc(m.created_at.replace('T', ' ').slice(0, 19))} &middot; ${esc(addressOf(m.from))}${m.attachments ? ` &middot; ${m.attachments} attachment(s)` : ''}</small></a>`;
    const detail = selected ? `<section class="detail">
      <h2>${esc(selected.subject)}</h2>
      <dl><dt>From</dt><dd>${esc(selected.from)}</dd><dt>To</dt><dd>${esc(selected.to.join(', '))}</dd>
      ${selected.cc.length ? `<dt>Cc</dt><dd>${esc(selected.cc.join(', '))}</dd>` : ''}${selected.reply_to.length ? `<dt>Reply-To</dt><dd>${esc(selected.reply_to.join(', '))}</dd>` : ''}
      <dt>Sent</dt><dd>${esc(selected.created_at)}</dd>${selected.tags.length ? `<dt>Tags</dt><dd>${esc(selected.tags.map((t) => `${t.name}=${t.value}`).join(', '))}</dd>` : ''}
      ${selected.attachments.length ? `<dt>Attachments</dt><dd>${selected.attachments.map((a) => esc(`${a.filename} (${a.content_type || '?'}, ${a.size ?? '?'} bytes)`)).join('<br>')}</dd>` : ''}
      <dt>JSON</dt><dd><a href="/qa/emails/${esc(selected.id)}">/qa/emails/${esc(selected.id)}</a></dd></dl>
      ${selected.html ? `<iframe sandbox="" src="/qa/emails/${esc(selected.id)}/html" title="HTML body"></iframe>` : ''}
      ${selected.text ? `<pre>${esc(selected.text)}</pre>` : ''}</section>` : '<section class="detail empty">Pick an email.</section>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA lab inbox</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--line:#ddd;--muted:#666;--accent:#0f766e}@media(prefers-color-scheme:dark){:root{--bg:#161616;--card:#202020;--line:#333;--muted:#aaa}}
body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg)}header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
h1{font-size:16px;margin:0}header form{display:flex;gap:6px;flex-wrap:wrap}input{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit}
button{padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
main{display:grid;grid-template-columns:minmax(260px,380px) 1fr;min-height:calc(100vh - 58px)}@media(max-width:760px){main{grid-template-columns:1fr}}
nav{border-right:1px solid var(--line);overflow:auto}.row{display:block;padding:10px 16px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.row.on{background:var(--card);box-shadow:inset 3px 0 var(--accent)}
.row b,.row span,.row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row span,.row small{color:var(--muted)}
.detail{padding:16px;min-width:0}.empty{color:var(--muted)}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
iframe{width:100%;height:60vh;border:1px solid var(--line);border-radius:8px;background:#fff}pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}</style></head>
<body><header><h1>QA lab inbox</h1><span style="color:var(--muted)">${store.state.emails.length} captured. Nothing here was sent.</span>
<form method="get"><input name="to" placeholder="to address" value="${esc(q.get('to') || '')}"><input name="subject" placeholder="subject contains" value="${esc(q.get('subject') || '')}"><button>Filter</button></form>
<form method="post" action="/qa/emails/clear" onsubmit="return confirm('Clear every captured email?')"><button>Clear inbox</button></form></header>
<main><nav>${rows.map(item).join('') || '<p class="row">No email yet.</p>'}</nav>${detail}</main></body></html>`;
  }

  function routes(router) {
    router.add('POST', '/resend/emails', async (req, res) => { auth(req); json(res, 200, { id: accept(await readJson(req), req.headers['idempotency-key']).id }); });
    router.add('POST', '/resend/emails/batch', async (req, res) => {
      auth(req);
      const body = await readJson(req);
      if (!Array.isArray(body)) throw new HttpError(422, 'batch body must be an array');
      // The key covers the whole batch: a retry with the same emails returns the first ids.
      const key = req.headers['idempotency-key'];
      const hash = key ? payloadHash(body) : null;
      if (key) {
        const prior = (store.state.batchIdempotency || []).find((b) => b.key === key && fresh(b.at));
        if (prior) {
          if (prior.hash !== hash) throw idempotencyMismatch();
          return json(res, 200, { data: prior.ids.map((id) => ({ id })) });
        }
      }
      for (const b of body) validate(b);
      const ids = body.map((b) => accept(b).id);
      if (key) store.update((s) => { s.batchIdempotency = [{ key, hash, ids, at: new Date().toISOString() }, ...(s.batchIdempotency || [])].slice(0, 500); });
      json(res, 200, { data: ids.map((id) => ({ id })) });
    });
    router.add('GET', '/resend/emails/receiving/:id', (req, res, { params }) => {
      auth(req);
      const e = received(params.id);
      json(res, 200, { object: 'email', id: e.id, from: e.from, to: e.to, cc: e.cc, bcc: e.bcc, reply_to: e.reply_to, subject: e.subject, html: e.html, text: e.text, headers: e.headers, message_id: e.message_id, created_at: e.created_at,
        attachments: e.attachments.map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type, size: Buffer.from(a.content, 'base64').length })),
        raw: { download_url: `${dockerBaseUrl}/resend/_raw/${e.id}`, expires_at: new Date(Date.now() + 3600e3).toISOString() } });
    });
    router.add('GET', '/resend/emails/receiving/:id/attachments', (req, res, { params }) => {
      auth(req);
      const e = received(params.id);
      json(res, 200, { object: 'list', data: e.attachments.map((a) => ({ id: a.id, filename: a.filename, size: Buffer.from(a.content, 'base64').length, content_type: a.content_type, content_disposition: a.content_disposition, content_id: a.content_id,
        download_url: `${dockerBaseUrl}/resend/_files/${e.id}/${a.id}`, expires_at: new Date(Date.now() + 3600e3).toISOString() })) });
    });
    // Signed-URL stand-ins (Resend's are unauthenticated URLs too).
    router.add('GET', '/resend/_files/:email/:att', (req, res, { params }) => {
      const a = received(params.email).attachments.find((x) => x.id === params.att);
      if (!a) throw new HttpError(404, 'not found');
      send(res, 200, Buffer.from(a.content, 'base64'), { 'Content-Type': a.content_type });
    });
    router.add('GET', '/resend/_raw/:email', (req, res, { params }) => send(res, 200, rawMessage(received(params.email)), { 'Content-Type': 'message/rfc822' }));
    router.add('GET', '/resend/emails/:id', (req, res, { params }) => {
      auth(req);
      const e = store.getEmail(params.id);
      if (!e) throw new HttpError(404, 'not found', { statusCode: 404, name: 'not_found', message: 'Email not found' });
      const { idempotencyKey, ...rest } = e;
      json(res, 200, rest);
    });

    router.add('GET', '/qa/emails', (req, res, { url }) => json(res, 200, { emails: store.state.emails.filter((m) => matches(m, url.searchParams)).map(summary) }));
    router.add('GET', '/qa/emails/:id', (req, res, { params }) => {
      const e = store.getEmail(params.id);
      if (!e) throw new HttpError(404, 'no such email');
      json(res, 200, e);
    });
    router.add('GET', '/qa/emails/:id/html', (req, res, { params }) => {
      const e = store.getEmail(params.id);
      if (!e?.html) throw new HttpError(404, 'no HTML body');
      // Shown in a sandboxed frame: no scripts, no remote loads.
      send(res, 200, e.html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" });
    });
    router.add('DELETE', '/qa/emails', (req, res) => { store.clearEmails(); json(res, 200, { cleared: true }); });
    router.add('POST', '/qa/emails/clear', (req, res) => { store.clearEmails(); send(res, 303, '', { Location: '/qa/inbox' }); });
    router.add('GET', '/qa/inbox', (req, res, { url }) => html(res, 200, inboxPage(url.searchParams)));
    router.add('POST', '/qa/inbound', async (req, res) => {
      const { email, event } = inbound(await readJson(req));
      const delivery = await deliverInbound(event);
      log(`resend: inbound "${email.subject}" to ${email.to.join(', ')} -> email-inbound ${delivery.status}`);
      json(res, 200, { emailId: email.id, delivery });
    });
  }
  return { routes, accept };
}
