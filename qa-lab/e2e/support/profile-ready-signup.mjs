// Hold only this page's initialization request. AI traffic is observed, never
// stubbed, replayed or classified as an expected health failure.
import { createPublicKey, verify } from 'node:crypto';

// Initialization uses Clerk's default session token. AI uses the separate
// Supabase template verifier; neither contract is relaxed to accept the other.
export function verifiedSignupSessionSubject(authorization, { jwk, issuer, authorizedParty, sessionId, now = Date.now() }) {
  try {
    if (typeof authorization !== 'string' || authorization.length > 8192 || !authorization.startsWith('Bearer ')) return null;
    if (!/^sess_qa[A-Za-z0-9]+$/.test(sessionId || '')) return null;
    const parts = authorization.slice(7).split('.');
    if (parts.length !== 3 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const seconds = now / 1000;
    if (header.alg !== 'RS256' || header.kid !== jwk?.kid || jwk?.kty !== 'RSA'
      || claims.iss !== issuer || claims.azp !== authorizedParty
      || !/^user_qa[A-Za-z0-9]{1,120}$/.test(claims.sub || '')
      || claims.sid !== sessionId || claims.sts !== 'active' || claims.v !== 2
      || Object.hasOwn(claims, 'aud') || Object.hasOwn(claims, 'role')
      || !Number.isFinite(claims.exp) || claims.exp <= seconds
      || !Number.isFinite(claims.iat) || claims.iat > seconds + 5
      || !Number.isFinite(claims.nbf) || claims.nbf > seconds + 5) return null;
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    return verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')) ? claims.sub : null;
  } catch { return null; }
}

const INITIALIZE = '/functions/v1/initialize-clerk-profile';
const AI = '/functions/v1/ai-proxy';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

export async function verifyProfileReadySignup(page, qa, {
  submit, expectedEmail, origins, verifyInitializationActor, verifyAiActor, timeoutMs = 30000, observationMs = 250,
}) {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    const u = new URL(origin); return u.origin !== origin || !['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  })) throw Error('Profile readiness acceptance requires explicit local origins');
  const endpoint = (request, path, method) => {
    const url = new URL(request.url());
    return origins.includes(url.origin) && url.pathname === path && !url.search && request.method() === method;
  };
  // Keep interception on the already guarded context. Removing the last page
  // interceptor can force-continue an unrelated route delegated to its context
  // guard, racing that guard's own continue in Playwright.
  const context = page.context();
  const initialization = deferred(), release = deferred(), initializedResponse = deferred(), aiResponse = deferred();
  let released = false, initializeCount = 0, heldRequest = null, initResponded = false;
  const aiRequests = [], aiResponses = [], dispatches = [];
  const initializeRoute = url => origins.includes(url.origin) && url.pathname === INITIALIZE && !url.search;
  const onInitialize = async route => {
    if (route.request().method() !== 'POST' || route.request().frame().page() !== page) return route.fallback();
    const dispatched = deferred(); dispatches.push(dispatched.promise);
    initializeCount += 1;
    if (!heldRequest) { heldRequest = route.request(); initialization.resolve(heldRequest); }
    try {
      await release.promise;
      await route.continue();
      dispatched.resolve(null);
    } catch (error) {
      dispatched.resolve(error);
      throw error;
    }
  };
  const onRequest = request => {
    if (endpoint(request, AI, 'GET')) aiRequests.push({ request, beforeRelease: !released, afterInitializerResponse: initResponded });
  };
  const onResponse = response => {
    if (response.request() === heldRequest) {
      initResponded = true; initializedResponse.resolve(response);
    }
    if (endpoint(response.request(), AI, 'GET')) { aiResponses.push(response); aiResponse.resolve(response); }
  };
  page.on('request', onRequest); page.on('response', onResponse);
  let installed = false;
  try {
    await context.route(initializeRoute, onInitialize); installed = true;
    await submit();
    const initializeRequest = await bounded(initialization.promise, timeoutMs, 'Signup did not start profile initialization');
    const actor = await page.evaluate(() => ({ id: window.Clerk?.user?.id, email: window.Clerk?.user?.primaryEmailAddress?.emailAddress, sessionId: window.Clerk?.session?.id }));
    const initSubject = await bounded(verifyInitializationActor(initializeRequest, actor), timeoutMs, 'Initialization actor verification did not finish');
    if (!/^user_qa[A-Za-z0-9]+$/.test(actor?.id || '') || actor.email !== expectedEmail || initSubject !== actor.id) {
      throw Error('Held initialization did not belong to the newly created verified actor');
    }
    // Two paints let mounted effects run. The short negative observation is
    // deliberately bounded; controlled unit tests cover arbitrarily pending
    // readiness. The initialization request remains held throughout.
    await bounded(paint(page), timeoutMs, 'Signup did not complete its render barrier');
    await new Promise(resolve => setTimeout(resolve, observationMs));
    qa.check('profile initialization is held for the new signed-in actor, with no response yet', initializeCount === 1 && !initResponded);
    qa.check('no AI status GET starts while profile initialization is held', aiRequests.length === 0, `${aiRequests.length} observed GET(s)`);
    released = true; release.resolve();
    const initResponse = await bounded(initializedResponse.promise, timeoutMs, 'Released profile initialization did not answer');
    if (await bounded(initResponse.finished(), timeoutMs, 'Profile initialization body did not finish') || initResponse.status() !== 200) {
      throw Error('Real profile initialization did not finish successfully');
    }
    const configResponse = await bounded(aiResponse.promise, timeoutMs, 'AI status did not resume after profile initialization');
    if (await bounded(configResponse.finished(), timeoutMs, 'AI status body did not finish')) throw Error('AI status response failed');
    const body = await bounded(configResponse.json(), timeoutMs, 'AI status JSON did not finish');
    const configSubject = await bounded(verifyAiActor(configResponse.request()), timeoutMs, 'AI actor verification did not finish');
    await bounded(paint(page), timeoutMs, 'Signup did not complete its post-response render barrier');
    qa.check('one real AI status GET resumes after the initializer answers, without reloading', initializeCount === 1 && aiRequests.length === 1 && aiResponses.length === 1 && !aiRequests[0].beforeRelease && aiRequests[0].afterInitializerResponse);
    qa.check('AI configuration answers HTTP 200 for the same verified new account', configResponse.status() === 200 && configSubject === actor.id);
    qa.check('the unpaid account receives a pending AI configuration with no administrator privilege', body?.allowed === false && body?.shared === false && body?.anthropic_shared === false && body?.unlimited === false && typeof body?.configured === 'boolean' && Number.isFinite(body?.limit) && body.limit > 0);
    return actor.id;
  } finally {
    // Release even when signup/ownership/assertion fails; never strand a real
    // request, remove the route guard globally, or fabricate a success body.
    release.resolve();
    try {
      try {
        // Complete every held dispatch before removing this helper only. The
        // permanent context containment guard stays installed throughout.
        const errors = await bounded(Promise.all(dispatches), timeoutMs, 'Held profile dispatch did not finish during cleanup');
        if (errors.some(Boolean)) throw Error('Held profile request could not be dispatched during cleanup');
      } finally { if (installed) await context.unroute(initializeRoute, onInitialize); }
    } finally {
      // Listener cleanup also survives route removal failure.
      page.off('request', onRequest); page.off('response', onResponse);
    }
  }
}
