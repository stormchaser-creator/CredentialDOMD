-- Several screenshots on one ticket or one reply.
--
-- A physician asked for this the way people do: "let me add multiple
-- screenshots because I need to add multiple photos to highlight some of the
-- issues". One picture rarely shows a bug.
--
-- Additive on purpose. attachment_path stays and keeps holding the FIRST
-- image, so every reader written while one was the limit still finds a
-- screenshot exactly where it looks for one. The array carries the whole set,
-- including that first path, and readers merge the two (see
-- attachmentPathsOf in supabase/functions/_shared/ticketAttachment.ts).
--
-- The ticket's own screenshots live in context_payload, which is jsonb and
-- needs no migration; only the messages table has a real column.

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS attachment_paths text[];

COMMENT ON COLUMN public.support_messages.attachment_paths IS
  'Every screenshot on this reply, in order, as storage keys in the private documents bucket. attachment_path holds the first of them for readers that predate this column.';

-- The thread view both screens read with select("*"). Adding the column to the
-- table is not enough: the view is the only shape the client ever sees.
CREATE OR REPLACE VIEW public.ticket_thread AS
SELECT m.id,
    m.ticket_id,
    m.body,
    m.is_admin_reply,
    m.created_at,
    m.author_id,
    p.email AS author_email,
    m.attachment_path,
    m.attachment_paths
   FROM support_messages m
     LEFT JOIN profiles p ON p.id = m.author_id
  WHERE (EXISTS ( SELECT 1
           FROM support_tickets t
          WHERE t.id = m.ticket_id AND (t.user_id = current_profile_id() OR is_admin(current_profile_id()))))
  ORDER BY m.created_at;

GRANT SELECT ON public.ticket_thread TO authenticated;
