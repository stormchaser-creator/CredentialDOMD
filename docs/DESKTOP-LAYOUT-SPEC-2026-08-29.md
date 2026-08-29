# CredentialDOMD Desktop Layout Spec

Date: 2026-08-29
Status: DRAFT, awaiting Eric's approval. This document specifies; it does not ship code.
Mandate: one codebase. Desktop is responsive layout inside the existing React app. There is no second product, no fork, no desktop-only page tree.

---

## 1. The Shape

### Breakpoint

One breakpoint: **1024px**.

- Below 1024px: the app renders exactly as it does today. Phone layout, bottom tabs, 480px column, card lists, modals. Pixel for pixel unchanged. Tablets in portrait (768 to 1023px) get the phone layout in v1.
- At 1024px and up: sidebar shell, widened content, tables where scanning matters.

The dormant scaffold in `src/styles/base.css` (lines 412 to 556) switches at 768px with an 840px content max. This spec adopts the scaffold but moves its switch to 1024px and raises the content max (below). Those two constants change; the rest of the scaffold mounts as written.

### Mechanism

Styling is ~99% inline style objects reading theme tokens (`T.*` from `src/constants/themes.js`), so CSS media queries cannot restyle most components. The responsive mechanism is therefore:

1. An `isDesktop` boolean (window width >= 1024, resize listener) exposed from AppContext. `shared/SideNav.jsx` already implements this exact pattern at lines 18 to 24; the flag moves to context so any component can branch.
2. The existing `cmd-*` CSS utility layer (`.cmd-app-layout`, `.cmd-sidebar`, `.cmd-content-area`, `.cmd-responsive-grid-2/-3`) for structural layout, since structure does not need theme tokens.
3. Components branch on `isDesktop` only where the desktop presentation differs (table vs cards, grid vs stack). Everything else renders one way.

No theme-token migration to CSS variables is required. The font-size zoom (`FONT_ZOOM`, App.jsx:1998) stays; desktop widths are maxima, not fixed widths, so zoom is tolerated.

### Shell

Mount `shared/SideNav.jsx` (written, exported, currently imported nowhere) and retire the inline bottom bar at desk width.

```
+---------------------------------------------------------------+
| SIDEBAR (240px)   | TOP BAR: page title, bell, theme toggle   |
| logo              |-------------------------------------------|
| Home              |                                           |
| Credentials       |   CONTENT AREA                            |
| Documents         |   max-width 1140px, centered              |
| Practice / Team   |   (840px on reading pages)                |
| More              |                                           |
|                   |                                           |
| profile footer    |                                           |
+---------------------------------------------------------------+
```

- Sidebar destinations are the same five the bottom bar has today, including the plan-dependent slot 4 (Practice for locum, Team otherwise). The "Add" center FAB becomes the Documents entry it already navigates to.
- The top bar keeps its current contents and spans the content area. "Back" appears for subPages exactly as today, except where a rail (below) makes it unnecessary.
- Content width: **1140px max** for working screens (tables, dashboard grid), **840px max** for reading pages (Settings, FAQ, Legal, Vera, CV). The 480px cap at App.jsx:2004 lifts only when `isDesktop` is true.
- Auth, beta gate, and Onboarding full-screens are unchanged at any width.

### Where list+detail panes appear (and where they do not)

**One pane pattern ships: the Credentials section rail.** The 17-row grouped menu (App.jsx:1427-1454) becomes a persistent left column inside the Credentials tab; the selected section renders beside it. This is second-level navigation, not record detail, and it removes two taps per section switch.

```
+------------------+------------------------------------------+
| ACTIVE           |                                          |
|  Licenses    <== |   Selected section content               |
|  State Matrix    |   (CrudSection list or table)            |
|  Privileges*     |                                          |
| CONTINUING ED    |                                          |
|  CME             |                                          |
|  Find CME        |                                          |
| ...14 more...    |                                          |
+------------------+------------------------------------------+
```

**Record-level split panes are explicitly rejected.** Lists here hold dozens of records, not hundreds; the research is clear that synced list+detail selection state earns its cost at triage scale, not this scale. Record view and edit stay in `shared/Modal.jsx` overlays. At desk width modals widen (default 520 -> 720 for record forms) and long single-column forms flow short related fields (dates, state, cost) into two columns. Same fields, same validation, same component.

### The table pattern

Screens whose records are line items render as a true table at desk width and keep their card renderer on phone. One shared desk-table component serves all of them: sticky header, column sort, status cell, row click opens the existing view modal, row-level quick actions (the functions already exist as card buttons). No inline cell editing, no column management, no saved views, no density toggles.

