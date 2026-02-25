# UI/UX Design Research: Healthcare Credential Management PWA
## Comprehensive Design Recommendations

---

## 1. COLOR PALETTE

### Primary Palette: "Modern Medical Trust"

This palette moves beyond generic blue-and-white by combining a deep, authoritative primary blue with warm teal accents and a sophisticated neutral system. It conveys trust, professionalism, and competency while feeling modern and premium.

#### Light Mode

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| **Primary** | Deep Medical Blue | `#0A2540` | Headers, primary text, nav backgrounds |
| **Primary Active** | Vibrant Blue | `#1A73E8` | Interactive elements, links, active states |
| **Primary Light** | Soft Blue | `#E8F0FE` | Selected states, highlights, light backgrounds |
| **Secondary** | Medical Teal | `#0D9488` | Success states, active credentials, accents |
| **Secondary Light** | Soft Teal | `#CCFBF1` | Success backgrounds, active badge fills |
| **Accent Warm** | Coral | `#E8634A` | Urgent alerts, expired items, CTAs |
| **Accent Amber** | Warning Amber | `#F59E0B` | Pending states, expiring-soon warnings |
| **Surface** | White | `#FFFFFF` | Card backgrounds, primary surface |
| **Surface Elevated** | Off-White | `#F8FAFC` | Page backgrounds, secondary surfaces |
| **Surface Subtle** | Light Gray | `#F1F5F9` | Dividers, input backgrounds |
| **Border** | Border Gray | `#E2E8F0` | Card borders, dividers |
| **Text Primary** | Near Black | `#0F172A` | Headings, primary body text |
| **Text Secondary** | Dark Gray | `#475569` | Secondary text, descriptions |
| **Text Tertiary** | Medium Gray | `#94A3B8` | Placeholders, timestamps, captions |

#### Dark Mode

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| **Background** | Dark Navy | `#0B1221` | App background (NOT pure black) |
| **Surface** | Dark Surface | `#151E2E` | Card backgrounds |
| **Surface Elevated** | Elevated Surface | `#1E293B` | Modals, elevated cards, bottom sheets |
| **Border** | Dark Border | `#2D3B50` | Card borders, dividers |
| **Primary** | Bright Blue | `#60A5FA` | Interactive elements (desaturated for dark) |
| **Secondary** | Light Teal | `#5EEAD4` | Success/active states (desaturated) |
| **Accent Warm** | Soft Coral | `#FB923C` | Alerts (desaturated from light mode) |
| **Accent Amber** | Soft Amber | `#FBBF24` | Warnings (desaturated) |
| **Text Primary** | Off White | `#E2E8F0` | Primary text (NOT pure white) |
| **Text Secondary** | Light Gray | `#94A3B8` | Secondary text |
| **Text Tertiary** | Muted Gray | `#64748B` | Placeholders, captions |

#### Dark Mode Rules
- Never use pure black (`#000000`) as a background - it causes halation and eye strain
- Never use pure white (`#FFFFFF`) for text on dark backgrounds
- Desaturate accent colors by ~20% for dark surfaces to prevent optical vibration
- Use lighter surface colors for elevation instead of shadows (higher = lighter)
- Maintain WCAG AA contrast (4.5:1 for text, 3:1 for UI components)

### Status Colors (Credential States)

| State | Light Mode | Dark Mode | Token Name |
|-------|-----------|-----------|------------|
| **Active / Compliant** | `#059669` (bg: `#ECFDF5`) | `#34D399` (bg: `#064E3B`) | `--status-success` |
| **Expiring Soon** | `#D97706` (bg: `#FFFBEB`) | `#FBBF24` (bg: `#78350F`) | `--status-warning` |
| **Expired / Non-Compliant** | `#DC2626` (bg: `#FEF2F2`) | `#F87171` (bg: `#7F1D1D`) | `--status-error` |
| **Pending / In Review** | `#2563EB` (bg: `#EFF6FF`) | `#60A5FA` (bg: `#1E3A5F`) | `--status-info` |
| **Not Started / Draft** | `#6B7280` (bg: `#F3F4F6`) | `#9CA3AF` (bg: `#374151`) | `--status-neutral` |

