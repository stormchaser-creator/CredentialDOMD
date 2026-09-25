// credentialdomd.com/credential-access* : the private administrator page.
// GitHub Pages cannot send response headers, so this Worker passes each
// request through to the site and adds them. The CSP is copied from the
// page's own <meta> tag on every HTML response, so the header can never
// drift from the script hash the page was built with; frame-ancestors (which
// a meta CSP cannot carry) is added here.
const PRIVATE = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
};
function metaCsp(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/http-equiv\s*=\s*["']content-security-policy["']/i.test(tag)) continue;
    const m = tag.match(/content\s*=\s*"([^"]*)"/i) || tag.match(/content\s*=\s*'([^']*)'/i);
    if (m) return m[1].trim().replace(/;\s*$/, "");
  }
  return null;
}
export default {
  async fetch(request) {
    const res = await fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVATE)) headers.set(k, v);
    if (request.method !== "HEAD" && (headers.get("content-type") || "").includes("text/html")) {
      const body = await res.text();
      // No meta CSP found: send only the one directive a meta tag cannot
      // carry, never a stricter policy that would block the page's scripts.
      const base = metaCsp(body);
      headers.set("Content-Security-Policy", !base ? "frame-ancestors 'none'" : /frame-ancestors/i.test(base) ? base : `${base}; frame-ancestors 'none'`);
      headers.delete("content-length");
      return new Response(body, { status: res.status, statusText: res.statusText, headers });
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
