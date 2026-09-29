// The QA lab's stand-in for the Clerk browser SDK (window.Clerk).
//
// Only a QA-lab build contains this file: qa-lab/app/vite.config.mjs aliases
// "@clerk/clerk-react" to ./clerk-shim.jsx, which uses this. The production
// build never resolves either (tests/qa-lab/production-bundle.test.mjs).
//
// It keeps the shapes the app reads from Clerk: window.Clerk.user / .session /
// .loaded / .signOut / .addListener, session.getToken() for the default session
// token and session.getToken({ template: "supabase" }) for the database token,
// both minted by the lab's mock Clerk with the lab's key. There is no password
// anywhere: a test physician is picked or created on the QA sign-in page.

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];
const MOCK = '/__qa/mock';
const COOKIE = 'qa_lab_session';
const EARLY_REFRESH_MS = 15000;

export function assertQaLabRuntime() {
  if (import.meta.env.VITE_QA_LAB !== '1') throw new Error('QA-lab sign-in is only part of QA-lab builds (VITE_QA_LAB=1).');
  if (typeof location !== 'undefined' && !LOCAL_HOSTS.includes(location.hostname)) {
    throw new Error(`QA-lab sign-in refuses to run on ${location.hostname}: it only runs on this machine.`);
  }
}
assertQaLabRuntime();

