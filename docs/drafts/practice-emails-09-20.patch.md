# Patch: Practice emails 09 to 20, field by field

For Codex. Apply to `/workspace/credentialdomd-emails/build/cdomd_emails_data.py` (one entry per email), then rerun `build_cdomd_emails2.py` and `render_cdomd_email_previews.py`. Not live; Eric approves before anything sends.

Source of this copy: `docs/drafts/practice-positioning-2026-11-16.md` on this branch.

## Read first

- **The data file was not visible when this was written.** It lives on the box, outside the repo. So the field names below (subject, preheader, body, cta) are by meaning: map them to the actual keys in each entry. No "old phrase" is given for 09 to 20 because the current text was never seen. Replace each entry's subject, preheader, body and CTA whole.
- If a current 09 to 20 email covers a topic that has no match below, do not drop it. Leave it as is and list it in your report so it can be rewritten.
- Keep unchanged in every entry: the footer, sender, send day and timing, unsubscribe and address lines, and any tracking fields.
- Audience wording: "DOs, MDs, NPs and PAs" in that order, "NPs and PAs" (never "PAs and NPs"), and "every practicing clinician, employed or locum".
- Prices: during founding, only the $99 Founder plan may appear. If any email in the series mentions $149, $199 or $245, remove that sentence and list the email in your report.
- Product name is CredentialDOMD, exact capitalization.
- Do not add claims. The app has no bonus calculator, no dollars-per-RVU rate and no automatic payment matching. Payments are recorded by hand.
- Greeting token is written `{first_name}` here. Use the token the data file already uses.
- CTA link: all CTAs go to `https://credentialdomd.com/app/`. If the entries already carry a tracked link for the app, keep that link and change only the label.
- Sign-off is "Eric Whitney, DO". If the entries hold the sign-off in a shared field or the footer, do not repeat it in the body.

## Emails 09 to 20

### Email 09: Practice is for every practicing clinician

| Field | New value |
| --- | --- |
| subject | Every clinician has a contract |
| preheader | Practice keeps your own record of the work you do under it. |
| greeting | Hi {first_name}, |
| cta label | Open Practice |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> Credential keeps your licenses and CME in order. Practice is the other half of your account, and it is for every practicing clinician, employed or locum.

P2:

> Every one of us works under a contract. Somebody else counts our procedures, our RVUs and our call. Practice gives you your own count: the work you did, the work RVUs it adds up to, and the contract you did it under.

P3:

> Open the Practice tab. It has seven parts: Work, RVUs, Schedule, Invoices, Contracts, Expenses and To do. Over the next few emails I will take them one at a time.

### Email 10: Start with your contract

| Field | New value |
| --- | --- |
| subject | Put your contract where you can find it |
| preheader | Rates, dates and key terms, with the signed copy attached. |
| greeting | Hi {first_name}, |
| cta label | Add your contract |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> Start in Practice > Contracts. Add your agreement, whether it is an employment contract, an independent contractor agreement or a locum assignment.

P2:

> You can upload the document as a PDF, photo, Word or Excel file. The scanner fills in what it finds, such as rates and coverage dates, and nothing saves until you have reviewed it. You can also type it in yourself. Key terms go in the notes: cancellation, guaranteed hours, anything you will want to find later.

P3:

> Once a contract is saved, the work you log is filed under it.

P4:

> One caution: check every amount and date against the paper. The app records your terms. It does not interpret them.

### Email 11: Log the work as it happens

| Field | New value |
| --- | --- |
| subject | Log it while you still remember it |
| preheader | Procedures, shifts and call, from your phone. |
| greeting | Hi {first_name}, |
| cta label | Open the work log |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> The Work tab is where the day gets recorded. Tap the timer when the phone rings and tap again when you are done. Missed one? Use Log past time.

P2:

> If your agreement pays by the day, Work switches to days and call instead of a timer.

P3:

> Time rounds to the billing increment in your contract, so the log matches the way you are paid. If you are salaried, the log is still worth keeping: it is your own record of the call you took and the hours you worked.

P4:

> Keep patient details out of billing notes.

