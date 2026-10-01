// Cancel and get a refund, in the app: RefundSection on the membership card
// (More > Profile & settings) and on More > Cancel Subscription, and the
// client calls behind it. The real component runs with a small hook runtime
// that also runs effects; the context and the limited-refund client are
// synthetic. No network, token, card or account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { createLimitedLaunchClient } from '../../src/utils/limitedLaunchClient.js';
import { REFUND_COPY, refundMessage } from '../../src/content/refundCopy.js';
import { MEMBERSHIP_COPY } from '../../src/content/membershipCopy.js';
import { WELCOME_MONEY_BACK } from '../../src/utils/welcomeEmail.js';

const owner = 'user_synthetic_refund';
const THEME = { text: '#text', textMuted: '#muted', textDim: '#dim', border: '#border', card: '#card', bg: '#bg', accent: '#accent', neutralDim: '#neutral', danger: '#danger', dangerDim: '#dangerdim' };
const quote = (patch = {}) => ({ schemaVersion: 1, state: 'available', paymentId: 'in_Latest', amountCents: 14900, currency: 'usd', paidAt: '2026-09-10T15:00:00.000Z', offerId: 'core', periodEnd: '2027-09-10T15:00:00.000Z', subscriptionCanceled: false, ...patch });
const refunded = (patch = {}) => ({ schemaVersion: 1, state: 'refunded', paymentId: 'in_Latest', amountCents: 14900, currency: 'usd', paidAt: '2026-09-10T15:00:00.000Z', offerId: 'core', subscriptionCanceled: true, refundStatus: 'succeeded', refundedAt: '2026-09-30T18:00:00.000Z', ...patch });

const require = createRequire(import.meta.url);
const built = await build({
  stdin: { contents: 'export {default as Refund} from "./src/components/pages/RefundSection.jsx";', resolveDir: fileURLToPath(new URL('../..', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'synthetic-refund', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/limitedLaunchClient\.js$/ }, () => ({ path: 'client', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      context: 'export const useApp = () => globalThis.__refund.context;',
      client: 'export const createLimitedLaunchClient = () => globalThis.__refund.client;',
    }[path] }));
  } }],
});
function runtime() {
  const cells = [], pending = [];
  let index = 0;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) { const at = index++; if (!(at in cells)) cells[at] = { value: typeof initial === 'function' ? initial() : initial }; const cell = cells[at]; return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v; }]; },
    useRef(value) { const at = index++; return cells[at] ??= { current: value }; },
    useMemo(fn, deps) { const at = index++; if (cells[at] && same(cells[at].deps, deps)) return cells[at].value; cells[at] = { deps, value: fn() }; return cells[at].value; },
    useEffect(fn, deps) {
      const at = index++; const prev = cells[at];
      if (prev && deps && same(prev.deps, deps)) return;
      const cell = cells[at] = { deps, cleanup: prev?.cleanup ?? null };
      pending.push(() => { cell.cleanup?.(); const c = fn(); cell.cleanup = typeof c === 'function' ? c : null; });
    },
  };
  return { hooks, begin() { index = 0; }, flush() { pending.splice(0).forEach(run => run()); } };
}
let active = runtime();
const exported = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'react' ? new Proxy({}, { get: (_, n) => active.hooks[n] }) : require(name), exported, exported.exports);
const { Refund } = exported.exports;