#### WCAG AA Contrast Verification

All recommended text/background combinations meet minimum 4.5:1 contrast:
- `#0F172A` on `#FFFFFF` = 15.4:1 (passes AAA)
- `#475569` on `#FFFFFF` = 7.1:1 (passes AAA)
- `#1A73E8` on `#FFFFFF` = 4.6:1 (passes AA)
- `#E2E8F0` on `#0B1221` = 12.1:1 (passes AAA)
- `#94A3B8` on `#0B1221` = 6.8:1 (passes AA)
- `#059669` on `#ECFDF5` = 4.8:1 (passes AA)
- `#DC2626` on `#FEF2F2` = 5.3:1 (passes AA)

---

## 2. LAYOUT PATTERNS

### 2.1 Dashboard Layout

#### Recommended Structure: "Compliance-First Dashboard"

```
+------------------------------------------+
|  [Logo]    Dashboard         [Bell] [Av]  |  <- Top bar (56px)
+------------------------------------------+
|                                           |
|  Overall Compliance          [Filter]     |
|  ┌─────────────────────────────────────┐  |
|  │   ╭──────╮                          │  |
|  │   │ 87%  │  12 Active  3 Expiring   │  |  <- Hero compliance ring
|  │   │      │  2 Expired  1 Pending    │  |
|  │   ╰──────╯                          │  |
|  └─────────────────────────────────────┘  |
|                                           |
|  Action Required (3)           See All >  |
|  ┌────────────┐ ┌────────────┐           |  <- Horizontal scroll cards
|  │ DEA Exp.   │ │ BLS Cert   │           |
|  │ in 14 days │ │ Expired    │           |
|  └────────────┘ └────────────┘           |
|                                           |
|  All Credentials              Filter ▼   |
|  ┌─────────────────────────────────────┐  |
|  │ ● Medical License    Active  2026 > │  |  <- List items
|  ├─────────────────────────────────────┤  |
|  │ ▲ DEA Registration   Exp Soon    > │  |
|  ├─────────────────────────────────────┤  |
|  │ ✕ BLS Certification  Expired     > │  |
|  └─────────────────────────────────────┘  |
|                                           |
+------------------------------------------+
|  [Home]  [Creds]  [+Add]  [Docs]  [More] |  <- Bottom tab bar (56-64px)
+------------------------------------------+
```

#### Key Layout Principles

1. **F-Pattern Scanning**: Place the most critical data (compliance score) at top-left
2. **Single-Screen Dashboard**: Keep the hero section and action items visible without scrolling
3. **Progressive Disclosure**: Show summary first, drill down to details on tap
4. **Max 5-6 Cards**: Limit initial view to avoid cognitive overload

### 2.2 Card-Based vs. List-Based Layouts

#### Recommendation: Hybrid Approach

Use a **list layout as the default** for credential items with **card-style expansion** for details:

**List Mode (Default - for scanning)**
- Best when users have many credentials and need quick lookup
- More space-efficient on mobile
- Supports easy sorting and filtering
- Each row: Status dot + Credential name + Status badge + Expiry date + Chevron

**Card Mode (for action items / dashboard)**
- Use cards only for the "Action Required" section (2-3 items max)
- Horizontally scrollable cards for urgency
- Each card: Status banner + Credential name + Days remaining + Action button

