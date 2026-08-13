# Waitlist email sequence — drafts for Eric's approval

From: Whit Whitney, DO <whit@credentialdomd.com>
Voice rules: physician to physician, first person, short, concrete, zero marketing
fluff, no em dashes. Every claim comes from real use. One idea per email.

---

## Email 1 — Welcome (sends instantly on signup)

**Subject:** You're #{{position}} on the CredentialDOMD founding list

Hi {{first_name}},

You're on the list. You're number {{position}}, and order matters here: founding
spots come with founding terms when the doors open.

Quick background so you know what you joined. I'm a neurosurgeon working locums,
and I built this because I was tracking licenses in a spreadsheet, chasing CME
totals across four states, and finding out the hard way that an agency's
remittance didn't match my own numbers. Now the app runs my actual practice
every day: my licenses, my call schedules, my invoices, my case log.

One question, and I read every reply: **what's the most painful part of
credentialing or locums paperwork for you right now?** Hit reply and tell me in
one sentence. It genuinely shapes what I build next.

One email when early access opens. That's the deal.

Whit

---

## Email 2 — Proof note (about 1 week later)

**Subject:** The app caught a $600 underpayment on my own invoice

Hi {{first_name}},

Short story from the field.

Last week an agency's timesheet portal showed my call week bucketed by their
billing calendar, not mine. I had the app reconcile their numbers against my
own work log, minute by minute, day by day. Six of seven days matched exactly.
One week was $600 short: a two-hour orientation block they never paid.

I only caught it because the app had every 15-minute call logged with a
timestamp. That's the difference between "the deposit looked about right" and
knowing.

That reconciliation view ships with early access. If you work with agencies,
it will probably pay for the app the first month.

Whit

---

## Email 3 — The 30-second import (about 2 weeks later)

**Subject:** Type one number, watch your licenses appear

Hi {{first_name}},

The first thing you'll do in CredentialDOMD takes thirty seconds: type your
NPI. The app pulls your state licenses straight from the NPPES registry and
sets up expiration tracking on each one automatically.

From there it's the boring-but-critical stuff handled: DEA renewal countdowns,
CME cycle math per state, one place for every document a credentialing office
will ever ask you for, and packets that assemble themselves when an agency
asks for "everything" by Friday.

No patient data ever touches it, by design. It tracks your career, not your
patients.

Doors open soon, founding list first, in order.

Whit

---

## Email 4 — The invite (sent in batches of ~10 when production opens)

**Subject:** Your CredentialDOMD invite is live

Hi {{first_name}},

Your spot is up. Here's your invite: {{invite_link}}

Founding terms, only for this list: {{founding_offer}}. Annual, and if it's
not earning its keep inside 30 days, full refund, no questions.

Do the NPI import first. It's the thirty-second version of the setup that took
me a weekend in spreadsheets.

I'm onboarding ten people at a time so I can actually help each one. If you
want fifteen minutes on the phone to get your credentials loaded, reply with
"call me" and a time.

Whit

---

### Wiring notes (for implementation once the Resend key exists)
- {{position}}: row order by created_at in early_access_leads.
- Email 1 fires from a DB trigger/webhook on insert; 2 and 3 from the schedule
  runner (reuse the onboarding_queue machinery in send-onboarding-email).
- {{founding_offer}}: ERIC DECIDES before Email 4 exists. Placeholder until then.
- Send domain: credentialdomd.com via Resend, SPF/DKIM through the Cloudflare
  token in keychain "Cloudflare CredentialDOMD".