function fixture({ paid = true, accessStatus = 'active' } = {}) {
  active = runtime();
  const calls = [];
  const context = { user: { id: owner }, theme: THEME, isDesktop: false, navigate: (...args) => calls.push(['navigate', ...args]),
    limitedLaunch: { enabled: true, access: { accessStatus }, refresh: async () => { calls.push(['refresh']); } } };
  const state = { context, calls, client: {
    refundStatus: async () => { calls.push(['status']); return { schemaVersion: 1, state: 'none' }; },
    refundQuote: async () => { calls.push(['quote']); return quote(); },
    refund: async input => { calls.push(['refund', input]); return refunded(); },
  } };
  globalThis.__refund = state;
  state.render = () => { active.begin(); return Refund({ paid }); };
  state.html = () => { const tree = state.render(); return tree ? renderToStaticMarkup(tree) : ''; };
  return state;
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
const textOf = node => renderToStaticMarkup(node).replace(/<[^>]+>/g, '');
const button = (f, label) => find(f.render(), n => n.type === 'button' && textOf(n).includes(label));
const tick = (f, checked = true) => find(f.render(), n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked } });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test('a paid member sees Cancel and get a refund; asking changes nothing until the refund is confirmed', async () => {
  const f = fixture();
  assert.match(f.html(), />Cancel and get a refund</);
  f.render(); active.flush(); await settle();
  assert.deepEqual(f.calls, [], 'no status lookup for a paid member, nothing sent on sight');
  await button(f, 'Cancel and get a refund').props.onClick();
  assert.deepEqual(f.calls, [['quote']]);
  const html = f.html();
  assert.match(html, /We will refund \$149\.00, your most recent annual membership payment, made on/);
  assert.match(html, /in full to the card you paid with\./);
  assert.match(html, /Your membership ends now\. The subscription is cancelled today and will not renew, and you can no longer add or change records\./);
  assert.match(html, /Nothing is deleted\. Your saved records and documents stay available to view and export until you delete them yourself\./);
  assert.match(html, /If you join again later, you pay the standard price at that time\./);
  assert.match(html, /without a refund\? Use Manage paid subscription to turn off renewal instead\./, 'cancelling at period end stays available');
  const confirm = button(f, 'Cancel membership and refund $149.00');
  assert.equal(confirm.props.disabled, true, 'an explicit confirmation first');
  await confirm.props.onClick();
  assert.equal(f.calls.some(c => c[0] === 'refund'), false);
});

test('export first is one tap away and changes nothing', async () => {
  const f = fixture();
  await button(f, 'Cancel and get a refund').props.onClick();
  button(f, REFUND_COPY.exportFirst).props.onClick();
  assert.deepEqual(f.calls.at(-1), ['navigate', 'more', 'export']);
  assert.equal(f.calls.some(c => c[0] === 'refund'), false);
});

test('confirmed, the refund is for exactly the quoted payment; the outcome shows and membership is checked again', async () => {
  const f = fixture();
  await button(f, 'Cancel and get a refund').props.onClick();
  tick(f);
  const confirm = button(f, 'Cancel membership and refund $149.00');
  assert.equal(confirm.props.disabled, false);
  assert.equal(confirm.props.style.background, THEME.danger);
  await confirm.props.onClick();
  assert.deepEqual(f.calls.find(c => c[0] === 'refund'), ['refund', { paymentId: 'in_Latest', amountCents: 14900, confirm: true }]);
  assert.ok(f.calls.some(c => c[0] === 'refresh'), 'the membership answer follows the cancellation');
  const html = f.html();
  assert.match(html, /Refunded: \$149\.00 on /);
  assert.match(html, /Your membership has ended and will not renew\./);
  assert.match(html, /The refund has been issued to the card you paid with\./);
  assert.doesNotMatch(html, /Cancel and get a refund<\/button>/, 'no second refund to press for');
});

test('Keep my membership closes the review without a refund', async () => {
  const f = fixture();
  await button(f, 'Cancel and get a refund').props.onClick();
  tick(f);
  button(f, REFUND_COPY.keep).props.onClick();
  assert.match(f.html(), />Cancel and get a refund</);
  assert.equal(f.calls.some(c => c[0] === 'refund'), false);
});

