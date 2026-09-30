// A release's unapplied migrations, as its DEPLOY-PLAN.md orders them.
// Pure (no I/O), so tests/qa-lab/release-plan.test.mjs checks every rule.
//
// Why: the lab builds its database from production's catalog (extract-schema),
// so on a release branch it has production's schema and NOT the release's own
// migrations. A release is tested the way it will be deployed: production's
// schema first, then each migration the plan lists, in the plan's order, run
// as the plan runs it (the file as it is, as `postgres`, one request each, as
// the SQL editor or the Management API query endpoint sends it), with the one
// rewrite every production definition gets in the lab: the production API
// origin becomes the local gateway, so a pg_net call can only land on this
// machine.
import { sanitize, PROD_ORIGIN } from './ddl.mjs';
import { PROD_PROJECT_REF } from './management-api.mjs';
import { compare, index } from './parity.mjs';

const MIGRATION_NAME = /^\d{8}(?:\d{6})?[a-z]?_[a-z0-9_]+$/;

/**
 * The migrations of a DEPLOY-PLAN.md, in step order: the rows of its "## Order"
 * table whose step is "Migration `<name>`". Throws when the table is missing,
 * a step number repeats or goes backwards, or a name is not a migration name.
 */
export function planMigrations(planText) {
  const lines = String(planText).split('\n');
  const start = lines.findIndex((l) => /^## Order\s*$/.test(l));
  if (start < 0) throw new Error('the deploy plan has no "## Order" section');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const out = [];
  let last = 0;
  for (const line of lines.slice(start + 1, end)) {
    const row = /^\|\s*(\d+)\s*\|\s*([^|]*)\|/.exec(line);
    if (!row) continue;
    const step = Number(row[1]);
    if (step <= last) throw new Error(`the deploy plan's Order table goes from step ${last} to step ${step}; steps run top to bottom`);
    last = step;
    const m = /^Migration `([^`]+)`/.exec(row[2].trim());
    if (!m) continue;
    const name = m[1].replace(/\.sql$/, '');
    if (!MIGRATION_NAME.test(name)) throw new Error(`step ${step} names "${m[1]}", which is not a migration file name`);
    if (out.some((x) => x.name === name)) throw new Error(`the deploy plan lists ${name} twice`);
    out.push({ step, name });
  }
  return out;
}

/**
 * The plan's read-only probes for "is this migration live": the first ```sql
 * block under each bold check heading named in `checks` (default A, the
 * migrations, and F, the reply-email migration), when the plan has it. Each
 * probe is one SELECT whose columns are all boolean.
 */
export function planProbes(planText, checks = ['A', 'F']) {
  const text = String(planText);
  const out = [];
  for (const id of checks) {
    const at = text.search(new RegExp(`^\\*\\*${id}\\. `, 'm'));
    if (at < 0) continue;
    const rest = text.slice(at);
    const next = rest.slice(4).search(/^\*\*[A-Z]\. /m);
    const section = next < 0 ? rest : rest.slice(0, next + 4);
    const block = /```sql\n([\s\S]*?)```/.exec(section);
    if (!block) continue;
    const sql = block[1].trim().replace(/;\s*$/, '');
    if (!/^select\b/i.test(sql) || sql.includes(';')) throw new Error(`check ${id}'s first SQL block is not one SELECT`);
    out.push({ id, sql });
  }
  return out;
}

/**
 * A migration's text as the lab runs it: the production API origin rewritten
 * to the local gateway (the rule lib/ddl.mjs applies to every production
 * definition). Refused when the production project ref survives the rewrite,
 * or when anything credential-shaped is in the file (the lab does not guess
 * what a migration meant by it).
 */
export function labMigrationText(text, name, localOrigin) {
  const report = { rewrites: [], redactions: [], skippedGrants: [], notes: [] };
  const sql = sanitize(text, name, report, localOrigin);
  if (report.redactions.length) throw new Error(`${name} holds credential-shaped text (${[...new Set(report.redactions.map((r) => r.kind))].join(', ')}); refusing to run it in the lab`);
  if (sql.includes(PROD_PROJECT_REF)) {
    const at = sql.indexOf(PROD_PROJECT_REF);
    throw new Error(`${name} still names the production project after the rewrite (near: ${sql.slice(Math.max(0, at - 60), at + 30).replace(/\s+/g, ' ')})`);
  }
  return { sql, rewrites: report.rewrites.reduce((n, r) => n + r.count, 0) };
}

/**
 * The migration files a release adds: those in `headFiles` but not in
 * `liveFiles` (both lists of supabase/migrations names). Compared with the
 * plan's list, so a migration the plan forgot (or lists but the branch lacks)
 * stops the run instead of leaving the lab with a schema no deploy produces.
 */
export function unplannedDifferences(planned, headFiles, liveFiles) {
  const strip = (f) => f.replace(/\.sql$/, '');
  const live = new Set(liveFiles.map(strip));
  const added = headFiles.map(strip).filter((f) => !live.has(f)).sort();
  const names = new Set(planned.map((m) => m.name));
  const onLive = planned.filter((m) => live.has(m.name)).map((m) => m.name);
  return {
    added,
    notPlanned: added.filter((f) => !names.has(f)),
    onLive,
    missing: planned.filter((m) => !headFiles.map(strip).includes(m.name)).map((m) => m.name),
  };
}

/**
 * What applying the release changed in the local database: every catalog
 * difference between the snapshot taken before the first release migration
 * and the one taken after the last, keyed like qa:parity's differences
 * (category, key, and kind in production-vs-local orientation: "only local" =
 * the release creates it, "missing locally" = the release drops it,
 * "differs" = the release changes it).
 */
export function releaseDelta(before, after, localOrigin) {
  return compare(index(before, { localOrigin, rewrite: false }), index(after, { localOrigin, rewrite: false }))
    .flatMap((r) => r.diffs.map((d) => ({ category: d.category, key: d.key, kind: d.kind })));
}

/** True when a parity difference is one of the release's own changes (same category, key and kind). */
export function isReleaseChange(diff, delta) {
  return delta.some((d) => d.category === diff.category && d.key === diff.key && d.kind === diff.kind);
}

export { PROD_ORIGIN };
