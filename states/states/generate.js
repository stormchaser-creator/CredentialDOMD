#!/usr/bin/env node

/**
 * CredentialDOMD - State Page Generator
 *
 * Reads template.html and states-data.json to generate
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

const TEMPLATE_PATH = path.join(__dirname, 'template.html');
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
    return `    <a href="/states/${s.slug}.html" class="related-card">
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
  return match ? match[0].replace(/,/g, '') : '0';
}

function processingTimeToISO(time) {
  const match = time.match(/(\d+)/);
  if (!match) return 'P30D';
  const weeks = parseInt(match[0], 10);
  return `P${weeks * 7}D`;
}

function getCmeDisplay(state) {
  if (state.cmeHours === 0) {
    return 'No fixed CME hours (mandatory topics only)';
  }
  return `${state.cmeHours} hours`;
}

// ─── Generate a Single State Page ────────────────────────────────

function generateStatePage(state, allStates, template) {
  const cmeDisplay = getCmeDisplay(state);
  const feeNumber = extractFeeNumber(state.renewalFee);
  const isoTime = processingTimeToISO(state.processingTime);

  let html = template;

  // Simple replacements
  const replacements = {
    '{{STATE_NAME}}': state.name,
    '{{STATE_ABBREVIATION}}': state.abbreviation,
    '{{STATE_SLUG}}': state.slug,
    '{{BOARD_NAME}}': state.boardName,
    '{{BOARD_URL}}': state.boardUrl,
    '{{RENEWAL_CYCLE}}': state.renewalCycle,
    '{{CME_HOURS_DISPLAY}}': cmeDisplay,
    '{{RENEWAL_FEE}}': state.renewalFee,
    '{{RENEWAL_FEE_NUMBER}}': feeNumber,
    '{{PROCESSING_TIME}}': state.processingTime,
    '{{PROCESSING_TIME_ISO}}': isoTime,
    '{{RENEWAL_MONTH}}': state.renewalMonth,
    '{{CME_DETAILS}}': state.cmeDetails,
    '{{YEAR}}': String(YEAR),
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    html = html.split(placeholder).join(value);
  }

  // Complex replacements (HTML fragments)
  html = html.replace('{{STEPS_HTML}}', buildStepsHTML(state.steps));
  html = html.replace('{{PITFALLS_HTML}}', buildPitfallsHTML(state.pitfalls));
  html = html.replace('{{FAQ_HTML}}', buildFaqHTML(state.faqs));
  html = html.replace('{{FAQ_SCHEMA_ITEMS}}', buildFaqSchema(state.faqs));
  html = html.replace('{{HOWTO_SCHEMA_STEPS}}', buildHowToSteps(state.steps));
  html = html.replace('{{RELATED_STATES_HTML}}', buildRelatedStatesHTML(state.relatedStates, allStates));

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