test('an unfinished refund says so and offers to finish it; a finished one reads its outcome', async () => {
  const f = fixture();
  f.client.refund = async input => { f.calls.push(['refund', input]); throw Object.assign(Error('x'), { code: 'refund_pending', httpStatus: 503, phase: 'http' }); };
  f.client.refundStatus = async () => { f.calls.push(['status']); return quote({ state: 'resume', subscriptionCanceled: true, periodEnd: undefined }); };
  await button(f, 'Cancel and get a refund').props.onClick();
  tick(f);
  await button(f, 'Cancel membership and refund').props.onClick();
  let html = f.html();
  assert.match(html, /Your refund did not finish\. Nothing was refunded twice\. Press Finish refund to complete it\./);
  assert.match(html, /Your refund is not finished yet\./);
  f.client.refundQuote = async () => { f.calls.push(['quote']); return quote({ state: 'resume', subscriptionCanceled: true }); };
  f.client.refund = async input => { f.calls.push(['refund', input]); return refunded({ refundStatus: 'pending' }); };
  await button(f, REFUND_COPY.finish).props.onClick();
  tick(f);
  await button(f, REFUND_COPY.finish).props.onClick();
  html = f.html();
  assert.match(html, /Refunded: \$149\.00/);
  assert.match(html, /The refund is on its way to the card you paid with\./);
});

test('a member whose membership ended sees a refund on record, and nothing when there is none', async () => {
  const none = fixture({ paid: false });
  assert.equal(none.html(), '');
  none.render(); active.flush(); await settle();
  assert.deepEqual(none.calls, [['status']]);
  assert.equal(none.html(), '', 'no record, nothing to show, no button');
  const done = fixture({ paid: false });
  done.client.refundStatus = async () => refunded();
  done.render(); active.flush(); await settle();
  assert.match(done.html(), /Refunded: \$149\.00/);
  const help = fixture({ paid: false });
  help.client.refundStatus = async () => refunded({ state: 'needs_support', refundStatus: null, refundedAt: null });
  help.render(); active.flush(); await settle();
  assert.match(help.html(), /the refund could not be completed automatically\. Contact support@credentialdomd\.com or use Get help/);
  const pending = fixture({ paid: false, accessStatus: 'pending' });
  pending.render(); active.flush(); await settle();
  assert.deepEqual(pending.calls, [], 'a pay-first account has nothing on record to look up');
});

test('refusals say why in plain words', () => {
  assert.match(refundMessage({ code: 'refund_in_progress' }), /already being processed/);
  assert.match(refundMessage({ code: 'no_refundable_payment' }), /no payment on this membership to refund/);
  assert.match(refundMessage({ code: 'refund_not_available' }), /Lifetime access has no payment to refund/);
  assert.match(refundMessage({ code: 'refund_quote_changed' }), /Review the refund again/);
  assert.match(refundMessage({ code: 'x', phase: 'timeout' }), /Check again to see where your refund stands/);
  assert.match(refundMessage({}), /Nothing was changed/);
});

