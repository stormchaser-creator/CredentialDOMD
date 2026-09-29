// Mock Clerk: the test physicians, their sessions and tokens (what the app's
// QA sign-in uses in place of Clerk's frontend), the Backend API the edge
// functions call (/clerk/v1/users...), the issuer's JWKS, and Svix-signed
// user.created / user.updated / user.deleted webhooks to the local
// clerk-webhook function, sent the way Clerk sends them.
//
// Two instances, as in production: "live" (the production instance the app
// signs in to; its Backend API key is the lab's sk_live_ key) and "legacy"
// (the retired development instance the continuity flow reads with the lab's
// sk_test_ key). The key a request carries picks the instance.
import { randomAlnum } from '../lib/lab-secrets.mjs';
import { APP_PUBLIC_ORIGIN, LAB_EMAIL_DOMAIN, LAB_ISSUER, LAB_LEGACY_ISSUER, SUPABASE_TEMPLATE } from '../lib/lab-config.mjs';
import { signJwt, svixHeaders } from './signing.mjs';
import { HttpError, json, readJson } from './http.mjs';

const EMAIL_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@qa\.credentialdomd\.test$/;
const SESSION_TOKEN_SECONDS = 60;      // Clerk's default session token lifetime
const TEMPLATE_TOKEN_SECONDS = 3600;   // the "supabase" template's lifetime (CLERK-SUPABASE-SETUP.md)
const WEBHOOK_RETRY_MS = [2000, 10000, 30000];

const clerkError = (status, code, message, longMessage = message) => new HttpError(status, message, { errors: [{ message, long_message: longMessage, code }], clerk_trace_id: `qa_${randomAlnum(16)}` });