```
+---------------------------------------------------------+
| Section title                              [ + Add ]    |
|---------------------------------------------------------|
| Col v | Col | Col | Col | Col | Status | Actions        |
|-------|-----|-----|-----|-----|--------|----------------|
| ..... | ... | ... | ... | ... |  dot   | [view] [send]  |
| ..... | ... | ... | ... | ... |  dot   | [view] [send]  |
+---------------------------------------------------------+
        row click -> existing view Modal, widened
```

### Dashboard shape

Home keeps its content and order but arranges into the existing `.cmd-responsive-grid` classes at desk width:

```
+------------------------------+------------------------------+
| Compliance Ring + stat tiles | Action Required              |
| (hero)                       | (vertical list, full cards,  |
|                              |  no horizontal snap scroll)  |
+------------------------------+------------------------------+
| CME state card  | CME state card  | CME state card          |
+-----------------+-----------------+-------------------------+
| Board cert card | Board cert card | Credentials preview     |
+-----------------+-----------------+-------------------------+
```

### What stays identical at every width

Auth flow, onboarding, beta gate, navigation model (tab + subPage state, no router), deep links from Vera and search, all modals and their logic, the theme system, notifications, and every screen not named in this spec (Documents, Share, Team, Settings, Admin, Vera, CV, Data Export, FAQ, Legal, Requests). They render wider inside the shell and nothing else.

---

## 2. Screen by Screen

### 2.1 Home dashboard (App.jsx renderHome, 487-1367)

- **Mobile today:** single stacked column: search, banners, checklist, Compliance Ring hero, gap cards, Action Required horizontal snap-scroll (240px cards), acknowledged list, locum To-do, Credentials preview, CME state cards, board cards, all-clear card. Math breakdowns open modals.
- **Desktop proposed:** two-column top (hero + stats left, Action Required as a vertical list right), then CME state cards three across, board cards three across, Credentials preview beside them. Search stays full width on top. The snap-scroll idiom disappears at desk; every action card is visible without scrolling sideways. CME math and board math stay as modals.
- **Table:** none. This screen is a glance-and-jump grid, not a ledger.

### 2.2 Licenses (App.jsx:1456-1497 + CrudSection.jsx:846-947)

- **Mobile today:** NPI-import banner, filter tabs, then one card per license with type, state, number, cost, and expiration mashed into a title plus dot-joined sub-line.
- **Desktop proposed:** banner and filter tabs unchanged above a license table. Row click opens the existing view modal; edit opens the existing edit modal (widened, two-column).
- **Table columns:** Status (dot) | Type | State | License number | Issued | Expires | Renewal cost | Actions (view, share). Default sort: Expires ascending, because expiration scanning is the job.

### 2.3 CME (CMESection.jsx:266-573)

- **Mobile today:** per-state compliance cards with progress bars, then stacked entry cards (title, category, hours, provider, date, topics, certificate link).
- **Desktop proposed:** compliance cards in a two- or three-across grid at top, entries table below, grouped by cycle window so the rows audit against the same math the compliance cards show. The transcript PDF already lays entries out as rows; the screen catches up to its own export.
- **Table columns:** Date | Title | Category | Hours | Provider | Topics | Certificate (link icon) | Actions. Default sort: Date descending within cycle grouping.

### 2.4 Work log (locum/WorkLog.jsx, 1857 lines)

- **Mobile today:** timer/capture card, then day-grouped entry cards each carrying date, type, billed span, logged and billed minutes, amount, invoice status, edit and delete. Entry detail, invoice day-picker, and invoice preview are modals. The invoice preview modal already renders a real `<table>` (WorkLog.jsx:1614-1652).
- **Desktop proposed:** timer/capture card stays pinned at top, full width. Below it, an entries table with a subtotal row per day (logged min, billed min, amount). Invoice building keeps its modal flow unchanged; the preview table finally matches the list above it.
- **Table columns:** Date | Type | Billed span | Logged min | Billed min | Amount | Invoice status | Actions (edit, delete). Day subtotal rows bold the three numeric columns.
- **Scope note:** contracts on the day-rate DutyLog engine keep their card layout in v1 (open question 5).

### 2.5 Invoices (locum/Invoices.jsx)

- **Mobile today:** outstanding/paid tiles (lines 258-276), then one card per invoice; invoice detail and payment recording are chained modals (332-455) with a mini-list of per-invoice rows inside a modal (279-330).
- **Desktop proposed:** tiles stay as a row of stat tiles; the list becomes a classic AR table. Row click opens the existing invoice detail modal with payment history and the record-payment form, unchanged.
- **Table columns:** Number | Bill to | Sent | Age (days) | Paid date | Balance | Status | Actions (record payment, open). Status colored with existing T status tokens. Default sort: unpaid first, then Age descending, so the oldest receivable is on top.

