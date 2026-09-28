-- docs/rollback/20260928150000_support_reply_verifications.rollback.sql
-- Rollback for 20260928150000_support_reply_verifications.sql.
--
-- Turns the enforcement off and nothing else: operator SQL can again insert a
-- support reply with no verification. The verification table, the
-- support_messages.verification_id column and the vault secret stay. They are
-- the audit trail of what was checked, the runner that writes them keeps
-- working, and dropping them is not needed to undo the behaviour.
--
-- To remove the rest as well (only after reverting the runner, whose replySQL
-- writes both), in this order:
--   alter table public.support_messages drop column if exists verification_id;
--   drop table if exists public.support_reply_verifications;
--   delete from vault.secrets where name = 'support_reply_hmac_key';

begin;
drop trigger if exists trg_require_verified_support_reply on public.support_messages;
drop function if exists public.require_verified_support_reply();
notify pgrst, 'reload schema';
commit;