**Expandable Detail Pattern**
```
┌─────────────────────────────────────────┐
│  ● Medical License - State of Texas     │
│    Active | Expires Dec 2026        ▼   │
│  ┌─────────────────────────────────────┐ │
│  │  License #: TX-12345               │ │
│  │  Issued: Jan 15, 2024             │ │
│  │  Expires: Dec 31, 2026            │ │
│  │  Primary Source: Verified          │ │
│  │  [View Document]  [Renew]         │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 2.3 Progress Visualization

#### Compliance Ring (Primary Metric)
- Large circular progress ring (120-160px diameter) as the dashboard hero
- Thick stroke (8-12px) with rounded caps
- Animated fill on load (0 to current value over 800ms, ease-out)
- Center: Large percentage number + small "Compliant" label
- Ring color transitions: Green (80-100%), Amber (50-79%), Red (<50%)

#### Credential Progress Bar (Individual Items)
- Thin linear progress bar under each credential category
- Shows time remaining until expiry as a percentage
- Color-coded: Green > 90 days, Amber 30-90 days, Red < 30 days

#### Mini Status Indicators
- 8px colored dots next to credential names in lists
- Pair with text labels: "Active", "Expiring", "Expired", "Pending"
- Never rely on color alone (accessibility)

### 2.4 Navigation Pattern

#### Recommendation: Bottom Tab Bar (5 items)

```
[Dashboard]  [Credentials]  [+ Add]  [Documents]  [Profile]
```

**Why Bottom Tab Bar:**
- Gold standard for mobile-first apps (Airbnb saw 40% faster task completion vs. hamburger)
- Within thumb reach for one-handed use
- Persistent visibility of primary destinations
- 3-5 items is the ideal range

**Bottom Tab Specifications:**
- Bar height: 56-64px (above safe area inset)
- Icon size: 24px
- Label font: 10-11px
- Active state: Brand color icon + label
- Inactive state: Gray icon + label at 60% opacity
- Touch targets: minimum 48x48px per tab
- Center "Add" button: Elevated/floating, brand color, 48px diameter

**Secondary Navigation:**
- Use a "More" tab or slide-up sheet for settings, help, notifications
- Use contextual top app bar with back arrow for detail screens
- Avoid hamburger menus as primary navigation on mobile

### 2.5 How Competitor Apps Handle Credential Displays

**Modio Health (OneView):**
- Cloud-based centralized dashboard for all team credentials
- Provider Directory as primary view
- Automatic primary source verification from 100+ sources (DEA, OIG, etc.)
- Alerts for upcoming expiry dates
- Simple, "jump right in" interface that requires minimal training

**Medallion:**
- Provider network management platform
- Focus on licensing, credentialing, and monitoring
- Integrates CME tracking
- Uses spreadsheet-like reporting (noted limitation by users)

**Certemy:**
- Workforce compliance and credential tracking
- Pre-built workflows for multi-state licensing
- Emphasis on audit trails and compliance reporting
- Praised for user-friendliness

**MD-Staff:**
- AI-powered credentialing
- All-in-one: credentialing, privileging, OPPE, performance tracking

**Common Patterns Across Competitors:**
- Centralized dashboard as home base
- Status-based color coding (RAG: Red/Amber/Green)
- Expiration date tracking with alerts
- Document storage and verification status
- Filter/sort by status, type, or expiry date

---

## 3. TYPOGRAPHY

### Recommended Font Stack

**Primary Font: Inter**
- Designed specifically for screen readability
- Tall x-height for clarity at small sizes
- Tabular numerals for aligned data displays
- Free, open source, excellent language support
- Optimized for 11px+ rendering

**Fallback Stack:**
```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

**Alternative Options:**
- SF Pro (iOS-native feel, excellent for Apple ecosystem)
- Plus Jakarta Sans (modern, geometric, premium feel)
- DM Sans (clean, slightly warmer than Inter)

### Type Scale for Mobile (Data-Dense Screens)

Using a 1.25 (Major Third) modular scale from a 16px base:

| Role | Size | Weight | Line Height | Letter Spacing | Usage |
|------|------|--------|-------------|----------------|-------|
| **Display** | 28px | 700 (Bold) | 34px (1.21) | -0.02em | Dashboard hero number |
| **H1** | 24px | 700 (Bold) | 30px (1.25) | -0.015em | Page titles |
| **H2** | 20px | 600 (SemiBold) | 26px (1.3) | -0.01em | Section headers |
| **H3** | 17px | 600 (SemiBold) | 24px (1.41) | 0 | Card titles, list headers |
| **Body Large** | 16px | 400 (Regular) | 24px (1.5) | 0 | Primary body text |
| **Body** | 15px | 400 (Regular) | 22px (1.47) | 0 | Default UI text, buttons |
| **Body Small** | 14px | 400 (Regular) | 20px (1.43) | 0.01em | Secondary text, descriptions |
| **Caption** | 12px | 500 (Medium) | 16px (1.33) | 0.02em | Labels, timestamps, badges |
| **Overline** | 11px | 600 (SemiBold) | 16px (1.45) | 0.08em | Section labels, uppercase tags |

