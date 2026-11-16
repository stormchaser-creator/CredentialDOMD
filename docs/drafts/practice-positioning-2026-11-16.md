# Practice positioning: for every practicing clinician

Draft for Eric's approval, November 16, 2026. Nothing here is live.

Standing rules applied: DOs, MDs, NPs and PAs, in that order; "every practicing clinician", employed or locum; only features the app has today.

## What the app does and does not do (checked against source)

Practice has today:

- Work log: one-tap call timer, past time, days and call for day-rate agreements, rounded to the agreement's billing increment.
- RVU log: say or type what you did, the AI proposes CPT codes with work RVUs, you approve. Totals by 7, 30 and 90 days, this month, last month, this year and all time, and by contract.
- Case log entries created from operative RVU entries, with CSV and PDF reports.
- Contracts: scan or enter an agreement (facility, dates, rates, key terms, attached document). Each contract shows what was logged under it: work days, total wRVU, cases, billed, collected and owed.
- Schedule of coverage blocks, invoices (PDF, Word, Excel), a manual payment ledger with partial payments, expenses with receipts, a to-do list.

Practice does not have today, so the copy does not claim it:

- A bonus or productivity calculator. There is no dollars-per-RVU rate, threshold or target field. The copy says you can check your own wRVU total against your productivity or bonus statement, which is true.
- A salaried or wRVU-based pay model on a contract. Pay models are call stipend, hourly and day rate. An employed clinician can store the contract, its dates, key terms and the document, and see wRVUs roll up under it.
- Automatic payment matching. Payments are recorded by hand.

If Eric wants the copy to say "track your bonuses" outright, the app needs a wRVU target and rate on the contract first.

## Positioning draft

**Tagline**

Your work, on your own record.

Alternates: "Know what you did and what it is worth." / "Every clinician has a contract. Keep your own numbers."

**Description (2 to 3 sentences)**

Practice is for every practicing clinician, employed or locum. It keeps your own record of the work you do: procedures, shifts and call, the work RVUs they add up to, and the contract you do it under. When your productivity report, bonus statement or payment arrives, you have your own numbers to check it against.

**Bullets**

- Log procedures, shifts and call as you go, from your phone.
- Say what you did and get CPT codes with work RVUs to review and approve.
- See your wRVU total by month, year and contract.
- Keep each contract, its rates, dates and key terms in one place, with the signed document attached.
- Check your own totals against your productivity or bonus statement.
- If you bill for your work: invoices, payments and expenses, built from the same log.

**Home section copy**

> **Practice**
> ### Your work, RVUs, contracts and pay
> For every practicing clinician, employed or locum. Every one of us works under a contract. Practice keeps your own record of the work you did under it.
> - Log procedures, shifts and call as you go
> - Say what you did and get CPT codes with work RVUs to review
> - wRVU totals by month, year and contract, to check against your productivity or bonus statement
> - Your contracts and their rates in one place
> - If you bill for your work: invoices, payments and expenses

**Meta description (149 characters)**

Track licenses, DEA, boards and CME, plus your work, RVUs, contracts and pay. Built by a neurosurgeon for DOs, MDs, NPs and PAs. $99/yr Founder plan.

**/locums intro reframe**

Badge: "Practice, for locum work" (was "For locum tenens physicians").

Added under the hero paragraph:

> Locums is one way to use Practice. Practice is for every practicing clinician, employed or locum: DOs, MDs, NPs and PAs who want their own record of their work, their RVUs and their contract. This page walks through the locum workflow, from the signed agreement to the payment. See everything Practice does.

## Emails 09 to 20

Read this first: the email source (`/workspace/credentialdomd-emails/build/cdomd_emails_data.py`) is on the box and was not reachable from this session, so these twelve were written without seeing the current 09 to 20. They are replacement copy on the new framing, one topic per email. Bot: keep each email's existing footer, sender and send timing; map these onto the existing slots; and if a current email covers a topic not listed here, send it over and it will be rewritten to match. First name token shown as `{first_name}`.

### 09. Practice is for every practicing clinician

