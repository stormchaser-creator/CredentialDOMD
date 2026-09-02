# CallSync sync (ANMG on-call schedule)

Ticket 833c06e8. The physician's published ANMG on-call shifts, from the
CallSync app, land on the Forecast calendar (Practice > Sched.) as call days on
the ANMG agreement, checked once a day when the app opens.

## Where the schedule comes from

CallSync (`~/Projects/ANMG-CallSync`, Next.js on Railway, Prisma/Postgres,
Clerk) publishes each provider's shifts as a calendar subscription:

    GET https://anmg-callsync-production.up.railway.app/api/ical?token=<uuid>

- Public route (no Clerk session), token-keyed: `Provider.icalToken`, shown
  and regenerated on CallSync's Dashboard under "Calendar Subscription".
- One full-day VEVENT per `ScheduleSlot` where the provider is primary or
  backup, from `SchedulePeriod.status = PUBLISHED` only, three months back
  to twelve months ahead. `SUMMARY:ON CALL <dash> <hospital abbr> <coverage
  abbr> (Primary|Backup)`, `DESCRIPTION` with the coverage name, role and
  on-call phone, `CATEGORIES:PRIMARY CALL|BACKUP CALL`, `UID:<slotId>-<role>@callsync.anmg`.
- `callsync.anmg-ca.com` is the documented public CNAME; it did not resolve
  on 2026-09-02, so the Railway host is what works. Both are accepted.
- The feed sends no CORS headers, so the browser cannot read it directly.

## Pieces in this app

| Piece | Role |
|---|---|
| `supabase/functions/callsync-feed` | Relay. Clerk JWT required (`_shared/clerkAuth.ts`), body `{ url }`, host allowlist + `/api/ical` + token shape enforced, returns `{ ics }`. Deploy with `--no-verify-jwt`. |
| `supabase/migrations/20260902_schedule_days_source.sql` | `schedule_days.source` + `source_key` (idempotency key `date\|hospital\|coverage\|role`). |
| `src/utils/callsync.js` | Pure: link validation, iCal parsing, shift extraction, ANMG contract detection, grid pricing, sync plan, once-a-day gate. Tested by `scripts/callsync.test.mjs`. |
| `src/hooks/useCallSync.js` | Fetch through the relay, apply the plan through addItem/editItem/deleteItem, bookkeeping in the per-user `credentialdomd-callsync` slot, `useCallSyncAutoRun()` mounted in App.jsx. |
| `src/components/features/locum/CallSyncPanel.jsx` | Sched. tab card: link field, agreement picker, Sync now, status, next shifts. Shown when an ANMG agreement is detected by name, any agreement has a call-rate grid, a link or agreement pick is saved, or synced shifts exist. |

The link and the agreement pick are device-local settings
(`settings.callsyncFeedUrl`, `settings.callsyncContractId`, in
`DEVICE_KEY_FIELDS`): never written to Postgres, cleared on sign-out,
entered once per device.

## Rules

- One `scheduleDays` entry per shift, `note: "ARMC NSx primary call
  (CallSync)"`, `source: "callsync"`. A day-rate agreement cannot have call
  without also being a day worked, so the `kind` and `expected` depend on
  what the physician has already logged by hand for that date on the same
  agreement: nothing hand-logged yet gets `kind: "day+call"` (day rate plus
  the grid/stipend call amount); a day already logged by hand gets
  `kind: "call"` (grid/stipend only); a date where the physician has
  already logged the call themselves (by hand, or a stipend agreement with
  no day rate) gets nothing added — a sync must not add a second call
  charge on top of one already there.
- Re-syncs match on `sourceKey`; nothing synced duplicates. A dollar figure
  the physician changed by hand is kept, unless the `kind` it was priced
  under no longer applies (the physician logged the missing half by hand
  since the last sync), in which case it is repriced.
- A future shift that leaves the feed (swap, unpublished month) is removed,
  inside the feed window only. Past entries are never removed. Entries with
  no `source` (hand-made days, vacations) are never touched.
- Auto-check: after load and when the app returns to the foreground, if the
  last good sync is 24h old; a failed attempt waits 15 minutes.

## Deploy (owner)

```sh
cd ~/Projects/CredentialDOMD
supabase functions deploy callsync-feed --no-verify-jwt --project-ref hkpnnsjcwprrwobmpqyy
```

Migration applied to production on 2026-09-02 through the management API.
