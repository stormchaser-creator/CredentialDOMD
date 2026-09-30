// Catalog queries shared by the extractor (production, via the Management API)
// and the parity check (production and the local stack). Each returns exactly
// one row with one JSON column "r". They run with search_path = pg_catalog, so
// every name that pg_get_*def() deparses comes back schema-qualified.
//
// Every query here must pass assertReadOnlySql (tests/qa-lab/read-only-guard.test.mjs).

/** Schemas whose objects belong to the application (everything else is Supabase platform). */
export const APP_SCHEMAS = ['public', 'supabase_migrations'];
/** Supabase platform schemas whose privileges the parity check compares for the app's roles. */
export const PLATFORM_SCHEMAS = ['auth', 'storage', 'cron', 'net', 'vault', 'realtime', 'extensions', 'graphql_public'];
/** Schemas that hold application policies or triggers on platform tables. */
export const POLICY_SCHEMAS = ['public', 'supabase_migrations', 'storage'];

const list = (xs) => `array[${xs.map((x) => `'${x}'`).join(',')}]::text[]`;
const APP = list(APP_SCHEMAS);

// Effective privileges of an object as JSON rows. A NULL acl means "built-in
// default", which acldefault() expands, so NULL and an explicit default compare equal.
const acl = (aclExpr, defaultType, ownerExpr) => `(select coalesce(jsonb_agg(jsonb_build_object(
  'grantor', pg_get_userbyid(a.grantor),
  'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
  'privilege', a.privilege_type, 'grantable', a.is_grantable)
  order by case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, a.privilege_type, pg_get_userbyid(a.grantor)), '[]'::jsonb)
  from aclexplode(coalesce(${aclExpr}, acldefault('${defaultType}', ${ownerExpr}))) a)`;

// Column privileges exist only when granted (attacl NULL means none).
const colAcl = (aclExpr) => `(select coalesce(jsonb_agg(jsonb_build_object(
  'grantor', pg_get_userbyid(a.grantor),
  'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
  'privilege', a.privilege_type, 'grantable', a.is_grantable)
  order by case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, a.privilege_type, pg_get_userbyid(a.grantor)), '[]'::jsonb)
  from aclexplode(${aclExpr}) a)`;

export const CATALOG_QUERIES = {
  meta: `select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'extensions', (select coalesce(jsonb_agg(jsonb_build_object('name', e.extname, 'version', e.extversion, 'schema', n.nspname) order by e.extname), '[]'::jsonb)
     from pg_extension e join pg_namespace n on n.oid = e.extnamespace),
  'roles', (select coalesce(jsonb_agg(rolname order by rolname), '[]'::jsonb) from pg_roles where rolname !~ '^pg_'),
  'schemas', (select coalesce(jsonb_agg(jsonb_build_object('name', n.nspname, 'owner', pg_get_userbyid(n.nspowner),
       'acl', ${acl('n.nspacl', 'n', 'n.nspowner')}, 'comment', obj_description(n.oid, 'pg_namespace')) order by n.nspname), '[]'::jsonb)
     from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'),
  'default_acls', (select coalesce(jsonb_agg(jsonb_build_object('role', pg_get_userbyid(d.defaclrole), 'schema', n.nspname,
       'objtype', d.defaclobjtype::text, 'acl', ${colAcl('d.defaclacl')}) order by pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype::text), '[]'::jsonb)
     from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace),
  'event_triggers', (select coalesce(jsonb_agg(evtname order by evtname), '[]'::jsonb) from pg_event_trigger)
) as r`,

  sequences: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'name', c.relname, 'type', format_type(s.seqtypid, null),
  'start', s.seqstart::text, 'increment', s.seqincrement::text, 'min', s.seqmin::text, 'max', s.seqmax::text,
  'cache', s.seqcache::text, 'cycle', s.seqcycle, 'owner', pg_get_userbyid(c.relowner),
  'acl', ${acl('c.relacl', 's', 'c.relowner')}, 'acl_is_null', c.relacl is null,
  'owned_by', (select jsonb_build_object('schema', rn.nspname, 'table', rc.relname, 'column', a.attname, 'deptype', d.deptype::text)
     from pg_depend d join pg_class rc on rc.oid = d.refobjid join pg_namespace rn on rn.oid = rc.relnamespace
     join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
     where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') limit 1),
  'comment', obj_description(c.oid, 'pg_class')) order by n.nspname, c.relname), '[]'::jsonb) as r
