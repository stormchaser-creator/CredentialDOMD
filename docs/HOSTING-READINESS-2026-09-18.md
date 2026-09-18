# Hosting preparation

The existing site is still served by GitHub Pages behind Cloudflare DNS. No DNS
change or Cloudflare Pages deployment has been made as part of this preparation.

`npm run build:site` produces `site-dist/`: the app under `/app/`, all five public
pages (home, locums, security, privacy, terms), state guides, public images and SEO
files. Both `.html` and directory routes are present for the public pages. The
service worker stays under `/app/`. The GitHub Pages workflow uses the same package
so new public pages are no longer silently omitted. It carries forward explicitly
named legacy public assets from `gh-pages`.

## Cloudflare preview

1. Create/reuse a Pages project named `credentialdomd`, production branch `main`.
2. Add account-scoped **Cloudflare Pages: Edit** credentials to the repository's
   `CLOUDFLARE_PAGES_API_TOKEN` secret and the account ID to `CLOUDFLARE_ACCOUNT_ID`.
   The existing `Cloudflare CredentialDOMD` credential returned HTTP 403 for the
   Pages projects endpoint on September 18; DNS reads succeeded. It is insufficient
   for this deployment. Do not put a token in source or chat.
3. Run the manual `Preview on Cloudflare Pages` workflow. It always deploys the
   `launch-readiness` preview branch using fixed Wrangler version 4.135.0.
4. Verify public routes, `/app/` assets/update behavior and authentication. Preview
   hostnames may need explicit Clerk/CORS configuration. The `/api/*` Worker route
   belongs to the production hostname and is not automatically present on previews.
   Do not submit real waitlist/customer records from a preview as a routing test.
5. After a successful preview, attach the production custom domain in Pages,
   preserve the existing `/api/*` Worker route and mail DNS, then change the web
   DNS records. Update the public privacy hosting-provider description at cutover.
   Preserve the previous A records and build for rollback. Switch automatic CI
   deployment only after the custom domain and app sign-in are verified.

The preview workflow does not perform steps 1, 2 or 5 and does not enable billing.
No provider spend cap was raised.

References: [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/),
[CI and token permissions](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/),
[custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).
