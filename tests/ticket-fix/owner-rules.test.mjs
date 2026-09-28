// G11: protected paths hold the merge for the owner; money literals count
// as protected; the blast radius lists untouched call sites and siblings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedReport, blastRadius, globRegExp, numericLiterals, loadJSON, PROTECTED_CONFIG, SIBLING_CONFIG } from '../../scripts/ticket-fix/gates/owner-rules.mjs';
import { createWorktree, commitWork } from '../../scripts/ticket-fix/worktree.mjs';
import { project, COMMITTER, RUN_ID, TICKET } from './stage2-helpers.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function changed(extra, change) {
  const p = project(extra);
  const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
  p.write(wt.dir, change);
  const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Synthetic', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
  const files = Object.keys(change).sort();
  return { p, wt, head, files };
}

test('the checked-in lists name real files and the rules the design requires', () => {
  const config = loadJSON(PROTECTED_CONFIG);
  const patterns = config.paths.map(p => p.pattern);
  for (const required of ['supabase/**', 'scripts/**', '.github/**', 'package.json', 'package-lock.json', 'landing/privacy.html', 'landing/terms.html', 'src/utils/pricing*.js', 'src/utils/admin*.js']) {
    assert.ok(patterns.includes(required), required);
  }
  for (const rule of config.paths) assert.ok(rule.reason.length > 3, rule.pattern);
  for (const group of loadJSON(SIBLING_CONFIG).groups) for (const member of group.members) assert.ok(existsSync(path.join(root, member)), member);
  assert.ok(globRegExp('supabase/**').test('supabase/migrations/x.sql'));
  assert.ok(globRegExp('src/utils/admin*.js').test('src/utils/adminData.js'));
  assert.ok(!globRegExp('src/utils/admin*.js').test('src/utils/nested/adminData.js'));
  assert.ok(globRegExp('src/components/features/locum/**').test('src/components/features/locum/Invoices.jsx'));
  assert.deepEqual(numericLiterals('const fee = 1,500.25 + rate * 0.75 + v2 + .5;'), ['1500.25', '0.75', '.5']);
});

test('protected paths and legal pages hold the merge', async () => {
  const { p, wt, head, files } = await changed({}, { 'supabase/migrations/20990101000000_x.sql': 'select 1;\n', 'landing/terms.html': '<p>Synthetic terms</p>\n', 'src/utils/adminData.js': 'export const x = 1;\n', 'src/plain.js': 'export const y = 1;\n' });
  try {
    const report = protectedReport({ dir: wt.dir, base: wt.base, head, files });
    assert.equal(report.protected, true);
    assert.deepEqual(report.hits.map(h => h.path).sort(), ['landing/terms.html', 'src/utils/adminData.js', 'supabase/migrations/20990101000000_x.sql']);
    assert.match(report.hits.find(h => h.path === 'landing/terms.html').reason, /legal/);
  } finally { p.cleanup(); }
});

test('a changed number in a money module, or on a price or rate line anywhere, is protected; other edits are not', async () => {
  const base = { 'src/utils/invoiceLayout.js': 'export const DAY_RATE = 3000;\nexport const label = "Day";\n', 'src/view.js': 'export const pageSize = 20;\nexport const fee = 75; // synthetic fee\n' };
  const money = await changed(base, { 'src/utils/invoiceLayout.js': 'export const DAY_RATE = 3075;\nexport const label = "Day";\n' });
  try {
    const report = protectedReport({ dir: money.wt.dir, base: money.wt.base, head: money.head, files: money.files });
    assert.equal(report.protected, true);
    assert.deepEqual(report.money_literals, [{ path: 'src/utils/invoiceLayout.js', removed: ['3000'], added: ['3075'], money_module: true }]);
  } finally { money.p.cleanup(); }
  const line = await changed(base, { 'src/view.js': 'export const pageSize = 25;\nexport const fee = 80; // synthetic fee\n' });
  try {
    const report = protectedReport({ dir: line.wt.dir, base: line.wt.base, head: line.head, files: line.files });
    assert.deepEqual(report.money_literals.map(l => [l.path, l.removed, l.added]), [['src/view.js', ['75'], ['80']]], 'the page size is not money; the fee is');
  } finally { line.p.cleanup(); }
  const wording = await changed(base, { 'src/utils/invoiceLayout.js': 'export const DAY_RATE = 3000;\nexport const label = "Call day";\n' });
  try {
    assert.equal(protectedReport({ dir: wording.wt.dir, base: wording.wt.base, head: wording.head, files: wording.files }).protected, false);
  } finally { wording.p.cleanup(); }
});

test('blast radius: untouched callers of a changed export and of a removed string, and siblings touched in part', async () => {
  const base = {
    'src/utils/shareText.js': "export function composeText(lines) { return lines.join(' '); }\nexport const heading = 'Synthetic heading text';\n",
    'src/utils/invoiceEmailSend.js': "import { composeText } from './shareText.js';\nexport const send = lines => composeText(lines);\n",
    'src/components/features/ShareModal.jsx': "import { composeText } from '../../utils/shareText.js';\nexport const Share = ({ lines }) => composeText(lines);\nconst title = 'Synthetic heading text';\n",
  };
  const r = await changed(base, { 'src/utils/shareText.js': "export function composeText(lines) { return lines.join('\\n'); }\nexport const heading = 'Synthetic new heading';\n" });
  try {
    const siblings = { groups: [{ name: 'send channels', members: ['src/utils/shareText.js', 'src/utils/invoiceEmailSend.js', 'src/components/features/ShareModal.jsx'] },
      { name: 'untouched group', members: ['src/a.js', 'src/b.js'] }] };
    const blast = blastRadius({ dir: r.wt.dir, base: r.wt.base, head: r.head, files: r.files, siblings });
    const exported = blast.terms.find(t => t.term === 'composeText');
    assert.equal(exported.kind, 'changed_export');
    assert.deepEqual(exported.untouched.map(s => s.file).sort(), ['src/components/features/ShareModal.jsx', 'src/components/features/ShareModal.jsx', 'src/utils/invoiceEmailSend.js', 'src/utils/invoiceEmailSend.js']);
    const removed = blast.terms.find(t => t.term === 'Synthetic heading text');
    assert.equal(removed.kind, 'removed_string');
    assert.deepEqual(removed.untouched.map(s => `${s.file}:${s.line}`), ['src/components/features/ShareModal.jsx:3']);
    assert.deepEqual(blast.sibling_groups, [{ name: 'send channels', touched: ['src/utils/shareText.js'], untouched: ['src/utils/invoiceEmailSend.js', 'src/components/features/ShareModal.jsx'] }]);
  } finally { r.p.cleanup(); }
});
