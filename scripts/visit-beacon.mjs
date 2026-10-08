// The first-party visit beacon: POST /api/pv, which the Cloudflare Worker
// relays to track_pv. Path and referrer only, no cookies, nothing about the
// visitor. The same script the home page, the Practice page and every state
// guide carry inline (tests/landing-beacon.test.mjs holds them equal); the
// page builders put it in the pages they generate. A page whose
// Content-Security-Policy is set by <meta> lists its hash and allows
// connect-src 'self' for it.
import { createHash } from 'node:crypto';

export const VISIT_BEACON_SOURCE = `if(!(location.protocol==="http:"&&location.hostname==="credentialdomd.com"))navigator.sendBeacon&&navigator.sendBeacon('/api/pv',JSON.stringify({p:location.pathname.replace(/\\.html$/,'').replace(/\\/index$/,'/')||'/',r:(/^http:\\/\\/credentialdomd\\.com\\//.test(document.referrer)?'':document.referrer)||(/[?&]src=li(&|$)/.test(location.search)?'https://www.linkedin.com/':'')}))`;
export const VISIT_BEACON_SCRIPT = `<script>${VISIT_BEACON_SOURCE}</script>`;
export const VISIT_BEACON_CSP_HASH = `'sha256-${createHash('sha256').update(VISIT_BEACON_SOURCE).digest('base64')}'`;
