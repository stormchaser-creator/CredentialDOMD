#!/usr/bin/env node
// Product help is authored once; the public page also works without JavaScript.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVideoCatalog, validateVideoCatalog, videoHref } from './help-videos.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function validateHelp(help) {
  if (help.schemaVersion !== 1 || help.status !== 'reviewed_product_help' || !help.contentVersion || !/^[a-f0-9]{8,40}$/.test(help.sourceRevision)) throw new Error('Missing reviewed help metadata');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(help.updatedAt) || !help.verifiedScope || !help.audience?.length) throw new Error('Missing scope, audience or date');
  if (!help.articles?.length || !help.usePolicy?.allowed?.length || !help.usePolicy?.escalate?.length || !help.usePolicy?.limits?.length) throw new Error('Missing help policy or articles');
  const ids = new Set();
  for (const article of help.articles) {
    if (!/^[a-z][a-z0-9-]*$/.test(article.id) || ids.has(article.id)) throw new Error('Invalid or duplicate guide ID');
    ids.add(article.id);
    for (const field of ['title', 'category', 'summary', 'verifiedScope', 'availability', 'success']) {
      if (typeof article[field] !== 'string' || !article[field].trim()) throw new Error(`Missing ${field}: ${article.id}`);
    }
    if (article.updatedAt !== help.updatedAt || !article.audience?.length || !article.steps?.length || !article.notes?.length || !article.sourceRefs?.length) throw new Error(`Missing guide evidence: ${article.id}`);
    if (article.sourceRefs.some(ref => !/^(src|supabase)\/[a-zA-Z0-9_./-]+$/.test(ref) || ref.includes('..'))) throw new Error(`Invalid source reference: ${article.id}`);
  }
  for (const article of help.articles) {
    if (!Array.isArray(article.related) || article.related.some(id => !ids.has(id) || id === article.id)) throw new Error(`Unknown related guide: ${article.id}`);
  }
  return help;
}

export function guideSearchText(article) {
  return [article.title, article.category, article.summary, ...article.steps, ...article.notes, article.availability, article.success].join(' ').toLowerCase();
}

export function renderVideo(video) {
  const e=escapeHtml, href=kind=>e(videoHref(video.id,kind));
  const seconds=Math.round(video.durationSeconds), duration=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  return `<section class="tutorial-video" aria-labelledby="video-title-${e(video.id)}">
              <h3 id="video-title-${e(video.id)}">Watch the walkthrough</h3>
              <p id="video-note-${e(video.id)}">${duration} · Narrated demo with captions. Synthetic data; no live messages or payments.</p>
              <video controls playsinline preload="none" width="${video.width}" height="${video.height}" poster="${href('poster')}" aria-label="${e(video.title)}" aria-describedby="video-note-${e(video.id)}">
                <source src="${href('video')}" type="video/mp4">
                <track kind="captions" src="${href('captions')}" srclang="en" label="English"${video.burnedCaptions?'':' default'}>
                Your browser cannot play this video. Use the transcript or download link below.
              </video>
              <p class="video-links"><a href="${href('transcript')}">Read the transcript</a><a href="${href('video')}" download>Download video</a></p>
            </section>`;
}