### Email 12: Say what you did, get the codes

| Field | New value |
| --- | --- |
| subject | Say what you did. Get the CPT codes. |
| preheader | The AI proposes codes and work RVUs. You approve them. |
| greeting | Hi {first_name}, |
| cta label | Log your first RVU entry |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> Open Practice > RVUs. Dictate or type what you did, in your own words. The app proposes CPT codes with their work RVU values. You review them, fix anything that is off, and save.

P2:

> You can also type a code or a procedure name and add it directly.

P3:

> Each entry is filed under the contract you pick, with its date and its total. Operative entries can go straight to your case log, so you are not entering the same case twice.

P4:

> The codes are a proposal. You are the one who approves them.

### Email 13: Your wRVU total, before the statement arrives

| Field | New value |
| --- | --- |
| subject | Know your wRVU number before they tell you |
| preheader | Totals by month, year and contract. |
| greeting | Hi {first_name}, |
| cta label | See your wRVU total |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> If your pay or your bonus depends on productivity, you get a report from someone else's system. Most of us have no number of our own to hold it against.

P2:

> The RVU log gives you one. Filter by contract and by period: this month, last month, this year. The total at the top is your count of the work RVUs you logged.

P3:

> When your productivity report or bonus statement arrives, compare the two. If they differ, you have the dates and codes to ask about.

P4:

> The app does not calculate your bonus. It gives you the count, and the question is yours to ask.

### Email 14: Your case log builds as you work

| Field | New value |
| --- | --- |
| subject | The case log you wish you had kept |
| preheader | Every case, its codes and its wRVU value. |
| greeting | Hi {first_name}, |
| cta label | Open your case log |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> When you save an operative entry in the RVU log, you can add it to your case log in the same step. The case carries its date, facility, codes and wRVU value.

P2:

> Cases are grouped by year, and you can produce a CSV or PDF report when a hospital, a board or a new employer asks for your numbers.

P3:

> If you are an NP or a PA, the same log works for the procedures you perform.

P4:

> It takes a few seconds per case now. It saves the afternoon you would otherwise spend rebuilding the list from memory.

### Email 15: See your coverage on one calendar

| Field | New value |
| --- | --- |
| subject | Your coverage, on one calendar |
| preheader | Add the dates to a contract and they show up in Schedule. |
| greeting | Hi {first_name}, |
| cta label | See your schedule |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> Each contract can hold its coverage dates. Add them once in Contracts and every scheduled block appears in Practice > Schedule.

P2:

> If you cover more than one hospital, or work under more than one agreement, they all show in the same place.

P3:

> When the day comes, Work opens on the contract you are scheduled under, so the time you log lands in the right place.

### Email 16: If you are employed

| Field | New value |
| --- | --- |
| subject | Employed? Practice is for you too |
| preheader | Three things worth keeping your own record of. |
| greeting | Hi {first_name}, |
| cta label | Open Practice |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> Practice was first built around locum work, and some of its screens still show that. It is meant for employed clinicians just as much. If you are employed, three things are worth doing:

P2 (numbered list):

1. Save your contract in Contracts, with its dates, key terms and the signed copy.
2. Log your work RVUs in the RVU tab as you go.
3. Log your call in Work.

P3:

> Each contract then shows what you did under it: days worked, total wRVU and cases. That is useful when your productivity report arrives, and again when the contract comes up for renewal.

P4:

> You can skip Invoices and Expenses entirely.

### Email 17: If you bill for your work

| Field | New value |
| --- | --- |
| subject | From the work log to an invoice |
| preheader | Pick the days, check the preview, send it. |
| greeting | Hi {first_name}, |
| cta label | Build an invoice |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> If you work locums or as an independent contractor, the work you logged becomes your invoice.

P2:

> In Work, choose Invoice, pick the days to bill and check the total. Open the preview and compare the dates, rates and total with your records. Then send it, or copy it into your own message. Invoices are available as PDF, Word or Excel.

P3:

> Sending or copying marks those entries as billed. Copy alone does not deliver the invoice, so confirm it reached the right person.

