// Turns a catalog snapshot (lib/catalog-sql.mjs) into DDL for the local stack.
// Pure: no I/O, so the rules below are unit-tested (tests/qa-lab/ddl.test.mjs).
//
// Order: extensions, schemas, sequences, tables (no defaults), functions,
// defaults, sequence ownership, constraints (foreign keys last), indexes,
// views (dependency order), triggers, row level security, policies, comments,
// owners, privileges, default privileges, then platform configuration
// (storage buckets, vault secret NAMES with local dummy values, cron jobs
// switched off, migration history names).
//
// Safety rules applied to every definition:
//   * the production API origin is rewritten to the local gateway, and the
//     output is refused if the production project ref survives anywhere;
//   * anything shaped like a credential is replaced and reported;
//   * cron jobs are created inactive.
import { PROD_PROJECT_REF } from './management-api.mjs';
import { APP_SCHEMAS } from './catalog-sql.mjs';

export const PROD_ORIGIN = `https://${PROD_PROJECT_REF}.supabase.co`;

/** Roles the local Supabase image provides (supabase/postgres 17.6.1.x). */
export const DEFAULT_LOCAL_ROLES = [
  'anon', 'authenticated', 'authenticator', 'dashboard_user', 'pgbouncer', 'postgres', 'service_role',
  'supabase_admin', 'supabase_auth_admin', 'supabase_etl_admin', 'supabase_functions_admin',
  'supabase_privileged_role', 'supabase_read_only_user', 'supabase_realtime_admin',
  'supabase_replication_admin', 'supabase_storage_admin',
];

/** Storage bucket columns copied (configuration only). */
const BUCKET_COLUMNS = ['id', 'name', 'public', 'file_size_limit', 'allowed_mime_types', 'avif_autodetection', 'type'];

const SECRET_PATTERNS = [
  ['stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g],
  ['stripe webhook secret', /\bwhsec_[A-Za-z0-9+/=]{8,}/g],
  ['resend key', /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{6,}/g],
  ['anthropic key', /\bsk-ant-[A-Za-z0-9_-]{10,}/g],
  ['google api key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/g],
  ['clerk key', /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g],
  ['long hex literal', /(?<![A-Za-z0-9_])[0-9a-f]{40,}(?![A-Za-z0-9_])/g],
];

export const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const qn = (schema, name) => `${qi(schema)}.${qi(name)}`;
export const lit = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const roleSql = (r) => (r === 'PUBLIC' || r === 'public' ? 'PUBLIC' : qi(r));

/**
 * Applies the safety rules to one definition. Returns the cleaned text and
 * records every rewrite and redaction in `report`.
 */
export function sanitize(text, where, report, localOrigin) {
  if (text === null || text === undefined) return text;
  let out = String(text);
  if (out.includes(PROD_ORIGIN)) {
    const n = out.split(PROD_ORIGIN).length - 1;
    out = out.split(PROD_ORIGIN).join(localOrigin);
    report.rewrites.push({ where, count: n, from: PROD_ORIGIN, to: localOrigin });
  }
  for (const [kind, re] of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      report.redactions.push({ where, kind });
      return `QA_LAB_REDACTED_${kind.replace(/\W+/g, '_').toUpperCase()}`;
    });
  }
  return out;
}

const PRIV_ORDER = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'USAGE', 'CREATE', 'EXECUTE', 'CONNECT', 'TEMPORARY'];
const FULL_OWNER = {
  TABLE: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
  SEQUENCE: ['SELECT', 'UPDATE', 'USAGE'],
  ROUTINE: ['EXECUTE'],
  SCHEMA: ['USAGE', 'CREATE'],
};
const sortPrivs = (ps) => [...new Set(ps)].sort((a, b) => PRIV_ORDER.indexOf(a) - PRIV_ORDER.indexOf(b));

/**
 * GRANT/REVOKE statements that make an object's privileges exactly `acl`
 * (aclexplode rows). The object is first reset by pg_temp.qa_reset_acl.
 */
