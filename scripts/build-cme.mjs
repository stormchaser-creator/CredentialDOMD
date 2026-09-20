#!/usr/bin/env node
// General CME education and website navigation; never an individualized eligibility verdict.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml as e } from './build-help.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Expected a public HTTPS source');
  return url.href;
}
export function validateCme(data, stateData) {
  if (data.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt) || !data.reviewScope) throw Error('Missing CME review metadata');
  const ids = new Set(['main','find-cme','state-boards','learn','questions','tutorials','sources','vera-guide','next-step','vera-title','vera-form','vera-query','vera-status','vera-results','find-title','states-title','state-filter','state-query','state-status','state-empty','learn-title','questions-title','tutorials-title']);
  for (const state of stateData.states || []) {
    const id = `board-${state.slug}`;
    if (ids.has(id)) throw Error('Duplicate state guide');
    ids.add(id);
  }
  for (const group of ['sources','resources','topics','faqs']) {
    if (!Array.isArray(data[group]) || !data[group].length) throw Error(`Missing ${group}`);
    for (const row of data[group]) {
      const domId = group === 'sources' ? `source-${row.id}` : row.id;
      if (!/^[a-z][a-z0-9-]*$/.test(row.id) || ids.has(domId)) throw Error('Invalid or duplicate CME ID');
      ids.add(domId);
      if (group === 'sources') { safeUrl(row.url); if (!row.title || !/^\d{4}-\d{2}-\d{2}$/.test(row.checkedOn)) throw Error('Missing source evidence'); }
      else {
        if (!row.sourceIds?.length || row.sourceIds.some(id => !data.sources.some(source => source.id === id))) throw Error(`Missing source: ${row.id}`);
        if (group === 'faqs' ? !row.question || !row.answer : !row.title || !row.summary) throw Error(`Incomplete CME entry: ${row.id}`);
        if (group === 'topics' && (!Array.isArray(row.paragraphs) || !Array.isArray(row.steps))) throw Error('Incomplete topic');
        if (group === 'resources' && (!row.cost || !row.format)) throw Error('Missing resource terms');
      }
    }
  }
  if (stateData.states?.length !== 51) throw Error('Expected 50 states and DC');
  for (const state of stateData.states) {
    if (!/^[a-z-]+$/.test(state.slug) || !state.name || !state.abbreviation) throw Error('Invalid state guide');
    safeUrl(state.boardUrl);
    if (state.doBoardUrl) safeUrl(state.doBoardUrl);
  }
  return data;
}