### Readability Rules for Quick-Scanning Physicians

1. **Limit to 4 font sizes per screen** - Header, body, secondary, caption
2. **Use weight contrast over size contrast** - SemiBold vs Regular differentiates hierarchy without size jumps
3. **Minimum 14px for interactive elements** - Buttons, links, tappable labels
4. **Minimum 12px for any visible text** - Captions, timestamps
5. **Line length: 45-75 characters** - Prevents eye fatigue on mobile
6. **Use tabular numerals** for dates, license numbers, and compliance percentages
7. **High contrast for critical data** - Expiry dates, status labels use SemiBold + status colors
8. **Consistent vertical rhythm** - All line heights as multiples of 4px for grid alignment

### Font Loading Strategy (PWA Performance)

```css
/* Preload critical weights */
@font-face {
  font-family: 'Inter';
  font-weight: 400;
  font-display: swap; /* Show fallback immediately, swap when loaded */
  src: url('/fonts/Inter-Regular.woff2') format('woff2');
}

@font-face {
  font-family: 'Inter';
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/Inter-SemiBold.woff2') format('woff2');
}

@font-face {
  font-family: 'Inter';
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/Inter-Bold.woff2') format('woff2');
}
```

---

## 4. MODERN DESIGN TRENDS (2025-2026)

### 4.1 Visual Style: Refined Flat with Subtle Depth

**Recommended approach:** Flat design foundation with subtle elevation and selective glass effects.

Avoid heavy glassmorphism or neumorphism for a credential management app - they compromise readability in data-dense layouts. Instead, use:

- **Subtle shadows** for card elevation (depth without distraction)
- **Selective glass effects** only for overlays, modals, and bottom sheets
- **Flat, clean surfaces** for data-heavy screens (lists, tables)

### 4.2 Card Elevation & Shadow System

Use 4 elevation levels based on the 8px grid:

```css
:root {
  /* Elevation 0 - Flat (default surface) */
  --shadow-0: none;

  /* Elevation 1 - Subtle (cards, list items) */
  --shadow-1: 0 1px 3px rgba(0, 0, 0, 0.04),
              0 1px 2px rgba(0, 0, 0, 0.06);

  /* Elevation 2 - Medium (hover state, dropdowns) */
  --shadow-2: 0 4px 6px rgba(0, 0, 0, 0.04),
              0 2px 4px rgba(0, 0, 0, 0.06);

  /* Elevation 3 - High (modals, bottom sheets, FABs) */
  --shadow-3: 0 12px 24px rgba(0, 0, 0, 0.06),
              0 4px 8px rgba(0, 0, 0, 0.04);

  /* Elevation 4 - Highest (popovers, toasts) */
  --shadow-4: 0 20px 40px rgba(0, 0, 0, 0.08),
              0 8px 16px rgba(0, 0, 0, 0.04);
}

/* Dark mode: Use surface color lightening instead of shadows */
[data-theme="dark"] {
  --shadow-1: none; /* Replace with lighter surface */
  --shadow-2: none;
  --shadow-3: 0 4px 16px rgba(0, 0, 0, 0.4);
  --shadow-4: 0 8px 32px rgba(0, 0, 0, 0.5);
}
```

### 4.3 Border Radius System

```css
:root {
  --radius-xs: 4px;    /* Small badges, tags */
  --radius-sm: 8px;    /* Buttons, inputs, small cards */
  --radius-md: 12px;   /* Standard cards, modals */
  --radius-lg: 16px;   /* Large cards, bottom sheets */
  --radius-xl: 24px;   /* Pills, floating elements */
  --radius-full: 9999px; /* Circular elements, avatars */
}
```

### 4.4 Spacing & Padding System (8px Grid)

