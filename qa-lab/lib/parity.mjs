// Compares two catalog snapshots (production and local) category by category.
// Pure, so tests/qa-lab/schema-ddl.test.mjs can check it on synthetic catalogs.
import { createHash } from 'node:crypto';
import { sanitize } from './ddl.mjs';
import { APP_SCHEMAS } from './catalog-sql.mjs';

const h = (s) => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);

/**
 * Canonical form of a deparsed expression: nested AND/OR groups are flattened.
 *
 * Why: PostgreSQL stores `a between 1 and 2 and b` as AND(AND(a>=1, a<=2), b),
 * which deparses as "((a >= 1) AND (a <= 2)) AND b". Re-creating the object from
 * that text makes the grammar flatten it to AND(a>=1, a<=2, b). Same meaning,
 * different text; comparing canonical forms keeps parity exact without calling
 * that a difference.
 */
export function normalizeExpr(text) {
  if (text === null || text === undefined) return text;
  const src = String(text);
  // Parse into nested groups. Items are plain text (strings), quoted literals or
  // identifiers ({ q }), which are never split, and parenthesized groups ({ items }).
  let i = 0;
  const parseGroup = (closing) => {
    const items = [];
    let buf = '';
    const flush = () => { if (buf) { items.push(buf); buf = ''; } };
    while (i < src.length) {
      const c = src[i];
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < src.length) { if (src[j] === c && src[j + 1] === c) { j += 2; continue; } if (src[j] === c) break; j++; }
        flush(); items.push({ q: src.slice(i, j + 1) }); i = j + 1; continue;
      }
      if (c === '(') { flush(); i++; items.push(parseGroup(true)); continue; }
      if (c === ')' && closing) { i++; flush(); return { items }; }
      buf += c; i++;
    }
    flush();
    return { items };
  };
  const root = parseGroup(false);
  const isGroup = (x) => typeof x === 'object' && 'items' in x;

  // Split a group's items at top-level " AND " / " OR " (only in plain text).
  const operands = (g) => {
    const ops = []; let cur = []; let kind = null; let mixed = false;
    for (const it of g.items) {
      if (typeof it !== 'string') { cur.push(it); continue; }
      for (const p of it.split(/( AND | OR )/)) {
        if (p === ' AND ' || p === ' OR ') {
          const k = p.trim();
          if (kind && kind !== k) mixed = true;
          kind = k; ops.push(cur); cur = [];
        } else if (p) cur.push(p);
      }
    }
    ops.push(cur);
    return { ops, kind: mixed ? null : kind };
  };
  const singleGroup = (op) => {
    const real = op.filter((x) => typeof x !== 'string' || x.trim() !== '');
    return real.length === 1 && isGroup(real[0]) ? real[0] : null;
  };
  const flatten = (g) => {
    for (const it of g.items) if (isGroup(it)) flatten(it);
    const { ops, kind } = operands(g);
    if (!kind || ops.length < 2) return;
    const out = [];
    for (const op of ops) {
      const inner = singleGroup(op);
      const sub = inner && operands(inner);
      if (sub && sub.kind === kind && sub.ops.length > 1) out.push(...sub.ops);
      else out.push(op);
    }
    g.items = [];
    out.forEach((op, n) => {
      if (n) g.items.push(` ${kind} `);
      const trimmed = [...op];
      if (typeof trimmed[0] === 'string') trimmed[0] = trimmed[0].replace(/^ +/, '');
      const last = trimmed.length - 1;
      if (typeof trimmed[last] === 'string') trimmed[last] = trimmed[last].replace(/ +$/, '');
      g.items.push(...trimmed);
    });
  };
  flatten(root);
  const print = (g) => g.items.map((x) => (typeof x === 'string' ? x : isGroup(x) ? `(${print(x)})` : x.q)).join('');
  return print(root);
}
const aclKey = (a) => `${a.grantee}:${a.privilege}${a.grantable ? '*' : ''}/${a.grantor}`;
const aclSet = (acl) => (acl || []).map(aclKey).sort();

/**
 * Keyed maps per category. Production definitions are passed through the same
 * rewrite the DDL generator applies, so a rewritten URL is not a difference.
 */
