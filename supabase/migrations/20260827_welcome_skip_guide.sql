-- Welcome email must not fire for guide-email leads (2026-08-27).
--
-- trg_welcome_lead fires welcome_new_lead() on EVERY insert into
-- early_access_leads, so a /states/{slug} guide requester got BOTH the
-- founding-welcome email and the state guide email, with contradictory
-- framing. The guide path marks its rows in note: waitlist_signup stores
-- p_note='guide-email {ABBR}' as given, or folds a non-"normal" p_stage
-- into note when p_note is null (the leads table has no stage column), so a
-- stage='guide' signup without a note lands as note='guide'. This recreates
-- welcome_new_lead() with an early return for both shapes; welcome now
-- fires only for normal waitlist joins. The send-guide sweep
-- (20260827_guide_email.sql) remains the only mail path for guide leads.
--
-- Same secret-preservation mechanism as 20260817_backups.sql and
-- 20260827_guide_email.sql: the WELCOME_HOOK_SECRET literal is deliberately
-- NOT committed; the DO block copies it out of the live welcome_new_lead()
-- definition at apply time and writes it back into the replacement. The
-- 'x-hook-secret',%L spelling (no space after the comma) is load-bearing:
-- later migrations extract the secret with that exact pattern.

do $$
declare
  secret text;
begin
  select substring(pg_get_functiondef('public.welcome_new_lead'::regproc)
                   from 'x-hook-secret'',''([^'']+)''')
    into secret;
  if secret is null or secret = '' then
    raise exception 'hook secret not found in welcome_new_lead(); paste WELCOME_HOOK_SECRET into this migration by hand';
  end if;

  execute format($fn$
    create or replace function public.welcome_new_lead()
    returns trigger
    language plpgsql
    security definer
    as $body$
    begin
      -- Guide-email leads (state renewal pages) get the state guide from the
      -- send-guide sweep instead; the founding welcome would contradict it.
      -- (the doubled percent below is format()'s escape for a literal one)
      if NEW.note = 'guide' or NEW.note like 'guide-email %%' then
        return NEW;
      end if;
      perform net.http_post(
        url := 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-welcome',
        headers := jsonb_build_object('Content-Type','application/json','x-hook-secret',%L),
        body := jsonb_build_object('record', to_jsonb(NEW))
      );
      return NEW;
    end
    $body$;
  $fn$, secret);
end
$$;

comment on function public.welcome_new_lead() is
  'AFTER INSERT trigger on early_access_leads: calls the send-welcome edge function with the shared WELCOME_HOOK_SECRET. Skips guide leads (note = ''guide'' or note like ''guide-email %''); those get the state guide from the send-guide sweep instead. Rotate the secret together with the other hook functions.';