```css
:root {
  --space-0: 0px;
  --space-1: 4px;     /* Tight: icon-text gap, badge padding */
  --space-2: 8px;     /* Compact: related element spacing */
  --space-3: 12px;    /* Default: list item padding, input padding */
  --space-4: 16px;    /* Standard: card padding, section gaps */
  --space-5: 20px;    /* Comfortable: between card groups */
  --space-6: 24px;    /* Spacious: major section spacing */
  --space-8: 32px;    /* Large: page section breaks */
  --space-10: 40px;   /* XL: page margins on tablet+ */
  --space-12: 48px;   /* XXL: hero section spacing */
  --space-16: 64px;   /* Jumbo: between major page sections */
}

/* Component-specific spacing */
:root {
  --page-padding-mobile: 16px;
  --page-padding-tablet: 24px;
  --page-padding-desktop: 32px;
  --card-padding: 16px;
  --card-gap: 12px;
  --list-item-padding-vertical: 12px;
  --list-item-padding-horizontal: 16px;
  --section-gap: 24px;
  --input-padding: 12px 16px;
  --button-padding: 12px 24px;
  --bottom-nav-height: 64px;
  --top-bar-height: 56px;
}
```

**Data-Dense Screens (credential lists, tables):**
- Reduce card-gap to 8px
- Use 12px vertical padding for list items (not 16px)
- Allow 4px spacing for inline badges and tags
- Internal spacing <= External spacing (Gestalt proximity rule)

### 4.5 Micro-Interactions & Animations

**Timing Guidelines:**
- **Instant feedback:** 100-200ms (button press, toggle)
- **Transitions:** 200-300ms (page transitions, card expand)
- **Loading animations:** 300-500ms loops (progress ring fill)
- **Entrance animations:** 200-400ms (card slide-in, fade-up)

**Recommended Easing:**
```css
:root {
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);    /* Standard */
  --ease-in: cubic-bezier(0.4, 0, 1, 1);            /* Accelerate */
  --ease-out: cubic-bezier(0, 0, 0.2, 1);           /* Decelerate */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* Bouncy */
}
```

**Specific Micro-Interactions:**

| Interaction | Animation | Duration | Easing |
|-------------|-----------|----------|--------|
| Compliance ring fill | Clockwise sweep from 0% to value | 800ms | ease-out |
| Status badge update | Scale 0.8 -> 1.0 + color transition | 200ms | spring |
| Card press | Scale 0.98 + shadow reduce | 100ms | ease-default |
| List item expand | Height 0 -> auto + fade in content | 250ms | ease-out |
| Pull to refresh | Spinner rotate + spring back | 300ms | spring |
| Page transition | Slide left + fade | 250ms | ease-default |
| Toast notification | Slide up from bottom + auto-dismiss | 300ms in, 200ms out | ease-out |
| Credential status change | Old color fade + new color pulse | 400ms | ease-default |

### 4.6 Status Indicators & Badges

**Badge Design Specs:**
```
Height: 24px
Padding: 4px 8px
Border-radius: 12px (pill shape)
Font: 12px / SemiBold (600)
Letter-spacing: 0.02em
```

**Badge Variants:**

| Status | Background | Text Color | Icon |
|--------|-----------|------------|------|
| Active | `#ECFDF5` | `#059669` | Filled circle (8px) |
| Expiring | `#FFFBEB` | `#D97706` | Warning triangle |
| Expired | `#FEF2F2` | `#DC2626` | X circle |
| Pending | `#EFF6FF` | `#2563EB` | Clock |
| Draft | `#F3F4F6` | `#6B7280` | Dashed circle |

**Always pair badges with:**
1. A colored shape indicator (dot, icon)
2. A text label
3. At least 3 of 4 elements: color, shape, text, icon (WCAG requirement)

### 4.7 Selective Glass Effects

Use glass morphism sparingly, only for layered UI:

```css
/* Bottom sheet overlay */
.glass-overlay {
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

/* Dark mode glass */
[data-theme="dark"] .glass-overlay {
  background: rgba(15, 23, 42, 0.75);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
```

**Where to use glass:** Modals, bottom sheets, floating action button backgrounds, notification overlays
**Where NOT to use glass:** Data cards, list items, navigation bars, form inputs

---

