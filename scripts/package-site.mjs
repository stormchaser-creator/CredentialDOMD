#!/usr/bin/env node
// One reviewed static artifact for GitHub Pages today and Cloudflare Pages later.
import { cp, mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packageSite(root, legacyDir) {
  const output = resolve(root, 'site-dist');
  // Refuse an incomplete build before removing the previous packaged output.
  const entryHtml = await readFile(resolve(root, 'dist/index.html'), 'utf8');
  if (!/<script\b[^>]*src=["']\/app\/assets\//.test(entryHtml)) {
    throw new Error('Build the app with --base=/app/ before packaging; refusing broken asset paths');
  }
  for (const page of ['index', 'locums', 'security', 'privacy', 'terms']) {
    await access(resolve(root, `landing/${page}.html`));
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(root, 'dist'), resolve(output, 'app'), { recursive: true });
  // Public root assets only. The app's service worker stays scoped to /app/.
  for (const entry of await readdir(resolve(root, 'public'), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:png|jpg|jpeg|svg|ico|txt|xml)$/.test(entry.name)) {
      await cp(resolve(root, 'public', entry.name), resolve(output, entry.name));
    }
  }
  for (const page of ['index', 'locums', 'security', 'privacy', 'terms']) {
    const html = await readFile(resolve(root, `landing/${page}.html`), 'utf8');
    await writeFile(resolve(output, `${page}.html`), html);
    if (page !== 'index') {
      await mkdir(resolve(output, page), { recursive: true });
      await writeFile(resolve(output, page, 'index.html'), html);
    }
  }
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
  await writeFile(resolve(output, '_headers'), '/app/sw.js\n  Cache-Control: no-cache\n/app/version.json\n  Cache-Control: no-store\n/app/index.html\n  Cache-Control: no-cache\n');
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const legacyIndex = process.argv.indexOf('--legacy-dir');
  const legacy = legacyIndex >= 0 ? process.argv[legacyIndex + 1] : undefined;
  if (legacyIndex >= 0 && !legacy) throw new Error('--legacy-dir requires a path');
  console.log(await packageSite(root, legacy ? resolve(legacy) : undefined));
}
