// PUBLIC-002: a fourth state guide in 24 hours is refused by waitlist_signup
// with HTTP 403 (20261001052000_guide_second_state), and the waitlist answer
// on that request is kept. The state page used to have no 403 branch: the
// refusal read "That did not go through. Check the address and try again.",
// and before that the PT429 read "Busy right now. Try again in a few minutes."
// for a refusal that lasts a day. Runs the page's own submit handler, from
// the template and from every generated state page, against a stub DOM.
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

async function submit(source, { status, waitlist }) {
  const msg = { style: {}, textContent: '' };
  let onSubmit;
  const fields = {
    'input[type="email"]': { value: 'limit@example.invalid' },
    'button[type="submit"]': { textContent: 'Send me the guide', dataset: {} },
    '.guide-hp': { value: '' },
    '.guide-choice': { classList: { remove() {} } },
    'input[name="waitlist"]:checked': { value: waitlist ? 'yes' : 'no' },
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
      requests.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: status >= 200 && status < 300, status });
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
  test(`${file}: a fourth guide refused for 24 hours says 24 hours, and says the waitlist answer counted`, async () => {
    const source = handlerSource(read(file), file);

    const yes = await submit(source, { status: 403, waitlist: true });
    assert.equal(yes.requests.find(r => r.url === '/api/waitlist').body.p_waitlist, true);
    assert.match(yes.msg.textContent, /three guides in the last 24 hours/);
    assert.match(yes.msg.textContent, /again in 24 hours/);
    assert.match(yes.msg.textContent, /You are on the waitlist/);
    // The limit is a rolling 24 hours (waitlist_signup counts sends newer than
    // now() - 1 day), not a calendar day: "today" and "tomorrow" were false
    // for a request the morning after three late night guides.
    assert.doesNotMatch(yes.msg.textContent, /today|tomorrow/);
    assert.doesNotMatch(yes.msg.textContent, /few minutes|Check the address|on its way/);
    assert.doesNotMatch(yes.msg.textContent, /[-–—]/, 'public copy has no hyphens or dashes');

    const no = await submit(source, { status: 403, waitlist: false });
    assert.match(no.msg.textContent, /again in 24 hours/);
    assert.doesNotMatch(no.msg.textContent, /today|tomorrow/);
    assert.doesNotMatch(no.msg.textContent, /waitlist/, 'a guide only request is not told it joined the waitlist');
    assert.doesNotMatch(no.msg.textContent, /[-–—]/);

    const busy = await submit(source, { status: 429, waitlist: false });
    assert.equal(busy.msg.textContent, 'Busy right now. Try again in a few minutes.', 'the global throttle keeps its copy');
  });

  test(`${file}: the same guide asked for again within 24 hours of its send (208) says it was already sent, not on its way`, async () => {
    const source = handlerSource(read(file), file);

    const yes = await submit(source, { status: 208, waitlist: true });
    assert.match(yes.msg.textContent, /already sent to this address in the last 24 hours/);
    assert.match(yes.msg.textContent, /spam/);
    assert.match(yes.msg.textContent, /You are on the waitlist/);
    assert.doesNotMatch(yes.msg.textContent, /on its way|today|tomorrow/);
    assert.doesNotMatch(yes.msg.textContent, /[-–—]/, 'public copy has no hyphens or dashes');

    const no = await submit(source, { status: 208, waitlist: false });
    assert.match(no.msg.textContent, /already sent/);
    assert.doesNotMatch(no.msg.textContent, /waitlist|on its way/);
    assert.doesNotMatch(no.msg.textContent, /[-–—]/);

    const sent = await submit(source, { status: 200, waitlist: false });
    assert.equal(sent.msg.textContent, 'The guide is on its way, usually within 15 minutes.', 'a guide that will be sent keeps its copy');
  });
}
