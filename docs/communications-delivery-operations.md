# Communication delivery operations

The daily reminder job still enqueues at 13:00 UTC. The minute job drains paced, leased batches. Authorized manual reminder calls return HTTP 202 with a queued count; they do not report a send. Dry runs preview without writing. Guide sweeps retain their existing ten-minute schedule and one-hour repeat-request rule.

Reminder and guide provider attempts use a frozen payload and stable key for at most 23 hours. An accepted message is confirmed only when the provider returns a nonblank ID; its database acknowledgement commits the delivery stamp atomically. A network error or lost acknowledgement is not proof of either sending or failure. This provides bounded retries, not an exactly-once guarantee beyond the provider's key-retention window.

Only one unfinished reminder job may exist for a profile across UTC dates. Minimal unresolved reminder identity (fingerprint, recipient hash, source job and intent start time) survives payload and job pruning. While acceptance is unknown, another job for the same digest and address observes the member's existing UTC-day cadence measured conservatively from the original intent start. Retries do not advance that date. After the configured daily/weekly interval, a new scheduled reminder is a new intent and may send. Changed digests or recipient addresses can form a new intent. Unknown acceptance never updates `reminder_emailed_at` or pretends to be a confirmed notification.

Guide request identities remain terminal after five attempts or 23 hours; resubmitting the same pending request cannot reset them. A later state/address request or a legitimately reopened sent request has a new identity. Confirming an older guide never stamps a newer request.

Use a service-role operations connection to inspect actionable failures. These queries contain no message bodies, addresses, hook secrets or API keys:

```sql
select profile_id, reminder_day, status, attempts, last_error, created_at, finished_at
from public.reminder_email_queue
where status='failed' or last_error='unconfirmed_delivery_within_cadence'
order by created_at;

select u.profile_id, u.fingerprint, u.recipient_hash, u.intent_started_at,
       u.last_error, q.status as source_status
from public.reminder_email_uncertainty u
left join public.reminder_email_queue q on q.id=u.source_job
where u.resolved_at is null
  and (q.id is null or q.status in ('failed','skipped'))
order by u.intent_started_at;

select lead_id, request_id, status, attempts, last_error, created_at, finished_at
from public.guide_email_deliveries
where status='failed'
order by created_at;
```

After verifying the provider record for a settled reminder intent, `reminder_delivery_reconcile` records an explicit `confirmed_sent` or `confirmed_not_sent` resolution, a reason of at least ten characters and, for a confirmed send, the actual provider acceptance timestamp. It refuses active work, ordinary user roles, missing evidence descriptions, and invented future timestamps. It sends no message. A confirmed send can correct an older cadence stamp; a confirmed-not-sent resolution permits a subsequent eligible intent without inventing a notification. Never resolve unknown acceptance by guessing. Resolved metadata is pruned after thirty days; unresolved minimal identity remains until confirmation, reconciliation or account deletion.

Apply `20260930223000_communications_delivery_claims.sql` before its matching edge handlers. Its predecessor `20260930220000_reminder_delivery_queue.sql` is unchanged. The rollback restores previous functions and timeouts but deletes the new uncertainty/guide ledger; archive operational evidence and stop active workers before using it. No migration application sends a message.

The combined release also requires `20261002001000_reminder_itemized_delivery.sql`
after both October 1 dispatcher files. The sender now stores a digest followed
by item identities/dates; the uncertainty ledger indexes only the original
24-character digest. Reconciliation uses the frozen item list while its queue
payload is retained, then falls back to the supported bare digest after the
retry window prunes that payload. No extra copy of credential dates is kept
indefinitely. Old bare-digest retries retain their original frozen payload.
The final claim rechecks the current profile under lock using the same snooze,
new-item and UTC cadence rules as the sender. A previous-day outstanding job
blocks a new intent without aborting the whole daily enqueue; exhausted jobs
are retired first. Applying the migration twice neither queues nor sends mail.

Do not run an older delivery rollback beneath the itemized sender. That pairing
rejects new reminders. Keep the full migration order, retain operational
ledgers, and prepare a reviewed forward correction if another issue is found.