Subject: Every clinician has a contract
Preview: Practice keeps your own record of the work you do under it.

Hi {first_name},

Credential keeps your licenses and CME in order. Practice is the other half of your account, and it is for every practicing clinician, employed or locum.

Every one of us works under a contract. Somebody else counts our procedures, our RVUs and our call. Practice gives you your own count: the work you did, the work RVUs it adds up to, and the contract you did it under.

Open the Practice tab. It has seven parts: Work, RVUs, Schedule, Invoices, Contracts, Expenses and To do. Over the next few emails I will take them one at a time.

Eric Whitney, DO

### 10. Start with your contract

Subject: Put your contract where you can find it
Preview: Rates, dates and key terms, with the signed copy attached.

Hi {first_name},

Start in Practice > Contracts. Add your agreement, whether it is an employment contract, an independent contractor agreement or a locum assignment.

You can upload the document as a PDF, photo, Word or Excel file. The scanner fills in what it finds, such as rates and coverage dates, and nothing saves until you have reviewed it. You can also type it in yourself. Key terms go in the notes: cancellation, guaranteed hours, anything you will want to find later.

Once a contract is saved, the work you log is filed under it.

One caution: check every amount and date against the paper. The app records your terms. It does not interpret them.

Eric Whitney, DO

### 11. Log the work as it happens

Subject: Log it while you still remember it
Preview: Procedures, shifts and call, from your phone.

Hi {first_name},

The Work tab is where the day gets recorded. Tap the timer when the phone rings and tap again when you are done. Missed one? Use Log past time.

If your agreement pays by the day, Work switches to days and call instead of a timer.

Time rounds to the billing increment in your contract, so the log matches the way you are paid. If you are salaried, the log is still worth keeping: it is your own record of the call you took and the hours you worked.

Keep patient details out of billing notes.

Eric Whitney, DO

### 12. Say what you did, get the codes

Subject: Say what you did. Get the CPT codes.
Preview: The AI proposes codes and work RVUs. You approve them.

Hi {first_name},

Open Practice > RVUs. Dictate or type what you did, in your own words. The app proposes CPT codes with their work RVU values. You review them, fix anything that is off, and save.

You can also type a code or a procedure name and add it directly.

Each entry is filed under the contract you pick, with its date and its total. Operative entries can go straight to your case log, so you are not entering the same case twice.

The codes are a proposal. You are the one who approves them.

Eric Whitney, DO

### 13. Your wRVU total, before the statement arrives

Subject: Know your wRVU number before they tell you
Preview: Totals by month, year and contract.

Hi {first_name},

If your pay or your bonus depends on productivity, you get a report from someone else's system. Most of us have no number of our own to hold it against.

The RVU log gives you one. Filter by contract and by period: this month, last month, this year. The total at the top is your count of the work RVUs you logged.

When your productivity report or bonus statement arrives, compare the two. If they differ, you have the dates and codes to ask about.

The app does not calculate your bonus. It gives you the count, and the question is yours to ask.

Eric Whitney, DO

### 14. Your case log builds as you work

Subject: The case log you wish you had kept
Preview: Every case, its codes and its wRVU value.

Hi {first_name},

When you save an operative entry in the RVU log, you can add it to your case log in the same step. The case carries its date, facility, codes and wRVU value.

Cases are grouped by year, and you can produce a CSV or PDF report when a hospital, a board or a new employer asks for your numbers.

If you are an NP or a PA, the same log works for the procedures you perform.

It takes a few seconds per case now. It saves the afternoon you would otherwise spend rebuilding the list from memory.

Eric Whitney, DO

### 15. See your coverage on one calendar

Subject: Your coverage, on one calendar
Preview: Add the dates to a contract and they show up in Schedule.

Hi {first_name},

Each contract can hold its coverage dates. Add them once in Contracts and every scheduled block appears in Practice > Schedule.

If you cover more than one hospital, or work under more than one agreement, they all show in the same place.

When the day comes, Work opens on the contract you are scheduled under, so the time you log lands in the right place.

