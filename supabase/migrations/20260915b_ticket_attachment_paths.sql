-- A ticket attachment key has to belong to the ticket (2026-09-15).
--
-- THE HOLE. ticket-attachment-url checked that the caller owns the TICKET and
-- then signed whatever storage key the row carried, with the service-role
-- client, against the private "documents" bucket. That bucket also holds
-- every physician's own uploaded documents at "<clerk sub>/<uuid>". Nothing
-- checked that the key had anything to do with the ticket.
--
-- The edge functions are not the only writer of those keys. RLS lets any
-- signed-in caller INSERT a support_tickets row (tickets_user_insert) and
-- UPDATE their own (tickets_owner_or_admin_update), and INSERT a
-- support_messages row (messages_thread_insert), straight through PostgREST;
-- all three are constrained on ownership and say nothing about the
-- attachment columns. Clerk sign-up is open on the dev instance, so "signed
-- in" is not a boundary. A caller could open their own ticket, PATCH
-- context_payload to another account's document key, and ask the function
-- for a signed link to it.
--
-- The functions now validate every key before signing it
-- (isTicketAttachmentPath in supabase/functions/_shared/ticketAttachment.ts)
-- and create-ticket no longer copies caller-supplied attachment keys onto
-- the row. This file is the third layer, the one a direct PostgREST write
-- cannot skip: the same shape check, in the database, on the way in.
--
-- WHY IT SCRUBS INSTEAD OF RAISING. A raise would make the whole write fail,
-- and these tables carry the physician's own words. An admin changing a
-- ticket's status, or a physician saving a reply, would lose the write over
-- a column they were not touching. A key that is not this row's own is not
-- a key at all, so it is dropped and the rest of the row is saved. The
-- reader treats a row with no key exactly as it treats a row that never had
-- one.
--
-- Additive and forgiving: NULLs pass through untouched, no column is
-- dropped, renamed or narrowed, and no policy changes. Measured against the
-- live project before writing this: all 24 attachment keys on the 18 rows
-- that carry one already match the shapes below, so nothing in production
-- is scrubbed by applying it.

-- ── The shape check ─────────────────────────────────────────────────────────
-- The four keys this system writes, and nothing else:
--   tickets/<ticket_id>/screenshot.<ext>
--   tickets/<ticket_id>/screenshot-<n>.<ext>
--   tickets/<ticket_id>/replies/<message_id>.<ext>
--   tickets/<ticket_id>/replies/<message_id>-<n>.<ext>
-- p_message null asks for the ticket's own family, a message id asks for
-- that reply's family. The ids are uuids, so interpolating them into the
-- pattern cannot smuggle a regex metacharacter. The extension list is the
-- values of MIME_EXT in _shared/ticketAttachment.ts; a key whose extension
-- the upload path could not have produced is not one of ours.
create or replace function public.ticket_attachment_path_ok(
  p_path text,
  p_ticket uuid,
  p_message uuid default null
) returns boolean
language sql
immutable
set search_path = public
as $$
  select p_path is not null
     and p_ticket is not null
     and p_path !~ '\.\.'
     and p_path !~ '//'
     and p_path ~ (
           '^tickets/' || p_ticket::text || '/' ||
           case when p_message is null
                then 'screenshot'
                else 'replies/' || p_message::text
           end ||
           '(-([2-9]|[1-9][0-9]))?' ||
           '\.(jpg|png|webp|gif|heic|heif|pdf|doc|docx|xls|xlsx|csv|txt|rtf)$'
         );
$$;

comment on function public.ticket_attachment_path_ok(text, uuid, uuid) is
  'True only for a storage key that create-ticket or reply-ticket would have written for this exact ticket (and reply). Used by the two scrub triggers so a direct PostgREST write cannot plant somebody else''s document key on a ticket for ticket-attachment-url to sign.';

