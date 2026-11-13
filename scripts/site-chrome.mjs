// One header, footer, font and brand for every public marketing page.
//
// package-site.mjs runs each page through applySiteChrome() after the launch
// renderer. Pages written for the redesign (home, pricing, credits) mark where
// the header and footer go. Pages that keep their own layout and content
// (locums, the state guides, CME, help, the watch pages and the legal pages)
// have their old navigation and footer replaced, and public/site-chrome.css
// gives them the light theme. Their words, forms, structured data and launch
// slots are not touched.
//
// The header and footer use div elements with cdm- classes, not nav, header,
// footer, ul or h3, so the element rules in the older page styles and the CME
// page's policy against inline styles never reach them.
import { PUBLIC_LAUNCH_MODE, publicLaunchPresentation } from '../src/content/publicLaunch.mjs';

export const SITE_CHROME_ASSETS = Object.freeze(['site-chrome.css', 'site-chrome.js', 'site.css']);
export const SITE_FONTS = Object.freeze(['figtree.woff']);
export const SIGN_IN_HREF = '/app/';

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const NAV_LINKS = Object.freeze([
  { id: 'home', label: 'Home', href: '/' },
  { id: 'how', label: 'How it works', href: '/#how-it-works' },
  { id: 'states', label: 'State guides', href: '/states/' },
  { id: 'pricing', label: 'Pricing', href: '/pricing' },
  { id: 'faq', label: 'FAQ', href: '/#faq' },
]);

const brand = '<a class="cdm-brand" href="/"><img src="/images/logo-64.png" alt="" width="40" height="40"><span>Credential<b>DOMD</b></span></a>';

export function siteHeader({ current = null, mode = PUBLIC_LAUNCH_MODE } = {}) {
  const view = publicLaunchPresentation(mode);
  const links = NAV_LINKS.map(link => `<a href="${link.href}"${link.id === current ? ' aria-current="page"' : ''}>${link.label}</a>`).join('');
  // Paid mode: the same signup destination and repaintable label as every
  // other signup button. Waitlist mode keeps the waitlist request.
  const cta = mode.enabled
    ? `<a class="cdm-cta" href="${escapeHtml(view.primaryAction.href)}"><span data-membership-action>${escapeHtml(view.primaryAction.shortLabel)}</span></a>`
    : `<a class="cdm-cta" href="${escapeHtml(view.primaryAction.href)}">${escapeHtml(view.primaryAction.shortLabel)}</a>`;
  return '<div class="cdm-header" role="banner"><div class="cdm-wrap cdm-nav" role="navigation" aria-label="Main">'
    + brand
    + '<button class="cdm-menu-btn" type="button" aria-expanded="false" aria-controls="cdm-menu">Menu</button>'
    + `<div class="cdm-links" id="cdm-menu">${links}<a href="${SIGN_IN_HREF}">Sign in</a>${cta}</div>`
    + '</div></div>';
}

export function siteFooter({ note = '' } = {}) {
  return '<div class="cdm-footer" role="contentinfo"><div class="cdm-wrap"><div class="cdm-foot-grid">'
    + `<div>${brand}<p>Your licenses, DEA, board certification, privileges and CME in one place. Built by a practicing physician.</p>`
    + '<p>Questions? <a href="mailto:support@credentialdomd.com">support@credentialdomd.com</a></p></div>'
    + '<div><p class="cdm-foot-h">Explore</p><div class="cdm-foot-list">'
    + '<a href="/states/">License renewal by state</a><a href="/pricing">Pricing</a><a href="/locums">Practice tools for locums</a><a href="/cme/">CME resources</a>'
    + '</div></div>'
    + '<div><p class="cdm-foot-h">Help &amp; policies</p><div class="cdm-foot-list">'
    + '<a href="/help">Help center &amp; videos</a><a href="/security">Security &amp; data handling</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a>'
    + '</div></div></div>'
    + (note ? `<p class="cdm-foot-note">${note}</p>` : '')
    + '<p class="cdm-credit">&copy; 2026 CredentialDOMD. State guides are informational, not legal advice; always confirm requirements with your state medical board. Photos from Unsplash (<a href="/credits">credits</a>).</p>'
    + '</div></div>';
}

const HEAD_LINKS = '<meta name="theme-color" content="#0f2a4a">\n'
  + '<link rel="icon" href="/favicon.ico" sizes="any">\n<link rel="icon" type="image/png" href="/favicon.png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n'
  + '<link rel="preload" href="/fonts/figtree.woff" as="font" type="font/woff" crossorigin>\n'
  + '<link rel="stylesheet" href="/site-chrome.css">\n<script src="/site-chrome.js" defer></script>\n';