### Email 18: Know what is still owed

| Field | New value |
| --- | --- |
| subject | Billed is not the same as paid |
| preheader | Record each payment and see what is still owed. |
| greeting | Hi {first_name}, |
| cta label | Record a payment |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> An invoice that went out is easy to file under "done". Practice > Invoices keeps it open until the money arrives.

P2:

> When a payment comes in, choose Record payment and enter the amount and date. Partial payments are fine. The invoice shows what has been received and what is still owed.

P3:

> You record payments yourself. The app does not connect to your bank or your agency.

### Email 19: Expenses and receipts

| Field | New value |
| --- | --- |
| subject | Photograph the receipt. Then forget about it. |
| preheader | Travel and work expenses, with the receipt attached. |
| greeting | Hi {first_name}, |
| cta label | Add an expense |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> Practice > Expenses is for the costs that come with the work: flights, hotels, rental cars and the rest.

P2:

> Add the amount and vendor and take a photo of the receipt. If the expense is reimbursable, you can put it on an invoice with the receipt attached.

P3:

> If you are employed and none of this applies to you, leave this tab alone. Nothing else in Practice depends on it.

### Email 20: One record under each contract

| Field | New value |
| --- | --- |
| subject | What did you do under this contract? |
| preheader | Days, wRVUs, cases and payments, in one view. |
| greeting | Hi {first_name}, |
| cta label | Open your contracts |
| cta link | https://credentialdomd.com/app/ |
| sign-off | Eric Whitney, DO |
| old phrase replaced | Not known. Replace the whole entry. |

Body paragraphs, in order:

P1:

> Tap a contract's name in Contracts. You will see everything logged under it: days worked, total wRVU, the cases you did, and what was billed, collected and is still owed.

P2:

> That is the point of Practice. Every clinician has a contract, and now you have your own record of the work you did under yours, whether you are a DO, MD, NP or PA, employed or locum.

P3:

> If something in Practice does not fit the way you work, tell me. Use Get help in the app. I read those.

## Every other email that mentions Practice

Search the whole data file (all 56 entries, including subjects and preheaders) for: `Practice`, `locum`, `locums`, `assignment`, `agency`, `shift`, `invoice`, `physicians`, `$149`, `$199`, `$245`. For each hit outside 09 to 20, apply the row that fits. The "old phrase" column lists wording the website used before this branch, which the emails are likely to share. Match on meaning where the words differ.

| Old phrase (or close to it) | Replace with |
| --- | --- |
| locums contracts, invoices and payments | your work, RVUs, contracts and pay |
| plus locums invoices | plus your work, RVUs, contracts and pay |
| tools for your locum work | tools to track your work, your RVUs and your contract |
| Practice handles the business side of your work | Practice keeps track of the work itself: what you did, what it is worth and what you are owed |
| Practice, for locum work / built for locums docs | Practice, for every practicing clinician, employed or locum |
| Contracts and rates for each assignment | Your contracts and their rates in one place |
| Log shifts, call and cases as you go | Log procedures, shifts and call as you go |
| billing is easy when an assignment ends | you have your own record of the work you did under your contract |
| physicians (as the whole audience) | DOs, MDs, NPs and PAs, or clinicians |
| track your bonus / calculate your bonus | check your wRVU total against your productivity or bonus statement |
| Credential + Practice is $245/year, or any $149 or $199 price | Delete the sentence. Where a price is needed, use: The Founder plan is $99 a year for the first 100 paid members, with Credential and Practice included. |

One-line description of Practice, for any email that needs one:

> Practice is for every practicing clinician, employed or locum. It keeps your own record of your work: procedures, shifts and call, your work RVUs, and the contract you do it under.

Leave as written: Eric's own story ("I'm a neurosurgeon working locums"), and any email whose subject is specifically locum work, as long as it does not say Practice is only for locums.

## Report back after applying

- Which entries changed, by number.
- Any 09 to 20 entry whose old topic had no match here.
- Any email where a $149, $199 or $245 mention was removed.
- That the generator and the preview renderer both ran clean, and that the footer is byte-identical before and after.
