import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adminReportCsv, normalizeAdminAttention, normalizeAdminPeople, normalizeAdminReport, ADMIN_REPORT_DEFINITIONS } from '../../src/utils/adminOperationsReport.js';
import { ACCOUNT_GROUPS, ADMIN_SOURCES, accountGroup, groupAdminAccounts, isFoundingAccount, isPaidFounder } from '../../src/utils/adminData.js';
import { leadState, paidMemberEmails, waitlistView } from '../../src/utils/adminWaitlist.js';
import { createPublicMembershipOfferHandler } from '../../supabase/functions/_shared/publicMembershipOffer.mjs';
import { ownerNotifyMessage } from '../../supabase/functions/_shared/ownerNotify.mjs';
import { offerPresentation } from '../../public/membership-offer.js';
import { reportFixture } from './report-fixture.mjs';

// Owner rule, 2026-11-16: only PAID members count as signed up, users or
// members. Anyone who only gave an email for a guide or the waitlist is a
// LEAD. The database side is leads-vs-paid-members-sql.test.mjs; this is the
// admin pages, the public offer function and the owner notifications.

const people = { paid_members: 3, paid_founders: 4, founder_spots_left: 96, leads: 41, accounts_not_paid: 9, new_paid_in_period: 0 };
const withPeople = (days = 7, paidDays = [0, 2]) => {
  const input = reportFixture(days);
  input.daily.forEach((row, index) => { row.paid_members = paidDays.includes(index) ? 1 : 0; });
  input.people = { ...people, new_paid_in_period: paidDays.length };
  return input;
};

test('the report keeps paid members and leads apart from account profiles', () => {
  const report = normalizeAdminReport(withPeople(), 7);
  assert.deepEqual(report.people, { ...people, new_paid_in_period: 2 });
  assert.deepEqual(report.daily.map(row => row.paid_members), [1, 0, 1, 0, 0, 0, 0]);
  // The account numbers are untouched and are never the member number.
  assert.equal(report.accounts.total, 1000);
  assert.notEqual(report.people.paid_members, report.accounts.total);
});

test('a server without the people block still reports, with no member number invented', () => {
  const report = normalizeAdminReport(reportFixture(7), 7);
  assert.equal(report.people, null);
  assert.ok(report.daily.every(row => row.paid_members === null));
  const csv = adminReportCsv(reportFixture(7));
  assert.doesNotMatch(csv, /"Paid members"|"Leads"/);
});

test('a malformed people block fails the report instead of reading as zero members', () => {
  const variants = [
    value => { value.people.paid_members = '3'; },
    value => { value.people.leads = -1; },
    value => { delete value.people.paid_founders; },
    value => { value.people.founder_spots_left = 101; },
    value => { value.people.founder_spots_left = 1.5; },
    value => { value.people = []; },
    value => { delete value.daily[0].paid_members; },
    value => { value.people.new_paid_in_period = 5; }, // does not match the daily rows
  ];
  for (const change of variants) {
    const input = withPeople(); change(input);
    assert.throws(() => normalizeAdminReport(input, 7), /incomplete report/, change.toString());
  }
  // No live founding program: spots left is absent, everything else stands.
  const input = withPeople(); input.people.founder_spots_left = null;
  assert.equal(normalizeAdminReport(input, 7).people.founder_spots_left, null);
  assert.equal(normalizeAdminPeople(null), null);
});

test('the CSV export names paid members and leads, and labels accounts as not members', () => {
  const csv = adminReportCsv(withPeople());
  for (const line of ['"Snapshot","Paid members","","3"', '"Snapshot","Paid founder members","","4"', '"Snapshot","Founder spots left","","96"',
    '"Window","New paid members","","2"', '"Snapshot","Leads","","41"', '"Snapshot","Accounts without a paid membership","","9"',
    '"Snapshot","Account profiles (not members)","","1000"', '"Window","New account profiles (not members)","","14"']) assert.ok(csv.includes(line), line);
  assert.equal(csv.match(/"Daily","New paid members"/g).length, 7);
  // Definitions may say "not signups"; no metric is named one.
  const metrics = csv.split('\r\n').map(line => line.split('","')[1] || '');
  assert.ok(metrics.every(name => !/signup/i.test(name)), 'no metric calls an unpaid account a signup');
  for (const key of ['paid_members', 'leads', 'founder_spots_left']) assert.ok(ADMIN_REPORT_DEFINITIONS[key]);
  assert.match(ADMIN_REPORT_DEFINITIONS.leads, /not users, members or signups/);
});

