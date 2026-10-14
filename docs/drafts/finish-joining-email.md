# Draft: "finish joining" email (for Eric's approval)

Status: DRAFT. Nothing sends it. The flag `FINISH_JOINING_EMAIL_ENABLED` in
`supabase/functions/_shared/finishJoiningEmail.mjs` is `false`, there is no
sender, no edge function and no cron job. The builder refuses to make a
message until a real unsubscribe link and a real mailing address are given.

## Who gets it, and when

- An account that is still pending (signed up, membership not paid).
- About 1 hour, 24 hours and 72 hours after the account was made. Only the
  latest step that is due is sent, never two at once, and nothing after 14 days.
- It stops for good when the account pays or the person unsubscribes.
- Sent from Eric, plain text, with replies going to Eric.

## What Eric needs to decide or fill in

1. The wording below (each sentence can change).
2. The physical mailing address for the footer (required for commercial email).
3. The unsubscribe page: it does not exist yet. It must work without signing in
   and stop every later step.
4. Whether it is sent at all, and from which address (whit@credentialdomd.com
   relays replies to Eric's inbox).
5. The link. The draft links to the app (`/app/`), where the person signs in,
   sees the offer and the renewal terms again, ticks the box and pays. A Stripe
   recovery link is recorded only for a Checkout that held no founding place
   (`billing_checkout_recoveries`): a founding Checkout's $99 place is released
   when it expires, so paying through a copy of it would go past the 100 place
   cap and its settlement would refuse it. While the founding offer is open,
   every Credential Checkout holds a founding place, so the app link is the one
   to use.

Prices in the email come from the live offer at send time (never typed in). The
examples below use the founding price, $99 a year, and a made up first name.

### Step 1 (about 1 hour after signup)

Subject: Your CredentialDOMD account is waiting for payment

```
Hi Jordan,

You made a CredentialDOMD account, but the membership payment was not finished, so the account is not open yet. Nothing was charged.

If you still want it, you can finish here: https://credentialdomd.com/app/
Sign in with the same email address. You will see the price ($99 a year) and the renewal terms again before you pay, and every membership has our 100% money back guarantee.

If something on the page stopped you, just reply to this email and tell me. I read every reply.

Eric Whitney, DO
Founder, CredentialDOMD


You are receiving this because you created an account at credentialdomd.com with this address. Unsubscribe from these reminders: [UNSUBSCRIBE LINK]
CredentialDOMD, [MAILING ADDRESS: Eric fills this in before anything is sent]
```

### Step 2 (about 24 hours after signup)

Subject: Finishing your CredentialDOMD membership

```
Hi Jordan,

Your CredentialDOMD account is still waiting for its first payment. Nothing has been charged, and nothing will be unless you choose to pay.

To finish: https://credentialdomd.com/app/
The membership is $99 a year, it renews yearly until you cancel, and the 100% money back guarantee covers your most recent annual payment.

If it is not for you, that is fine too. A reply telling me why helps me build it better.

Eric Whitney, DO
Founder, CredentialDOMD


You are receiving this because you created an account at credentialdomd.com with this address. Unsubscribe from these reminders: [UNSUBSCRIBE LINK]
CredentialDOMD, [MAILING ADDRESS: Eric fills this in before anything is sent]
```

### Step 3 (about 72 hours after signup)

Subject: Last note about your CredentialDOMD account

```
Hi Jordan,

This is the last reminder I will send about your unfinished CredentialDOMD account. Nothing was charged.

If you want to finish later, the same link works: https://credentialdomd.com/app/

Thank you for taking a look.

Eric Whitney, DO
Founder, CredentialDOMD


You are receiving this because you created an account at credentialdomd.com with this address. Unsubscribe from these reminders: [UNSUBSCRIBE LINK]
CredentialDOMD, [MAILING ADDRESS: Eric fills this in before anything is sent]
```