function avatar(first, last) {
  const initials = `${(first || '?')[0] || '?'}${(last || '')[0] || ''}`.toUpperCase().replace(/[^A-Z?]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#0f766e"/><text x="48" y="60" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Public (API) view of a stored user: Clerk Backend API shape. */
export const apiUser = (record) => record.data;

export function createClerkMock({ store, secrets, supabaseUrl, serviceRoleKey, log = console.log }) {
  const state = () => store.state.clerk;
  const instances = { live: { issuer: LAB_ISSUER, key: secrets.clerk.secretKey }, legacy: { issuer: LAB_LEGACY_ISSUER, key: secrets.clerk.legacySecretKey } };

  function instanceForKey(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const found = m && Object.entries(instances).find(([, v]) => v.key === m[1]);
    if (!found) throw clerkError(401, 'authentication_invalid', 'Invalid authentication', 'Unable to authenticate the request, you need to supply an active API key');
    return found[0];
  }

  const usersOf = (instance) => Object.values(state().users).filter((r) => r.instance === instance);
  const primaryEmail = (user) => user.email_addresses.find((e) => e.id === user.primary_email_address_id)?.email_address || null;

  function normalizeEmail(input, first, last) {
    let email = typeof input === 'string' && input.trim() ? input.trim().toLowerCase() : '';
    if (email && !email.includes('@')) email = `${email}@${LAB_EMAIL_DOMAIN}`;
    if (!email) {
      const slug = `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]+/g, '').replace(/^\.+|\.+$/g, '') || 'physician';
      email = `${slug}-${randomAlnum(5).toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
    }
    if (!EMAIL_RE.test(email)) throw new HttpError(400, `test physicians use addresses on @${LAB_EMAIL_DOMAIN} only`, { error: 'email_domain', message: `Use an address on @${LAB_EMAIL_DOMAIN}` });
    if (Object.values(state().users).some((r) => r.data.email_addresses.some((e) => e.email_address === email))) {
      throw new HttpError(409, 'that address is already a test physician', { error: 'email_taken', message: `${email} is already a test physician` });
    }
    return email;
  }

  function createUser(input = {}, fixture = null) {
    const firstName = String(input.firstName ?? 'Test').trim().slice(0, 60) || 'Test';
    const lastName = String(input.lastName ?? 'Physician').trim().slice(0, 60) || 'Physician';
    const instance = input.instance === 'legacy' ? 'legacy' : 'live';
    const email = normalizeEmail(input.email, firstName, lastName);
    const now = fixture?.updatedAt ?? Date.now();
    const emailId = `idn_qa${randomAlnum(24)}`;
    const verified = input.verified !== false;
    const data = {
      id: fixture?.id ?? `user_qa${randomAlnum(24)}`, object: 'user', username: null,
      first_name: firstName, last_name: lastName, image_url: avatar(firstName, lastName), has_image: false,
      primary_email_address_id: emailId, primary_phone_number_id: null, primary_web3_wallet_id: null,
      password_enabled: false, two_factor_enabled: false, totp_enabled: false, backup_code_enabled: false,
      email_addresses: [{
        id: emailId, object: 'email_address', email_address: email, reserved: false,
        verification: verified ? { status: 'verified', strategy: 'email_code', attempts: 1, expire_at: now + 600000 } : { status: 'unverified', strategy: 'email_code', attempts: 0, expire_at: now + 600000 },
        linked_to: [], matches_sso_connection: false, created_at: now, updated_at: now,
      }],
      phone_numbers: [], web3_wallets: [], passkeys: [], external_accounts: [], saml_accounts: [], enterprise_accounts: [],
      public_metadata: {}, private_metadata: input.privateMetadata && typeof input.privateMetadata === 'object' ? input.privateMetadata : {}, unsafe_metadata: {},
      external_id: typeof input.externalId === 'string' ? input.externalId : null,
      last_sign_in_at: null, banned: false, locked: false, lockout_expires_in_seconds: null, verification_attempts_remaining: 100,
      created_at: fixture?.createdAt ?? now, updated_at: now, delete_self_enabled: true, create_organization_enabled: true, last_active_at: null, legal_accepted_at: null,
    };
    store.update((s) => { s.clerk.users[data.id] = { instance, data, createdAt: new Date(now).toISOString() }; });
    log(`clerk: created ${instance} test physician ${data.id} <${email}>`);
    const delivery = instance === 'live' ? queueWebhook('user.created', data) : null;
    return { user: data, instance, webhook: delivery?.id || null };
  }

  function findUser(id, instance = null) {
    const record = state().users[id];
    if (!record || (instance && record.instance !== instance)) return null;
    return record;
  }

  function updateUser(id, patch = {}) {
    const record = findUser(id);
    if (!record) throw new HttpError(404, 'no such test physician');
    const u = record.data;
    const now = Math.max(Date.now(), u.updated_at + 1);
    if (typeof patch.firstName === 'string') u.first_name = patch.firstName.trim().slice(0, 60);
    if (typeof patch.lastName === 'string') u.last_name = patch.lastName.trim().slice(0, 60);
    if (typeof patch.verified === 'boolean') {
      const primary = u.email_addresses.find((e) => e.id === u.primary_email_address_id);
      primary.verification = { ...primary.verification, status: patch.verified ? 'verified' : 'unverified' };
      primary.updated_at = now;
    }
    if (typeof patch.email === 'string') {
      const email = normalizeEmail(patch.email, u.first_name, u.last_name);
      const emailId = `idn_qa${randomAlnum(24)}`;
      u.email_addresses.push({ id: emailId, object: 'email_address', email_address: email, reserved: false,
        verification: { status: 'verified', strategy: 'email_code', attempts: 1, expire_at: now + 600000 }, linked_to: [], matches_sso_connection: false, created_at: now, updated_at: now });
      if (patch.makePrimary !== false) u.primary_email_address_id = emailId;
    }
    if (typeof patch.banned === 'boolean') u.banned = patch.banned;
    if (typeof patch.locked === 'boolean') u.locked = patch.locked;
    u.image_url = avatar(u.first_name, u.last_name);
    u.updated_at = now;
    store.save();
    const delivery = record.instance === 'live' ? queueWebhook('user.updated', u) : null;
    return { user: u, webhook: delivery?.id || null };
  }

  function deleteUser(id) {
    const record = findUser(id);
    if (!record) throw new HttpError(404, 'no such test physician');
    store.update((s) => {
      delete s.clerk.users[id];
      for (const [sid, sess] of Object.entries(s.clerk.sessions)) if (sess.userId === id) s.clerk.sessions[sid].status = 'removed';
    });
    const delivery = record.instance === 'live' ? queueWebhook('user.deleted', { deleted: true, id, object: 'user' }) : null;
    return { deleted: true, id, webhook: delivery?.id || null };
  }

  // ── Sessions and tokens (the QA sign-in) ──────────────────────────────────
  function createSession(userId) {
    const record = findUser(userId, 'live');
    if (!record) throw new HttpError(404, 'no such test physician', { error: 'user_not_found' });
    if (record.data.banned || record.data.locked) throw new HttpError(403, 'this test physician is banned or locked', { error: 'user_locked' });
    const now = Date.now();
    const session = { id: `sess_qa${randomAlnum(24)}`, userId, status: 'active', createdAt: now, lastActiveAt: now, expireAt: now + 7 * 24 * 3600 * 1000 };
    store.update((s) => {
      s.clerk.sessions[session.id] = session;
      record.data.last_sign_in_at = now; record.data.last_active_at = now;
    });
    return session;
  }

  function activeSession(id) {
    const session = state().sessions[id];
    if (!session || session.status !== 'active' || session.expireAt < Date.now()) throw new HttpError(401, 'session ended', { error: 'session_ended' });
    const record = findUser(session.userId, 'live');
    if (!record) throw new HttpError(401, 'session user no longer exists', { error: 'session_ended' });
    return { session, user: record.data };
  }

  function mintToken(sessionId, template) {
    const { session, user } = activeSession(sessionId);
    const now = Math.floor(Date.now() / 1000);
    const base = { azp: APP_PUBLIC_ORIGIN, iat: now, iss: LAB_ISSUER, jti: randomAlnum(20), nbf: now - 10, sub: user.id };
    let claims;
    if (!template) claims = { ...base, exp: now + SESSION_TOKEN_SECONDS, fva: [0, -1], sid: session.id, sts: 'active', v: 2 };
    else if (template === SUPABASE_TEMPLATE) claims = { ...base, exp: now + TEMPLATE_TOKEN_SECONDS, aud: 'authenticated', role: 'authenticated', email: primaryEmail(user) };
    else throw clerkError(404, 'resource_not_found', `No JWT template exists with name: ${template}`);
    session.lastActiveAt = Date.now();
    return { jwt: signJwt(claims, secrets.signingKey), claims };
  }

  // ── Webhooks (Svix-signed, as Clerk sends them) ───────────────────────────
  function queueWebhook(type, data) {
    const id = `msg_qa${randomAlnum(24)}`;
    const event = { data, event_attributes: { http_request: { client_ip: '127.0.0.1', user_agent: 'CredentialDOMD QA lab' } }, instance_id: secrets.clerk.instanceId, object: 'event', timestamp: Date.now(), type };
    const delivery = { id, type, userId: data.id, state: 'pending', attempts: [], queuedAt: new Date().toISOString() };
    store.update((s) => { s.clerk.webhooks.unshift(delivery); s.clerk.webhooks.length = Math.min(s.clerk.webhooks.length, 500); });
    const body = JSON.stringify(event);
    const attempt = async (n) => {
      const live = state().webhooks.find((d) => d.id === id);
      if (!live) return;
      let status = 0, text = '';
      try {
        const headers = { 'Content-Type': 'application/json', ...svixHeaders(secrets.clerk.webhookSecret, body, { id }) };
        const r = await fetch(`${supabaseUrl}/functions/v1/clerk-webhook`, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) });
        status = r.status; text = (await r.text()).slice(0, 500);
      } catch (e) { text = `network: ${e.message}`; }
      live.attempts.push({ at: new Date().toISOString(), status, response: text });
      live.state = status >= 200 && status < 300 ? 'delivered' : (n < WEBHOOK_RETRY_MS.length ? 'retrying' : 'failed');
      store.save();
      log(`clerk: webhook ${type} for ${data.id} -> ${status || 'no response'}${live.state === 'retrying' ? ' (will retry)' : ''}`);
      if (live.state === 'retrying') setTimeout(() => attempt(n + 1), WEBHOOK_RETRY_MS[n]).unref();
    };
    setImmediate(() => attempt(0));
    return delivery;
  }

  function redeliver(id) {
    const d = state().webhooks.find((w) => w.id === id);
    if (!d) throw new HttpError(404, 'no such delivery');
    const record = findUser(d.userId);
    if (!record && d.type !== 'user.deleted') throw new HttpError(409, 'that test physician no longer exists');
    return queueWebhook(d.type, d.type === 'user.deleted' ? { deleted: true, id: d.userId, object: 'user' } : record.data);
  }

  // ── Local database helpers (service role on the LOCAL stack only) ─────────
  async function rest(pathAndQuery, init = {}) {
    if (!serviceRoleKey) throw new HttpError(503, 'the mock was started without the local service-role key');
    const r = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, { ...init, headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    const text = await r.text();
    if (!r.ok) throw new HttpError(502, `local database: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  async function profileOf(userId, { waitMs = 0 } = {}) {
    const until = Date.now() + waitMs;
    for (;;) {
      const rows = await rest(`profiles?auth_user_id=eq.${encodeURIComponent(userId)}&select=id,auth_user_id,access_status,email,verified_email,name,founding_number,deleted_at`);
      if (rows?.[0] || Date.now() >= until) return rows?.[0] || null;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // The legacy-instance account behind the synthetic continuity member in
  // qa-lab/seed.sql (same subject, address and clock values), so the
  // continuity path can be exercised: a live test physician who signs up with
  // that address is bound to it the way production binds a pre-cutover account.
  function ensureFixtures() {
    if (findUser('user_qalegacy1')) return;
    createUser({ firstName: 'Legacy', lastName: 'Member', email: `qa-legacy-1@${LAB_EMAIL_DOMAIN}`, instance: 'legacy' }, { id: 'user_qalegacy1', createdAt: 1788000000000, updatedAt: 1789000000000 });
  }
  ensureFixtures();

  // ── Routes ────────────────────────────────────────────────────────────────
  function routes(router) {
    // Issuer keys (the edge functions fetch these through CLERK_JWKS_URL).
    router.add('GET', '/clerk/.well-known/jwks.json', (req, res) => {
      const { kty, n, e, kid, alg } = secrets.signingKey;
      json(res, 200, { keys: [{ use: 'sig', kty, kid, alg, n, e }] }, { 'Cache-Control': 'public, max-age=60' });
    });
    router.add('GET', '/clerk/.well-known/openid-configuration', (req, res) => json(res, 200, { issuer: LAB_ISSUER, jwks_uri: `${LAB_ISSUER}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ['RS256'] }));

    // Backend API.
    router.add('GET', '/clerk/v1/users', (req, res, { url }) => {
      const instance = instanceForKey(req);
      const q = url.searchParams;
      const all = (name) => [...q.getAll(name), ...q.getAll(`${name}[]`)].flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
      let list = usersOf(instance).map(apiUser);
      const emails = all('email_address').map((e) => e.toLowerCase());
      const ids = all('user_id');
      const external = all('external_id');
      if (emails.length) list = list.filter((u) => u.email_addresses.some((e) => emails.includes(e.email_address)));
      if (ids.length) list = list.filter((u) => ids.includes(u.id));
      if (external.length) list = list.filter((u) => external.includes(u.external_id));
      if (q.get('query')) { const needle = q.get('query').toLowerCase(); list = list.filter((u) => JSON.stringify([u.first_name, u.last_name, u.email_addresses.map((e) => e.email_address)]).toLowerCase().includes(needle)); }
      const order = q.get('order_by') || '-created_at';
      const field = order.replace(/^[+-]/, '');
      const dir = order.startsWith('+') ? 1 : -1;
      list.sort((a, b) => ((a[field] ?? 0) > (b[field] ?? 0) ? 1 : (a[field] ?? 0) < (b[field] ?? 0) ? -1 : 0) * dir);
      const limit = Math.min(Math.max(Number(q.get('limit') || 10), 1), 500);
      const offset = Math.max(Number(q.get('offset') || 0), 0);
      json(res, 200, list.slice(offset, offset + limit));
    });
    router.add('GET', '/clerk/v1/users/count', (req, res) => json(res, 200, { object: 'total_count', total_count: usersOf(instanceForKey(req)).length }));
    router.add('GET', '/clerk/v1/users/:id', (req, res, { params }) => {
      const record = findUser(params.id, instanceForKey(req));
      if (!record) throw clerkError(404, 'resource_not_found', 'not found', 'Resource not found');
      json(res, 200, apiUser(record));
    });
    router.add('GET', '/clerk/v1/email_addresses/:id', (req, res, { params }) => {
      const instance = instanceForKey(req);
      for (const r of usersOf(instance)) {
        const e = r.data.email_addresses.find((x) => x.id === params.id);
        if (e) return json(res, 200, e);
      }
      throw clerkError(404, 'resource_not_found', 'not found', 'Resource not found');
    });

    // The lab's sign-in API (QA sign-in page, smoke test, runner).
    router.add('GET', '/qa/users', (req, res, { url }) => {
      const instance = url.searchParams.get('instance') === 'legacy' ? 'legacy' : 'live';
      const list = usersOf(instance).map((r) => r.data).sort((a, b) => b.created_at - a.created_at)
        .map((u) => ({ id: u.id, firstName: u.first_name, lastName: u.last_name, email: primaryEmail(u), verified: u.email_addresses.find((e) => e.id === u.primary_email_address_id)?.verification?.status === 'verified', createdAt: new Date(u.created_at).toISOString(), banned: u.banned, locked: u.locked }));
      json(res, 200, { users: list });
    });
    router.add('POST', '/qa/users', async (req, res) => json(res, 201, createUser(await readJson(req))));
    router.add('GET', '/qa/users/:id', (req, res, { params }) => {
      const record = findUser(params.id);
      if (!record) throw new HttpError(404, 'no such test physician');
      json(res, 200, { instance: record.instance, user: record.data });
    });
    router.add('PATCH', '/qa/users/:id', async (req, res, { params }) => json(res, 200, updateUser(params.id, await readJson(req))));
    router.add('DELETE', '/qa/users/:id', (req, res, { params }) => json(res, 200, deleteUser(params.id)));
    router.add('GET', '/qa/users/:id/profile', async (req, res, { params, url }) => {
      const profile = await profileOf(params.id, { waitMs: Math.min(Number(url.searchParams.get('wait') || 0), 60000) });
      if (!profile) throw new HttpError(404, 'no profile for this test physician yet');
      json(res, 200, { profile });
    });
    router.add('POST', '/qa/users/:id/admin', async (req, res, { params }) => {
      const profile = await profileOf(params.id, { waitMs: 30000 });
      if (!profile) throw new HttpError(409, 'no profile yet: sign in as this physician once first');
      await rest('app_admins?on_conflict=profile_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ profile_id: profile.id, note: 'QA lab test administrator', added_at: new Date().toISOString() }) });
      json(res, 200, { admin: true, profileId: profile.id });
    });
    router.add('POST', '/qa/sessions', async (req, res) => {
      const body = await readJson(req);
      const session = createSession(body.userId);
      json(res, 201, { session, user: findUser(session.userId).data });
    });
    router.add('GET', '/qa/sessions/:id', (req, res, { params }) => {
      const { session, user } = activeSession(params.id);
      json(res, 200, { session, user });
    });
    router.add('DELETE', '/qa/sessions/:id', (req, res, { params }) => {
      const session = state().sessions[params.id];
      if (session) { session.status = 'ended'; store.save(); }
      json(res, 200, { ended: true });
    });
    router.add('POST', '/qa/sessions/:id/tokens', async (req, res, { params }) => {
      const body = await readJson(req);
      const template = typeof body.template === 'string' && body.template ? body.template : null;
      const { jwt } = mintToken(params.id, template);
      json(res, 200, { object: 'token', jwt });
    });
    router.add('GET', '/qa/clerk/webhooks', (req, res) => json(res, 200, { deliveries: state().webhooks }));
    router.add('POST', '/qa/clerk/webhooks/:id/redeliver', (req, res, { params }) => json(res, 202, redeliver(params.id)));
  }

  return { routes, createUser, updateUser, deleteUser, createSession, mintToken, profileOf };
}
