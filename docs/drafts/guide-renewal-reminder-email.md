# Renewal reminder email: draft for Eric's approval

Drafted November 19, 2026. Nothing here is sent. Sending stays off until Eric says yes
(`guide_reminder_settings.enabled`), and the state guide form is not on the live site until then.

Who gets it: a reader who typed their email and renewal date into the reminder form on a state guide.
When: about three months, one month and one week before the date they gave, once each.
From: Eric Whitney, DO <whit@credentialdomd.com>. Replies go to support@credentialdomd.com.
The source of this text is `supabase/functions/_shared/guideReminderEmail.mjs`; the samples below are its real output for Colorado.

The timing phrase changes with the stage: "about three months from now", "within the next month", "within the next week".

## 1. The plain reminder (everyone)

Subject: Your Colorado license renews April 30, 2027

```text
You asked for a reminder about your Colorado medical license. You told us it renews on April 30, 2027, which is about three months from now.

Cycle: Biennial (2 years)
CME: 30 hours per cycle
Renew at: https://apps2.colorado.gov/dora/licensing/

The full Colorado guide has the checklist, the CME detail and the board's own sources, each with the date it was last checked:
https://credentialdomd.com/states/colorado

Eric Whitney, DO
CredentialDOMD

You are receiving this because you asked for a Colorado renewal reminder at credentialdomd.com. Stop these reminders: https://credentialdomd.com/api/unsubscribe?t=EXAMPLE
```

## 2. With the product line

Only for readers who ticked the product news box, and only once a postal address is set.

Subject: Your Colorado license renews April 30, 2027

```text
You asked for a reminder about your Colorado medical license. You told us it renews on April 30, 2027, which is within the next week.

Cycle: Biennial (2 years)
CME: 30 hours per cycle
Renew at: https://apps2.colorado.gov/dora/licensing/

The full Colorado guide has the checklist, the CME detail and the board's own sources, each with the date it was last checked:
https://credentialdomd.com/states/colorado

You also asked to hear about CredentialDOMD. It keeps your licenses, DEA, board certifications and CME in one place, with reminders like this one built in. See it at https://credentialdomd.com

Eric Whitney, DO
CredentialDOMD

You are receiving this because you asked for a Colorado renewal reminder at credentialdomd.com. Stop these reminders: https://credentialdomd.com/api/unsubscribe?t=EXAMPLE
CredentialDOMD, 1 Example Way, Springfield, CA 90000
```

The address shown is a placeholder. Until a real postal address is set as EMAIL_MAILING_ADDRESS, nobody gets
version 2; every reader gets version 1.

## What Eric decides

1. Is the wording of version 1 approved as written?
2. The postal address for version 2 (the same one the finish joining email is waiting for).