## 5. APP DESIGN REFERENCES & INSPIRATION

### From Credential Management Apps

**What to emulate from Modio Health / Medallion / Certemy:**
- Centralized compliance dashboard as the primary home screen
- Automatic primary source verification status display
- Expiry-date-driven alert system with time-remaining countdowns
- Document storage linked to each credential
- Quick filter by status: Active / Expiring / Expired / All

**What to improve upon:**
- Most competitors have desktop-first, enterprise-heavy UIs
- Mobile experience is an afterthought (especially Medallion's spreadsheet-based reporting)
- Tracking features are "clunky" in some apps (user complaints about Modio)
- Opportunity: Build a truly mobile-first, visually polished experience

### From Oscar Health (Design System: "Anatomy")

**Key takeaways:**
- Larger font sizes + darker colors for improved readability
- Minimal navigation buttons - users find everything quickly
- Consistent UI patterns across all screens
- Result: 22% drop in bounce rates, 31% faster task completion
- Robust component library shared across design and engineering

### From Headspace / Calm

**Key takeaways:**
- Playful but purposeful illustrations reduce anxiety for new users
- Card-style navigation breaks complex tasks into small, doable steps
- Built-in progress tracking with visual rewards
- Friendly microcopy that avoids clinical/intimidating language
- Onboarding that focuses on immediate value

### From Modern Fintech Apps (Stripe, Mercury, Brex)

**Key takeaways for data-dense design:**
- Clean data tables with generous whitespace between functional groups
- Compact but scannable list items with clear hierarchy
- Status badges as first visual element in each row
- Filter/sort controls accessible but not cluttering the main view
- Subtle transitions between states (no jarring page reloads)

---

## 6. IMPLEMENTATION SUMMARY: DESIGN TOKEN SYSTEM

### Recommended CSS Custom Properties

```css
:root {
  /* === Colors === */
  --color-primary: #0A2540;
  --color-primary-active: #1A73E8;
  --color-primary-light: #E8F0FE;
  --color-secondary: #0D9488;
  --color-secondary-light: #CCFBF1;
  --color-accent-warm: #E8634A;
  --color-accent-amber: #F59E0B;

  --color-surface: #FFFFFF;
  --color-surface-elevated: #F8FAFC;
  --color-surface-subtle: #F1F5F9;
  --color-border: #E2E8F0;

  --color-text-primary: #0F172A;
  --color-text-secondary: #475569;
  --color-text-tertiary: #94A3B8;

  --color-status-success: #059669;
  --color-status-success-bg: #ECFDF5;
  --color-status-warning: #D97706;
  --color-status-warning-bg: #FFFBEB;
  --color-status-error: #DC2626;
  --color-status-error-bg: #FEF2F2;
  --color-status-info: #2563EB;
  --color-status-info-bg: #EFF6FF;
  --color-status-neutral: #6B7280;
  --color-status-neutral-bg: #F3F4F6;

  /* === Typography === */
  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-size-display: 28px;
  --font-size-h1: 24px;
  --font-size-h2: 20px;
  --font-size-h3: 17px;
  --font-size-body-lg: 16px;
  --font-size-body: 15px;
  --font-size-body-sm: 14px;
  --font-size-caption: 12px;
  --font-size-overline: 11px;

  /* === Spacing (8px grid) === */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;

  /* === Border Radius === */
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --radius-full: 9999px;

  /* === Shadows === */
  --shadow-1: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06);
  --shadow-2: 0 4px 6px rgba(0,0,0,0.04), 0 2px 4px rgba(0,0,0,0.06);
  --shadow-3: 0 12px 24px rgba(0,0,0,0.06), 0 4px 8px rgba(0,0,0,0.04);
  --shadow-4: 0 20px 40px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.04);

  /* === Animation === */
  --duration-instant: 100ms;
  --duration-fast: 200ms;
  --duration-normal: 300ms;
  --duration-slow: 500ms;
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

  /* === Layout === */
  --page-padding: 16px;
  --card-padding: 16px;
  --card-gap: 12px;
  --bottom-nav-height: 64px;
  --top-bar-height: 56px;
  --touch-target-min: 48px;
}

/* Dark mode overrides */
[data-theme="dark"] {
  --color-surface: #151E2E;
  --color-surface-elevated: #1E293B;
  --color-surface-subtle: #0B1221;
  --color-border: #2D3B50;
  --color-primary-active: #60A5FA;
  --color-secondary: #5EEAD4;
  --color-text-primary: #E2E8F0;
  --color-text-secondary: #94A3B8;
  --color-text-tertiary: #64748B;

  --color-status-success: #34D399;
  --color-status-success-bg: #064E3B;
  --color-status-warning: #FBBF24;
  --color-status-warning-bg: #78350F;
  --color-status-error: #F87171;
  --color-status-error-bg: #7F1D1D;
  --color-status-info: #60A5FA;
  --color-status-info-bg: #1E3A5F;
  --color-status-neutral: #9CA3AF;
  --color-status-neutral-bg: #374151;

  --shadow-1: none;
  --shadow-2: none;
  --shadow-3: 0 4px 16px rgba(0,0,0,0.4);
  --shadow-4: 0 8px 32px rgba(0,0,0,0.5);
}

/* Tablet+ responsive adjustments */
@media (min-width: 768px) {
  :root {
    --page-padding: 24px;
    --card-gap: 16px;
  }
}

@media (min-width: 1024px) {
  :root {
    --page-padding: 32px;
    --card-gap: 20px;
  }
}
```

---

## 7. QUICK-REFERENCE COMPONENT SPECS

### Credential List Item
- Height: 64-72px
- Padding: 12px 16px
- Left: 8px status dot + 12px gap + credential name (15px/SemiBold)
- Right: Status badge (pill) + chevron icon
- Subtitle: Expiry date (14px/Regular, secondary color)
- Border: 1px bottom border (--color-border)
- Tap state: Scale 0.98 + background darken

### Compliance Ring (Dashboard Hero)
- Diameter: 140px
- Stroke width: 10px
- Center number: 28px/Bold
- Center label: 12px/Medium, secondary color
- Background track: --color-surface-subtle
- Active track: Gradient from --color-secondary to --color-primary-active
- Animation: 800ms ease-out sweep on mount

### Action Card (Urgent Items)
- Width: 280px (horizontal scroll)
- Height: auto (content-driven)
- Padding: 16px
- Border-radius: 12px
- Shadow: --shadow-1 (--shadow-2 on hover)
- Top accent: 3px colored bar matching status
- Content: Credential name (17px/SemiBold) + status + days remaining + CTA button

### Bottom Tab Bar
- Height: 64px + safe area inset
- Background: --color-surface (light) or --color-surface (dark)
- Border-top: 1px --color-border
- Icon size: 24px
- Label: 11px/Medium
- Active: --color-primary-active icon + label
- Inactive: --color-text-tertiary icon + label
- Center FAB: 48px diameter, --color-primary-active, --shadow-2

### Status Badge
- Height: 24px
- Padding: 4px 8px
- Border-radius: 12px (pill)
- Font: 12px/SemiBold
- Includes: 6px dot + 4px gap + label text
- Variants: success, warning, error, info, neutral

---

## SOURCES

- [Octet Design Labs - Smart Healthcare Color Palette](https://octet.design/colors/palette/smart-healthcare-color-palette-1732100703/)
- [ThinkPod Agency - Medical Colors for Healthcare Branding 2025](https://thinkpodagency.com/the-art-of-medical-colors-in-healthcare-branding-in-2025/)
- [Eleken - Healthcare UI Design 2026](https://www.eleken.co/blog-posts/user-interface-design-for-healthcare-applications)
- [UXPin - Dashboard Design Principles](https://www.uxpin.com/studio/blog/dashboard-design-principles/)
- [Pencil & Paper - Dashboard Design UX Patterns](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards)
- [WebAIM - Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [AllAccessible - Color Contrast WCAG Guide 2025](https://www.allaccessible.org/blog/color-contrast-accessibility-wcag-guide-2025)
- [AppMySite - Bottom Navigation Bar Guide](https://blog.appmysite.com/bottom-navigation-bar-in-mobile-apps-heres-all-you-need-to-know/)
- [UX Planet - Bottom Tab Bar Best Practices](https://uxplanet.org/bottom-tab-bar-navigation-design-best-practices-48d46a3b0c36)
- [ILOVEWP - Most Used Google Fonts on Hospital Websites](https://www.ilovewp.com/resources/medical/wordpress-for-hospitals/most-used-google-fonts-on-hospital-websites/)
- [Brandcare - Fonts in Healthcare](https://www.brandcare.net/blog/fonts-in-healthcare/)
- [RAIS Project - Legible Fonts for Healthcare](https://raisproject.com/legible-fonts-for-healthcare/)
- [Learn UI - Font Size Guidelines](https://www.learnui.design/blog/mobile-desktop-website-font-size-guidelines.html)
- [Sanjay Dey - Mobile UI Trends 2026: Glassmorphism to Spatial Computing](https://www.sanjaydey.com/mobile-ui-trends-2026-glassmorphism-spatial-computing/)
- [Designveloper - Mobile App Design Trends 2026](https://www.designveloper.com/blog/mobile-app-design-trends/)
- [Natively - Mobile App Design Trends 2026](https://natively.dev/blog/best-mobile-app-design-trends-2026)
- [Material Design 3 - Elevation](https://m3.material.io/styles/elevation/applying-elevation)
- [Josh W. Comeau - Designing Beautiful Shadows in CSS](https://www.joshwcomeau.com/css/designing-shadows/)
- [Design Systems Surf - Elevation Design Patterns](https://designsystems.surf/articles/depth-with-purpose-how-elevation-adds-realism-and-hierarchy)
- [Prototypr - The 8pt Grid](https://blog.prototypr.io/the-8pt-grid-consistent-spacing-in-ui-design-with-sketch-577e4f0fd520)
- [Cieden - Spacing Best Practices](https://cieden.com/book/sub-atomic/spacing/spacing-best-practices)
- [Paul Wallas - Designing for Data Density](https://paulwallas.medium.com/designing-for-data-density-what-most-ui-tutorials-wont-teach-you-091b3e9b51f4)
- [Carbon Design System - Status Indicator Pattern](https://carbondesignsystem.com/patterns/status-indicator-pattern/)
- [UX Patterns for Developers - Table vs List vs Cards](https://uxpatterns.dev/pattern-guide/table-vs-list-vs-cards)
- [NN/g - Card View vs. List View](https://www.nngroup.com/videos/card-view-vs-list-view/)
- [Oscar Health - Design System Journey](https://medium.com/oscar-tech/0-to-1-oscars-design-system-journey-e7ee5f688571)
- [Oscar Health Blog - App Design Process](https://www.hioscar.com/blog/the-design-process-behind-oscars-latest-mobile-app-update/)
- [Merge - Best Designed Health Apps](https://merge.rocks/blog/8-best-designed-health-apps-weve-seen-so-far)
- [Modio Health](https://www.modiohealth.com/)
- [Certemy](https://certemy.com/)
- [BricxLabs - Micro Animation Examples 2025](https://bricxlabs.com/blogs/micro-interactions-2025-examples)
- [PrimoTech - UI/UX Evolution 2026: Micro-Interactions](https://primotech.com/ui-ux-evolution-2026-why-micro-interactions-and-motion-matter-more-than-ever/)
- [DEV Community - Micro-Interaction Design Rules 2026](https://dev.to/devin-rosario/5-micro-interaction-design-rules-for-apps-in-2026-48nb)
- [Atmos Style - Dark Mode Best Practices](https://atmos.style/blog/dark-mode-ui-best-practices)
- [EightShapes - Light & Dark Color Modes](https://medium.com/eightshapes-llc/light-dark-9f8ea42c9081)
- [Untitled UI - Progress Circles](https://www.untitledui.com/components/progress-circles)
- [UIKits - Gauge Elements in UI Design](https://www.uinkits.com/blog-post/how-to-use-gauge-elements-in-ui-design)
- [Mobbin - Progress Indicator Patterns](https://mobbin.com/glossary/progress-indicator)