test('the Leads tab count is optional, and a bad one is not shown as a number', () => {
  const base = { unread_replies: 0, new_errors_since_seen: 0, waitlist_waiting: 2, fields_pending: 0 };
  assert.equal(normalizeAdminAttention(base).leads, undefined);
  assert.equal(normalizeAdminAttention({ ...base, leads: 41 }).leads, 41);
  assert.equal(normalizeAdminAttention({ ...base, leads: '41' }), null);
  assert.equal(ADMIN_SOURCES.waitlist.label, 'Leads');
});

test('a lead is counted once and leaves the lead count only by paying', () => {
  const rows = [
    { id: 1, email: 'guide@example.invalid', waitlist: false },
    { id: 2, email: ' GUIDE@example.invalid', waitlist: false }, // second guide, same person
    { id: 3, email: 'wait@example.invalid', waitlist: true },
    { id: 4, email: 'account@example.invalid', waitlist: true }, // signed in, never paid
    { id: 5, email: 'Paid@example.invalid', waitlist: false }, // asked for a guide, later paid
  ];
  const users = [
    { id: 'a', email: 'account@example.invalid', access_status: 'active' },
    { id: 'p', email: 'paid@example.invalid', access_status: 'active' },
    { id: 'x', email: 'closed@example.invalid', access_status: 'active', deleted_at: '2026-11-01T00:00:00Z' },
  ];
  const memberships = new Map([['a', { paid_active: false }], ['p', { paid_active: true }], ['x', { paid_active: true }]]);
  const paid = paidMemberEmails(users, memberships);
  assert.deepEqual([...paid], ['paid@example.invalid']);
  const view = waitlistView(rows, users, [], {}, paid);
  assert.equal(view.leadCount, 3, 'guide, wait and the unpaid account; two guide rows are one lead');
  assert.deepEqual(view.members.map(row => row.id), [5]);
  assert.equal(view.paidKnown, true);
  assert.equal(leadState(rows[4], view), 'paid member');
  assert.equal(leadState(rows[3], view), 'account active', 'an account without payment is still not a member');
  assert.equal(leadState(rows[0], view), 'guide only');
  // Nothing is removed from the list: every row is still there to read.
  assert.equal(view.leads.length + view.members.length, rows.length);
  // Payment facts unavailable: nobody is moved, and the page can say so.
  const unknown = waitlistView(rows, users, [], {}, paidMemberEmails(users, { error: 'x' }));
  assert.equal(unknown.paidKnown, false);
  assert.equal(unknown.leadCount, 4);
  assert.equal(unknown.members.length, 0);
});

test('Accounts: only the paying group is members, and the founder count is paid founders only', () => {
  assert.deepEqual(ACCOUNT_GROUPS.map(group => group.label), ['Paid members', 'Free access, not paid members', 'Accounts without a paid membership, not members', 'Closed accounts']);
  const rows = [{ id: 1 }, { id: 2 }, { id: 3, founding_number: 7, is_founding_member: true }, { id: 4 }];
  const facts = new Map([[1, { paid_active: true, founding: true, founding_paid: true }], [2, { paid_active: false, lifetime: true, founding_paid: false }],
    [3, { paid_active: false, founding: true, founding_paid: false }], [4, { paid_active: false, founding: true, founding_paid: true }]]);
  const groups = groupAdminAccounts(rows, facts);
  assert.deepEqual(groups.paying.map(row => row.id), [1]);
  assert.equal(accountGroup(rows[1], facts.get(2)), 'free');
  // The pre-launch badge still shows on the row but is not a paid founder.
  assert.equal(isFoundingAccount(rows[2], facts.get(3)), true);
  assert.equal(isPaidFounder(facts.get(3)), false);
  assert.equal(rows.filter(row => isPaidFounder(facts.get(row.id)) === true).length, 2);
  // An older server does not say: no number rather than a mixed one.
  assert.equal(isPaidFounder({ founding: true }), null);
  assert.equal(isPaidFounder(undefined), null);
});