-- ── support_tickets.context_payload ─────────────────────────────────────────
-- The ticket's own keys live in jsonb, so the scrub is key-by-key: a bad
-- singular key is removed, a bad entry in the array is dropped, and an array
-- left with nothing in it is removed rather than stored as [].
create or replace function public.scrub_ticket_attachment_paths()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_one  text;
  v_many jsonb;
  v_keep jsonb := '[]'::jsonb;
  v_item jsonb;
begin
  if new.context_payload is null or jsonb_typeof(new.context_payload) <> 'object' then
    return new;
  end if;

  v_one := new.context_payload ->> 'attachment_path';
  if v_one is not null and not public.ticket_attachment_path_ok(v_one, new.id) then
    new.context_payload := new.context_payload - 'attachment_path';
  end if;

  v_many := new.context_payload -> 'attachment_paths';
  if v_many is not null then
    if jsonb_typeof(v_many) <> 'array' then
      -- Not even the right type. The reader ignores it; do not store it.
      new.context_payload := new.context_payload - 'attachment_paths';
    else
      for v_item in select jsonb_array_elements(v_many) loop
        if jsonb_typeof(v_item) = 'string'
           and public.ticket_attachment_path_ok(v_item #>> '{}', new.id) then
          v_keep := v_keep || jsonb_build_array(v_item);
        end if;
      end loop;
      if jsonb_array_length(v_keep) = 0 then
        new.context_payload := new.context_payload - 'attachment_paths';
      elsif v_keep <> v_many then
        new.context_payload := jsonb_set(new.context_payload, '{attachment_paths}', v_keep);
      end if;
    end if;
  end if;

  return new;
end $$;

-- ── support_messages.attachment_path / attachment_paths ─────────────────────
-- A reply's key has to name that reply, not a sibling on the same thread:
-- reply-ticket mints the message id first precisely so the object can be
-- stored under it.
create or replace function public.scrub_message_attachment_paths()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_keep text[] := '{}';
  v_path text;
begin
  if new.attachment_path is not null
     and not public.ticket_attachment_path_ok(new.attachment_path, new.ticket_id, new.id) then
    new.attachment_path := null;
  end if;

  if new.attachment_paths is not null then
    foreach v_path in array new.attachment_paths loop
      if v_path is not null
         and public.ticket_attachment_path_ok(v_path, new.ticket_id, new.id) then
        v_keep := array_append(v_keep, v_path);
      end if;
    end loop;
    new.attachment_paths := case when cardinality(v_keep) = 0 then null else v_keep end;
  end if;

  return new;
end $$;

drop trigger if exists trg_scrub_ticket_attachment_paths on public.support_tickets;
create trigger trg_scrub_ticket_attachment_paths
  before insert or update on public.support_tickets
  for each row execute function public.scrub_ticket_attachment_paths();

drop trigger if exists trg_scrub_message_attachment_paths on public.support_messages;
create trigger trg_scrub_message_attachment_paths
  before insert or update on public.support_messages
  for each row execute function public.scrub_message_attachment_paths();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function, and anon and
-- authenticated hold their access through PUBLIC rather than in their own
-- right (see 20260913_view_and_rpc_lockdown.sql, section 5: revoking the two
-- role names alone left prune_page_visits() answering the anon key). So
-- PUBLIC is what gets revoked and the roles that need it are named.
--
-- The two trigger functions need no grant at all: Postgres checks EXECUTE on
-- a trigger function when the trigger is created, not when it fires. The
-- predicate does need one, because the trigger bodies are not SECURITY
-- DEFINER and call it as whoever is writing the row.
revoke execute on function public.ticket_attachment_path_ok(text, uuid, uuid) from public, anon;
grant execute on function public.ticket_attachment_path_ok(text, uuid, uuid) to authenticated, service_role, postgres;

revoke execute on function public.scrub_ticket_attachment_paths() from public, anon, authenticated;
revoke execute on function public.scrub_message_attachment_paths() from public, anon, authenticated;
grant execute on function public.scrub_ticket_attachment_paths() to postgres, service_role;
grant execute on function public.scrub_message_attachment_paths() to postgres, service_role;

notify pgrst, 'reload schema';
