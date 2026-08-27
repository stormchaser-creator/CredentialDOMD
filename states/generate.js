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

  // relatedStates entries are objects ({name, slug, abbreviation}) in
  // states-data.json; accept plain slug strings too.
  return relatedSlugs.map(entry => {
    const slug = typeof entry === 'string' ? entry : entry && entry.slug;
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

// CME phrasing for the <title>/twitter ("48 hours CME", "no CME required")
// and the meta description ("48 hours of CME", "no CME hours required"),
// so zero-CME states never render "No CME hours required CME".
function cmeTitlePhrase(state) {
  if (state.cmeHours === 0) return 'no CME required';
  if (state.cmeHours == null) return 'CME per board';
  return `${state.cmeHours} hours CME`;
}
function cmeMetaPhrase(state) {
  if (state.cmeHours === 0) return 'no CME hours required';
  if (state.cmeHours == null) return 'CME set by the board';
  return `${state.cmeHours} hours of CME`;
}

// ─── CME details formatting ──────────────────────────────────────
// states-data.json stores cmeDetails as "<total sentence>. <comma list>",
// optionally split into "MD: ... DO: ..." tracks. Render the total as a
// paragraph and the topic requirements as list items with correct
// singular/plural hours ("1 hr human trafficking" -> "1 hour of human
// trafficking"), instead of dumping the raw comma string into one <p>.

function cmeItemHTML(item) {
  let t = item.trim().replace(/\.$/, '');
  if (!t) return null;
  const atLeast = t.match(/^at least ([\d.]+) Category 1$/i);
  if (atLeast) {
    const n = parseFloat(atLeast[1]);
    return `At least ${atLeast[1]} ${n === 1 ? 'hour' : 'hours'} in Category 1`;
  }
  const hrs = t.match(/^([\d.]+)\s*hrs?\s+(.+)$/i);
  if (hrs) {
    const n = parseFloat(hrs[1]);
    const topic = hrs[2].replace(/\bhiv\/aids\b/i, 'HIV/AIDS');
    return `${hrs[1]} ${n === 1 ? 'hour' : 'hours'} of ${topic}`;
  }
  return t.replace(/^\w/, c => c.toUpperCase());
}

function cmeTrackHTML(label, body) {
  body = body.trim();
  const dot = body.indexOf('. ');
  const lead = dot === -1 ? body : body.slice(0, dot + 1);
  const rest = dot === -1 ? '' : body.slice(dot + 1).trim();
  const prefix = label ? `<strong>${label}:</strong> ` : '';
  let html = `  <p>${prefix}${escapeHtml(lead)}</p>`;
  if (rest) {
    // Keep "required topics: A, B" together as one item.
    let listText = rest.replace(/\.$/, '');
    let requiredTopics = null;
    const rt = listText.match(/(?:^|,\s*)required topics:\s*(.+)$/i);
    if (rt) {
      requiredTopics = rt[1];
      listText = listText.slice(0, rt.index).replace(/,\s*$/, '');
    }
    const items = listText.split(/,\s*/).map(cmeItemHTML).filter(Boolean);
    if (requiredTopics) items.push(`Required topics: ${requiredTopics}`);
    if (items.length) {
      html += `\n  <ul style="color:var(--text-secondary);margin:0 0 16px 20px;">\n` +
        items.map(i => `    <li>${escapeHtml(i)}</li>`).join('\n') +
        `\n  </ul>`;
    }
  }
  return html;
}

function formatCmeDetailsHTML(state) {
  const text = (state.cmeDetails || '').trim();
  if (!text) return '  <p>See the board for current CME requirements.</p>';
  const split = text.match(/^MD:\s*([\s\S]*?)\s*DO:\s*([\s\S]*)$/);
  if (split) {
    return cmeTrackHTML('MD', split[1]) + '\n' + cmeTrackHTML('DO', split[2]);
  }
  return cmeTrackHTML(null, text);
}

// Plain-text version of the same cleanup, for the "MD vs DO" row in the
// renewal detail block (no raw comma dump, correct singulars).
function cmeTrackProse(label, body) {
  body = body.trim();
  const dot = body.indexOf('. ');
  const lead = (dot === -1 ? body : body.slice(0, dot + 1)).replace(/\.$/, '');
  const rest = dot === -1 ? '' : body.slice(dot + 1).trim();
  let listText = rest.replace(/\.$/, '');
  let requiredTopics = null;
  const rt = listText.match(/(?:^|,\s*)required topics:\s*(.+)$/i);
  if (rt) {
    requiredTopics = rt[1];
    listText = listText.slice(0, rt.index).replace(/,\s*$/, '');
  }
  const items = listText ? listText.split(/,\s*/).map(cmeItemHTML).filter(Boolean).map(i => i.replace(/^\w/, c => c.toLowerCase())) : [];
  if (requiredTopics) items.push(`required topics: ${requiredTopics}`);
  const prefix = label ? `${label}: ` : '';
  return prefix + lead + (items.length ? ': ' + items.join(', ') : '') + '.';
}

function cmeInlineProse(text) {
  text = (text || '').trim();
  if (!text) return '';
  const split = text.match(/^MD:\s*([\s\S]*?)\s*DO:\s*([\s\S]*)$/);
  if (split) return cmeTrackProse('MD', split[1]) + ' ' + cmeTrackProse('DO', split[2]);
  return cmeTrackProse(null, text);
}

// ─── Deadline anchors ────────────────────────────────────────────
// Curated per state from renewalAnchor in states-data.json. A state is
// "individual" when the due date depends on the licensee (birth month,
// birthday, license issue date, assigned or per-license dates). Individual
// states must never claim a fixed statewide date in the title, meta, or
// quick facts, so:
//   type:     'fixed' | 'birth-month' | 'birthday' | 'individual'
//   short:    Quick Facts "Renewal Due" value (honest, snippet-length)
//   title:    deadline phrase for the <title>, or null to omit it entirely
//   due:      meta-description phrase completing "due ..."
//   sentence: hero sentence (plain text, transcribed from renewalAnchor)
// Fixed states with different MD and DO dates get title: null so the title
// never picks one profession's date over the other.
const DEADLINE_ANCHORS = {
  'alabama':        { type: 'fixed', short: 'December 31, every year', title: 'December 31 deadline', due: 'December 31 every year', sentence: 'All licenses expire December 31 each year, regardless of when they were issued.' },
  'alaska':         { type: 'fixed', short: 'December 31, even years', title: 'December 31 deadline', due: 'December 31 of even-numbered years', sentence: 'All medical licenses expire December 31 of even-numbered years, regardless of issuance date.' },
  'arizona':        { type: 'individual', short: 'Your birthday (MD); assigned Dec 31 (DO)', title: null, due: 'on or before your birthday (MD) or your assigned December 31 (DO)', sentence: 'MD renewal is due on or before your birthday every other year; DO licenses expire December 31 of your assigned renewal year.' },
  'arkansas':       { type: 'birth-month', short: 'Last day of your birth month', title: 'birth-month deadline', due: 'by the last day of your birth month', sentence: 'Renewal is due annually on or before the last day of your birth month, with no grace period.' },
  'california':     { type: 'individual', short: 'Last day of your issuance month (MD)', title: null, due: 'on the last day of your license issuance month (MD)', sentence: 'MD licenses expire on the last day of the month the license was originally issued, every two years; DO licenses renew on a biennial cycle through BreEZe.' },
  'colorado':       { type: 'fixed', short: 'April 30, odd years', title: 'April 30 deadline', due: 'April 30 of odd-numbered years', sentence: 'All physician licenses expire April 30 of odd-numbered years, regardless of when the license was issued.' },
  'connecticut':    { type: 'birth-month', short: 'Your birth month', title: 'birth-month deadline', due: 'during your birth month', sentence: 'Renewal is due annually during your birth month.' },
  'delaware':       { type: 'fixed', short: 'March 31, odd years', title: 'March 31 deadline', due: 'March 31 of odd-numbered years', sentence: 'All physician licenses expire March 31 of odd-numbered years.' },
  'district-of-columbia': { type: 'birth-month', short: 'Last day of your birth month', title: 'birth-month deadline', due: 'by the last day of your birth month', sentence: 'Licenses expire on the last day of your birth month, in odd or even years matching your birth year.' },
  'florida':        { type: 'fixed', short: 'Jan 31 (MD) / Mar 31 even yrs (DO)', title: null, due: 'January 31 (MD, board-assigned year) or March 31 of even years (DO)', sentence: 'MD licenses expire January 31, in the year set by your board-assigned group; DO licenses renew by March 31 of even-numbered years.' },
  'georgia':        { type: 'birth-month', short: 'Last day of your birth month', title: 'birth-month deadline', due: 'by the last day of your birth month', sentence: 'Renewal is due every two years by the last day of your birth month.' },
  'hawaii':         { type: 'fixed', short: 'Jan 31 even yrs (MD) / Jun 30 even yrs (DO)', title: null, due: 'January 31 of even years (MD) or June 30 of even years (DO)', sentence: 'MD licenses expire January 31 of even-numbered years; DO licenses expire June 30 of even-numbered years.' },
  'idaho':          { type: 'birthday', short: 'Your birthday', title: 'birthday deadline', due: 'on your birthday', sentence: 'Licenses expire on your birthday under the 2026 biennial transition; confirm your individual expiration date in the eDOPL portal.' },
  'illinois':       { type: 'fixed', short: 'July 31, every 3rd year', title: 'July 31 deadline', due: 'July 31 every third year', sentence: 'All Physician and Surgeon licenses expire July 31 every third year, statewide.' },
  'indiana':        { type: 'fixed', short: 'October 31, odd years', title: 'October 31 deadline', due: 'October 31 of odd-numbered years', sentence: 'All physician licenses expire October 31 of odd-numbered years, statewide, regardless of issue date.' },
  'iowa':           { type: 'birth-month', short: 'First day of your birth month', title: 'birth-month deadline', due: 'by the first day of your birth month', sentence: 'Licenses expire on the first day of your birth month, on a two-year cycle.' },
  'kansas':         { type: 'fixed', short: 'Jul 31 (MD) / Oct 31 (DO)', title: null, due: 'July 31 (MD) or October 31 (DO) every year', sentence: 'All MD licenses expire July 31 and all DO licenses expire October 31, every year.' },
  'kentucky':       { type: 'fixed', short: 'March 1, every year', title: 'March 1 deadline', due: 'March 1 every year', sentence: 'Renewal is due by March 1 of each year for all licensees.' },
  'louisiana':      { type: 'birth-month', short: 'First day of your birth month', title: 'birth-month deadline', due: 'by the first day of your birth month', sentence: 'Licenses expire annually on the first day of the month in which you were born.' },
  'maine':          { type: 'birth-month', short: 'Last day of your birth month', title: 'birth-month deadline', due: 'by the last day of your birth month', sentence: 'Licenses expire on the last day of your birth month, in even or odd years matching your birth year.' },
  'maryland':       { type: 'fixed', short: 'September 30', title: 'September 30 deadline', due: 'September 30, in alternating years by last name', sentence: 'Licenses expire September 30, in alternating years by last name: A through L in even years, M through Z in odd years.' },
  'massachusetts':  { type: 'birthday', short: 'Your birth date', title: 'birthday deadline', due: 'on your birth date', sentence: 'Renewal runs on a two-year cycle keyed to your birth date.' },
  'michigan':       { type: 'individual', short: 'Anniversary of your issue date', title: null, due: 'on the anniversary of your license issue date', sentence: 'Licenses expire every three years on the anniversary of the license issue date; check the date printed on your license.' },
  'minnesota':      { type: 'birth-month', short: 'Last day of your birth month', title: 'birth-month deadline', due: 'by the last day of your birth month', sentence: 'The annual renewal cycle ends on the last day of your birth month.' },
  'mississippi':    { type: 'fixed', short: 'June 30, every year', title: 'June 30 deadline', due: 'June 30 every year', sentence: 'The statewide renewal window opens May 1 and the deadline is June 30 each year.' },
  'missouri':       { type: 'fixed', short: 'January 31, every year', title: 'January 31 deadline', due: 'January 31 every year', sentence: 'All physician licenses expire January 31 of every year.' },
  'montana':        { type: 'fixed', short: 'March 31', title: 'March 31 deadline', due: 'March 31 of your renewal year', sentence: 'Licenses expire March 31 of the renewal year; the board sets each license’s renewal year individually.' },
  'nebraska':       { type: 'fixed', short: 'October 1, even years', title: 'October 1 deadline', due: 'October 1 of even-numbered years', sentence: 'All physician licenses expire October 1 of every even-numbered year, regardless of when the license was issued.' },
  'nevada':         { type: 'fixed', short: 'Jun 30 odd yrs (MD) / Dec 31 (DO)', title: null, due: 'June 30 of odd years (MD) or December 31 (DO)', sentence: 'MD registration is due June 30 of odd-numbered years; DO licenses renew by December 31, moving to even-numbered years starting in 2026.' },
  'new-hampshire':  { type: 'individual', short: '2 years from your issue date', title: null, due: 'two years from your license issue date', sentence: 'Licenses are valid for two years from the date of issuance; renewal is due by your license’s own expiration date.' },
  'new-jersey':     { type: 'fixed', short: 'June 30, odd years', title: 'June 30 deadline', due: 'June 30 of odd-numbered years', sentence: 'All MD and DO licenses expire June 30 of odd-numbered years, regardless of when the license was issued.' },
  'new-mexico':     { type: 'fixed', short: 'July 1, every 3rd year', title: 'July 1 deadline', due: 'July 1 every third year', sentence: 'Licenses expire July 1 of every third year; online renewal must be completed by June 30.' },
  'new-york':       { type: 'individual', short: 'Your registration date, every 2 years', title: null, due: 'every two years from your own registration date', sentence: 'Your two-year registration period runs from your own registration date, not a birth month or a fixed statewide date.' },
  'north-carolina': { type: 'birthday', short: 'Within 30 days after your birthday', title: null, due: 'within 30 days after your birthday, every year', sentence: 'Renewal is due every year, no later than 30 days after your birthday.' },
  'north-dakota':   { type: 'birthday', short: 'Your birthday, every other year', title: 'birthday deadline', due: 'on your birthday every other year', sentence: 'Licenses expire on your birthday every other year.' },
  'ohio':           { type: 'individual', short: '2 years from your issuance date', title: null, due: 'two years from your license issuance date', sentence: 'Your license expires two years from its issuance date, not in a fixed statewide month.' },
  'oklahoma':       { type: 'individual', short: 'Your initial-licensure month (MD); Jun 30 (DO)', title: null, due: 'during your initial-licensure month (MD) or by June 30 (DO)', sentence: 'MD reregistration is due annually during the month you were initially licensed; DO licenses expire June 30 every year.' },
  'oregon':         { type: 'fixed', short: 'December 31, odd years', title: 'December 31 deadline', due: 'December 31 of odd-numbered years', sentence: 'The renewal application and fee are due December 31 of each odd-numbered year for all physicians.' },
  'pennsylvania':   { type: 'fixed', short: 'Dec 31 even yrs (MD) / Oct 31 even yrs (DO)', title: null, due: 'December 31 of even years (MD) or October 31 of even years (DO)', sentence: 'MD licenses expire December 31 of even-numbered years; DO licenses expire October 31 of even-numbered years.' },
  'rhode-island':   { type: 'fixed', short: 'June 30, even years', title: 'June 30 deadline', due: 'June 30 of even-numbered years', sentence: 'Licenses run through June 30 of even-numbered years; the renewal must be filed before July 1.' },
  'south-carolina': { type: 'fixed', short: 'June 30, odd years', title: 'June 30 deadline', due: 'June 30 of odd-numbered years', sentence: 'Licenses expire June 30 of odd-numbered years, statewide.' },
  'south-dakota':   { type: 'fixed', short: 'March 1, odd years', title: 'March 1 deadline', due: 'March 1 of odd-numbered years', sentence: 'All physician licenses must be renewed on or before March 1 of odd-numbered years.' },
  'tennessee':      { type: 'birth-month', short: 'Last day of your birth month', title: 'birth-month deadline', due: 'by the last day of your birth month', sentence: 'Renewal is due every two years by the last day of your birth month, with the renewal year keyed to your birth year.' },
  'texas':          { type: 'individual', short: 'Your assigned date: Feb 28, May 31, Aug 31, or Nov 30', title: null, due: 'on your TMB-assigned quarterly date', sentence: 'TMB assigns each license one of four expiration dates: February 28, May 31, August 31, or November 30. Even license numbers expire in even years, odd numbers in odd years.' },
  'utah':           { type: 'fixed', short: 'Jan 31 even yrs (MD) / May 31 even yrs (DO)', title: null, due: 'January 31 of even years (MD) or May 31 of even years (DO)', sentence: 'MD licenses expire January 31 of even years; DO renewals are due May 31 of even years.' },
  'vermont':        { type: 'fixed', short: 'Nov 30 even yrs (MD) / Sep 30 even yrs (DO)', title: null, due: 'November 30 of even years (MD) or September 30 of even years (DO)', sentence: 'MD licenses expire November 30 of even-numbered years; DO licenses renew by September 30 of even-numbered years.' },
  'virginia':       { type: 'birth-month', short: 'Your birth month, even years', title: 'birth-month deadline', due: 'during your birth month in even-numbered years', sentence: 'Renewal is due during your birth month in each even-numbered year.' },
  'washington':     { type: 'birthday', short: 'Your birthday', title: 'birthday deadline', due: 'on your birthday', sentence: 'MD licenses renew every two years on your birthday; DO licenses renew every year on your birthday.' },
  'west-virginia':  { type: 'fixed', short: 'June 30', title: 'June 30 deadline', due: 'June 30', sentence: 'Renewal closes June 30; MD renewal years are staggered by last name, A through L in even years and M through Z in odd years.' },
  'wisconsin':      { type: 'fixed', short: 'October 31, odd years', title: 'October 31 deadline', due: 'October 31 of odd-numbered years', sentence: 'All physicians renew by October 31 of each odd-numbered year, statewide.' },
  'wyoming':        { type: 'fixed', short: 'June 30, every year', title: 'June 30 deadline', due: 'June 30 every year', sentence: 'All physician licenses must be renewed no later than June 30 of each calendar year.' },
};

function deadlineAnchor(state) {
  const a = DEADLINE_ANCHORS[state.slug];
  if (!a) {
    console.error(`ERROR: no deadline anchor curated for "${state.slug}". Add it to DEADLINE_ANCHORS in generate.js (transcribe from renewalAnchor; never guess a date).`);
    process.exit(1);
  }
  return a;
}

// Quick Facts "Renewal Due" value.
function deadlineShort(state) {
  return deadlineAnchor(state).short;
}

// ", <phrase> deadline" for the <title>, or "" when no honest short phrase exists.
function titleDeadlinePhrase(state) {
  const a = deadlineAnchor(state);
  return a.title ? `, ${a.title}` : '';
}

// ", due <phrase>" for meta descriptions.
function metaDuePhrase(state) {
  return `, due ${deadlineAnchor(state).due}`;
}

function deadlineSentence(state) {
  return escapeHtml(deadlineAnchor(state).sentence);
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
  if (state.cmeSplit && state.cmeDetails) rows.push(['MD vs DO', 'This state runs separate MD and DO requirements. ' + cmeInlineProse(state.cmeDetails)]);
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
    '{{CME_TITLE_PHRASE}}': cmeTitlePhrase(state),
    '{{CME_META_PHRASE}}': cmeMetaPhrase(state),
    '{{RENEWAL_FEE}}': state.renewalFee || 'See board',
    '{{ESTIMATED_COST_BLOCK}}': feeNumber
      ? `\n  "estimatedCost": { "@type": "MonetaryAmount", "currency": "USD", "value": "${feeNumber}" },`
      : '',
    '{{PROCESSING_TIME}}': state.processingTime || 'Not published',
    '{{PROCESSING_TIME_ISO}}': processingTimeToISO(state.processingTime || ''),
    '{{DEADLINE_SHORT}}': dShort,
    '{{TITLE_DEADLINE_PHRASE}}': titleDeadlinePhrase(state),
    '{{META_DUE_PHRASE}}': metaDuePhrase(state),
    // NOTE: {{DEADLINE_SENTENCE}} is intentionally NOT in this map. It is
    // filled in the fragment pass below; listing it here with '' deleted the
    // placeholder before that pass ran, leaving the hero sentence empty.
    '{{VERIFIED_DATE}}': (state.verified && state.verified.startsWith('2026-08')) ? 'August 2026' : 'recently',
    '{{YEAR}}': String(YEAR),
    '{{FEE_SHORT}}': feeShort(state) || 'see board',
  };
  for (const [k, v] of Object.entries(replacements)) html = html.split(k).join(String(v));

  // fragments (may contain markup)
  html = html.split('{{DEADLINE_SENTENCE}}').join(deadlineSentence(state));
  html = html.split('{{CME_DETAILS_HTML}}').join(formatCmeDetailsHTML(state));
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