from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_sequence s on s.seqrelid = c.oid
where c.relkind = 'S' and n.nspname = any(${APP})`,

  tables: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'name', c.relname, 'kind', c.relkind::text, 'persistence', c.relpersistence::text,
  'options', to_jsonb(c.reloptions), 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
  'replident', c.relreplident::text, 'owner', pg_get_userbyid(c.relowner),
  'acl', ${acl('c.relacl', 'r', 'c.relowner')}, 'acl_is_null', c.relacl is null,
  'comment', obj_description(c.oid, 'pg_class'),
  'columns', (select coalesce(jsonb_agg(jsonb_build_object(
       'num', a.attnum, 'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull,
       'default', case when a.attgenerated::text = '' then pg_get_expr(d.adbin, d.adrelid) end,
       'generated', case when a.attgenerated::text <> '' then pg_get_expr(d.adbin, d.adrelid) end,
       'identity', nullif(a.attidentity::text, ''),
       'collation', case when a.attcollation <> 0 and a.attcollation <> t.typcollation then
          (select quote_ident(cn.nspname) || '.' || quote_ident(co.collname) from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace where co.oid = a.attcollation) end,
       'comment', col_description(c.oid, a.attnum), 'acl', ${colAcl('a.attacl')}) order by a.attnum), '[]'::jsonb)
     from pg_attribute a join pg_type t on t.oid = a.atttypid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
) order by n.nspname, c.relname), '[]'::jsonb) as r
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname = any(${APP})`,

  constraints: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'table', c.relname, 'name', k.conname, 'type', k.contype::text,
  'def', pg_get_constraintdef(k.oid), 'comment', obj_description(k.oid, 'pg_constraint'))
  order by n.nspname, c.relname, k.conname), '[]'::jsonb) as r