// The four shapes of navigation the older pages carry.
const LEGACY_NAV = [
  /<nav>\s*<div class="nav-inner">[\s\S]*?<\/nav>\s*/,
  /<header class="nav">[\s\S]*?<\/header>\s*/,
  /<nav aria-label="Main navigation">[\s\S]*?<\/nav>\s*/,
  /<nav class="topnav"[^>]*>[\s\S]*?<\/nav>\s*/,
];

// The sentence an older footer carried that still matters: the offer line the
// launch renderer wrote (help, CME) or a guide's board disclaimer.
function footerNote(footer) {
  const disclaimer = footer.match(/<div class="footer-disclaimer">\s*([\s\S]*?)\s*<\/div>/);
  if (disclaimer) return disclaimer[1];
  const offer = [...footer.matchAll(/<p>([\s\S]*?)<\/p>/g)].find(match => match[1].includes('data-membership-availability'));
  return offer ? offer[1] : '';
}

function head(html) {
  let out = html
    .replace(/[ \t]*<link rel="preconnect" href="https:\/\/fonts\.(?:googleapis|gstatic)\.com"[^>]*>\n?/g, '')
    .replace(/[ \t]*<link href="https:\/\/fonts\.googleapis\.com\/[^"]*" rel="stylesheet">\n?/g, '')
    .replace(/[ \t]*<link rel="icon"[^>]*?href="[^"]*"[^>]*>\n?/g, '')
    .replace(/[ \t]*<link rel="apple-touch-icon"[^>]*>\n?/g, '')
    .replace(/[ \t]*<meta name="theme-color"[^>]*>\n?/g, '');
  // A page that sets its own policy must also allow the self-hosted font.
  out = out.replace(/(<meta\b[^>]*http-equiv="Content-Security-Policy" content=")([^"]+)(")/, (whole, open, policy, close) =>
    /\bfont-src\b/.test(policy) ? whole : `${open}${/;\s*img-src /.test(policy) ? policy.replace(/;\s*img-src /, "; font-src 'self'; img-src ") : `${policy}; font-src 'self'`}${close}`);
  if (!out.includes('</head>')) throw Error('Site chrome needs a head element');
  return out.replace('</head>', `${HEAD_LINKS}</head>`);
}

/** The page with the shared header, footer, font and brand. */
export function applySiteChrome(html, { current = null, mode = PUBLIC_LAUNCH_MODE } = {}) {
  if (/\sdata-site-chrome=/.test(html)) throw Error('Site chrome was already applied');
  // A fragment with no head is not a page (test fixtures); leave it alone.
  if (!html.includes('</head>')) return html;
  const header = siteHeader({ current, mode });
  let out = head(html);
  if (out.includes('<!-- site-chrome:header -->')) {
    if (!out.includes('<!-- site-chrome:footer -->')) throw Error('A redesigned page must mark where its footer goes');
    return out.replace(/<html\b/, '<html data-site-chrome="page"')
      .replace('<!-- site-chrome:header -->', header).replace('<!-- site-chrome:footer -->', siteFooter());
  }
  const nav = LEGACY_NAV.map(pattern => out.match(pattern)).find(Boolean);
  if (!nav) throw Error('Site chrome found no navigation to replace');
  const inWrap = nav[0].startsWith('<nav class="topnav"');
  out = out.slice(0, nav.index) + out.slice(nav.index + nav[0].length);
  const body = out.match(/<body\b[^>]*>(?:<!--email_off-->)?/);
  if (!body) throw Error('Site chrome needs a body element');
  out = out.slice(0, body.index + body[0].length) + `\n${header}\n` + out.slice(body.index + body[0].length);
  const start = out.lastIndexOf('<footer');
  const end = out.indexOf('</footer>', start);
  if (start < 0 || end < 0) throw Error('Site chrome found no footer to replace');
  const footer = siteFooter({ note: footerNote(out.slice(start, end)) });
  let rest = out.slice(end + '</footer>'.length);
  if (inWrap) {
    // These pages close their width-limited wrapper after the footer; the
    // shared footer spans the page, so it goes after that closing tag.
    const close = rest.indexOf('</div>');
    if (close < 0) throw Error('Site chrome found no wrapper to close before the footer');
    rest = `${rest.slice(0, close + '</div>'.length)}\n${footer}${rest.slice(close + '</div>'.length)}`;
    out = out.slice(0, start) + rest;
  } else {
    out = out.slice(0, start) + footer + rest;
  }
  // The old script recoloured the old fixed navigation on scroll.
  out = out.replace(/\/\/ Nav scroll effect\n\(function\(\) \{[\s\S]*?\n\}\)\(\);\n/, '');
  return out.replace(/<html\b/, '<html data-site-chrome="legacy"');
}
