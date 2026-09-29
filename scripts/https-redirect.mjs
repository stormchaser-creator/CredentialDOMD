// A page opened as plain http://credentialdomd.com/ stayed on http, and every
// signup call it made was refused (403). Hosting settings are not changed from
// this repository, so every page switches itself to https as the first thing
// it runs: this inline script sits straight after the charset declaration,
// before any other script, stylesheet or style. It acts only on the production
// host, never on localhost or any other development or preview host, and it
// keeps the path, query and fragment (an invitation link survives the switch).
//
// A page that sets its Content-Security-Policy by <meta> also lists this
// script's hash (the private access page's header CSP is copied from its meta
// tag) and adds upgrade-insecure-requests.
import { createHash } from 'node:crypto';

export const HTTPS_REDIRECT_HOST = 'credentialdomd.com';
export const HTTPS_REDIRECT_SOURCE = `if(location.protocol==="http:"&&location.hostname==="${HTTPS_REDIRECT_HOST}")location.replace(location.href.replace(/^http:/,"https:"))`;
export const HTTPS_REDIRECT_SCRIPT = `<script id="https-redirect">${HTTPS_REDIRECT_SOURCE}</script>`;
export const HTTPS_REDIRECT_CSP_HASH = `'sha256-${createHash('sha256').update(HTTPS_REDIRECT_SOURCE).digest('base64')}'`;

// Only these may come before the redirect: doctype, comments, the opening
// <html> and <head> tags and the charset declaration. Anything else there
// (a script, stylesheet or style) would load or run on plain http first.
const ALLOWED_BEFORE = /^(?:\s+|<!doctype\b[^>]*>|<!--[\s\S]*?-->|<html\b[^>]*>|<head\b[^>]*>|<meta\s+charset=["']?[\w-]+["']?\s*\/?>)*$/i;

const directives = csp => new Map(csp.split(';').map(part => part.trim()).filter(Boolean).map(part => {
  const [name, ...values] = part.split(/\s+/);
  return [name.toLowerCase(), values];
}));

// Returns why a page would stay on plain http, or null when it switches first.
export function httpsRedirectProblem(html) {
  const at = html.indexOf(HTTPS_REDIRECT_SCRIPT);
  if (at < 0) return 'has no https redirect script';
  if (html.indexOf(HTTPS_REDIRECT_SCRIPT, at + 1) >= 0) return 'carries the https redirect script twice';
  if (!ALLOWED_BEFORE.test(html.slice(0, at))) return 'loads or runs something before the https redirect script';
  for (const [, csp] of html.matchAll(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]*)"/gi)) {
    const policy = directives(csp);
    if (!policy.has('upgrade-insecure-requests')) return 'sets a Content-Security-Policy without upgrade-insecure-requests';
    const scripts = policy.get('script-src') || policy.get('default-src');
    if (scripts && !scripts.includes(HTTPS_REDIRECT_CSP_HASH)) return 'sets a Content-Security-Policy that does not allow the https redirect script by hash';
  }
  return null;
}

export function assertHttpsRedirect(html, name) {
  const problem = httpsRedirectProblem(html);
  if (problem) throw new Error(`${name} ${problem}; every published page must switch to https first (scripts/https-redirect.mjs)`);
  return html;
}