Eric Whitney, DO

### 16. If you are employed

Subject: Employed? Practice is for you too
Preview: Three things worth keeping your own record of.

Hi {first_name},

Practice was first built around locum work, and some of its screens still show that. It is meant for employed clinicians just as much. If you are employed, three things are worth doing:

1. Save your contract in Contracts, with its dates, key terms and the signed copy.
2. Log your work RVUs in the RVU tab as you go.
3. Log your call in Work.

Each contract then shows what you did under it: days worked, total wRVU and cases. That is useful when your productivity report arrives, and again when the contract comes up for renewal.

You can skip Invoices and Expenses entirely.

Eric Whitney, DO

### 17. If you bill for your work

Subject: From the work log to an invoice
Preview: Pick the days, check the preview, send it.

Hi {first_name},

If you work locums or as an independent contractor, the work you logged becomes your invoice.

In Work, choose Invoice, pick the days to bill and check the total. Open the preview and compare the dates, rates and total with your records. Then send it, or copy it into your own message. Invoices are available as PDF, Word or Excel.

Sending or copying marks those entries as billed. Copy alone does not deliver the invoice, so confirm it reached the right person.

Eric Whitney, DO

### 18. Know what is still owed

Subject: Billed is not the same as paid
Preview: Record each payment and see what is still owed.

Hi {first_name},

An invoice that went out is easy to file under "done". Practice > Invoices keeps it open until the money arrives.

When a payment comes in, choose Record payment and enter the amount and date. Partial payments are fine. The invoice shows what has been received and what is still owed.

You record payments yourself. The app does not connect to your bank or your agency.

Eric Whitney, DO

### 19. Expenses and receipts

Subject: Photograph the receipt. Then forget about it.
Preview: Travel and work expenses, with the receipt attached.

Hi {first_name},

Practice > Expenses is for the costs that come with the work: flights, hotels, rental cars and the rest.

Add the amount and vendor and take a photo of the receipt. If the expense is reimbursable, you can put it on an invoice with the receipt attached.

If you are employed and none of this applies to you, leave this tab alone. Nothing else in Practice depends on it.

Eric Whitney, DO

### 20. One record under each contract

Subject: What did you do under this contract?
Preview: Days, wRVUs, cases and payments, in one view.

Hi {first_name},

Tap a contract's name in Contracts. You will see everything logged under it: days worked, total wRVU, the cases you did, and what was billed, collected and is still owed.

That is the point of Practice. Every clinician has a contract, and now you have your own record of the work you did under yours, whether you are a DO, MD, NP or PA, employed or locum.

If something in Practice does not fit the way you work, tell me. Use Get help in the app. I read those.

Eric Whitney, DO

## Other emails that mention Practice

Apply these replacements wherever Practice is described in the other 44 emails.

| Where the email says | Use instead |
| --- | --- |
| "Practice, for locum work" or "for locums docs" | "Practice, for every practicing clinician, employed or locum" |
| "locums contracts, invoices and payments" | "your work, RVUs, contracts and pay" |
| "tools for your locum work" | "tools to track your work, your RVUs and your contract" |
| "log shifts" | "log procedures, shifts and call" |
| "each assignment" | "each contract" |
| "physicians" as the whole audience | "DOs, MDs, NPs and PAs" or "clinicians" |
| "track your bonus" or "calculate your bonus" | "check your wRVU total against your productivity or bonus statement" |

Founder-story lines such as "I'm a neurosurgeon working locums" are Eric's own history and can stay as written.

## Left as is, on purpose

- Help videos, captions and transcripts still say "locum agreement". They are narrated recordings with checksums, so the words can only change by re-recording.
- The /locums title, meta description, keywords and structured data keep their locum search terms.
- Terms and privacy text ("locum work", "Locum and case data") were not touched. That is a legal wording change for Eric to approve separately.
- `src/content/publicLaunch.mjs` was not edited. Its Practice lines are pricing and trial policy, with no locum framing.
- "Locums agency" remains the fallback bill-to name on an expense invoice with no agency entered.