export function aclStatements(kind, objSql, resetArg, owner, acl, ctx, where) {
  const out = [`select pg_temp.qa_reset_acl(${lit(kind)}, ${lit(resetArg)});`];
  const ownerPrivs = acl.filter((a) => a.grantee === owner && a.grantor === owner).map((a) => a.privilege);
  const missing = FULL_OWNER[kind].filter((p) => !ownerPrivs.includes(p));
  if (missing.length) out.push(`revoke ${sortPrivs(missing).join(', ')} on ${kind} ${objSql} from ${qi(owner)};`);
  const groups = new Map();
  for (const a of acl) {
    if (a.grantee === owner && a.grantor === owner && !a.grantable) continue;
    if (a.grantee !== 'PUBLIC' && !ctx.roles.has(a.grantee)) { ctx.report.skippedGrants.push({ where, grantee: a.grantee, privilege: a.privilege }); continue; }
    const key = `${a.grantor}\u0000${a.grantee}\u0000${a.grantable}`;
    if (!groups.has(key)) groups.set(key, { ...a, privs: [] });
    groups.get(key).privs.push(a.privilege);
  }
  for (const g of groups.values()) {
    const stmt = `grant ${sortPrivs(g.privs).join(', ')} on ${kind} ${objSql} to ${roleSql(g.grantee)}${g.grantable ? ' with grant option' : ''};`;
    out.push(g.grantor === owner ? stmt : `set role ${qi(g.grantor)}; ${stmt} reset role;`);
  }
  return out;
}

function columnGrants(tableSql, owner, columns, ctx, where) {
  const groups = new Map();
  for (const col of columns) for (const a of col.acl || []) {
    if (a.grantee !== 'PUBLIC' && !ctx.roles.has(a.grantee)) { ctx.report.skippedGrants.push({ where: `${where}.${col.name}`, grantee: a.grantee, privilege: a.privilege }); continue; }
    const key = `${a.grantor}\u0000${a.grantee}\u0000${a.privilege}\u0000${a.grantable}`;
    if (!groups.has(key)) groups.set(key, { ...a, cols: [] });
    groups.get(key).cols.push(col.name);
  }
  return [...groups.values()].map((g) => {
    const stmt = `grant ${g.privilege} (${g.cols.map(qi).join(', ')}) on table ${tableSql} to ${roleSql(g.grantee)}${g.grantable ? ' with grant option' : ''};`;
    return g.grantor === owner ? stmt : `set role ${qi(g.grantor)}; ${stmt} reset role;`;
  });
}

function sequenceOptions(s) {
  return `as ${s.type} start with ${s.start} increment by ${s.increment} minvalue ${s.min} maxvalue ${s.max} cache ${s.cache}${s.cycle ? ' cycle' : ' no cycle'}`;
}

function topoViews(views) {
  const byName = new Map(views.map((v) => [`${v.schema}.${v.name}`, v]));
  const done = new Set(); const out = []; const visiting = new Set();
  const visit = (key) => {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new Error(`view dependency cycle at ${key}`);
    visiting.add(key);
    for (const dep of byName.get(key).depends_on_views) if (byName.has(dep)) visit(dep);
    visiting.delete(key); done.add(key); out.push(byName.get(key));
  };
  for (const key of byName.keys()) visit(key);
  return out;
}

const DEFAULT_ACL_TYPES = { r: 'tables', S: 'sequences', f: 'functions', T: 'types', n: 'schemas' };

/**
 * @param catalog  production snapshot from fetchProdCatalog()
 * @param opts.localOrigin   URL the local database uses to reach the local API gateway
 * @param opts.localRoles    roles that exist locally (grants to others are skipped and reported)
 * @param opts.vaultValues   { secretName: localDummyValue } (never production values)
 */