from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any(${APP}) and c.relkind in ('r', 'p')`,

  indexes: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'table', t.relname, 'name', i.relname, 'def', pg_get_indexdef(i.oid),
  'comment', obj_description(i.oid, 'pg_class')) order by n.nspname, i.relname), '[]'::jsonb) as r
from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid join pg_namespace n on n.oid = t.relnamespace
where n.nspname = any(${APP})
  and not exists (select 1 from pg_constraint k where k.conindid = i.oid and k.conrelid = t.oid and k.contype in ('p', 'u', 'x'))`,

  views: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'name', c.relname, 'kind', c.relkind::text, 'def', pg_get_viewdef(c.oid),
  'options', to_jsonb(c.reloptions), 'owner', pg_get_userbyid(c.relowner),
  'acl', ${acl('c.relacl', 'r', 'c.relowner')}, 'acl_is_null', c.relacl is null, 'comment', obj_description(c.oid, 'pg_class'),
  'columns', (select coalesce(jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
       'comment', col_description(c.oid, a.attnum), 'acl', ${colAcl('a.attacl')}) order by a.attnum), '[]'::jsonb)
     from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
  'depends_on_views', (select coalesce(jsonb_agg(distinct dn.nspname || '.' || dc.relname), '[]'::jsonb)
     from pg_rewrite rw join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid and d.refclassid = 'pg_class'::regclass
     join pg_class dc on dc.oid = d.refobjid join pg_namespace dn on dn.oid = dc.relnamespace
     where rw.ev_class = c.oid and dc.oid <> c.oid and dc.relkind in ('v', 'm')),
  'depends_on_functions', (select coalesce(jsonb_agg(distinct pn.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'), '[]'::jsonb)
     from pg_rewrite rw join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid and d.refclassid = 'pg_proc'::regclass
     join pg_proc p on p.oid = d.refobjid join pg_namespace pn on pn.oid = p.pronamespace
     where rw.ev_class = c.oid)
) order by n.nspname, c.relname), '[]'::jsonb) as r
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v', 'm') and n.nspname = any(${APP})`,

  functions: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'argtypes', oidvectortypes(p.proargtypes),
  'kind', p.prokind::text, 'language', (select l.lanname from pg_language l where l.oid = p.prolang), 'sql_body', p.prosqlbody is not null,
  'owner', pg_get_userbyid(p.proowner), 'security_definer', p.prosecdef,
  'acl', ${acl('p.proacl', 'f', 'p.proowner')}, 'acl_is_null', p.proacl is null,
  'comment', obj_description(p.oid, 'pg_proc'),
  'def', case when p.prokind in ('f', 'p', 'w') then pg_get_functiondef(p.oid) end,
  'signature_relations', (select coalesce(jsonb_agg(distinct jsonb_build_object('schema', rn.nspname, 'name', rc.relname, 'kind', rc.relkind::text)), '[]'::jsonb)
     from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]) || p.prorettype) ty(oid)
     join pg_type tt on tt.oid = ty.oid
     join pg_class rc on rc.oid = case when tt.typrelid <> 0 then tt.typrelid else (select e.typrelid from pg_type e where e.oid = tt.typelem) end
     join pg_namespace rn on rn.oid = rc.relnamespace)
) order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb) as r
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = any(${APP})
  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`,

  triggers: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'table', c.relname, 'name', t.tgname, 'def', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled::text,
  'function', pn.nspname || '.' || p.proname, 'comment', obj_description(t.oid, 'pg_trigger'))
  order by n.nspname, c.relname, t.tgname), '[]'::jsonb) as r
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
where not t.tgisinternal and (n.nspname = any(${APP}) or pn.nspname = any(${APP}))`,

  policies: `select coalesce(jsonb_agg(jsonb_build_object(
  'schema', schemaname, 'table', tablename, 'name', policyname, 'permissive', permissive,
  'roles', to_jsonb(roles::text[]), 'cmd', cmd, 'qual', qual, 'with_check', with_check)
  order by schemaname, tablename, policyname), '[]'::jsonb) as r
from pg_policies where schemaname = any(${list(POLICY_SCHEMAS)})`,

  // What the application's roles can actually do on Supabase platform objects
  // (auth, storage, cron, net, vault, realtime, extensions): effective privileges,
  // PUBLIC included, grantor ignored. Owners and grantors differ between the
  // hosted project and the local image; what anon/authenticated/service_role/
  // postgres may do is what matters to the app.
  platform_privileges: `select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) as r from (
  select 'table ' || n.nspname || '.' || c.relname as k,
    (select coalesce(jsonb_agg(r.rolname || ':' || p.priv order by r.rolname, p.priv), '[]'::jsonb)
       from pg_roles r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
      where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres') and has_table_privilege(r.oid, c.oid, p.priv)) as v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = any(${list(PLATFORM_SCHEMAS)}) and c.relkind in ('r', 'v', 'm', 'p')
  union all
  select 'function ' || n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
    (select coalesce(jsonb_agg(r.rolname order by r.rolname), '[]'::jsonb) from pg_roles r
      where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres') and has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = any(${list(PLATFORM_SCHEMAS)})
) t`,

  // Platform tables whose ROWS are application configuration. Only
  // configuration columns are read: never object contents, never a secret value.
  platform: `select jsonb_build_object(
  'buckets', (select coalesce(jsonb_agg(to_jsonb(b) - 'created_at' - 'updated_at' - 'owner' - 'owner_id' order by b.id), '[]'::jsonb) from storage.buckets b),
  'cron_jobs', (select coalesce(jsonb_agg(jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'command', j.command,
       'database', j.database, 'username', j.username, 'active', j.active) order by j.jobname), '[]'::jsonb) from cron.job j),
  'vault_secret_names', (select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'description', s.description) order by s.name), '[]'::jsonb) from vault.secrets s),
  -- NAMES only: the lab stores a placeholder under each (qa-lab/lab.mjs), so every function takes the branch it takes live.
  'app_secret_names', (select coalesce(jsonb_agg(s.name order by s.name), '[]'::jsonb) from public.app_secrets s),
  'migrations', (select coalesce(jsonb_agg(jsonb_build_object('version', m.version, 'name', m.name) order by m.version), '[]'::jsonb) from supabase_migrations.schema_migrations m),
  'publications', (select coalesce(jsonb_agg(jsonb_build_object('name', p.pubname, 'all_tables', p.puballtables,
       'tables', (select coalesce(jsonb_agg(pt.schemaname || '.' || pt.tablename order by pt.schemaname, pt.tablename), '[]'::jsonb) from pg_publication_tables pt where pt.pubname = p.pubname))
       order by p.pubname), '[]'::jsonb) from pg_publication p)
) as r`,
};

/** The non-personal configuration rows the seed copies (parity compares them too). */
export const CONFIG_ROWS_QUERY = `select jsonb_build_object(
  'access_policy_settings', (select coalesce(jsonb_agg(to_jsonb(a) order by a.singleton), '[]'::jsonb) from public.access_policy_settings a),
  'vera_source_settings', (select coalesce(jsonb_agg(to_jsonb(v) order by v.singleton), '[]'::jsonb) from public.vera_source_settings v),
  'welcome_email_settings', (select coalesce(jsonb_agg(jsonb_build_object('singleton', w.singleton, 'enabled', w.enabled) order by w.singleton), '[]'::jsonb) from public.welcome_email_settings w),
  -- Counts only (the programs' promised places are member mailboxes): how many founding places each mode's program promised.
  'founding_programs', (select coalesce(jsonb_agg(jsonb_build_object('livemode', f.livemode, 'promise_count', f.promise_count,
       'promised_total', (select count(*) from public.limited_founding_slots s where s.livemode = f.livemode and s.promise_email is not null)) order by f.livemode), '[]'::jsonb)
     from public.limited_founding_programs f)
) as r`;
