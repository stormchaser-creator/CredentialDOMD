#!/usr/bin/env node

/**
 * CredentialDOMD - State Page Generator
 *
 * Reads ../state-template.html and states-data.json to generate
 * individual SEO pages for all 50 US states.
 *
 * Usage:
 *   node generate.js              # Generate all 50 state pages
 *   node generate.js california   # Generate a single state page
 *   node generate.js --dry-run    # Preview without writing files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template lives one level up so the published states/ folder holds only real pages.
const TEMPLATE_PATH = path.join(__dirname, '..', 'state-template.html');
const DATA_PATH = path.join(__dirname, 'states-data.json');
const OUTPUT_DIR = __dirname;
const YEAR = new Date().getFullYear();

// ─── Load Files ──────────────────────────────────────────────────

function loadTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('ERROR: template.html not found at', TEMPLATE_PATH);
    process.exit(1);
  }
  return fs.readFileSync(TEMPLATE_PATH, 'utf-8');
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error('ERROR: states-data.json not found at', DATA_PATH);
    process.exit(1);
  }
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  return JSON.parse(raw);
}

// ─── Build HTML Fragments ────────────────────────────────────────

function buildStepsHTML(steps) {
  return steps.map(step => `    <li class="step-item">${escapeHtml(step)}</li>`).join('\n');
}

function buildPitfallsHTML(pitfalls) {
  return pitfalls.map(p => `    <li class="pitfall-item">${escapeHtml(p)}</li>`).join('\n');
}

function buildFaqHTML(faqs) {
  return faqs.map((faq, i) => `    <div class="faq-item${i === 0 ? ' open' : ''}">
      <div class="faq-question">
        <span>${escapeHtml(faq.question)}</span>
        <span class="chevron">&#9662;</span>
      </div>
      <div class="faq-answer">${escapeHtml(faq.answer)}</div>
    </div>`).join('\n');
}

function buildFaqSchema(faqs) {
  return faqs.map((faq, i) => {
    const comma = i < faqs.length - 1 ? ',' : '';
    return `    {
      "@type": "Question",
      "name": ${JSON.stringify(faq.question)},
      "acceptedAnswer": {
        "@type": "Answer",
        "text": ${JSON.stringify(faq.answer)}
      }
    }${comma}`;
  }).join('\n');
}

function buildHowToSteps(steps) {
  return steps.map((step, i) => {
    const comma = i < steps.length - 1 ? ',' : '';
    return `    {
      "@type": "HowToStep",
      "position": ${i + 1},
      "name": "Step ${i + 1}",
      "text": ${JSON.stringify(step)}
    }${comma}`;
  }).join('\n');
}

function buildRelatedStatesHTML(relatedSlugs, allStates) {
  const stateMap = {};
  allStates.forEach(s => { stateMap[s.slug] = s; });

  return relatedSlugs.map(slug => {
    const s = stateMap[slug];
    if (!s) return '';
    return `    <a href="/states/${s.slug}" class="related-card">
      <span class="state-abbr">${s.abbreviation}</span>
      <span class="state-name">${s.name} License Renewal</span>
    </a>`;
  }).filter(Boolean).join('\n');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractFeeNumber(fee) {
  const match = fee.match(/[\d,]+/);
  return match ? match[0].replace(/,/g, '') : '';
}

function processingTimeToISO(time) {
  const match = time.match(/(\d+)/);
  if (!match) return 'P30D';
  const weeks = parseInt(match[0], 10);
  return `P${weeks * 7}D`;
}

function feeShort(state) {
  if (!state.renewalFee) return null;
  const m = state.renewalFee.match(/\$[\d,]+(?:\.\d\d)?/);
  return m ? m[0].replace(/\.00$/, '') : null;
}

function getCmeDisplay(state) {
  if (state.cmeHours === 0) return 'No CME hours required';
  if (state.cmeHours == null) return 'See board';
  return `${state.cmeHours} hours`;
}

// Short, snippet-friendly deadline for titles and quick facts.
function deadlineShort(state) {
  const a = state.renewalAnchor || '';
  const m = a.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/);
  if (m) return m[0];
  if (state.renewalMonth) return state.renewalMonth;
  const m2 = a.match(/(birth month|anniversary|last name|odd years|even years)/i);
  return m2 ? m2[0].replace(/^\w/, c => c.toUpperCase()) : 'See board';
}
function deadlineSentence(state) {
  return state.renewalAnchor ? escapeHtml(state.renewalAnchor.split('.')[0] + '.') : `Renewal is due ${deadlineShort(state)}.`;
}

function factItem(label, value) {
  return `      <div class="fact-item">
        <span class="fact-label">${escapeHtml(label)}</span>
        <span class="fact-value">${escapeHtml(value)}</span>
      </div>`;
}

function renewalDetailBlock(state) {
  const rows = [];
  if (state.renewalAnchor) rows.push(['When it is due', state.renewalAnchor]);
  if (state.renewalFee) rows.push(['Fee', state.renewalFee]);
  if (state.lateFee) rows.push(['Late fee', state.lateFee]);
  if (state.graceOrLapse) rows.push(['If you miss the deadline', state.graceOrLapse]);
  if (state.processingTime) rows.push(['Processing time', state.processingTime]);
  if (state.cmeSplit && state.cmeDetails) rows.push(['MD vs DO', 'This state runs separate MD and DO requirements. ' + state.cmeDetails]);
  if (!rows.length) return '';
  const items = rows.map(([k, v]) => `      <div style="padding:14px 0;border-bottom:1px solid var(--border-subtle);">
        <div style="font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${escapeHtml(k)}</div>
        <div style="color:var(--text-secondary);">${escapeHtml(v)}</div>
      </div>`).join('\n');
  return `<section class="container content-section">
  <h2><span class="section-number">i</span> Deadlines, fees, and what happens if you are late</h2>
  <div class="quick-facts" style="margin-top:8px;">
${items}
  </div>
</section>`;
}

function sourcesBlock(state) {
  const verified = state.verified === '2026-08' ? 'Double-checked against a second official source' : 'From the board\'s own pages';
  const links = (state.sources || []).map(x => `      <li style="margin-bottom:6px;"><a href="${escapeHtml(x.url)}" target="_blank" rel="noopener">${escapeHtml(x.what || x.url)}</a></li>`).join('\n');
  const cme = state.cmeSourceUrl ? `      <li style="margin-bottom:6px;"><a href="${escapeHtml(state.cmeSourceUrl)}" target="_blank" rel="noopener">CME requirement: ${escapeHtml(state.cmeSource || 'state rule')}</a></li>` : '';
  return `<section class="container content-section">
  <h2><span class="section-number">&#10003;</span> Where this comes from</h2>
  <p>${verified}, ${escapeHtml(state.verified && state.verified.startsWith('2026-08') ? 'August 2026' : 'recently')}. These are the primary sources we read:</p>
  <ul style="list-style:none;padding:0;">
${links}
${cme}
  </ul>
  <p style="font-size:13px;color:var(--text-muted);">Boards change fees and rules; always confirm on the board page before you pay. Report anything out of date to support@credentialdomd.com.</p>
</section>`;
}

// ─── Generate a Single State Page ────────────────────────────────

function generateStatePage(state, allStates, template) {
  const cmeDisplay = getCmeDisplay(state);
  const feeNumber = extractFeeNumber(state.renewalFee || '');
  const dShort = deadlineShort(state);

  let html = template;
  const replacements = {
    '{{STATE_NAME}}': state.name,
    '{{STATE_ABBREVIATION}}': state.abbreviation,
    '{{STATE_SLUG}}': state.slug,
    '{{BOARD_NAME}}': state.boardName || 'the state medical board',
    '{{BOARD_URL}}': state.boardUrl || '#',
    '{{PORTAL_URL}}': state.portalUrl || state.boardUrl || '#',
    '{{RENEWAL_CYCLE}}': state.renewalCycle || 'See board',
    '{{CME_HOURS_DISPLAY}}': cmeDisplay,
    '{{RENEWAL_FEE}}': state.renewalFee || 'See board',
    '{{ESTIMATED_COST_BLOCK}}': feeNumber
      ? `\n  "estimatedCost": { "@type": "MonetaryAmount", "currency": "USD", "value": "${feeNumber}" },`
      : '',
    '{{PROCESSING_TIME}}': state.processingTime || 'Not published',
    '{{PROCESSING_TIME_ISO}}': processingTimeToISO(state.processingTime || ''),
    '{{DEADLINE_SHORT}}': dShort,
    '{{DEADLINE_SENTENCE}}': '',  // set below (needs raw HTML entities preserved)
    '{{CME_DETAILS}}': state.cmeDetails || 'See the board for current CME requirements.',
    '{{VERIFIED_DATE}}': (state.verified && state.verified.startsWith('2026-08')) ? 'August 2026' : 'recently',
    '{{YEAR}}': String(YEAR),
    '{{FEE_SHORT}}': feeShort(state) || 'see board',
  };
  for (const [k, v] of Object.entries(replacements)) html = html.split(k).join(String(v));

  // fragments (may contain markup)
  html = html.split('{{DEADLINE_SENTENCE}}').join(deadlineSentence(state));
  html = html.split('{{LATE_FEE_FACT}}').join(state.lateFee ? factItem('Late fee', state.lateFee.split('(')[0].trim()) : '');
  html = html.split('{{RENEWAL_DETAIL_BLOCK}}').join(renewalDetailBlock(state));
  html = html.split('{{SOURCES_BLOCK}}').join(sourcesBlock(state));
  html = html.replace('{{STEPS_HTML}}', buildStepsHTML(state.steps || []));
  html = html.replace('{{PITFALLS_HTML}}', buildPitfallsHTML(state.pitfalls || []));
  html = html.replace('{{FAQ_HTML}}', buildFaqHTML(state.faqs || []));
  html = html.replace('{{FAQ_SCHEMA_ITEMS}}', buildFaqSchema(state.faqs || []));
  html = html.replace('{{HOWTO_SCHEMA_STEPS}}', buildHowToSteps(state.steps || []));
  html = html.replace('{{RELATED_STATES_HTML}}', buildRelatedStatesHTML(state.relatedStates || [], allStates));
  return html;
}

// ─── Main ────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const singleState = args.find(a => !a.startsWith('--'));

  const template = loadTemplate();
  const data = loadData();
  const allStates = data.states;

  const statesToGenerate = singleState
    ? allStates.filter(s => s.slug === singleState)
    : allStates;

  if (singleState && statesToGenerate.length === 0) {
    console.error(`ERROR: No state found with slug "${singleState}"`);
    console.log('Available slugs:', allStates.map(s => s.slug).join(', '));
    process.exit(1);
  }

  console.log(`\nCredentialDOMD State Page Generator`);
  console.log(`${'='.repeat(40)}`);
  console.log(`Template: ${TEMPLATE_PATH}`);
  console.log(`Data: ${DATA_PATH}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Year: ${YEAR}`);
  console.log(`States to generate: ${statesToGenerate.length}`);
  if (dryRun) console.log(`MODE: DRY RUN (no files will be written)\n`);
  else console.log('');

  let generated = 0;
  let skipped = 0;

  for (const state of statesToGenerate) {
    const outputPath = path.join(OUTPUT_DIR, `${state.slug}.html`);
    const html = generateStatePage(state, allStates, template);

    if (dryRun) {
      console.log(`  [DRY RUN] Would write: ${state.slug}.html (${(html.length / 1024).toFixed(1)} KB)`);
    } else {
      fs.writeFileSync(outputPath, html, 'utf-8');
      console.log(`  Generated: ${state.slug}.html (${(html.length / 1024).toFixed(1)} KB)`);
    }
    generated++;
  }

  console.log(`\nDone. ${generated} pages generated.${skipped > 0 ? ` ${skipped} skipped.` : ''}`);
  if (!dryRun) {
    console.log(`\nNext steps:`);
    console.log(`  1. Review the generated pages in a browser`);
    console.log(`  2. Research and fill in [RESEARCH NEEDED] data in states-data.json`);
    console.log(`  3. Re-run this script to regenerate with updated data`);
    console.log(`  4. Deploy to your hosting provider\n`);
  }
}

main();