export function generateSchemaSql(catalog, { localOrigin, localRoles = DEFAULT_LOCAL_ROLES, vaultValues = {} } = {}) {
  if (!localOrigin) throw new Error('localOrigin is required');
  const report = { rewrites: [], redactions: [], skippedGrants: [], notes: [] };
  const ctx = { roles: new Set(localRoles), report };
  const s = (text, where) => sanitize(text, where, report, localOrigin);
  const L = [];
  const section = (title) => L.push('', `-- ${'='.repeat(76)}`, `-- ${title}`, `-- ${'='.repeat(76)}`);
  const asOwner = (owner) => L.push(owner === 'postgres' ? 'set role postgres;' : `set role ${qi(owner)};`);
  const asSuper = () => L.push('reset role;');

  L.push(
    '-- CredentialDOMD QA lab: production schema reconstructed from the catalog.',
    `-- Source: ${catalog.source} catalog, read ${catalog.extracted_at} (PostgreSQL ${catalog.meta.server_version}).`,
    '-- GENERATED by qa-lab/extract-schema.mjs. Do not edit and do not commit (qa-lab/.generated is gitignored).',
    '-- Apply with: npm run qa:apply   (runs as the local superuser in ONE transaction)',
    '',
    'set check_function_bodies = off;',
    "set client_min_messages = warning;",
    'set search_path = pg_catalog;',
    '',
    '-- Resets an object\'s privileges to "owner only" so the grants below are exact.',
    `create function pg_temp.qa_reset_acl(p_kind text, p_obj text) returns void language plpgsql as $qa$
declare g record; v_acl aclitem[]; v_owner oid; v_type "char";
begin
  if p_kind in ('TABLE', 'SEQUENCE') then select relacl, relowner into v_acl, v_owner from pg_class where oid = p_obj::regclass;
  elsif p_kind = 'ROUTINE' then select proacl, proowner into v_acl, v_owner from pg_proc where oid = p_obj::regprocedure;
  elsif p_kind = 'SCHEMA' then select nspacl, nspowner into v_acl, v_owner from pg_namespace where nspname = p_obj;
  else raise exception 'unknown kind %', p_kind; end if;
  v_type := case p_kind when 'TABLE' then 'r' when 'SEQUENCE' then 's' when 'ROUTINE' then 'f' else 'n' end;
  for g in select distinct a.grantee from aclexplode(coalesce(v_acl, acldefault(v_type, v_owner))) a where a.grantee <> v_owner loop
    execute format('revoke all on %s %s from %s cascade', p_kind,
      case when p_kind = 'SCHEMA' then quote_ident(p_obj) when p_kind = 'ROUTINE' then p_obj::regprocedure::text else p_obj::regclass::text end,
      case when g.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(g.grantee)) end);
  end loop;
end $qa$;`,
  );

  // ---- extensions -------------------------------------------------------------------------
  section('Extensions (production set; created only when missing)');
  for (const e of catalog.meta.extensions) {
    if (e.name === 'plpgsql') continue;
    const schema = e.name === 'pg_cron' ? 'pg_catalog' : e.schema;
    L.push(`do $qa$ begin
  if not exists (select 1 from pg_extension where extname = ${lit(e.name)}) then
    if exists (select 1 from pg_available_extension_versions where name = ${lit(e.name)} and version = ${lit(e.version)}) then
      execute ${lit(`create extension ${qi(e.name)} with schema ${qi(schema)} version ${lit(e.version)}`)};
    else
      execute ${lit(`create extension ${qi(e.name)} with schema ${qi(schema)}`)};
    end if;
  end if;
end $qa$;`);
  }

  // ---- schemas ----------------------------------------------------------------------------
  section('Application schemas');
  for (const sc of catalog.meta.schemas.filter((x) => APP_SCHEMAS.includes(x.name))) {
    if (sc.name === 'public') continue;
    L.push(`create schema if not exists ${qi(sc.name)} authorization ${qi(sc.owner)};`);
  }

  // ---- sequences ---------------------------------------------------------------------------
  section('Sequences (identity sequences are created by their columns)');
  asOwner('postgres');
  const identitySeq = new Map();
  for (const q of catalog.sequences) {
    if (q.owned_by?.deptype === 'i') { identitySeq.set(`${q.owned_by.schema}.${q.owned_by.table}.${q.owned_by.column}`, q); continue; }
    L.push(`create sequence ${qn(q.schema, q.name)} ${sequenceOptions(q)};`);
  }

  // ---- tables -------------------------------------------------------------------------------
  section('Tables (columns, identity, NOT NULL; defaults and constraints follow)');
  for (const t of catalog.tables) {
    if (t.kind !== 'r') throw new Error(`unsupported table kind ${t.kind} for ${t.schema}.${t.name}`);
    const cols = t.columns.map((c) => {
      let d = `  ${qi(c.name)} ${c.type}`;
      if (c.collation) d += ` collate ${c.collation}`;
      if (c.identity) {
        const seq = identitySeq.get(`${t.schema}.${t.name}.${c.name}`);
        const opts = seq ? ` (sequence name ${qn(seq.schema, seq.name)} ${sequenceOptions(seq).replace(/^as \S+ /, '')})` : '';
        d += ` generated ${c.identity === 'a' ? 'always' : 'by default'} as identity${opts}`;
      }
      if (c.generated) d += ` generated always as (${s(c.generated, `${t.name}.${c.name} generated`)}) stored`;
      if (c.notnull) d += ' not null';
      return d;
    });
    L.push(`create ${t.persistence === 'u' ? 'unlogged ' : ''}table ${qn(t.schema, t.name)} (\n${cols.join(',\n')}\n)${t.options ? ` with (${t.options.join(', ')})` : ''};`);
  }

  // ---- functions ----------------------------------------------------------------------------
  const viewNames = new Set(catalog.views.map((v) => `${v.schema}.${v.name}`));
  const afterViews = (f) => f.signature_relations.some((r) => viewNames.has(`${r.schema}.${r.name}`));
  const fnSql = (f) => {
    if (!f.def) throw new Error(`no definition for ${f.schema}.${f.name}(${f.args}) (kind ${f.kind})`);
    return `${s(f.def, `function ${f.schema}.${f.name}(${f.args})`).trimEnd()};`;
  };
  section('Functions (bodies are not validated at creation: check_function_bodies = off)');
  for (const f of catalog.functions.filter((x) => !afterViews(x))) L.push(fnSql(f));

  // ---- defaults, sequence ownership, constraints, indexes --------------------------------------
  section('Column defaults');
  for (const t of catalog.tables) for (const c of t.columns) {
    if (c.default !== null && c.default !== undefined) L.push(`alter table only ${qn(t.schema, t.name)} alter column ${qi(c.name)} set default ${s(c.default, `${t.name}.${c.name} default`)};`);
  }
  section('Sequence ownership');
  for (const q of catalog.sequences) {
    if (q.owned_by?.deptype === 'a') L.push(`alter sequence ${qn(q.schema, q.name)} owned by ${qn(q.owned_by.schema, q.owned_by.table)}.${qi(q.owned_by.column)};`);
  }
  section('Constraints (primary keys, unique, exclusion, checks; foreign keys last)');
  const conOrder = { p: 0, u: 1, x: 2, c: 3, f: 4 };
  const cons = catalog.constraints.filter((k) => k.type !== 't').sort((a, b) => (conOrder[a.type] ?? 9) - (conOrder[b.type] ?? 9));
  for (const k of cons) {
    if (!(k.type in conOrder)) throw new Error(`unsupported constraint type ${k.type} (${k.name})`);
    L.push(`alter table only ${qn(k.schema, k.table)} add constraint ${qi(k.name)} ${s(k.def, `constraint ${k.name}`)};`);
  }
  section('Indexes');
  for (const i of catalog.indexes) L.push(`${s(i.def, `index ${i.name}`)};`);

  // ---- views --------------------------------------------------------------------------------
  section('Views (dependency order)');
  for (const v of topoViews(catalog.views)) {
    const body = s(v.def, `view ${v.name}`).trim().replace(/;\s*$/, '');
    const opts = v.options ? ` with (${v.options.join(', ')})` : '';
    if (v.kind === 'm') L.push(`create materialized view ${qn(v.schema, v.name)}${opts} as\n${body}\nwith no data;`);
    else L.push(`create view ${qn(v.schema, v.name)}${opts} as\n${body};`);
  }
  const late = catalog.functions.filter(afterViews);
  if (late.length) { section('Functions whose signatures use a view row type'); for (const f of late) L.push(fnSql(f)); }

  // ---- triggers -----------------------------------------------------------------------------
  section('Triggers (application tables as postgres; platform tables as superuser)');
  const enableSql = { D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' };
  for (const tg of catalog.triggers) {
    const platform = !APP_SCHEMAS.includes(tg.schema);
    if (platform) asSuper();
    L.push(`${s(tg.def, `trigger ${tg.name}`)};`);
    if (enableSql[tg.enabled]) L.push(`alter table ${qn(tg.schema, tg.table)} ${enableSql[tg.enabled]} ${qi(tg.name)};`);
    if (platform) asOwner('postgres');
  }

  // ---- row level security & policies -----------------------------------------------------------
  section('Row level security');
  for (const t of catalog.tables) {
    if (t.rls) L.push(`alter table ${qn(t.schema, t.name)} enable row level security;`);
    if (t.force_rls) L.push(`alter table ${qn(t.schema, t.name)} force row level security;`);
    if (t.replident === 'f') L.push(`alter table ${qn(t.schema, t.name)} replica identity full;`);
    else if (t.replident === 'n') L.push(`alter table ${qn(t.schema, t.name)} replica identity nothing;`);
    else if (t.replident !== 'd') report.notes.push(`replica identity ${t.replident} on ${t.name} not reproduced`);
  }
  section('Policies (storage.objects policies need the superuser: the table belongs to supabase_storage_admin)');
  for (const p of catalog.policies) {
    const platform = !APP_SCHEMAS.includes(p.schema);
    if (platform) asSuper();
    let d = `create policy ${qi(p.name)} on ${qn(p.schema, p.table)} as ${p.permissive.toLowerCase()} for ${p.cmd.toLowerCase()} to ${p.roles.map(roleSql).join(', ')}`;
    if (p.qual) d += ` using (${s(p.qual, `policy ${p.name}`)})`;
    if (p.with_check) d += ` with check (${s(p.with_check, `policy ${p.name}`)})`;
    L.push(`${d};`);
    if (platform) asOwner('postgres');
  }

  // ---- comments -----------------------------------------------------------------------------
  section('Comments');
  for (const t of catalog.tables) {
    if (t.comment) L.push(`comment on table ${qn(t.schema, t.name)} is ${lit(t.comment)};`);
    for (const c of t.columns) if (c.comment) L.push(`comment on column ${qn(t.schema, t.name)}.${qi(c.name)} is ${lit(c.comment)};`);
  }
  for (const v of catalog.views) {
    if (v.comment) L.push(`comment on ${v.kind === 'm' ? 'materialized view' : 'view'} ${qn(v.schema, v.name)} is ${lit(v.comment)};`);
    for (const c of v.columns) if (c.comment) L.push(`comment on column ${qn(v.schema, v.name)}.${qi(c.name)} is ${lit(c.comment)};`);
  }
  for (const f of catalog.functions) if (f.comment) L.push(`comment on ${f.kind === 'p' ? 'procedure' : 'function'} ${qn(f.schema, f.name)}(${f.argtypes}) is ${lit(f.comment)};`);
  for (const q of catalog.sequences) if (q.comment) L.push(`comment on sequence ${qn(q.schema, q.name)} is ${lit(q.comment)};`);
  for (const k of catalog.constraints) if (k.comment) L.push(`comment on constraint ${qi(k.name)} on ${qn(k.schema, k.table)} is ${lit(k.comment)};`);
  for (const i of catalog.indexes) if (i.comment) L.push(`comment on index ${qn(i.schema, i.name)} is ${lit(i.comment)};`);
  for (const tg of catalog.triggers) if (tg.comment) L.push(`comment on trigger ${qi(tg.name)} on ${qn(tg.schema, tg.table)} is ${lit(tg.comment)};`);
  for (const sc of catalog.meta.schemas.filter((x) => APP_SCHEMAS.includes(x.name))) {
    if (sc.comment) L.push(`comment on schema ${qi(sc.name)} is ${lit(sc.comment)};`);
  }

  // ---- owners & privileges ------------------------------------------------------------------
  section('Owners (objects not owned by postgres)');
  asSuper();
  for (const t of catalog.tables) if (t.owner !== 'postgres') L.push(`alter table ${qn(t.schema, t.name)} owner to ${qi(t.owner)};`);
  for (const v of catalog.views) if (v.owner !== 'postgres') L.push(`alter ${v.kind === 'm' ? 'materialized view' : 'view'} ${qn(v.schema, v.name)} owner to ${qi(v.owner)};`);
  for (const q of catalog.sequences) if (q.owner !== 'postgres' && q.owned_by?.deptype !== 'i') L.push(`alter sequence ${qn(q.schema, q.name)} owner to ${qi(q.owner)};`);
  for (const f of catalog.functions) if (f.owner !== 'postgres') L.push(`alter routine ${qn(f.schema, f.name)}(${f.argtypes}) owner to ${qi(f.owner)};`);

  section('Privileges: every object reset to owner-only, then production grants exactly');
  for (const sc of catalog.meta.schemas.filter((x) => APP_SCHEMAS.includes(x.name))) {
    L.push(...aclStatements('SCHEMA', qi(sc.name), sc.name, sc.owner, sc.acl, ctx, `schema ${sc.name}`));
  }
  for (const t of catalog.tables) {
    const obj = qn(t.schema, t.name);
    L.push(...aclStatements('TABLE', obj, obj, t.owner, t.acl, ctx, `table ${t.name}`));
    L.push(...columnGrants(obj, t.owner, t.columns, ctx, `table ${t.name}`));
  }
  for (const v of catalog.views) {
    const obj = qn(v.schema, v.name);
    L.push(...aclStatements('TABLE', obj, obj, v.owner, v.acl, ctx, `view ${v.name}`));
    L.push(...columnGrants(obj, v.owner, v.columns, ctx, `view ${v.name}`));
  }
  for (const q of catalog.sequences) {
    const obj = qn(q.schema, q.name);
    L.push(...aclStatements('SEQUENCE', obj, obj, q.owner, q.acl, ctx, `sequence ${q.name}`));
  }
  for (const f of catalog.functions) {
    const obj = `${qn(f.schema, f.name)}(${f.argtypes})`;
    L.push(...aclStatements('ROUTINE', obj, obj, f.owner, f.acl, ctx, `function ${f.name}(${f.args})`));
  }

  // Platform schemas belong to Supabase: nothing is revoked there, but a grant
  // production has on one of them (for example USAGE on cron that postgres gave
  // itself) is added, as the same grantor.
  section('Platform schema grants production has (added only; platform schemas are never reset)');
  for (const sc of catalog.meta.schemas.filter((x) => !APP_SCHEMAS.includes(x.name))) {
    for (const a of sc.acl) {
      if (a.grantee === sc.owner && a.grantor === sc.owner) continue;
      if ((a.grantee !== 'PUBLIC' && !ctx.roles.has(a.grantee)) || !ctx.roles.has(a.grantor)) { report.skippedGrants.push({ where: `schema ${sc.name}`, grantee: a.grantee, privilege: a.privilege }); continue; }
      const grant = `grant ${a.privilege} on schema ${qi(sc.name)} to ${roleSql(a.grantee)}${a.grantable ? ' with grant option' : ''}`;
      const body = a.grantor === sc.owner
        ? `execute ${lit(grant)};`
        : `execute ${lit(`set role ${qi(a.grantor)}`)}; execute ${lit(grant)}; execute 'reset role';`;
      L.push(`do $qa$ begin if exists (select 1 from pg_namespace where nspname = ${lit(sc.name)}) then ${body} end if; end $qa$;`);
    }
  }

  // ---- default privileges -------------------------------------------------------------------
  section('Default privileges (what later migrations inherit), exactly as production');
  const localSchemaSet = new Set(catalog.meta.schemas.map((x) => x.name));
  const prodKeys = catalog.meta.default_acls.map((d) => `${d.role}|${d.schema ?? ''}|${d.objtype}`);
  L.push(`-- Clear every default-privilege entry on a schema production also has, then grant production's.
do $qa$ declare g record; begin
  for g in select pg_get_userbyid(d.defaclrole) as role, n.nspname as schema, d.defaclobjtype::text as objtype, a.grantee
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
    where (n.nspname is null or n.nspname = any(${`array[${[...localSchemaSet].map(lit).join(',')}]::text[]`}))
  loop
    execute format('alter default privileges for role %I %s revoke all on %s from %s', g.role,
      case when g.schema is null then '' else format('in schema %I', g.schema) end,
      case g.objtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types' else 'schemas' end,
      case when g.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(g.grantee)) end);
  end loop;
end $qa$;`);
  for (const d of catalog.meta.default_acls) {
    if (!ctx.roles.has(d.role)) { report.skippedGrants.push({ where: `default privileges for ${d.role}`, grantee: '*', privilege: '*' }); continue; }
    const groups = new Map();
    for (const a of d.acl) {
      if (a.grantee !== 'PUBLIC' && !ctx.roles.has(a.grantee)) { report.skippedGrants.push({ where: `default privileges ${d.role}/${d.schema}/${d.objtype}`, grantee: a.grantee, privilege: a.privilege }); continue; }
      const key = `${a.grantee}\u0000${a.grantable}`;
      if (!groups.has(key)) groups.set(key, { ...a, privs: [] });
      groups.get(key).privs.push(a.privilege);
    }
    for (const g of groups.values()) {
      L.push(`alter default privileges for role ${qi(d.role)}${d.schema ? ` in schema ${qi(d.schema)}` : ''} grant ${sortPrivs(g.privs).join(', ')} on ${DEFAULT_ACL_TYPES[d.objtype]} to ${roleSql(g.grantee)}${g.grantable ? ' with grant option' : ''};`);
    }
  }
  report.notes.push(`default privilege entries reproduced: ${prodKeys.length}`);

  // ---- platform configuration ----------------------------------------------------------------
  section('Storage buckets (configuration only; no objects)');
  for (const b of catalog.platform.buckets) {
    const cols = BUCKET_COLUMNS.filter((c) => c in b);
    const vals = cols.map((c) => {
      const v = b[c];
      if (v === null) return 'NULL';
      if (Array.isArray(v)) return `array[${v.map(lit).join(',')}]::text[]`;
      if (typeof v === 'boolean' || typeof v === 'number') return String(v);
      return lit(v);
    });
    L.push(`insert into storage.buckets (${cols.map(qi).join(', ')}) values (${vals.join(', ')}) on conflict (id) do nothing;`);
  }

  section('Vault: production secret NAMES with local dummy values (never production values)');
  for (const v of catalog.platform.vault_secret_names) {
    const value = vaultValues[v.name];
    if (!value) throw new Error(`no local dummy value for vault secret ${v.name}`);
    L.push(`select vault.create_secret(${lit(value)}, ${lit(v.name)}, ${lit(`QA lab local dummy for ${v.name}`)}) where not exists (select 1 from vault.secrets where name = ${lit(v.name)});`);
  }

  section('Cron jobs: production definitions, created INACTIVE (enable one by hand with cron.alter_job)');
  for (const j of catalog.platform.cron_jobs) {
    asOwner(j.username);
    L.push(`select cron.alter_job(cron.schedule(${lit(j.jobname)}, ${lit(j.schedule)}, ${lit(s(j.command, `cron ${j.jobname}`))}), active := false);`);
  }
  asSuper();

  section('Migration history: version and name only (the statements are not copied)');
  for (const m of catalog.platform.migrations) {
    L.push(`insert into supabase_migrations.schema_migrations (version, name) values (${lit(m.version)}, ${lit(m.name)}) on conflict do nothing;`);
  }
  if (catalog.platform.publications.some((p) => p.tables.length)) {
    section('Publications');
    for (const p of catalog.platform.publications) for (const t of p.tables) L.push(`alter publication ${qi(p.name)} add table ${t.split('.').map(qi).join('.')};`);
  }

  section('QA-lab marker (local-only schema, excluded from parity)');
  L.push(
    'create schema if not exists qa_lab;',
    'create table if not exists qa_lab.applied (applied_at timestamptz not null default now(), source text not null, extracted_at timestamptz not null);',
    `insert into qa_lab.applied (source, extracted_at) values (${lit(catalog.source)}, ${lit(catalog.extracted_at)});`,
    'reset role;',
    '',
  );

  const sql = L.join('\n');
  if (sql.includes(PROD_PROJECT_REF)) {
    const at = sql.indexOf(PROD_PROJECT_REF);
    throw new Error(`refusing to write DDL that still names the production project (near: ${sql.slice(Math.max(0, at - 80), at + 40).replace(/\s+/g, ' ')})`);
  }
  return { sql, report };
}
