// Preview host for the packaged public site (site-dist), for review before a
// production deploy. Production stays on GitHub Pages; nothing here is used
// there. The Worker serves site-dist with GitHub Pages' routing so the
// redesign verifier and a browser see what production would serve:
//   /states/texas   -> states/texas.html (200)
//   /states         -> 301 /states/      (a folder with an index.html)
//   /states/texas/  -> 404               (no such folder)
// Two things differ from production, on purpose:
//   - every response says "noindex", so the preview host is never indexed;
//   - opening /app/ in a browser goes to the live app, because sign-in only
//     works on credentialdomd.com. Other requests for /app/ files get the
//     previewed build.
const LIVE = 'https://credentialdomd.com';

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const url = new URL(request.url);
    const path = url.pathname;
    if ((path === '/app' || path === '/app/') && request.headers.get('Sec-Fetch-Dest') === 'document') {
      return Response.redirect(`${LIVE}/app/${url.search}`, 302);
    }
    const asset = async name => {
      const response = await env.ASSETS.fetch(new Request(new URL(name, url.origin), { method: request.method, headers: request.headers }));
      return response.status === 404 ? null : response;
    };
    const send = (response, status = response.status) => {
      const headers = new Headers(response.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(response.body, { status, headers });
    };
    let found = null;
    if (path.endsWith('/')) found = await asset(`${path}index.html`);
    else {
      found = await asset(path) || await asset(`${path}.html`);
      if (!found && await asset(`${path}/index.html`)) {
        return new Response(null, { status: 301, headers: { Location: `${path}/${url.search}`, 'X-Robots-Tag': 'noindex, nofollow' } });
      }
    }
    if (found) return send(found);
    const missing = await asset('/404.html');
    return missing ? send(missing, 404) : new Response('Not found', { status: 404 });
  },
};