export function renderCme(input, stateData) {
  const data = validateCme(input, stateData);
  const sources = new Map(data.sources.map(source => [source.id, source]));
  const refs = row => `<p class="sources">Sources: ${row.sourceIds.map(id => { const s=sources.get(id); return `<a href="${e(safeUrl(s.url))}">${e(s.title)}</a>`; }).join(' · ')}</p>`;
  const cards = data.resources.map(r => `<article id="${e(r.id)}" class="resource-card" data-guide-kind="resource" data-guide-entry data-guide-title="${e(r.title)}" data-guide-summary="${e(r.summary)}" data-guide-tags="courses activities ${e((r.tags||[]).join(' '))}"><p class="eyebrow">${e(r.format)}</p><h3>${e(r.title)}</h3><p>${e(r.summary)}</p><p class="cost">${e(r.cost)}</p><p><a class="text-link" href="${e(safeUrl(sources.get(r.sourceIds[0]).url))}">Explore ${e(r.title)} ↗</a></p>${refs(r)}</article>`).join('\n');
  const topics = data.topics.map(t => `<article id="${e(t.id)}" class="topic" data-guide-entry data-guide-title="${e(t.title)}" data-guide-summary="${e(t.summary)}"><h3>${e(t.title)}</h3><p class="topic-intro">${e(t.summary)}</p>${t.paragraphs.map(p=>`<p>${e(p)}</p>`).join('')}${t.steps.length?`<ol>${t.steps.map(s=>`<li>${e(s)}</li>`).join('')}</ol>`:''}${refs(t)}</article>`).join('\n');
  const faqs = data.faqs.map(f => `<details id="${e(f.id)}" class="faq" data-guide-entry data-guide-title="${e(f.question)}" data-guide-summary="${e(f.answer)}" data-guide-tags="${e((f.tags||[]).join(' '))}"><summary>${e(f.question)}</summary><div><p>${e(f.answer)}</p>${refs(f)}</div></details>`).join('\n');
  const states = [...stateData.states].sort((a,b)=>a.name.localeCompare(b.name)).map(s => {
    const hasDoPage = s.doBoardUrl && !s.doBoardName?.startsWith('null-equivalent');
    return `<article class="state-card" id="board-${e(s.slug)}" data-state="${e(`${s.name} ${s.abbreviation}`.toLowerCase())}" data-abbreviation="${e(s.abbreviation.toLowerCase())}" data-state-name="${e(s.name.toLowerCase())}" data-guide-entry data-guide-title="${e(s.name)} licensing board and CME guide" data-guide-summary="Open the ${e(s.name)} licensing board and the existing state renewal guide." data-guide-tags="${e(s.abbreviation)} state MD DO license"><h3>${e(s.name)} <span>${e(s.abbreviation)}</span></h3><a href="${e(safeUrl(s.boardUrl))}">${hasDoPage?'MD licensing':'Medical licensing board'}</a>${hasDoPage?`<a href="${e(safeUrl(s.doBoardUrl))}">DO licensing</a>`:''}<a href="/states/${e(s.slug)}">State renewal guide →</a><p class="state-review">Guide review: ${e(s.verified || "Date not recorded")}</p></article>`;
  }).join('\n');
  const tutorials = [
    ['scan-cme','Save a CME certificate','Scan a certificate and review the extracted fields.'],
    ['import-cme','Import a transcript','Bring in a transcript, review rows and check duplicates.'],
    ['review-cme','Review your CME progress','Check cycle dates, categories and rule applicability.'],
  ].map(([id,title,summary])=>`<a class="tutorial-card" href="/help/#${id}" data-guide-entry data-guide-title="${title}" data-guide-summary="${summary}" data-guide-href="/help/#${id}"><img src="/help/videos/${id}/poster.jpg" width="1920" height="1080" loading="lazy" alt=""><span class="eyebrow">Video + written guide</span><h3>${title}</h3><p>${summary}</p><span class="text-link">Watch the walkthrough →</span></a>`).join('\n');
  return `<!doctype html>
<!-- Generated by scripts/build-cme.mjs. Edit the knowledge source, not this file. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CME resources, courses & physician renewal guidance | CredentialDoMD</title><meta name="description" content="Find physician CME, understand AMA and AOA credit, locate your licensing board, organize certificates and explore one-time DEA training. Official sources and practical guides."><link rel="canonical" href="https://credentialdomd.com/cme/"><meta name="theme-color" content="#0a1014"><meta name="referrer" content="strict-origin-when-cross-origin"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><link rel="stylesheet" href="/cme-assets/cme.css"><script type="module" src="/cme-assets/cme.mjs"></script></head>
<body><a class="skip" href="#main">Skip to CME resources</a><div class="wrap">
<nav class="topnav" aria-label="Main navigation"><a class="brand" href="/">Credential<span>DoMD</span></a><div class="navlinks"><a href="/states/">License guides</a><a href="/cme/" aria-current="page">CME resources</a><a href="/help/">Help & videos</a><a class="nav-app" href="/app/">Open app ↗</a></div></nav>
<main id="main"><header class="hero"><div><p class="eyebrow">The physician CME resource center</p><h1>Make CME count.<br><span>Know your next step.</span></h1><p class="lead">Find learning that fits your requirements, understand the credit offered, and keep the proof you need for renewal.</p><div class="actions"><a class="button" href="#find-cme">Find CME activities</a><a class="button secondary" href="#state-boards">Check my state board</a></div><p class="review-note">General resources checked <time datetime="${e(data.updatedAt)}">${e(data.updatedAt)}</time>. State guides retain their own review dates.</p></div><aside class="hero-note"><span class="step-label">A simpler CME routine</span><ol><li><strong>Know the requirement</strong><span>Board, license type, cycle and topics.</span></li><li><strong>Choose the right learning</strong><span>Credit, cost and claim deadline.</span></li><li><strong>Keep your evidence</strong><span>Certificate, transcript and completion date.</span></li></ol><a href="#renewal-plan">Build your renewal checklist →</a></aside></header>
<nav class="jump-links" aria-label="CME sections"><a href="#vera-guide">Vera Guide</a><a href="#find-cme">Find activities</a><a href="#state-boards">State boards</a><a href="#learn">Understand CME</a><a href="#questions">Common questions</a><a href="#tutorials">How-to videos</a></nav>
<section id="vera-guide" class="vera-panel" aria-labelledby="vera-title"><div><p class="eyebrow">Vera Guide · Website navigation</p><h2 id="vera-title">What are you trying to do?</h2><p>Find a public guide, resource or answer. For help with your saved records, <a href="/app/">open Vera in the app</a>.</p><p class="fine">This guide searches the website’s reviewed content. It does not generate personalized compliance decisions. Searches stay on this page.</p></div><div><div class="guide-prompts"><a href="#find-cme">Find affordable CME</a><a href="#credit-types">Understand AMA / AOA credit</a><a href="#dea-mate">Check DEA training</a><a href="/help/#import-cme">Import a transcript</a></div><form id="vera-form" hidden><label for="vera-query">Search CME guides and questions</label><div class="search-row"><input type="search" id="vera-query" maxlength="160" autocomplete="off" placeholder="Try “MOC”, “free courses” or “Ohio”"><button type="submit">Find a guide</button></div><p id="vera-status" role="status" aria-live="polite"></p><ul id="vera-results" class="guide-results"></ul></form><noscript><p>Use the topic links above or browse the questions below.</p></noscript></div></section>
<section id="find-cme" aria-labelledby="find-title"><div class="section-heading"><p class="eyebrow">01 / Choose your learning</p><h2 id="find-title">Places to find physician CME</h2><p>Start with the requirement you need to meet. Before enrolling, check the activity’s credit statement, eligibility, total cost and deadline to claim credit.</p></div><div class="resource-grid">${cards}</div><p class="fine">These are independent resources. Availability and prices can change; CredentialDoMD does not award CME credit or guarantee acceptance of an activity.</p></section>
<section id="state-boards" aria-labelledby="states-title"><div class="section-heading"><p class="eyebrow">02 / Start with your board</p><h2 id="states-title">Find your state’s licensing guidance</h2><p>Choose the board that licenses you, especially where MD and DO boards differ. Check your exact cycle, credit categories, required topics, exemptions and record-retention period.</p></div><div class="directory-note"><p><strong>50 states + Washington, DC.</strong> This directory reuses our state-guide links; it is not a new verification of every state’s rules. Individual guides show their sources and review dates. For territories or another board, use the <a href="https://www.fsmb.org/contact-a-state-medical-board/">FSMB board directory</a>.</p></div><div id="state-filter" hidden><label for="state-query">Find a state or abbreviation</label><input id="state-query" type="search" autocomplete="off" maxlength="60" placeholder="e.g., California or CA"><p id="state-status" role="status" aria-live="polite"></p></div><div class="state-grid">${states}</div><p id="state-empty" hidden>No matching state. Try its full name or two-letter abbreviation, or use the <a href="https://www.fsmb.org/contact-a-state-medical-board/">official board directory</a>.</p></section>
<section id="learn" aria-labelledby="learn-title"><div class="section-heading"><p class="eyebrow">03 / Understand what counts</p><h2 id="learn-title">CME, without the guesswork</h2><p>State licensure, specialty certification and DEA registration can ask for different things. Keep each requirement visible.</p></div><nav class="topic-links" aria-label="Learning topics">${data.topics.map(t=>`<a href="#${e(t.id)}">${e(t.title)}</a>`).join('')}</nav><div class="topic-grid">${topics}</div></section>
<section id="questions" aria-labelledby="questions-title"><div class="section-heading"><p class="eyebrow">04 / Answers to common questions</p><h2 id="questions-title">The details that trip people up</h2></div><div class="faq-list">${faqs}</div></section>
<section id="tutorials" aria-labelledby="tutorials-title"><div class="section-heading"><p class="eyebrow">05 / Put it into practice</p><h2 id="tutorials-title">Organize your CME in CredentialDoMD</h2><p>Short narrated walkthroughs with captions, written steps and transcripts. Product tutorials do not award CME credit.</p></div><div class="tutorial-grid">${tutorials}</div></section>
<section id="next-step" class="next-step"><div><p><!-- public-launch:early-release -->credentialdomd is an early release. Some workflows are less polished, and the app will continue to evolve.<!-- /public-launch:early-release --></p><p><!-- public-launch:participation -->Founding members help shape what comes next. Use Vera to get help with the app and share feedback, and use in-app support tickets to report problems or request improvements. Review a ticket before sending it.<!-- /public-launch:participation --></p><p class="eyebrow">From learning to a clear record</p><h2>Keep the evidence with the deadline.</h2><p>Use CredentialDoMD to organize certificates and review your saved CME. Confirm acceptance and unresolved exceptions with the receiving board.</p></div><div class="actions"><a class="button" href="/app/">Open CredentialDoMD</a><!-- public-launch:cta --><a href="/#join">Request beta access →</a><!-- /public-launch:cta --><a href="/help/#get-help">Get product support</a></div></section>
<details id="sources" class="source-register"><summary>Sources, review dates and scope</summary><p>${e(data.reviewScope)}</p><ul>${data.sources.map(s=>`<li id="source-${e(s.id)}"><a href="${e(safeUrl(s.url))}">${e(s.title)}</a> · Resource checked ${e(s.checkedOn)}</li>`).join('')}</ul><p>For an activity-specific question, contact its provider. For acceptance, exemptions or renewal eligibility, contact your licensing or certifying board. <a href="/help/#get-help">Report a broken link or unclear guide</a>.</p></details>
</main><footer><p><!-- public-launch:footer-mode -->credentialdomd · Early release. Membership opens by invitation; billing is not open.<!-- /public-launch:footer-mode --></p><nav aria-label="Footer navigation"><a href="/">Home</a><a href="/states/">License guides</a><a href="/help/">Help & videos</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security & data handling</a></nav></footer></div></body></html>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(await readFile(resolve(root,'public/knowledge/credentialdo-cme.json'),'utf8'));
  const states = JSON.parse(await readFile(resolve(root,'landing/states/states-data.json'),'utf8'));
  const html=renderCme(data,states), output=resolve(root,'landing/cme.html');
  if (process.argv.includes('--check')) {
    if (await readFile(output,'utf8') !== html) throw Error('CME page is stale; run node scripts/build-cme.mjs');
    console.log('CME page matches source');
  } else { await writeFile(output,html); console.log('Built landing/cme.html'); }
}
