#!/usr/bin/env node
// The QA lab's mock server: one Node process on one local port serving the
// stand-ins for every third party the app and its edge functions talk to.
//
//   /clerk/...      Clerk Backend API + the issuer's JWKS            (mocks/clerk.mjs)
//   /v1/...         Stripe API (the SDK always calls /v1 at the root) (mocks/stripe.mjs)
//   /resend/...     Resend send + Receiving API                      (mocks/resend.mjs)
//   /anthropic/..., /gemini/...  AI providers (mocked unless QA_AI=real) (mocks/ai.mjs)
//   /telegram/...   operator alerts                                   (mocks/ai.mjs)
//   /qa/...         the lab's own API and pages: test physicians, sessions and tokens,
//                   inbox, Stripe checkout completion, AI script, health
//
// Started by `npm run qa:lab`; can run alone:
//   node qa-lab/mocks/server.mjs --port 54380 --app-origin http://127.0.0.1:54390
// It binds 127.0.0.1 only. Containers reach it as host.docker.internal.
import http from 'node:http';
import { parseArgs } from 'node:util';
import { DEFAULT_MOCK_PORT, DOCKER_HOST_ALIAS, SUPABASE_API_URL } from '../lib/lab-config.mjs';
import { labSecrets } from '../lib/lab-secrets.mjs';
import { MOCK_STATE_DIR, isMain } from '../lib/paths.mjs';
import { createStore } from './store.mjs';
import { createClerkMock } from './clerk.mjs';
import { createResendMock } from './resend.mjs';
import { createStripeMock } from './stripe.mjs';
import { createAiMock, aiSettings } from './ai.mjs';
import { HttpError, createRouter, json } from './http.mjs';

export function createMockServer({ port, appOrigin, supabaseUrl = SUPABASE_API_URL, serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '', stateDir = MOCK_STATE_DIR, env = process.env, secrets = labSecrets(), log = (m) => console.log(`[mock] ${m}`) } = {}) {
  const store = createStore(stateDir);
  const dockerBaseUrl = `http://${DOCKER_HOST_ALIAS}:${port}`;
  const router = createRouter();
  const clerk = createClerkMock({ store, secrets, supabaseUrl, serviceRoleKey, log });
  const resend = createResendMock({ store, secrets, supabaseUrl, dockerBaseUrl, log });
  const stripe = createStripeMock({ store, secrets, supabaseUrl, appOrigin, log });
  const ai = createAiMock({ store, secrets, settings: aiSettings(env), log });
  for (const m of [clerk, resend, stripe, ai]) m.routes(router);
  router.add('GET', '/qa/health', (req, res) => json(res, 200, { ok: true, service: 'credentialdomd-qa-lab-mocks', appOrigin, aiMode: ai.settings.real ? 'real' : 'mock' }));
  router.add('POST', '/qa/reset', (req, res) => { store.reset(); stripe.seed?.(); json(res, 200, { reset: true, note: 'mock state cleared; the database was not touched' }); });
  router.add('GET', '/', (req, res) => json(res, 200, { service: 'credentialdomd-qa-lab-mocks', inbox: '/qa/inbox', health: '/qa/health' }));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      const found = router.match(req.method, url.pathname);
      if (!found) throw new HttpError(404, `no mock route for ${req.method} ${url.pathname}`, url.pathname.startsWith('/v1/') ? { error: { type: 'invalid_request_error', message: `Unrecognized request URL (${req.method}: ${url.pathname}).` } } : undefined);
      if (found.methodNotAllowed) throw new HttpError(405, 'method not allowed');
      await found.handler(req, res, { params: found.params, url });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e.status || 500;
      if (status >= 500) log(`error on ${req.method} ${url.pathname}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, status, e.body || { error: e.message });
      else res.end();
    }
  });
  return { server, store, clerk, stripe, resend, ai, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); }) };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, 'app-origin': { type: 'string' } } });
  const port = Number(values.port || process.env.QA_MOCK_PORT || DEFAULT_MOCK_PORT);
  const appOrigin = values['app-origin'] || process.env.QA_APP_ORIGIN || 'http://127.0.0.1:54390';
  const mock = createMockServer({ port, appOrigin });
  mock.listen().then(() => console.log(`[mock] listening on http://127.0.0.1:${port} (inbox http://127.0.0.1:${port}/qa/inbox)`), (e) => { console.error(`[mock] ${e.message}`); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { mock.server.close(); process.exit(0); });
}
