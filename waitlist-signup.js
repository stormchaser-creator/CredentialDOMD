// The first-party relay returns a status with an empty body. The fallback RPC
// returns a JSON UUID. Neither response confirms that an email was delivered.
const SUPABASE_URL = 'https://hkpnnsjcwprrwobmpqyy.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrcG5uc2pjd3BycndvYm1wcXl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTIwODksImV4cCI6MjA4NzY2ODA4OX0._8iVLrhaDshKbxWV4XIs9LuyuS_-25fmABwloazhB-U';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const boundForms = new WeakSet();

export function createWaitlistClient({ fetchImpl = globalThis.fetch, timeoutMs = 12000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  async function request(url, payload, direct) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        const error = new Error('Invitation request timed out');
        error.name = 'TimeoutError';
        reject(error);
        controller.abort();
      }, timeoutMs);
    });
    const response = async () => {
      const headers = { 'Content-Type': 'application/json' };
      if (direct) {
        headers.apikey = SUPABASE_ANON;
        headers.Authorization = `Bearer ${SUPABASE_ANON}`;
      }
      const res = await fetchImpl(url, {
        method: 'POST', headers, body: JSON.stringify(payload),
        signal: controller.signal, keepalive: true,
      });
      if (!res.ok) return { ok: false, status: res.status };
      // Reading the body is inside the same deadline as fetch. A connection
      // can return headers and then stall without finishing its response.
      const body = await res.text();
      const contentType = res.headers.get('content-type') || '';
      if (!direct && !body.trim() && !/html/i.test(contentType)) return { ok: true, status: res.status };
      if (direct && /\bapplication\/json\b/i.test(contentType)) {
        try {
          const receipt = JSON.parse(body);
          if (typeof receipt === 'string' && UUID.test(receipt)) return { ok: true, status: res.status };
        } catch { /* Unexpected response; never confirm an unverified request. */ }
      }
      throw new Error('Unexpected invitation response');
    };
    try {
      return await Promise.race([response(), timeout]);
    } finally {
      clearTimer(timer);
    }
  }

  return async function postSignup(apiPath, rpcName, payload) {
    let relay;
    try {
      relay = await request(apiPath, payload, false);
    } catch (error) {
      // A timed-out write may already have reached the database. Recover the
      // form for the visitor without automatically sending the write again.
      if (error.name === 'TimeoutError') throw error;
    }
    if (relay && relay.status !== 404 && relay.status !== 405 && relay.status < 500) return relay;
    // This sits outside the relay catch: failure here must never retry direct.
    return request(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, payload, true);
  };
}

export function bindWaitlistForms(documentRoot, { postSignup = createWaitlistClient(), now = Date.now, pathname = globalThis.location?.pathname || '/' } = {}) {
  const loadedAt = now();
  documentRoot.querySelectorAll('.wl-form').forEach(form => {
    if (boundForms.has(form)) return;
    const emailEl = form.querySelector('.wl-email');
    const nameEl = form.querySelector('.wl-name');
    const hpEl = form.querySelector('.wl-hp');
    const msg = form.parentElement?.querySelector('.wl-msg') || form.querySelector('.wl-msg');
    const btn = form.querySelector('button[type="submit"]');
    if (!emailEl || !msg || !btn) return;
    boundForms.add(form);
    let busy = false;
    const say = (text, success = false) => {
      msg.style.color = success ? 'var(--emerald)' : 'var(--amber, #f59e0b)';
      msg.textContent = text;
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      // Keep the browser's required/type=email validation, including when a
      // submit event is dispatched without the normal native form submission.
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const snapshot = { email: emailEl.value, name: nameEl?.value, honeypot: hpEl?.value };
      const email = snapshot.email.trim();
      if (!email) return;
      const name = (snapshot.name || '').trim();
      const flags = [];
      if ((snapshot.honeypot || '').trim()) flags.push('honeypot');
      if (now() - loadedAt < 4000) flags.push('fast-submit');
      const note = flags.length ? flags.join(',') : null;
      const payload = { p_email: email, p_name: name || null, p_source: pathname, p_note: note };
      const label = btn.textContent;
      const wasDisabled = btn.disabled;
      const previousBusy = form.getAttribute('aria-busy');
      busy = true;
      btn.disabled = true;
      btn.textContent = 'Joining…';
      form.setAttribute('aria-busy', 'true');
      msg.textContent = '';

      // Existing best-effort trace is independent of the actual signup. It
      // neither blocks confirmation nor causes personal details to be logged.
      try {
        postSignup('/api/waitlist-attempt', 'waitlist_attempt', {
          p_email: email, p_name: name || null, p_source: pathname, p_stage: note || 'normal',
        }).catch(() => {});
      } catch { /* A trace failure must not block the invitation request. */ }

      try {
        const res = await postSignup('/api/waitlist', 'waitlist_signup', payload);
        if (res.ok || res.status === 409) {
          say(`You're on the list as ${email}. We'll email you when an invitation is available.`, true);
          // A delayed answer must not erase details the visitor edited while
          // this request was pending. Keep the whole form if any field changed.
          if (emailEl.value === snapshot.email && nameEl?.value === snapshot.name && hpEl?.value === snapshot.honeypot) form.reset();
        } else if (res.status === 429) {
          say('The list is busy right now. Your details are still here. Please try again in a few minutes.');
        } else if (res.status === 400) {
          say('Check your email address and try again. Your request has not been confirmed.');
        } else {
          say("We couldn't confirm your request. Your details are still here. Please try again.");
        }
      } catch (error) {
        say(error.name === 'TimeoutError'
          ? "We couldn't confirm your request in time. Your details are still here. Please try again."
          : "We couldn't confirm your request. Check your connection and try again. Your details are still here.");
      } finally {
        busy = false;
        btn.disabled = wasDisabled;
        btn.textContent = label;
        if (previousBusy === null) form.removeAttribute('aria-busy');
        else form.setAttribute('aria-busy', previousBusy);
      }
    });
  });
}

if (typeof document !== 'undefined') bindWaitlistForms(document);
