#!/usr/bin/env node
// One reviewed static artifact for GitHub Pages today and Cloudflare Pages later.
import { cp, mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVideoCatalog, copyVideoAssets } from './help-videos.mjs';
import { renderHelp } from './build-help.mjs';
import { renderCme } from './build-cme.mjs';
import { renderWatchPages, addWatchPagesToSitemap } from './watch-pages.mjs';

const publicPages = ['index', 'locums', 'security', 'privacy', 'terms', 'help', 'cme', 'credential-access'];
const cmeAssets = ['cme.css', 'cme.mjs'];
const supportNavAssets = ['support-nav.css', 'support-nav.js'];
// Reviewed runtime images only; source originals and provenance stay out of the site.
const landingImages = [
  'physician-life-v3-600.webp', 'physician-life-v3-1200.webp',
  'physician-colleagues-v3-600.webp', 'physician-colleagues-v3-1200.webp',
  'physician-learning-v3-600.webp', 'eric-whitney-120.webp', 'eric-whitney-400.webp',
];

export async function packageSite(root, legacyDir) {
  const output = resolve(root, 'site-dist');
  // Refuse an incomplete build before removing the previous packaged output.
  const entryHtml = await readFile(resolve(root, 'dist/index.html'), 'utf8');
  if (!/<script\b[^>]*src=["']\/app\/assets\//.test(entryHtml)) {
    throw new Error('Build the app with --base=/app/ before packaging; refusing broken asset paths');
  }
  for (const page of publicPages) {
    await access(resolve(root, `landing/${page}.html`));
  }
  for (const name of landingImages) await access(resolve(root, 'landing/images', name));
  await access(resolve(root, 'scripts/root-sw-retirement.js'));
  const videoCatalog = await loadVideoCatalog(root);
  const help = JSON.parse(await readFile(resolve(root, 'public/knowledge/credentialdo-help.json'), 'utf8'));
  if (await readFile(resolve(root, 'landing/help.html'), 'utf8') !== renderHelp(help, videoCatalog)) throw Error('Help page is stale or advertises unreviewed videos; run node scripts/build-help.mjs');
  const watchPages = renderWatchPages(help, videoCatalog);
  const sitemap = addWatchPagesToSitemap(await readFile(resolve(root, 'public/sitemap.xml'), 'utf8'), watchPages);
  const cme = JSON.parse(await readFile(resolve(root, 'public/knowledge/credentialdo-cme.json'), 'utf8'));
  const states = JSON.parse(await readFile(resolve(root, 'landing/states/states-data.json'), 'utf8'));
  if (await readFile(resolve(root, 'landing/cme.html'), 'utf8') !== renderCme(cme, states)) throw Error('CME page is stale; run node scripts/build-cme.mjs');
  for (const name of cmeAssets) await access(resolve(root, 'public/cme-assets', name));
  for (const name of supportNavAssets) await access(resolve(root, 'public', name));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(root, 'dist'), resolve(output, 'app'), { recursive: true });
  // An old root registration only checks its original script URL for updates.
  // Publish its retirement there while preserving the active /app/sw.js worker.
  await cp(resolve(root, 'scripts/root-sw-retirement.js'), resolve(output, 'sw.js'));
  // Public root assets only. The app's service worker stays scoped to /app/.
  for (const entry of await readdir(resolve(root, 'public'), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:png|jpg|jpeg|svg|ico|txt|xml)$/.test(entry.name)) {
      await cp(resolve(root, 'public', entry.name), resolve(output, entry.name));
    }
  }
  for (const page of publicPages) {
    const html = await readFile(resolve(root, `landing/${page}.html`), 'utf8');
    await writeFile(resolve(output, `${page}.html`), html);
    if (page !== 'index') {
      await mkdir(resolve(output, page), { recursive: true });
      await writeFile(resolve(output, page, 'index.html'), html);
    }
  }
  for (const name of supportNavAssets) await cp(resolve(root, 'public', name), resolve(output, name));
  await mkdir(resolve(output, 'images'), { recursive: true });
  for (const name of landingImages) await cp(resolve(root, 'landing/images', name), resolve(output, 'images', name));
  await cp(resolve(root, 'public/credential-access'), resolve(output, 'credential-access'), { recursive: true });
  await cp(resolve(root, 'public/knowledge'), resolve(output, 'knowledge'), { recursive: true });
  await mkdir(resolve(output, 'cme-assets'), { recursive: true });
  for (const name of cmeAssets) await cp(resolve(root, 'public/cme-assets', name), resolve(output, 'cme-assets', name));
  await copyVideoAssets(root, output, videoCatalog);
  for (const page of watchPages) {
    await mkdir(resolve(output, 'help', page.id), { recursive: true });
    await writeFile(resolve(output, 'help', page.id, 'index.html'), page.html);
  }
  // Only pages with verified media enter the published sitemap.
  await writeFile(resolve(output, 'sitemap.xml'), sitemap);
  await mkdir(resolve(output, 'states'), { recursive: true });
  for (const name of await readdir(resolve(root, 'landing/states'))) {
    if (name.endsWith('.html')) await cp(resolve(root, 'landing/states', name), resolve(output, 'states', name));
  }
  // Keep explicitly named legacy public assets when migrating the existing site.
  // Never copy a whole checkout or undocumented public directories.
  if (legacyDir) {
    for (const name of ['dr-whitney-headshot.jpg', 'docs/CANCELLATION_SPEC.md', 'docs/IDEAS.md']) {
      try {
        await access(resolve(legacyDir, name));
        await mkdir(dirname(resolve(output, name)), { recursive: true });
        await cp(resolve(legacyDir, name), resolve(output, name));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await writeFile(resolve(output, '.nojekyll'), '');
  await writeFile(resolve(output, 'CNAME'), 'credentialdomd.com\n');
  // A real 404 prevents Cloudflare's default site-wide SPA fallback. Only the
  // /app/ is the app entry; it uses in-app state rather than URL path routing.
  await writeFile(resolve(output, '404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found</title><h1>Page not found</h1><p><a href="/">CredentialDoMD home</a></p></html>\n');
  // Pages applies redirects even when a static file exists. A wildcard /app/*
  // rewrite would turn JS, sw.js and version.json into HTML and break the PWA.
  await writeFile(resolve(output, '_redirects'), '/app/privacy /privacy 302\n/app/terms /terms 302\n');
  const privatePage = await readFile(resolve(root, 'landing/credential-access.html'), 'utf8');
  const portalCsp = privatePage.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  if (!portalCsp) throw new Error('Private access page must declare its content security policy');
  const portalHeaders = ['/credential-access', '/credential-access.html', '/credential-access/*'].map(route =>
    `${route}\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer\n  X-Robots-Tag: noindex, nofollow, noarchive\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: ${portalCsp}; frame-ancestors 'none'\n`).join('\n');
  await writeFile(resolve(output, '_headers'), '/sw.js\n  Cache-Control: no-cache\n/app/sw.js\n  Cache-Control: no-cache\n/app/version.json\n  Cache-Control: no-store\n/app/index.html\n  Cache-Control: no-cache\n\n' + portalHeaders);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const legacyIndex = process.argv.indexOf('--legacy-dir');
  const legacy = legacyIndex >= 0 ? process.argv[legacyIndex + 1] : undefined;
  if (legacyIndex >= 0 && !legacy) throw new Error('--legacy-dir requires a path');
  console.log(await packageSite(root, legacy ? resolve(legacy) : undefined));
}
