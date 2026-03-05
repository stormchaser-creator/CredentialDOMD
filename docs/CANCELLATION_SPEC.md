# Cancellation & Data Export Spec

## Philosophy

We don't hold data hostage. When someone leaves, we help them leave well. That earns more trust than any retention popup ever could.

## Flow

### 1. User Cancels Subscription

Trigger: User clicks "Cancel Subscription" in account settings.

**Screen: "Hate to see you go"**

> We understand — and we don't want to leave you hanging.
>
> Your credentials will be available for export for the **next 7 days**. After that, they'll be permanently wiped from our system.
>
> Please download your data before then. And thank you for trusting us with your credentials.

Two buttons:
- **[Export & Download My Data]** (primary, prominent)
- **[I've changed my mind — keep my account]** (secondary, subtle)

### 2. Bulk Export

When user clicks export, generate a ZIP file containing:

**Files:**
- All uploaded credential documents (PDFs, images, scans)
- Organized into folders by credential type:
  ```
  CredentialDOMD_Export/
  ├── Medical_Licenses/
  │   ├── CA_Medical_License_2026.pdf
  │   └── TX_Medical_License_2025.pdf
  ├── DEA_Registration/
  │   └── DEA_Certificate_2026.pdf
  ├── Board_Certifications/
  │   └── ABNS_Certificate_2025.pdf
  ├── Hospital_Privileges/
  │   ├── Eisenhower_Health_2026.pdf
  │   └── Desert_Regional_2025.pdf
  ├── Insurance/
  │   └── Malpractice_Policy_2026.pdf
  ├── CME/
  │   └── CME_Certificates/
  └── credentials_summary.xlsx
  ```

**Spreadsheet (credentials_summary.xlsx):**
| Credential | Type | Issuing Authority | License/Cert # | Issue Date | Expiration Date | Status | State | Notes |
|---|---|---|---|---|---|---|---|---|
| Medical License | License | CA Medical Board | A12345 | 2024-01-15 | 2026-01-15 | Active | CA | — |

Include ALL credential data: dates, numbers, authorities, status, renewal history, CME hours, everything.

### 3. 7-Day Grace Period

- Subscription access ends immediately (no more active tracking/alerts)
- Data remains accessible in read-only mode for 7 days
- User can re-download the export ZIP during this period
- Daily reminder email on days 1, 3, 5, 7:
  - Day 1: "Your data is ready to download"
  - Day 3: "4 days left to export your credentials"
  - Day 5: "2 days left — don't forget your data"
  - Day 7: "Last day — your data will be permanently deleted tomorrow"

### 4. Permanent Deletion (Day 8)

- All user data wiped from Supabase
- All uploaded files deleted from storage
- User record anonymized (keep aggregate analytics only)
- Confirmation email: "Your data has been permanently deleted. If you ever need us again, we'll be here."

### 5. Re-subscription

If user comes back:
- Fresh start, no old data
- But if they re-subscribe within the 7-day window, full restore — cancel the deletion
- Welcome back message: "Good to have you back. Everything's right where you left it."

## Technical Notes

- ZIP generation: server-side (Supabase Edge Function or separate worker)
- Max export size: handle large credential portfolios (100+ docs)
- XLSX generation: use a lightweight library (SheetJS/xlsx)
- Deletion: hard delete, not soft — GDPR-style permanent removal
- Audit log: record deletion event for compliance, but no user data in the log

## Founding Member Badge

Founding members get a permanent badge/icon in their dashboard — visible to them as a mark of early trust. Something like a shield with a star, or an emerald gem with "Founding Member" text.

- Badge appears next to their name in the dashboard header
- Visible on their profile
- Never removed, even if they upgrade/downgrade later
- Could unlock future perks (beta features, direct feedback channel, etc.)
- The badge says: "You believed in us before anyone else did."

---

## Why This Matters

1. **Trust signal:** "We care more about your data than your subscription"
2. **Word of mouth:** People tell others when a company treats them well on the way out
3. **Regulatory alignment:** GDPR right-to-erasure, CCPA deletion rights — we exceed the minimum
4. **Competitive differentiation:** Try exporting your data from Mockingbird. Good luck.
