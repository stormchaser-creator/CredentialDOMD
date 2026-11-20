# Members and leads

Owner rule, November 16, 2026: only paid members count as signed up, users or
members. Anyone who only gave an email to get a guide (state license guides,
CME guides, lead magnets, newsletter) is a lead, not a user.

## The one definition of a paid member

`public.paid_member_profiles()` (migration `20261116120000_leads_vs_paid_members.sql`):

A profile that is not deleted or closed, with a live (`livemode`)
`billing_subscriptions` row where

- `status = 'active'`
- `membership_active` is true
- `period_end > now()`
- `offer_id` is `core` (Credential) or `core_locum` (Credential + Practice)

This is the same rule `credentialdo_access_snapshot()` uses to open paid
access, so "counted as a member" and "has paid access" cannot drift apart.

Not paid members: lifetime and gifted access, the protected no-card beta, a
beta opt-in that has not been charged yet (`trialing`), `past_due`, `unpaid`
or `canceled` subscriptions (a refund cancels the subscription), accounts that
only signed in, test-mode subscriptions, and every lead.

## Leads

A lead is an address in `early_access_leads` (waitlist or guide request) that
does not belong to a paid member. One address counts once.
`public.lead_contact_count()` is the count. Lead rows are never deleted,
merged or rewritten by any of this: when a lead pays, a paid subscription
exists under the same address, so the person leaves the lead count and enters
the member count with no data change.

## Founder spots left

Not part of this change. The public "spots left" count (capacity minus paid
founding places) is `20261120150000_public_founder_spots_left.sql` (PR #25):
`paid_founder_count()`, `founder_spots_left()` and
`public_membership_offer().founderSpotsLeft`. The `founding_cohort_count`
view is unchanged here.

## Where each number is used

| Place | Number | Source |
| --- | --- | --- |
| Admin > Overview & reports | paid members, new paid members, leads, accounts without a paid membership | `admin_operations_report().people` |
| Admin > Overview daily table and CSV | new paid members per day | `admin_operations_report().daily[].paid_members` |
| Admin > Leads tab label | leads | `admin_attention_counts().leads` |
| Admin > Accounts groups | paid members, free access, accounts without a paid membership | `admin_account_memberships().paid_active` |
| Admin > Accounts "Paid founder members" | paid founders among loaded accounts | `admin_account_memberships().founding_paid` |
| Owner texts and emails | "lead", "new account, not paid", money lines for payments | `scripts/signup-notify.py`, `_shared/ownerNotify.mjs` |

Account profile counts ("Account profiles", "New account profiles") remain in
the report for operations, labeled as not members.

## Read-only check

```sql
select (select count(*) from public.paid_member_profiles()) as paid_members,
       public.lead_contact_count()  as leads;
```

Before the migration is applied, the same numbers by hand:

```sql
select
  (select count(*) from public.billing_subscriptions x join public.profiles p on p.id = x.profile_id
    where x.livemode and x.status = 'active' and x.membership_active and x.period_end > now()
      and x.offer_id in ('core','core_locum') and p.deleted_at is null
      and not exists (select 1 from public.account_tombstones t where t.profile_id = p.id)) as paid_members,
  (select count(*) from public.limited_founding_slots where livemode and state = 'paid') as paid_founders,
  (select count(distinct lower(btrim(email))) from public.early_access_leads where btrim(coalesce(email,'')) <> '') as lead_addresses;
```

(`lead_addresses` here still includes any address that has since paid.)