export function renderHelp(input, videoCatalog = null) {
  const help = structuredClone(validateHelp(input));
  const videos = videoCatalog ? validateVideoCatalog(videoCatalog).tutorials : [];
  const videoById = new Map(videos.map(video=>[video.id,video]));
  const e = escapeHtml;
  const categories = [...new Set(help.articles.map(article => article.category))];
  const titles = Object.fromEntries(help.articles.map(article => [article.id, article.title]));
  const guides = help.articles.map((article, index) => `
      <article id="${e(article.id)}" data-guide data-category="${e(article.category)}" data-search="${e(guideSearchText(article))}">
        <details>
          <summary><span class="number">${String(index + 1).padStart(2, '0')}</span><span><span class="category">${e(article.category)}</span><strong>${e(article.title)}</strong><span class="description">${e(article.summary)}</span></span><span class="chevron" aria-hidden="true">+</span></summary>
          <div class="guide-body">
            <p class="availability">${e(article.availability)}</p>${videoById.has(article.id)?"\n            "+renderVideo(videoById.get(article.id)):""}
            <ol>${article.steps.map(step => `<li>${e(step)}</li>`).join('')}</ol>
            <div class="notes"><h3>Good to know</h3><ul>${article.notes.map(note => `<li>${e(note)}</li>`).join('')}</ul></div>
            <p class="outcome"><strong>You’re done when:</strong> ${e(article.success)}</p>
            <nav class="related" aria-label="Related to ${e(article.title)}">${article.related.map(id => `<a href="#${e(id)}">${e(titles[id])}</a>`).join('')}</nav>
          </div>
        </details>
      </article>`).join('');
  return `<!doctype html>
<!-- Generated by scripts/build-help.mjs from public/knowledge/credentialdo-help.json. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Help center | CredentialDoMD</title>
  <meta name="description" content="${videos.length ? "Written and video walkthroughs" : "Written walkthroughs"} for license uploads, CME transcripts, locum agreements, work logs, invoices, payments and support in CredentialDoMD.">
  <link rel="canonical" href="https://credentialdomd.com/help">
  <meta name="theme-color" content="#0a1014">
  <style>
    :root { color-scheme: dark; --bg:#0a1014; --card:#101b22; --text:#eef4f2; --muted:#aec0bd; --line:#2c414b; --accent:#6ee7b7; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--text); background:var(--bg); font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:var(--accent); text-underline-offset:4px; }
    a:hover { color:#d1fae5; }
    a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible { outline:3px solid var(--accent); outline-offset:4px; }
    button, input { font:inherit; }
    [hidden] { display:none !important; }
    .skip { position:absolute; left:16px; top:-100px; z-index:2; padding:12px 18px; background:var(--card); }
    .skip:focus { top:12px; }
    .wrap { max-width:1080px; margin:auto; padding:0 24px; }
    .topnav { display:flex; justify-content:space-between; align-items:center; gap:20px; padding:24px 0; border-bottom:1px solid var(--line); }
    .brand { color:var(--text); text-decoration:none; font-size:20px; font-weight:800; }
    .brand span { color:var(--accent); }
    .navlinks, .actions, .filters { display:flex; flex-wrap:wrap; align-items:center; gap:10px 20px; }
    .navlinks a { font-size:14px; padding:8px 0; }
    header { max-width:800px; padding:56px 0 36px; }
    .eyebrow, .category { color:var(--accent); font-size:12px; font-weight:750; letter-spacing:.08em; text-transform:uppercase; }
    h1 { font-size:clamp(36px,6vw,60px); line-height:1.08; letter-spacing:-.035em; margin:14px 0 20px; }
    .lead { font-size:20px; color:var(--muted); margin:0 0 24px; max-width:680px; }
    .button { display:inline-block; padding:12px 20px; border-radius:10px; background:var(--accent); color:#08241b; font-weight:750; text-decoration:none; }
    .button:hover { background:#a7f3d0; color:#08241b; }
    .updated { color:var(--muted); font-size:13px; margin-top:20px; }
    .orientation { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin:0 0 40px; }
    .orientation a { display:block; padding:20px; border:1px solid var(--line); border-radius:14px; color:var(--text); text-decoration:none; }
    .orientation strong { display:block; margin-bottom:5px; }
    .orientation span { font-size:14px; color:var(--muted); }
    .orientation a:hover { border-color:var(--accent); }
    h2 { margin:0 0 14px; font-size:26px; letter-spacing:-.02em; }
    .searchbox { margin:16px 0 12px; }
    .searchbox label { display:block; font-size:14px; font-weight:700; margin-bottom:8px; }
    input { width:100%; border:1px solid var(--line); border-radius:10px; padding:14px 16px; background:var(--card); color:var(--text); }
    .filters { gap:8px; margin-top:14px; }
    .filters button { min-height:44px; padding:8px 14px; border:1px solid var(--line); border-radius:24px; background:transparent; color:var(--text); cursor:pointer; font-size:14px; }
    .filters button[aria-pressed="true"] { background:var(--accent); color:#08241b; border-color:var(--accent); }
    #result-count { font-size:14px; color:var(--muted); margin:12px 0 20px; }
    article { border:1px solid var(--line); border-radius:14px; background:var(--card); margin:12px 0; scroll-margin-top:20px; }
    summary { display:flex; gap:18px; padding:22px; cursor:pointer; list-style:none; align-items:flex-start; }
    summary::-webkit-details-marker { display:none; }
    summary > span:nth-child(2) { flex:1; min-width:0; }
    summary strong { display:block; font-size:19px; line-height:1.4; margin:3px 0 6px; }
    .description { display:block; font-size:14px; color:var(--muted); }
    .number { font-size:13px; color:var(--accent); font-variant-numeric:tabular-nums; padding-top:5px; }
    .chevron { font-size:24px; line-height:1; color:var(--accent); padding-top:8px; }
    details[open] .chevron { transform:rotate(45deg); }
    .guide-body { padding:0 24px 24px 60px; max-width:920px; }
    .availability { font-size:14px; color:var(--muted); margin:0 0 20px; }
    ol { padding-left:24px; margin:0 0 24px; }
    li { margin:12px 0; padding-left:4px; }
    ol li::marker { color:var(--accent); font-weight:750; }
    .notes { padding:16px 20px; border-left:2px solid var(--accent); background:var(--bg); border-radius:0 10px 10px 0; }
    .notes h3 { font-size:14px; margin:0 0 6px; }
    .notes ul { margin:0; padding-left:18px; }
    .notes li { color:var(--muted); font-size:14px; margin:8px 0; }
    .tutorial-video { margin:0 0 26px; }
    .tutorial-video h3 { margin:0 0 6px; font-size:18px; }
    .tutorial-video > p { color:var(--muted); font-size:13px; margin:6px 0 12px; }
    .tutorial-video video { display:block; width:100%; height:auto; aspect-ratio:16/9; background:#050a0e; border:1px solid var(--line); border-radius:10px; }
    .video-links { display:flex; flex-wrap:wrap; gap:12px 24px; }
    .video-links a { padding:5px 0; }
    video:focus-visible { outline:3px solid var(--accent); outline-offset:4px; }
    .outcome { margin:22px 0 14px; }
    .related { display:flex; flex-wrap:wrap; gap:8px 20px; font-size:14px; }
    .related a { padding:6px 0; }
    .empty { border:1px dashed var(--line); padding:24px; border-radius:12px; }
    .support { margin:44px 0; padding:28px; border:1px solid var(--line); border-radius:16px; }
    .support p { color:var(--muted); max-width:760px; }
    footer { border-top:1px solid var(--line); padding:24px 0 36px; color:var(--muted); font-size:13px; }
    footer a { margin-right:18px; display:inline-block; padding:7px 0; }
    @media(max-width:700px) { .wrap { padding:0 18px; } .topnav { align-items:flex-start; flex-direction:column; gap:6px; } header { padding:36px 0 28px; } .orientation { grid-template-columns:1fr; gap:10px; } .orientation a { padding:16px; } summary { padding:18px 14px; gap:10px; } .guide-body { padding:0 18px 20px; } .support { padding:20px; } .lead { font-size:18px; } }
    @media print { .topnav, .actions, .orientation, .searchbox, .filters, footer { display:none; } body { color:#111; background:white; } article { break-inside:avoid; } }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to help</a>
  <div class="wrap">
    <nav class="topnav" aria-label="Main navigation"><a class="brand" href="/">Credential<span>DoMD</span></a><div class="navlinks"><a href="/locums">Locum tools</a><a href="/security">Data handling</a><a href="/app/">Open app</a></div></nav>
    <main id="main">
      <header><div class="eyebrow">Help center</div><h1>Help with your next step.</h1><p class="lead">Add a license, make sense of your CME log, or take locum work through to a recorded payment. Start with the task in front of you.</p><div class="actions"><a class="button" href="/app/">Open CredentialDoMD</a><a href="#get-help">Find your support ticket</a></div><p class="updated">${videos.length ? `${videos.length} video walkthroughs with transcripts` : "Written walkthroughs"} · Updated ${e(help.updatedAt)}${videos.length ? " · Demo data only." : " · Videos are not available yet."}</p></header>
      <nav class="orientation" aria-label="Choose a starting point"><a href="#first-license"><strong>I’m getting started</strong><span>Add your first license and its document.</span></a><a href="#import-cme"><strong>I’m organizing CME</strong><span>Import credits and review what counts.</span></a><a href="#locum-contract"><strong>I’m tracking locum work</strong><span>Agreement → work → invoice → payment.</span></a></nav>
      <section aria-labelledby="guide-heading">
        <h2 id="guide-heading">${help.articles.length} ${videos.length ? "step-by-step guides" : "written walkthroughs"}</h2>
        <div id="search-tools" hidden><div class="searchbox"><label for="help-search">Find a task</label><input id="help-search" type="search" placeholder="Try “certificate”, “payment” or “ticket”" autocomplete="off"></div><div class="filters" role="group" aria-label="Filter guides"><button type="button" data-filter="" aria-pressed="true">All guides</button>${categories.map(category => `<button type="button" data-filter="${e(category)}" aria-pressed="false">${e(category)}</button>`).join('')}</div><p id="result-count" role="status" aria-live="polite"></p></div>
        <div id="no-results" class="empty" hidden><strong>No matching guide yet.</strong><p>Try a shorter phrase, choose All guides, or <a href="#get-help">follow a support ticket</a>.</p></div>
        ${guides}
      </section>
      <section class="support" aria-labelledby="support-title"><h2 id="support-title">Still stuck?</h2><p>Open <strong>Get help</strong> in the app and tell us what you tried. Replies stay under <strong>Your tickets</strong>, so you can check there even if an email has not arrived. If you cannot sign in, email <a href="mailto:support@credentialdomd.com">support@credentialdomd.com</a>.</p><p>Support may use AI assistance. Leave passwords, API keys and patient records out of your message.</p><a class="button" href="/app/">Open the app for support</a></section>
    </main>
    <footer><p>CredentialDoMD · Free invite-only beta. Billing is off.</p><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security & data handling</a></footer>
  </div>
  <script>
    (() => {
      const guides = [...document.querySelectorAll('[data-guide]')];
      const input = document.getElementById('help-search');
      const filters = [...document.querySelectorAll('[data-filter]')];
      let category = '';
      function applyFilter() {
        const words = input.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);
        let count = 0;
        guides.forEach(guide => {
          const text = guide.dataset.search || '';
          const matches = (!category || guide.dataset.category === category) && words.every(word => text.includes(word));
          guide.hidden = !matches;
          if (!matches) guide.querySelector('video')?.pause();
          if (matches) count += 1;
          if (words.length && matches) guide.querySelector('details').open = true;
        });
        filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === category)));
        document.getElementById('result-count').textContent = count + (count === 1 ? ' guide' : ' guides') + ' shown';
        document.getElementById('no-results').hidden = count !== 0;
      }
      function openHash() {
        const target = guides.find(guide => '#' + guide.id === location.hash);
        if (!target) return;
        category = ''; input.value = ''; applyFilter();
        target.querySelector('details').open = true;
        target.scrollIntoView({ block: 'start' });
      }
      document.addEventListener('play', event => {
        if (event.target.tagName !== 'VIDEO') return;
        document.querySelectorAll('video').forEach(video => { if (video !== event.target) video.pause(); });
      }, true);
      guides.forEach(guide => guide.querySelector('details').addEventListener('toggle', event => {
        if (!event.target.open) guide.querySelector('video')?.pause();
      }));
      input.addEventListener('input', applyFilter);
      filters.forEach(button => button.addEventListener('click', () => { category = button.dataset.filter; applyFilter(); }));
      document.addEventListener('click', event => {
        const anchor = event.target.closest('a[href^="#"]');
        if (anchor && anchor.getAttribute('href') === location.hash) openHash();
      });
      window.addEventListener('hashchange', openHash);
      document.getElementById('search-tools').hidden = false;
      applyFilter(); openHash();
    })();
  </script>
</body>
</html>
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const help = JSON.parse(await readFile(resolve(root, 'public/knowledge/credentialdo-help.json'), 'utf8'));
  const videoCatalog = await loadVideoCatalog(root);
  const html = renderHelp(help, videoCatalog);
  const target = resolve(root, 'landing/help.html');
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== html) throw new Error('Help page is stale. Run node scripts/build-help.mjs');
    console.log('Help page matches the reviewed knowledge base');
  } else {
    await writeFile(target, html);
    console.log(`Built ${help.articles.length} written guides`);
  }
}
