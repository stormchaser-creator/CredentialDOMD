# CredentialDOMD — Project Instructions

## What This Is

A Progressive Web App for physician credential management. Tracks medical licenses, CME hours, hospital privileges, insurance, case logs, and compliance across multiple states and boards.

## Tech Stack

- **Framework:** React 19.2.0 (JSX, not TypeScript)
- **Build:** Vite 7.3.1
- **Styling:** CSS (base.css) + inline theme system (dark/light)
- **State:** Context API (AppContext.jsx) with debounced localStorage persistence
- **AI:** Anthropic Claude API (client-side, for document scanning)
- **External APIs:** NPPES/NPI Registry (CMS)
- **PWA:** Service worker + manifest
- **Hosting:** Netlify
- **Mobile:** Capacitor bridge support for native iOS/Android

## Project Structure

```
src/
├── App.jsx                    # Main app with tab navigation
├── main.jsx                   # Entry point (PWA/CSP setup)
├── context/AppContext.jsx      # State management (12 data sections)
├── components/
│   ├── features/              # CME, CPT, CV, Documents, Health Records, etc.
│   ├── pages/                 # FAQ, Legal, Settings, Notifications
│   └── shared/                # Icons, Modal, Field, StatusBadge, etc.
├── constants/                 # 30 data files (states, boards, CPT codes, themes)
├── utils/                     # Document scanner, NPI lookup, compliance calc
└── styles/base.css
```

## Key Commands

```bash
cd /Users/whit_1/Desktop/CredentialDOMD
npm run dev        # Vite dev server (port 5173)
npm run build      # Production build
npm run preview    # Preview production build
```

## Environment Variables (.env)

- `VITE_ANTHROPIC_API_KEY` — Claude API key for document scanning
- `VITE_NPI_PROXY_URL` — Optional NPI API proxy URL

## Key Features

- License management across multiple states
- CME tracking with state/board-specific requirements
- AI document scanning (Claude Vision — license/cert image analysis)
- NPI lookup for provider data pre-fill
- Real-time compliance ring (licenses + privileges + CME)
- CV generation from stored credential data
- Credential sharing with audit log
- Browser notifications for expiring items

## Design References

- `DESIGN_RESEARCH.md` — Color system, WCAG compliance notes
- `AI-APP-BUILDING-INSTRUCTIONS.md` — Security guidelines

## Conventions

- All state in AppContext with debounced localStorage save (300ms)
- Capacitor storage fallback for mobile builds
- Document scanner limits: 4.5MB max image, auto-compress to 2048px
- NPI API proxied through Vite dev server config