export function index(catalog, { localOrigin, rewrite }) {
  const report = { rewrites: [], redactions: [], skippedGrants: [], notes: [] };
  const clean = (text, where) => normalizeExpr(rewrite ? sanitize(text, where, report, localOrigin) : text);
  const m = {};
  const put = (cat, key, value) => { (m[cat] ??= new Map()).set(key, value); };

  for (const e of catalog.meta.extensions) put('extensions', e.name, `${e.version} in ${e.schema}`);
  for (const r of catalog.meta.roles) put('roles', r, 'exists');
  for (const s of catalog.meta.schemas) {
    put('schemas', s.name, `owner ${s.owner}`);
    put('schema grants', s.name, aclSet(s.acl).join(' '));
  }
  for (const e of catalog.meta.event_triggers) put('event triggers', e, 'exists');
  for (const d of catalog.meta.default_acls) put('default privileges', `${d.role} in ${d.schema ?? '(all schemas)'} on ${d.objtype}`, aclSet(d.acl).join(' '));

  for (const t of catalog.tables) {
    const k = `${t.schema}.${t.name}`;
    put('tables', k, `owner ${t.owner}, rls ${t.rls}, force ${t.force_rls}, replica ${t.replident}, ${t.persistence}`);
    put('table grants', k, aclSet(t.acl).join(' '));
    t.columns.forEach((c, i) => {
      put('columns', `${k}.${c.name}`, JSON.stringify({ position: i + 1, type: c.type, notnull: c.notnull, default: clean(c.default, k), identity: c.identity, generated: clean(c.generated, k), collation: c.collation }));
      if ((c.acl || []).length) put('column grants', `${k}.${c.name}`, aclSet(c.acl).join(' '));
    });
  }
  for (const v of catalog.views) {
    const k = `${v.schema}.${v.name}`;
    put('views', k, `owner ${v.owner}, options ${JSON.stringify(v.options)}, def ${h(clean(v.def, k))}`);
    put('table grants', k, aclSet(v.acl).join(' '));
    for (const c of v.columns) if ((c.acl || []).length) put('column grants', `${k}.${c.name}`, aclSet(c.acl).join(' '));
  }
  for (const q of catalog.sequences) {
    const k = `${q.schema}.${q.name}`;
    put('sequences', k, `${q.type} start ${q.start} inc ${q.increment} min ${q.min} max ${q.max} cache ${q.cache} cycle ${q.cycle} owner ${q.owner} owned_by ${q.owned_by ? `${q.owned_by.table}.${q.owned_by.column}/${q.owned_by.deptype}` : '-'}`);
    put('sequence grants', k, aclSet(q.acl).join(' '));
  }
  for (const f of catalog.functions) {
    const k = `${f.schema}.${f.name}(${f.args})`;
    put('functions', k, `${f.kind} owner ${f.owner} secdef ${f.security_definer} def ${h(clean(f.def, k))}`);
    put('function grants', k, aclSet(f.acl).join(' '));
  }
  for (const c of catalog.constraints) put('constraints', `${c.schema}.${c.table}.${c.name}`, `${c.type} ${clean(c.def, c.name)}`);
  for (const i of catalog.indexes) put('indexes', `${i.schema}.${i.name}`, clean(i.def, i.name));
  for (const t of catalog.triggers) put('triggers', `${t.schema}.${t.table}.${t.name}`, `${t.enabled} ${clean(t.def, t.name)}`);
  for (const p of catalog.policies) put('policies', `${p.schema}.${p.table}.${p.name}`, JSON.stringify({ permissive: p.permissive, roles: p.roles, cmd: p.cmd, qual: clean(p.qual, p.name), with_check: clean(p.with_check, p.name) }));

  for (const [k, v] of Object.entries(catalog.platform_privileges || {})) put('platform privileges', k, v.join(' '));

  const pl = catalog.platform;
  for (const b of pl.buckets) put('storage buckets', b.id, JSON.stringify({ name: b.name, public: b.public, file_size_limit: b.file_size_limit, allowed_mime_types: b.allowed_mime_types }));
  for (const j of pl.cron_jobs) {
    put('cron jobs', j.jobname, JSON.stringify({ schedule: j.schedule, command: clean(j.command, j.jobname).trim(), database: j.database, username: j.username }));
    put('cron job active', j.jobname, String(j.active));
  }
  for (const v of pl.vault_secret_names) put('vault secret names', v.name, 'exists');
  for (const mg of pl.migrations) put('migration history', mg.version, mg.name);
  for (const p of pl.publications) put('publications', p.name, `all ${p.all_tables}: ${p.tables.join(',')}`);
  return m;
}

/** Categories whose scope is the application (counts reported in the summary). */
export const APP_CATEGORIES = [
  'tables', 'columns', 'views', 'sequences', 'functions', 'constraints', 'indexes', 'triggers', 'policies',
  'table grants', 'column grants', 'sequence grants', 'function grants', 'schema grants', 'default privileges',
  'storage buckets', 'cron jobs', 'cron job active', 'vault secret names', 'migration history', 'publications',
  'extensions', 'schemas', 'roles', 'event triggers', 'platform privileges',
];

export function compare(prodIdx, localIdx) {
  const results = [];
  const cats = [...new Set([...APP_CATEGORIES, ...Object.keys(prodIdx), ...Object.keys(localIdx)])];
  for (const cat of cats) {
    const p = prodIdx[cat] ?? new Map();
    const l = localIdx[cat] ?? new Map();
    const diffs = [];
    for (const [k, v] of p) {
      if (!l.has(k)) diffs.push({ category: cat, key: k, kind: 'missing locally', prod: v });
      else if (l.get(k) !== v) diffs.push({ category: cat, key: k, kind: 'differs', prod: v, local: l.get(k) });
    }
    for (const [k, v] of l) if (!p.has(k)) diffs.push({ category: cat, key: k, kind: 'only local', local: v });
    results.push({ category: cat, prod: p.size, local: l.size, diffs });
  }
  return results;
}

/** Grants per role: how many privileges each role holds on application objects. */
export function grantsPerRole(catalog) {
  const count = new Map();
  const add = (acl, kind) => { for (const a of acl || []) { const k = `${a.grantee}|${kind}`; count.set(k, (count.get(k) || 0) + 1); } };
  for (const t of catalog.tables) { add(t.acl, 'table'); for (const c of t.columns) add(c.acl, 'column'); }
  for (const v of catalog.views) { add(v.acl, 'view'); for (const c of v.columns) add(c.acl, 'column'); }
  for (const q of catalog.sequences) add(q.acl, 'sequence');
  for (const f of catalog.functions) add(f.acl, 'function');
  for (const s of catalog.meta.schemas.filter((x) => APP_SCHEMAS.includes(x.name))) add(s.acl, 'schema');
  return count;
}

/** A difference is explained when parity-known.json lists its category and key (key may be "*"). */
export function explain(diff, known) {
  return known.find((k) => k.category === diff.category && (k.key === '*' || k.key === diff.key) && (!k.kind || k.kind === diff.kind));
}