test('the copy: no em or en dashes, and the terms beside the button are the offer\'s own', () => {
  const texts = [...Object.values(REFUND_COPY), MEMBERSHIP_COPY.refundTerms,
    ...['refund_in_progress', 'refund_pending', 'refund_quote_changed', 'no_refundable_payment', 'refund_not_available', 'refund_needs_support', 'no_paid_membership', 'payment_already_refunded'].map(code => refundMessage({ code }))];
  for (const text of texts) assert.doesNotMatch(text, /[—–]/, text);
  for (const file of ['src/components/pages/RefundSection.jsx', 'src/content/refundCopy.js', 'src/utils/payFirst.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), /[—–]/, file);
  }
  assert.ok(WELCOME_MONEY_BACK.startsWith(MEMBERSHIP_COPY.refundTerms), 'the unchanged guarantee');
  const card = fs.readFileSync(new URL('../../src/components/pages/LimitedLaunchMembership.jsx', import.meta.url), 'utf8');
  assert.match(card, /<RefundSection paid \/>/, 'on the paid membership card in Profile & settings');
  const cancel = fs.readFileSync(new URL('../../src/components/pages/CancellationPage.jsx', import.meta.url), 'utf8');
  assert.match(cancel, /<RefundSection paid \/>/, 'on More > Cancel Subscription');
  assert.match(cancel, /onClick=\{manage\}>Manage paid subscription/, 'cancel at period end stays');
});

test('client: the refund calls go to limited-refund and only a well-formed answer is used', async () => {
  const posted = [];
  const session = { user: { id: owner }, getToken: async () => 'synthetic-token' };
  let answer = quote();
  const client = createLimitedLaunchClient({ accountId: owner, enabled: true, url: 'https://membership.invalid', anonKey: 'synthetic-public-key', getSession: () => session, timeoutMs: 1000,
    fetchImpl: async (url, init) => { posted.push([new URL(url).pathname, JSON.parse(init.body)]); return Response.json(answer); } });
  assert.deepEqual(await client.refundQuote(), quote());
  answer = refunded();
  assert.equal((await client.refund({ paymentId: 'in_Latest', amountCents: 14900, confirm: true })).state, 'refunded');
  answer = { schemaVersion: 1, state: 'none' };
  assert.deepEqual(await client.refundStatus(), { schemaVersion: 1, state: 'none' });
  assert.deepEqual(posted, [['/functions/v1/limited-refund', { action: 'quote' }], ['/functions/v1/limited-refund', { action: 'refund', paymentId: 'in_Latest', amountCents: 14900, confirm: true }], ['/functions/v1/limited-refund', { action: 'status' }]]);
  for (const bad of [{ ...quote(), amountCents: 1 }, { ...quote(), currency: 'eur' }, { ...quote(), state: 'granted' }, { ...refunded(), refundedAt: null }]) {
    answer = bad;
    await assert.rejects(client.refundQuote(), /Membership information could not load/);
  }
  await assert.rejects(client.refund({ paymentId: 'in_Latest', amountCents: 14900 }), error => error.code === 'refund_confirmation_required');
  await assert.rejects(client.refund({ paymentId: 'in_Latest', amountCents: 14900, confirm: true, extra: 1 }), error => error.code === 'refund_confirmation_required');
  assert.equal(posted.length, 3 + 4, 'nothing sent for an unconfirmed refund');
});

// Review fix (2026-09-30): a request that stopped before its cancellation.
test('an unfinished request whose cancellation did not happen never says the membership is cancelled; its dialog says access ends now', async () => {
  const f = fixture();
  f.client.refund = async input => { f.calls.push(['refund', input]); throw Object.assign(Error('x'), { code: 'refund_pending', httpStatus: 503, phase: 'http' }); };
  f.client.refundStatus = async () => { f.calls.push(['status']); return quote({ state: 'resume', subscriptionCanceled: false, periodEnd: undefined }); };
  await button(f, 'Cancel and get a refund').props.onClick();
  tick(f);
  await button(f, 'Cancel membership and refund').props.onClick();
  let html = f.html();
  assert.doesNotMatch(html, /Your membership is cancelled/);
  assert.match(html, /Your refund request did not finish, and nothing has been refunded yet\. We keep trying to finish it for you, which cancels your membership and returns your payment\. You can also press Finish refund to do it now\./);
  f.client.refundQuote = async () => { f.calls.push(['quote']); return quote({ state: 'resume', subscriptionCanceled: false }); };
  await button(f, REFUND_COPY.finish).props.onClick();
  html = f.html();
  assert.match(html, /Your membership ends now\. The subscription is cancelled today and will not renew, and you can no longer add or change records\./, 'told what finishing does');
  assert.doesNotMatch(html, /Your membership is cancelled/);
  assert.match(html, /without a refund\? Use Manage paid subscription to turn off renewal instead\./, 'keeping it is still offered');
  // Cancelled on record: the unfinished line and no keep offer.
  const g = fixture();
  g.client.refundQuote = async () => quote({ state: 'resume', subscriptionCanceled: true });
  await button(g, 'Cancel and get a refund').props.onClick();
  html = g.html();
  assert.match(html, /Your membership is cancelled, and we keep trying to return your payment for you\. You can also press Finish refund to try again now\./);
  assert.doesNotMatch(html, /Your membership ends now|turn off renewal instead/);
  // Needs support before any cancellation, and after one.
  const open = fixture({ paid: false });
  open.client.refundStatus = async () => refunded({ state: 'needs_support', subscriptionCanceled: false, refundStatus: 'succeeded', refundedAt: null });
  open.render(); active.flush(); await settle();
  assert.match(open.html(), /Your refund request needs a person to finish it\./);
  assert.doesNotMatch(open.html(), /Your membership was cancelled/);
  const failed = fixture({ paid: false });
  failed.client.refundStatus = async () => refunded({ state: 'needs_support', subscriptionCanceled: true, refundStatus: 'failed', refundedAt: null });
  failed.render(); active.flush(); await settle();
  assert.match(failed.html(), /Your membership was cancelled, but the refund could not be completed automatically\./);
  assert.doesNotMatch(failed.html(), /has been issued|on its way/, 'a refund that failed is never shown as issued');
});

// Server side hand-over (2026-09-30): a refund that cannot finish opens a
// support ticket for the member (20260930071000); the answer says so
// (supportTicket) and the member reads that they need to do nothing.
test('a refund that needs a person: the member reads that a ticket was opened for them and that they need to do nothing', async () => {
  const cancelled = fixture({ paid: false });
  cancelled.client.refundStatus = async () => refunded({ state: 'needs_support', subscriptionCanceled: true, refundStatus: 'failed', refundedAt: null, supportTicket: true });
  cancelled.render(); active.flush(); await settle();
  let html = cancelled.html();
  assert.match(html, /Your membership was cancelled, but the refund could not be completed automatically\. We opened a support ticket for you, which you can read in Get help, and we will finish your refund for you\. You do not need to do anything\./);
  assert.doesNotMatch(html, /Contact support@credentialdomd\.com/, 'nothing asked of the member');
  const open = fixture({ paid: false });
  open.client.refundStatus = async () => refunded({ state: 'needs_support', subscriptionCanceled: false, refundStatus: null, refundedAt: null, supportTicket: true });
  open.render(); active.flush(); await settle();
  html = open.html();
  // Before any cancellation (a dispute, say): nothing is promised, and the membership still stands (review round 3).
  assert.match(html, /Your refund request needs a person to look at it, and your membership is not cancelled yet\. We opened a support ticket for you, which you can read in Get help, and we will reply there\./);
  assert.doesNotMatch(html, /Your membership was cancelled|Contact support@|will finish it for you|do not need to do anything/);
  // Cancelled, the refund attempt failed: a ticket is open and a press may still finish it.
  const stuck = fixture({ paid: false });
  stuck.client.refundStatus = async () => quote({ state: 'resume', subscriptionCanceled: true, periodEnd: undefined, supportTicket: true });
  stuck.render(); active.flush(); await settle();
  html = stuck.html();
  assert.match(html, /We opened a support ticket for you, which you can read in Get help, and we will finish your refund for you\. You do not need to do anything\. You can also press Finish refund to try again now\./);
  assert.ok(button(stuck, REFUND_COPY.finish), 'the button stays');
  // A server from before the ticket migration: no ticket claimed.
  const legacy = fixture({ paid: false });
  legacy.client.refundStatus = async () => refunded({ state: 'needs_support', subscriptionCanceled: true, refundStatus: null, refundedAt: null });
  legacy.render(); active.flush(); await settle();
  assert.match(legacy.html(), /Contact support@credentialdomd\.com or use Get help and it will be finished for you/);
  assert.doesNotMatch(legacy.html(), /We opened a support ticket/);
  for (const text of [REFUND_COPY.needsSupport, REFUND_COPY.needsSupportOpen, REFUND_COPY.unfinishedTicket]) assert.doesNotMatch(text, /[—–]/);
});

test('client: supportTicket is a boolean when present', async () => {
  let answer = refunded({ state: 'needs_support', refundedAt: null, supportTicket: true });
  const session = { user: { id: owner }, getToken: async () => 'synthetic-token' };
  const client = createLimitedLaunchClient({ accountId: owner, enabled: true, url: 'https://membership.invalid', anonKey: 'synthetic-public-key', getSession: () => session, timeoutMs: 1000,
    fetchImpl: async () => Response.json(answer) });
  assert.equal((await client.refundStatus()).supportTicket, true);
  answer = refunded({ state: 'needs_support', refundedAt: null, supportTicket: 'yes' });
  await assert.rejects(client.refundStatus(), /Membership information could not load/);
});

test('a new purchase while a refund is unfinished is refused in plain words', () => {
  assert.match(REFUND_COPY.finishBeforeJoining, /Press Finish refund on this page first/);
  const card = fs.readFileSync(new URL('../../src/components/pages/LimitedLaunchMembership.jsx', import.meta.url), 'utf8');
  assert.match(card, /refund_unfinished: REFUND_COPY\.finishBeforeJoining/);
  const client = fs.readFileSync(new URL('../../src/utils/limitedLaunchClient.js', import.meta.url), 'utf8');
  assert.match(client, /"refund_unfinished"/, 'the code reaches the page');
});

// Review round 4 (2026-09-30).
test('a refund a person must look at first (reviewOnly, a disputed charge say) promises nothing, cancelled or not, as the ticket does not', async () => {
  const cancelled = fixture({ paid: false });
  cancelled.client.refundStatus = async () => refunded({ state: 'needs_support', subscriptionCanceled: true, refundStatus: null, refundedAt: null, supportTicket: true, reviewOnly: true });
  cancelled.render(); active.flush(); await settle();
  let html = cancelled.html();
  assert.match(html, /Your membership was cancelled, and your refund needs a person to look at it\. We opened a support ticket for you, which you can read in Get help, and we will reply there\./);
  assert.doesNotMatch(html, /we will finish your refund|do not need to do anything|will be finished for you/);
  const legacy = fixture({ paid: false });
  legacy.client.refundStatus = async () => refunded({ state: 'needs_support', subscriptionCanceled: true, refundStatus: null, refundedAt: null, reviewOnly: true });
  legacy.render(); active.flush(); await settle();
  html = legacy.html();
  assert.match(html, /Your membership was cancelled, and your refund needs a person to look at it\. Contact support@credentialdomd\.com or use Get help\./);
  assert.doesNotMatch(html, /will be finished for you/);
  // A disputed charge with no request on record: the refusal promises nothing either.
  assert.equal(refundMessage({ code: 'refund_needs_support' }), 'This payment needs a person to look at it. Contact support@credentialdomd.com or use Get help.');
  for (const text of [REFUND_COPY.needsSupportReview, REFUND_COPY.needsSupportReviewNoTicket]) assert.doesNotMatch(text, /[—–]/);
});

test('a refund press that fails in a way the server did not name never says nothing changed (the cancellation and refund may have gone through)', async () => {
  const f = fixture();
  f.client.refund = async input => { f.calls.push(['refund', input]); throw Object.assign(Error('x'), { code: 'billing_unavailable', httpStatus: 503, phase: 'http' }); };
  f.client.refundStatus = async () => { f.calls.push(['status']); return quote({ state: 'resume', subscriptionCanceled: true, periodEnd: undefined }); };
  await button(f, 'Cancel and get a refund').props.onClick();
  tick(f);
  await button(f, 'Cancel membership and refund').props.onClick();
  const html = f.html();
  assert.doesNotMatch(html, /Nothing was changed/);
  assert.match(html, /We could not confirm the result yet\. Check again to see where your refund stands\./);
  // The quote failing the same way changed nothing, and says so.
  const q = fixture();
  q.client.refundQuote = async () => { throw Object.assign(Error('x'), { code: 'billing_unavailable', httpStatus: 503, phase: 'http' }); };
  await button(q, 'Cancel and get a refund').props.onClick();
  assert.match(q.html(), /Nothing was changed/);
});

test('client: reviewOnly is a boolean when present', async () => {
  let answer = refunded({ state: 'needs_support', refundedAt: null, reviewOnly: true });
  const session = { user: { id: owner }, getToken: async () => 'synthetic-token' };
  const client = createLimitedLaunchClient({ accountId: owner, enabled: true, url: 'https://membership.invalid', anonKey: 'synthetic-public-key', getSession: () => session, timeoutMs: 1000,
    fetchImpl: async () => Response.json(answer) });
  assert.equal((await client.refundStatus()).reviewOnly, true);
  answer = refunded({ state: 'needs_support', refundedAt: null, reviewOnly: 'yes' });
  await assert.rejects(client.refundStatus(), /Membership information could not load/);
});