test('the public offer function passes the database count through and never makes one up', async () => {
  const base = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available', bundleAvailable: false };
  const answer = async offer => (await createPublicMembershipOfferHandler({ readOffer: async () => offer })(new Request('https://x.example/', { method: 'GET' }))).json();
  assert.equal((await answer({ ...base, founderSpotsLeft: 97 })).founderSpotsLeft, 97);
  assert.equal((await answer({ ...base, founderSpotsLeft: 0 })).founderSpotsLeft, 0);
  // No count from the database: none in the reply. Never a default or a literal.
  assert.equal(Object.hasOwn(await answer(base), 'founderSpotsLeft'), false);
  for (const bad of [-1, 101, 12.5, '97', null, NaN]) {
    assert.equal(Object.hasOwn(await answer({ ...base, founderSpotsLeft: bad }), 'founderSpotsLeft'), false, String(bad));
  }
  // Founding is over: no founder count, whatever the database row says.
  const later = await answer({ ...base, phase: 'earlybird', annualCents: 14900, bundleAvailable: true, founderSpotsLeft: 3 });
  assert.equal(Object.hasOwn(later, 'founderSpotsLeft'), false);
  // The site prints exactly what was sent.
  assert.equal(offerPresentation({ ...base, founderSpotsLeft: 97 }).spots, '97 of 100 founder spots left');
  const source = fs.readFileSync(new URL('../../supabase/functions/_shared/publicMembershipOffer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /founderSpotsLeft:\s*\d/, 'no hard-coded count');
});

test('the migration computes spots left from capacity and paid places, with no literal count', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20261116120000_leads_vs_paid_members.sql', import.meta.url), 'utf8');
  const body = sql.slice(sql.indexOf('create or replace function public.founder_spots_left()'), sql.indexOf('comment on function public.founder_spots_left()'));
  assert.match(body, /g\.capacity-public\.paid_founder_count\(\)/);
  assert.doesNotMatch(body, /\b100\b/);
  assert.match(sql, /f\.livemode and f\.state='paid'/);
  // Additive and reversible: no table is dropped, altered, deleted from or updated.
  const statements = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(statements, /\b(drop\s+table|alter\s+table|truncate|delete\s+from|update\s+public\.|insert\s+into)\b/i);
  assert.ok(fs.existsSync(new URL('../../docs/rollback/20261116120000_leads_vs_paid_members.rollback.sql', import.meta.url)));
});

test('owner notifications do not call an unpaid contact a signup, in the email and the text alike', () => {
  const lead = { kind: 'waitlist', name: 'Synthetic Lead', email: 'lead@example.test', extra: 'state guide' };
  const account = { kind: 'app profile', name: 'Synthetic Account', email: 'acct@example.test' };
  const cases = [[[lead], 'CredentialDOMD lead'], [[lead, { ...lead, kind: 'founding' }], 'CredentialDOMD leads'],
    [[account], 'CredentialDOMD new account, not paid'], [[account, account], 'CredentialDOMD new accounts, not paid'],
    [[lead, account], 'CredentialDOMD leads and new accounts, not paid'],
    [[{ kind: 'PAID', name: 'Synthetic Member', email: 'm@example.test', extra: '$99.00' }], 'CredentialDOMD money: 1 paid']];
  const script = fileURLToPath(new URL('../../scripts/signup-notify.py', import.meta.url));
  for (const [rows, header] of cases) {
    const message = ownerNotifyMessage(rows);
    assert.equal(message.split('\n')[0], header);
    assert.doesNotMatch(message, /signup/i);
    // signup-notify.py composes the iMessage: the same text, line for line.
    const python = execFileSync('python3', ['-I', '-c',
      'import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("n",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nsys.stdout.write(m.compose(json.loads(sys.argv[2])))',
      script, JSON.stringify(rows)], { encoding: 'utf8' });
    assert.equal(python, message);
  }
});
