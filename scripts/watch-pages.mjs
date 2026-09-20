// Static watch pages reuse reviewed help and exact, hash-checked media bytes.
// No publication timestamp is inferred from a video's review timestamp.
import { escapeHtml, renderVideo, validateHelp } from './build-help.mjs';
import { validateVideoCatalog, WATCH_PAGES, watchHref } from './help-videos.mjs';

export function renderWatchPages(help, catalog) {
  validateHelp(help);
  if (!catalog) return [];
  const videos = new Map(validateVideoCatalog(catalog).tutorials.map(video => [video.id, video]));
  const articles = new Map(help.articles.map(article => [article.id, article]));
  const e = escapeHtml;
  return WATCH_PAGES.filter(page => videos.has(page.id)).map(page => {
    const article = articles.get(page.id);
    if (!article) throw Error(`Watch page has no reviewed guide: ${page.id}`);
    const href = watchHref(page.id);
    const canonical = `https://credentialdomd.com${href}`;
    const html = `<!doctype html>
<!-- Generated during packaging from reviewed product help and video assets. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${e(page.title)} | CredentialDoMD</title>
  <meta name="description" content="${e(article.summary)} Watch the short CredentialDoMD tutorial, with captions, transcript and written steps.">
  <link rel="canonical" href="${canonical}">
  <meta name="theme-color" content="#0a1014">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${e(page.title)} | CredentialDoMD">
  <meta property="og:description" content="${e(article.summary)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="https://credentialdomd.com/help/videos/${page.id}/poster.jpg">
  <style>
    :root { color-scheme:dark; --bg:#0a1014; --card:#101b22; --text:#eef4f2; --muted:#aec0bd; --line:#2c414b; --accent:#6ee7b7; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--text); background:var(--bg); font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:var(--accent); text-underline-offset:4px; }
    a:focus-visible, summary:focus-visible, video:focus-visible { outline:3px solid var(--accent); outline-offset:4px; }
    .wrap { max-width:960px; margin:auto; padding:0 24px; }
    .skip { position:absolute; top:-100px; left:16px; padding:12px; background:var(--card); }
    .skip:focus { top:12px; }
    .topnav, .navlinks, .actions, .related, .video-links { display:flex; flex-wrap:wrap; align-items:center; gap:10px 24px; }
    .topnav { justify-content:space-between; border-bottom:1px solid var(--line); padding:18px 0; }
    .topnav a, .related a, .video-links a { display:inline-block; padding:8px 0; }
    .brand { font-weight:800; color:var(--text); text-decoration:none; font-size:20px; }
    header { padding:28px 0 12px; }
    .eyebrow { font-size:13px; color:var(--accent); }
    h1 { font-size:clamp(30px,5vw,48px); line-height:1.12; letter-spacing:-.025em; margin:12px 0 16px; }
    .lead { font-size:19px; color:var(--muted); margin:0; }
    h2 { font-size:25px; margin:28px 0 12px; }
    h3 { font-size:18px; margin:0 0 6px; }
    .tutorial-video { margin:12px 0 28px; }
    .tutorial-video > p, .availability, .updated { color:var(--muted); font-size:14px; }
    .tutorial-video video { display:block; width:100%; height:auto; aspect-ratio:16/9; border-radius:12px; background:#050a0e; border:1px solid var(--line); }
    .video-transcript { border:1px solid var(--line); border-radius:10px; margin-top:16px; }
    .video-transcript summary { padding:12px 16px; cursor:pointer; color:var(--accent); font-weight:700; }
    .transcript-text { padding:0 16px 16px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; }
    li { margin:12px 0; padding-left:4px; }
    ol { padding-left:24px; }
    .notes, .next { padding:22px; border:1px solid var(--line); background:var(--card); border-radius:14px; margin:24px 0; }
    .notes h2, .next h2 { margin-top:0; }
    .button { padding:12px 20px; border-radius:10px; background:var(--accent); color:#08241b; font-weight:750; text-decoration:none; }
    footer { margin-top:32px; border-top:1px solid var(--line); padding:24px 0 36px; font-size:14px; color:var(--muted); }
    footer a { display:inline-block; padding:8px 0; margin-right:18px; }
    @media(max-width:640px) { .wrap { padding:0 18px; } .topnav { align-items:flex-start; flex-direction:column; gap:4px; } .navlinks { gap:8px 18px; } header { padding-top:20px; } .lead { font-size:17px; } .notes, .next { padding:18px; } }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to the video guide</a>
  <div class="wrap">
    <nav class="topnav" aria-label="Main navigation"><a class="brand" href="/">CredentialDoMD</a><div class="navlinks"><a href="/help">All guides</a><a href="/cme/">CME resources</a><a href="/locums">Locum tools</a></div></nav>
    <main id="main">
      <header><div class="eyebrow">Video guide · ${e(article.category)}</div><h1>${e(page.title)}</h1><p class="lead">${e(article.summary)}</p></header>
      ${renderVideo(videos.get(page.id))}
      <section aria-labelledby="steps-heading"><h2 id="steps-heading">Follow the steps</h2><p class="availability">${e(article.availability)}</p><ol>${article.steps.map(step => `<li>${e(step)}</li>`).join('')}</ol></section>
      <section class="notes" aria-labelledby="notes-heading"><h2 id="notes-heading">Good to know</h2><ul>${article.notes.map(note => `<li>${e(note)}</li>`).join('')}</ul></section>
      <p><strong>You’re done when:</strong> ${e(article.success)}</p>
      <p class="updated">Written guide reviewed ${e(article.updatedAt)}. This walkthrough uses synthetic demo data.</p>
      <nav class="related" aria-label="Related guides">${article.related.map(id => `<a href="${e(videos.has(id) && watchHref(id) ? watchHref(id) : `/help#${id}`)}">${e(articles.get(id).title)}</a>`).join('')}</nav>
      <section class="next" aria-labelledby="next-heading"><p><!-- public-launch:early-release -->credentialdomd is an early release. Some workflows are less polished, and the app will continue to evolve.<!-- /public-launch:early-release --></p><p><!-- public-launch:participation -->Founding members help shape what comes next. In the app, ask VERA for help and use support tickets to report problems or suggest improvements.<!-- /public-launch:participation --></p><h2 id="next-heading">Organize your own records</h2><p><!-- public-launch:availability -->credentialdomd membership opens by invitation. Billing is not open. A card is required at future paid checkout. Join the waitlist, or open the app if you already have access.<!-- /public-launch:availability --></p><div class="actions"><!-- public-launch:cta --><a class="button" href="/#join">Request early access</a><!-- /public-launch:cta --><a href="/app/">Open the app</a></div></section>
    </main>
    <footer><a href="/help">All help guides</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security & data handling</a><p>CredentialDoMD · Tools for organizing physician credentials and locum work.</p></footer>
  </div>
</body>
</html>
`;
    return { id: page.id, href, updatedAt: page.updatedAt, html };
  });
}

export function addWatchPagesToSitemap(sitemap, pages) {
  if (!/<\/urlset>\s*$/.test(sitemap)) throw Error('Invalid sitemap closing element');
  const entries = pages.map(page => {
    if (page.href !== watchHref(page.id) || !/^\d{4}-\d{2}-\d{2}$/.test(page.updatedAt)) throw Error('Invalid watch sitemap entry');
    const url = `https://credentialdomd.com${page.href}`;
    if (sitemap.includes(`<loc>${url}</loc>`)) throw Error(`Duplicate watch sitemap entry: ${page.id}`);
    return `  <url><loc>${url}</loc><lastmod>${page.updatedAt}</lastmod></url>\n`;
  }).join('');
  return sitemap.replace('</urlset>', entries + '</urlset>');
}