### 2.6 Tax prep (locum/TaxPrep.jsx:201-330)

- **Mobile today:** per-state income and estimate figures as stacked mini-cards, and the estimated-payments ledger as more stacked cards. StatementImport embedded.
- **Desktop proposed:** two tables. StatementImport and any explanatory copy unchanged around them.
- **Table 1, income by jurisdiction:** Jurisdiction | Income | Est. federal | Est. state | Paid | Remaining. Totals row at bottom.
- **Table 2, payments ledger:** Date | Jurisdiction | Amount | Note | Actions (edit, delete). Default sort: Date descending.

---

## 3. What Does Not Change

- **The phone experience. Untouched.** Below 1024px every screen renders exactly as it does today. Card renderers are not modified; table renderers are additive branches behind `isDesktop`. If the flag is false the new code paths never execute.
- **Components and their logic.** CrudSection field configs, validation, view/edit modals, Modal.jsx, CMESection math, WorkLog timer and invoice builder, Invoices payment flow, TaxPrep calculations. Desktop rearranges where output renders; it does not touch what is computed or saved.
- **The data layer.** No schema changes, no new endpoints, no storage changes. Tables read the same record arrays the cards read.
- **Navigation model.** tab + subPage state, no router, no URLs. The sidebar and the Credentials rail set the same two state vars the bottom bar and menu set today. Vera and search deep links (handleNavigate) work unchanged.
- **Auth, beta gating, onboarding, plan gating.** Pro-gated sections stay gated; locum-plan branching (slot 4, To-do widget) stays as is.
- **Theme system and font zoom.** T.* tokens, toggleTheme, FONT_ZOOM all untouched.
- **Skipped by decision, not omission:** command palette, single-letter shortcut vocabulary, record-level split panes, spreadsheet inline editing, column management, saved views, density toggles. Each is team-scale or daily-use machinery; this is a few-sessions-per-month professional tool. The rejections follow the pattern research and keep the solo-maintenance surface small.

---

## 4. Build Plan

Each increment is shippable alone; the app is releasable after every row. Estimates are focused solo+Claude sessions (a session is roughly a half day). Eric can reorder screens 4 through 9 by his own usage without breaking anything.

| # | Increment | Contents | Est. |
|---|-----------|----------|------|
| 1 | Shell | `isDesktop` in AppContext; mount SideNav; hide bottom bar at desk; lift the 480px cap; content max widths (1140/840); move scaffold constants 768 -> 1024 and 840 -> 1140; verify FONT_ZOOM and both themes | 2 sessions |
| 2 | Credentials rail | credGroups as persistent left column inside the Credentials tab; Back button suppressed there at desk | 1 session |
| 3 | Desk table component + Licenses | Shared table (sticky header, sort, status cell, row actions, day/group subtotal support); Licenses first consumer | 2 sessions |
| 4 | Invoices | Tiles row + AR table | 1 session |
| 5 | Work log | Entries table with day subtotals; pinned timer; DutyLog contracts excluded | 2 sessions |
| 6 | Home grid | Two-column top, card grids, snap-scroll retired at desk | 1 session |
| 7 | CME | Compliance card grid + entries table with cycle grouping | 1 session |
| 8 | Tax prep | Two tables | 1 session |
| 9 | Forms + keys | Widened modals with two-column field flow; keyboard minimums: `/` focuses search, `Esc` closes modals (audit existing), `n` opens Add on list screens | 1 session |

Total: about 12 sessions. Increment 1 alone already converts the desktop from a phone column centered on a monitor into a real desk shell; everything after it is compounding value. After increment 3 the table component makes each remaining screen a configuration exercise. Later candidates, not in this plan: Multi-State Matrix as a true states-by-credentials grid, RVU log table, case logs table, DutyLog table.

---

## 5. Open Questions for Eric

1. **Tablet band.** 768 to 1023px gets the phone layout in v1. iPad landscape (1024+) gets the desk shell. Acceptable, or does iPad portrait matter enough to pull the breakpoint down to 768?
2. **Content width.** 1140px max for working screens, centered. Or do you want tables fluid to the full window on big monitors? 1140 is the recommendation; full-fluid rows get hard to scan.
3. **Credentials rail.** Ship it (increment 2), or keep the tap-through menu at all widths and save a session? The rail is the only navigational change desktop makes.
4. **Sidebar promotions.** The sidebar mirrors the five bottom-bar destinations. Should any More items get their own sidebar entries at desk (Vera, Finance, CV)? Default: no, More stays the container.
5. **DutyLog contracts.** Day-rate work logs keep cards in v1. Convert them in increment 5 as well (adds roughly a session), or defer?

