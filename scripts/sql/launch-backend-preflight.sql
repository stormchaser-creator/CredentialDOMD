-- Read-only catalog inventory for reviewed launch migrations. No customer rows,
-- secret/config values, auth tokens, cron job text, or outbound requests.
begin transaction read only;
select 'server' as section, jsonb_build_object('version',current_setting('server_version'),'database',current_database()) as records
union all
select 'extensions' as section, coalesce(jsonb_agg(jsonb_build_object('name',extname,'version',extversion) order by extname),'[]'::jsonb) as records from pg_extension
union all
select 'tables' as section, coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'acl',c.relacl::text) order by n.nspname,c.relname),'[]'::jsonb) as records
from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','storage')
union all
select 'columns' as section, coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by n.nspname,c.relname,a.attnum),'[]'::jsonb) as records
from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
where c.relkind in ('r','p') and n.nspname in ('public','storage') and a.attnum>0 and not a.attisdropped
union all
select 'constraints' as section, coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',x.conname,'definition',pg_get_constraintdef(x.oid)) order by n.nspname,c.relname,x.conname),'[]'::jsonb) as records
from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','storage')
union all
select 'policies' as section, coalesce(jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname),'[]'::jsonb) as records from pg_policies p where schemaname in ('public','storage')
union all
select 'indexes' as section, coalesce(jsonb_agg(to_jsonb(i) order by schemaname,tablename,indexname),'[]'::jsonb) as records from pg_indexes i where schemaname in ('public','storage')
union all
select 'triggers' as section, coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) order by n.nspname,c.relname,t.tgname),'[]'::jsonb) as records
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','storage')
union all
select 'functions_and_grants' as section, coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'securityDefiner',p.prosecdef,'config',p.proconfig,'anonExecute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'EXECUTE'),'serviceExecute',has_function_privilege('service_role',p.oid,'EXECUTE')) order by n.nspname,p.proname,p.oid),'[]'::jsonb) as records
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
-- Only known identity/policy/ledger helpers, never arbitrary function bodies.
union all
select 'reviewed_helper_definitions' as section, coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid)) order by p.proname,p.oid),'[]'::jsonb) as records
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
 'current_profile_id','is_admin','lock_profile_identity','lock_profile_insert','lock_founding_fields',
 'guard_profile_insert','guard_profile_identity','claim_mailbox','revoke_mailbox','apply_account_mailbox','mailbox_domain_lock',
 'credentialdo_access_snapshot','credentialdo_scope_write_allowed','seal_lifetime_access_cohort','record_credential_purchase_trial',
 'limited_billing_eligibility','prepare_limited_billing_invitations','bind_limited_billing_invitation','has_limited_paid_purchase',
 'claim_billing_checkout','save_billing_checkout','close_billing_checkout','claim_billing_reconcile','release_billing_reconcile','apply_billing_subscription',
 'reserve_ai_request','reserve_ai_spend','settle_ai_spend','reserve_packet_send')
-- The AI seed precondition is aggregate only; no identities, prompt text or keys.
union all
select 'anthropic_seed_precondition' as section, jsonb_build_object('currentUtcMonthRows',count(*),'earliest',min(created_at),'latest',max(created_at)) as records
from public.ai_usage where provider='anthropic' and created_at>=date_trunc('month',now() at time zone 'utc')
;
rollback;
