#!/usr/bin/env node
/**
 * Regenerates landing/privacy.html and landing/terms.html from the same
 * content the app renders (src/content/legalText.js), in the landing page's
 * visual style. Run after editing legalText.js and commit the output:
 *
 *   node scripts/generate-legal-pages.mjs
 *
 * The GitHub Pages deploy workflow copies these files to the site root, where
 * they are served as https://credentialdomd.com/app/privacy and /terms
 * (GitHub Pages resolves extensionless URLs to the .html file).
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVACY, TERMS, LEGAL_CONTACT } from "../src/content/legalText.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "landing");

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

const block = (b) => Array.isArray(b)
  ? `<ul>\n${b.map((li) => `  <li>${inline(li)}</li>`).join("\n")}\n</ul>`
  : `<p>${inline(b)}</p>`;

const section = (s) =>
  `<section>\n<h2>${esc(s.title)}</h2>\n${s.blocks.map(block).join("\n")}\n</section>`;

const page = (doc, other) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(doc.title)} | CredentialDoMD</title>
<meta name="description" content="${esc(doc.title)} for CredentialDoMD, the physician credential tracker. Last updated ${esc(doc.updated)}.">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://credentialdomd.com/app/${doc.slug}">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%2310b981'/><rect x='12.2' y='6' width='7.7' height='20' rx='2' fill='white'/><rect x='6' y='12.2' width='20' height='7.7' rx='2' fill='white'/></svg>">
<link rel="apple-touch-icon" href="/app/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0a1014;
  --bg-elevated: #0e161c;
  --bg-card: #101b22;
  --surface: #182831;
  --border: #21363f;
  --border-subtle: #17262e;
  --emerald: #10b981;
  --emerald-light: #34d399;
  --emerald-dim: rgba(16, 185, 129, 0.08);
  --emerald-border: rgba(16, 185, 129, 0.2);
  --text: #eef4f2;
  --text-secondary: #a2b6b3;
  --text-muted: #6d8582;
  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --radius-md: 12px;
  --radius-lg: 16px;
}
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6; overflow-x: hidden; }
a { color: var(--emerald); text-decoration: none; transition: color 0.2s; }
a:hover { color: var(--emerald-light); }

nav { position: fixed; top: 0; left: 0; right: 0; z-index: 1000; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); background: rgba(13, 13, 26, 0.8); border-bottom: 1px solid var(--border-subtle); }
.nav-inner { display: flex; align-items: center; justify-content: space-between; max-width: 1200px; margin: 0 auto; padding: 16px 24px; }
.logo { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
.logo-mark { width: 36px; height: 36px; background: linear-gradient(135deg, var(--emerald), #059669); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 900; color: white; }
.logo-text span { color: var(--emerald); }
.nav-links { display: flex; gap: 32px; align-items: center; }
.nav-links a { color: var(--text-secondary); font-size: 14px; font-weight: 500; }
.nav-links a:hover { color: var(--text); }
.btn-primary { display: inline-flex; align-items: center; justify-content: center; padding: 10px 22px; border-radius: var(--radius-md); background: var(--emerald); color: #0d0d1a; font-weight: 700; font-size: 13px; letter-spacing: -0.01em; transition: all 0.2s ease; }
.btn-primary:hover { background: var(--emerald-light); color: #0d0d1a; transform: translateY(-2px); box-shadow: 0 8px 32px rgba(16, 185, 129, 0.3); }

main { max-width: 800px; margin: 0 auto; padding: 128px 24px 64px; }
.section-label { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--emerald); margin-bottom: 16px; }
h1 { font-size: clamp(30px, 4vw, 44px); font-weight: 800; line-height: 1.15; letter-spacing: -1.5px; margin-bottom: 8px; }
.updated { font-size: 14px; color: var(--text-muted); margin-bottom: 28px; }
.intro { font-size: 17px; color: var(--text-secondary); line-height: 1.7; margin-bottom: 36px; }
.intro p + p { margin-top: 12px; }
section { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 24px 28px; margin-bottom: 16px; }
section h2 { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 10px; color: var(--text); }
section p, section li { font-size: 15px; color: var(--text-secondary); line-height: 1.7; }
section p + p, section ul + p, section p + ul { margin-top: 10px; }
section ul { padding-left: 20px; }
section li { margin-bottom: 6px; }
section li::marker { color: var(--emerald); }
strong { color: var(--text); font-weight: 600; }
.doc-switch { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 28px; font-size: 14px; }
.doc-switch a { padding: 8px 14px; border: 1px solid var(--border); border-radius: 9999px; color: var(--text-secondary); }
.doc-switch a:hover { border-color: var(--emerald-border); color: var(--text); background: var(--emerald-dim); }

footer { padding: 48px 0 32px; border-top: 1px solid var(--border-subtle); background: var(--bg); }
.footer-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 24px; }
.footer-brand { font-size: 16px; font-weight: 700; color: var(--text); }
.footer-brand span { color: var(--emerald); }
.footer-copy { font-size: 13px; color: var(--text-muted); margin-top: 8px; }
.footer-links { display: flex; gap: 24px; flex-wrap: wrap; }
.footer-links a { font-size: 13px; color: var(--text-muted); }
.footer-links a:hover { color: var(--text-secondary); }

@media (max-width: 640px) {
  .nav-links a:not(.btn-primary) { display: none; }
  main { padding: 104px 18px 48px; }
  section { padding: 20px 18px; }
}
</style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <a href="/" class="logo">
      <div class="logo-mark">D</div>
      <div class="logo-text">Credential<span>DOMD</span></div>
    </a>
    <div class="nav-links">
      <a href="/#features">Features</a>
      <a href="/#faq">FAQ</a>
      <a href="/app/">Sign in</a>
      <a href="/#early-access" class="btn-primary">Get Early Access</a>
    </div>
  </div>
</nav>

<main>
  <div class="section-label">Legal</div>
  <h1>${esc(doc.title)}</h1>
  <div class="updated">Last updated ${esc(doc.updated)}</div>
  <div class="intro">
${doc.intro.map((p) => `    <p>${inline(p)}</p>`).join("\n")}
  </div>

${doc.sections.map(section).join("\n\n")}

  <div class="doc-switch">
    <a href="/${other.slug}">${esc(other.title)}</a>
    <a href="mailto:${LEGAL_CONTACT}">Contact: ${LEGAL_CONTACT}</a>
    <a href="/">Back to credentialdomd.com</a>
  </div>
</main>

<footer>
  <div class="footer-inner">
    <div>
      <div class="footer-brand">Credential<span>DOMD</span></div>
      <div class="footer-copy">&copy; 2026 CredentialDOMD. All rights reserved.</div>
    </div>
    <div class="footer-links">
      <a href="/app/privacy">Privacy Policy</a>
      <a href="/app/terms">Terms of Service</a>
      <a href="mailto:${LEGAL_CONTACT}">Contact</a>
      <a href="mailto:${LEGAL_CONTACT}">Support</a>
    </div>
  </div>
</footer>

</body>
</html>
`;

// The gh-pages workflow cannot be edited from this machine (token lacks the
// workflow scope), so the pages ship inside the app bundle via public/ and
// are served at /app/privacy and /app/terms; landing/ keeps a copy for the repo.
const pubDir = resolve(out, "..", "public");
for (const [name, html] of [["privacy.html", page(PRIVACY, TERMS)], ["terms.html", page(TERMS, PRIVACY)]]) {
  writeFileSync(resolve(out, name), html);
  writeFileSync(resolve(pubDir, name), html);
}
console.log("wrote landing/{privacy,terms}.html and public/{privacy,terms}.html");
