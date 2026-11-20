// PUBLIC-002: a fourth state guide in 24 hours is refused with HTTP 403
// (20261001052000_guide_second_state; guide_request since
// 20261120220000_retire_waitlist). The state page used to have no 403 branch:
// the refusal read "That did not go through. Check the address and try
// again.", and before that the PT429 read "Busy right now. Try again in a few
// minutes." for a refusal that lasts a day. Runs the page's own submit
// handler, from the template and from every generated state page, against a
// stub DOM.
//
// The waitlist was retired 2026-11-20: the form posts a guide request only
// (/api/guide-request, guide_request), with no waitlist answer and no attempt
// trace, and no message mentions a waitlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8');
const pages = ['landing/state-template.html',
  ...fs.readdirSync(new URL('landing/states/', root)).filter(f => f.endsWith('.html') && f !== 'index.html').map(f => `landing/states/${f}`)];

test('every state and DC has a generated page to check', () => assert.equal(pages.length, 52));

function handlerSource(html, file) {
  const start = html.indexOf("(function() {\n  var SB = ");
  assert.ok(start > 0, `${file}: guide form handler not found`);
  const end = html.indexOf('})();', start);
  return html.slice(start, end + 5);
}

async function submit(source, { status, relayStatus = status }) {
  const msg = { style: {}, textContent: '' };
  let onSubmit;
  const fields = {
    'input[type="email"]': { value: 'limit@example.invalid' },
    'button[type="submit"]': { textContent: 'Send me the guide', dataset: {} },
    '.guide-hp': { value: '' },
  };
  const form = {
    addEventListener: (type, fn) => { if (type === 'submit') onSubmit = fn; },
    querySelector: sel => fields[sel] || null,
    getAttribute: () => 'inline',
    parentElement: { querySelector: sel => (sel === '.guide-msg' ? msg : null) },
    reset() {},
  };
  const requests = [];
  const context = {
    document: {
      getElementById: () => null,
      querySelectorAll: sel => (sel === '.guide-form' ? [form] : []),
      documentElement: { getAttribute: () => null },
    },
    location: { pathname: '/states/texas' },
    localStorage: { getItem: () => null, setItem() {} },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
    fetch: (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const s = url.startsWith('/') ? relayStatus : status;
      return Promise.resolve({ ok: s >= 200 && s < 300, status: s });
    },
    Date,
    JSON,
  };
  vm.runInNewContext(source, context);
  assert.ok(onSubmit, 'the handler binds the form');
  onSubmit({ preventDefault() {} });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  return { msg, requests };
}

for (const file of pages) {
  test(`${file}: the form requests a guide only, through the relay, with no waitlist answer or attempt trace`, async () => {
    const source = handlerSource(read(file), file);
    assert.doesNotMatch(source, /waitlist/i);
    const { requests, msg } = await submit(source, { status: 200 });
    assert.deepEqual(requests.map(r => r.url), ['/api/guide-request']);
    assert.deepEqual(requests[0].body, { p_email: 'limit@example.invalid', p_source: '/states/texas', p_note: requests[0].body.p_note });
    assert.match(requests[0].body.p_note, file.endsWith('template.html') ? /^guide-email \{\{STATE_ABBREVIATION\}\} inline/ : /^guide-email [A-Z]{2} inline/);
    assert.equal(msg.textContent, 'The guide is on its way, usually within 15 minutes.');
    // A relay that is not there yet falls back to the RPC itself, same body.
    const fallback = await submit(source, { status: 200, relayStatus: 404 });
    assert.deepEqual(fallback.requests.map(r => r.url), ['/api/guide-request', 'https://hkpnnsjcwprrwobmpqyy.supabase.co/rest/v1/rpc/guide_request']);
    assert.deepEqual(fallback.requests[1].body, fallback.requests[0].body);
  });

  test(`${file}: a fourth guide refused for 24 hours says 24 hours`, async () => {
    const source = handlerSource(read(file), file);
    const refused = await submit(source, { status: 403 });
    assert.match(refused.msg.textContent, /three guides in the last 24 hours/);
    assert.match(refused.msg.textContent, /again in 24 hours/);
    // The limit is a rolling 24 hours (guide_request counts sends newer than
    // now() - 1 day), not a calendar day: "today" and "tomorrow" were false
    // for a request the morning after three late night guides.
    assert.doesNotMatch(refused.msg.textContent, /today|tomorrow|waitlist/);
    assert.doesNotMatch(refused.msg.textContent, /few minutes|Check the address|on its way/);
    assert.doesNotMatch(refused.msg.textContent, /[-–—]/, 'public copy has no hyphens or dashes');

    const busy = await submit(source, { status: 429 });
    assert.equal(busy.msg.textContent, 'Busy right now. Try again in a few minutes.', 'the global throttle keeps its copy');
  });

  test(`${file}: the same guide asked for again within 24 hours of its send (208) says it was already sent, not on its way`, async () => {
    const source = handlerSource(read(file), file);
    const again = await submit(source, { status: 208 });
    assert.match(again.msg.textContent, /already sent to this address in the last 24 hours/);
    assert.match(again.msg.textContent, /spam/);
    assert.doesNotMatch(again.msg.textContent, /waitlist|on its way|today|tomorrow/);
    assert.doesNotMatch(again.msg.textContent, /[-–—]/, 'public copy has no hyphens or dashes');
  });
}