export async function qaApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${MOCK}${path}`, {
    method, credentials: 'omit', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw Object.assign(new Error(data?.message || data?.error || data?.errors?.[0]?.message || `QA lab request failed (${res.status})`), { status: res.status, data });
  return data;
}

const readCookie = () => (document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1) || null;
const writeCookie = (value) => { document.cookie = value ? `${COOKIE}=${value}; Path=/; SameSite=Lax` : `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`; };

/** A Clerk-shaped user resource from the mock's Backend API user. */
function userResource(api, reload) {
  const emails = api.email_addresses.map((e) => ({ id: e.id, emailAddress: e.email_address, verification: { status: e.verification?.status || null, strategy: e.verification?.strategy || null }, linkedTo: [], toString() { return e.email_address; } }));
  const primary = emails.find((e) => e.id === api.primary_email_address_id) || null;
  const full = [api.first_name, api.last_name].filter(Boolean).join(' ') || null;
  return {
    id: api.id, externalId: api.external_id, username: api.username, firstName: api.first_name, lastName: api.last_name, fullName: full,
    imageUrl: api.image_url, hasImage: false, primaryEmailAddressId: api.primary_email_address_id, primaryEmailAddress: primary, emailAddresses: emails,
    primaryPhoneNumberId: null, primaryPhoneNumber: null, phoneNumbers: [], web3Wallets: [], externalAccounts: [], passkeys: [], enterpriseAccounts: [],
    passwordEnabled: false, twoFactorEnabled: false, totpEnabled: false, backupCodeEnabled: false, publicMetadata: api.public_metadata || {}, unsafeMetadata: api.unsafe_metadata || {},
    createdAt: new Date(api.created_at), updatedAt: new Date(api.updated_at), lastSignInAt: api.last_sign_in_at ? new Date(api.last_sign_in_at) : null,
    reload, update: async () => { throw new Error('Profile changes go through the QA lab API (PATCH /qa/users/:id).'); },
  };
}

function createQaClerk() {
  const listeners = new Set();
  const subscribers = new Set();
  let version = 0;
  const clerk = {
    loaded: false, user: null, session: null, client: { sessions: [] }, isQaLab: true,
    frontendApi: 'clerk.qa.credentialdomd.test', publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || '',
  };

  const resources = () => ({ client: clerk.client, session: clerk.session, user: clerk.user, organization: null });
  function emit() {
    version += 1;
    for (const l of [...listeners]) { try { l(resources()); } catch (e) { console.error(e); } }
    for (const s of [...subscribers]) s();
  }

  function makeSession(apiSession, apiUser) {
    const cache = new Map();
    const inflight = new Map();
    const session = {
      id: apiSession.id, status: 'active', lastActiveAt: new Date(apiSession.lastActiveAt), expireAt: new Date(apiSession.expireAt), abandonAt: new Date(apiSession.expireAt),
      user: null, publicUserData: { identifier: apiUser.email_addresses[0]?.email_address || null, firstName: apiUser.first_name, lastName: apiUser.last_name, imageUrl: apiUser.image_url, userId: apiUser.id },
      async getToken(options = {}) {
        if (clerk.session !== session) return null;
        const template = options?.template || '';
        const cached = cache.get(template);
        if (cached && !options.skipCache && cached.expMs - EARLY_REFRESH_MS > Date.now()) return cached.jwt;
        if (inflight.has(template)) return inflight.get(template);
        const p = qaApi(`/qa/sessions/${encodeURIComponent(session.id)}/tokens`, { method: 'POST', body: template ? { template } : {} })
          .then(({ jwt }) => {
            const exp = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp;
            cache.set(template, { jwt, expMs: exp * 1000 });
            return jwt;
          })
          .catch((error) => {
            if (error.status === 401 && clerk.session === session) { writeCookie(null); setSignedIn(null, null); }
            if (error.status === 404) throw error; // unknown template, as Clerk
            return null;
          })
          .finally(() => inflight.delete(template));
        inflight.set(template, p);
        return p;
      },
      async end() { await signOut(); },
      async remove() { await signOut(); },
      async touch() { return session; },
      async reload() { return session; },
      checkAuthorization: () => false,
    };
    const reload = async () => {
      const fresh = await qaApi(`/qa/sessions/${encodeURIComponent(session.id)}`);
      session.user = userResource(fresh.user, reload);
      if (clerk.session === session) { clerk.user = session.user; emit(); }
      return session.user;
    };
    session.user = userResource(apiUser, reload);
    return session;
  }

  function setSignedIn(apiSession, apiUser) {
    const session = apiSession ? makeSession(apiSession, apiUser) : null;
    clerk.session = session;
    clerk.user = session ? session.user : null;
    clerk.client = { sessions: session ? [session] : [], activeSessions: session ? [session] : [], lastActiveSessionId: session?.id || null };
    emit();
  }

  async function load() {
    if (clerk.loaded || clerk._loading) return clerk._loading;
    clerk._loading = (async () => {
      const sid = readCookie();
      if (sid) {
        try {
          const { session, user } = await qaApi(`/qa/sessions/${encodeURIComponent(sid)}`);
          clerk.loaded = true;
          setSignedIn(session, user);
          return;
        } catch { writeCookie(null); }
      }
      clerk.loaded = true;
      emit();
    })();
    return clerk._loading;
  }

  async function signInAs(userId) {
    const { session, user } = await qaApi('/qa/sessions', { method: 'POST', body: { userId } });
    writeCookie(session.id);
    setSignedIn(session, user);
    return session;
  }

  async function signOut(callbackOrOptions, maybeOptions) {
    const options = typeof callbackOrOptions === 'object' && callbackOrOptions ? callbackOrOptions : (maybeOptions || {});
    const current = clerk.session;
    writeCookie(null);
    if (current) { try { await qaApi(`/qa/sessions/${encodeURIComponent(current.id)}`, { method: 'DELETE' }); } catch { /* the session is gone either way */ } }
    setSignedIn(null, null);
    if (typeof callbackOrOptions === 'function') await callbackOrOptions();
    const target = options.redirectUrl || clerk._afterSignOutUrl;
    if (target && typeof location !== 'undefined' && location.pathname + location.search !== target) location.assign(target);
  }

  Object.assign(clerk, {
    load, signInAs, signOut,
    setAfterSignOutUrl(url) { clerk._afterSignOutUrl = url; },
    addListener(listener) {
      listeners.add(listener);
      if (clerk.loaded) { try { listener(resources()); } catch (e) { console.error(e); } }
      return () => listeners.delete(listener);
    },
    // Clerk UI the lab does not have. Sign-in methods are managed in the QA lab API.
    openUserProfile() { window.alert('QA lab: there is no Clerk account screen. Change a test physician through the QA lab API (PATCH /qa/users/:id).'); },
    closeUserProfile() {}, openSignIn() {}, closeSignIn() {}, openSignUp() {}, closeSignUp() {},
    redirectToSignIn: async () => { location.assign('/app/'); },
    redirectToSignUp: async () => { location.assign('/app/'); },
    setActive: async () => {},
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    getVersion: () => version,
  });
  return clerk;
}

export const qaClerk = createQaClerk();
if (typeof window !== 'undefined') window.Clerk = qaClerk;
