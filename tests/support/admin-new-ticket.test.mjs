// Ticket 95e6425f: the admin New ticket form offered a "Question" category
// that create-ticket and the support_tickets CHECK both refuse, so choosing
// it always failed and the ticket and its screenshot were lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { ADMIN_TICKET_CATEGORIES, TICKET_BODY_MIN, TICKET_SUBJECT_MIN, adminTicketDraftProblem } from '../../src/utils/adminTicketDraft.js';

const server = await readFile(new URL('../../supabase/functions/create-ticket/index.ts', import.meta.url), 'utf8');
const serverCategories = JSON.parse(server.match(/const VALID_CATEGORIES = (\[[^\]]*\]);/)[1]);
const dashboard = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');

test('every category the admin form offers is one create-ticket accepts', () => {
  assert.ok(ADMIN_TICKET_CATEGORIES.length >= 3);
  for (const { value } of ADMIN_TICKET_CATEGORIES) assert.ok(serverCategories.includes(value), value);
  assert.ok(!ADMIN_TICKET_CATEGORIES.some(option => option.value === 'question'));
  assert.doesNotMatch(dashboard, /\["question", "Question"\]/);
});

test('the form holds the same minimum lengths the server enforces', () => {
  assert.match(server, new RegExp(`subject\\.length < ${TICKET_SUBJECT_MIN}\\b`));
  assert.match(server, new RegExp(`ticketBody\\.length < ${TICKET_BODY_MIN}\\b`));
  assert.match(adminTicketDraftProblem({ subject: 'Upload', body: 'short', category: 'bug' }), /at least 10 characters \(5 more\)/);
  assert.match(adminTicketDraftProblem({ subject: 'No', body: 'Long enough details', category: 'bug' }), /one-line summary/);
  assert.match(adminTicketDraftProblem({ subject: 'Upload', body: 'Long enough details', category: 'question' }), /Choose a category/);
  assert.equal(adminTicketDraftProblem({ subject: 'Upload', body: '  Long enough details  ', category: 'bug' }), '');
});

function admin() {
  const hooks = [], invokes = []; let cursor = 0;
  const react = { useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; }, useEffect() {} };
  const db = { functions: { async invoke(name, args) { invokes.push({ name, body: args.body }); return { data: { id: 'ticket', ok: true } }; } } };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../../context/AppContext': { useApp: () => ({ theme: {}, user: { id: 'owner' }, data: {}, userIdRef: { current: 'owner' } }) },
    '../../lib/supabase': { supabase: db }, '../../lib/admin': { useIsAdmin: () => true },
    '../../utils/adminTicketDraft': { ADMIN_TICKET_CATEGORIES, adminTicketDraftProblem },
    '../../utils/ticketAttachments': { attachmentsPayload: () => ({}), linksFor: x => x || [] } };
  const injected = dashboard.replace('  const [reloadedAt, setReloadedAt] = useState(null);', '  const [reloadedAt, setReloadedAt] = useState(null); globalThis.current={createTicket,setNewCategory,setNewSubject,setNewBody,ticketMsg}; return null;') + '\nexport {AdminDashboardContent};';
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: n => imports[n] || {}, console });
  vm.runInContext(transformSync(injected, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  const render = () => { cursor = 0; module.exports.AdminDashboardContent(); return ctx.current; };
  return { render, invokes };
}

test('each category button sends a ticket create-ticket accepts', async () => {
  for (const { value } of ADMIN_TICKET_CATEGORIES) {
    const f = admin();
    f.render().setNewSubject('No screenshot upload');
    f.render().setNewBody('The attach control is missing on the admin form.');
    f.render().setNewCategory(value);
    await f.render().createTicket();
    assert.equal(f.invokes.length, 1, value);
    const sent = f.invokes[0].body;
    assert.ok(serverCategories.includes(sent.category), sent.category);
    assert.ok(sent.subject.length >= TICKET_SUBJECT_MIN && sent.body.length >= TICKET_BODY_MIN);
  }
});

test('a too-short body is stopped before the request, with the reason', async () => {
  const f = admin();
  f.render().setNewSubject('Upload');
  f.render().setNewBody('Broken');
  await f.render().createTicket();
  assert.equal(f.invokes.length, 0);
  assert.match(f.render().ticketMsg, /at least 10 characters/);
});
