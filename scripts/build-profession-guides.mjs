#!/usr/bin/env node
// The public renewal guides for physician assistants and nurse practitioners:
//   landing/states/physician-assistant/<slug>.html   (/states/physician-assistant/<slug>)
//   landing/states/nurse-practitioner/<slug>.html    (/states/nurse-practitioner/<slug>)
//
// Every statement on a page comes from the rule data the app already uses
// (src/constants/paStateRules.js, npStateRules.js, certificationRules.js,
// generated from data/app-rules by scripts/generate-app-rules.mjs). This
// script writes sentences around those values and nothing else:
//   * a number, a topic or a rule appears only when the data marks it verified,
//     and it carries the data's own citation;
//   * what the data lists as not yet verified is shown as "not yet verified"
//     with the board link, never as a figure;
//   * the data holds no renewal fee and no expiration date for these licenses,
//     so the page says so and points to the board;
//   * a license whose rules are not verified at all gets a page that says so
//     and is kept out of search (noindex, not in the sitemap).
// Curated text in the data (a topic's note, an agreement's text, a note, an
// option) is printed as it is. The look comes from landing/state-template.html
// (its styles, header and footer), so the two kinds of guide stay alike.
//
//   node scripts/build-profession-guides.mjs          write the pages
//   node scripts/build-profession-guides.mjs --check  exit 1 if a page is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PA_STATE_RULES } from '../src/constants/paStateRules.js';
import { NP_STATE_RULES } from '../src/constants/npStateRules.js';
import { CERTIFICATION_RULES, APP_GENERAL_SOURCES, DEA_APP_RULES } from '../src/constants/certificationRules.js';
import { factUsable } from './generate-app-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export const PROFESSIONS = Object.freeze({
  pa: Object.freeze({ dir: 'physician-assistant', noun: 'physician assistant', short: 'PA', plural: 'physician assistants' }),
  np: Object.freeze({ dir: 'nurse-practitioner', noun: 'nurse practitioner', short: 'NP', plural: 'nurse practitioners' }),
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const httpsUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const monthYear = v => { const m = /^(\d{4})-(\d{2})/.exec(String(v || '')); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
const longDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '')); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(v || ''); };
const every = n => (n === 1 ? 'every year' : `every ${n} years`);
const count = (n, unit) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? unit.replace(/s$/, '') : unit}`;
const sentence = s => { const t = String(s || '').trim(); return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.`; };

// ── The evidence ledger, for the one figure whose citation the generated
// rules do not carry (how often the license itself renews). Same lookup as
// scripts/generate-app-rules.mjs: the first usable fact under a field id.
function ledgerIndex(st) {
  const file = path.join(ROOT, 'data/app-rules/ledger', `${st}.json`);
  const extra = path.join(ROOT, 'data/app-rules/ledger/additions', `${st}.json`);
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const additions = fs.existsSync(extra) ? JSON.parse(fs.readFileSync(extra, 'utf8')) : [];
  const index = new Map();
  const add = f => { if (f?.field) index.set(f.field, [...(index.get(f.field) || []), f]); };
  for (const f of ledger.pa?.facts || []) add(f);
  for (const f of ledger.np?.facts || []) add(f);
  for (const f of Array.isArray(additions) ? additions : additions.facts || []) add(f);
  return index;
}
function ledgerCite(index, id) {
  const m = /^(.*)#(\d+)$/.exec(id || '');
  const fact = m ? [(index.get(m[1]) || [])[Number(m[2]) - 1]].find(factUsable) : (index.get(id) || []).find(factUsable);
  return fact && httpsUrl(fact.url) ? { cite: fact.cite || '', url: httpsUrl(fact.url) } : null;
}
/** The citation behind a canonical { fact } or { facts } entry, or null. */
const specCite = (index, spec) => [...(spec?.facts || []), ...(spec?.fact ? [spec.fact] : [])].map(id => ledgerCite(index, id)).find(Boolean) || null;
/** The curated section the generated rule was built from (data/app-rules/states). */
function canonSection(st, kind) {
  const canon = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/app-rules/states', `${st}.json`), 'utf8'));
  return kind === 'pa' ? canon.pa : canon.np?.[kind];
}

// ── One page's sources, in the order they are first cited.
function sourceBook() {
  const list = [];
  const link = (cite, url) => {
    const href = httpsUrl(url);
    if (!href) return '';
    const label = String(cite || '').trim() || new URL(href).host.replace(/^www\./, '');
    if (!list.some(s => s.url === href && s.cite === label)) list.push({ cite: label, url: href });
    return ` <a class="cite" href="${esc(href)}" target="_blank" rel="noopener nofollow">${esc(label)}</a>`;
  };
  return { list, link };
}

const CE_UNVERIFIED = 'Not yet verified';
function ceSummary(sec) {
  if (sec.ceMode === 'hours') return `${count(sec.total, sec.unit)} ${every(sec.cycle)}`;
  if (sec.ceMode === 'certification') return 'Current national certification';
  if (sec.ceMode === 'none') return 'No general hour requirement';
  if (sec.ceMode === 'options') return 'One of several options';
  return CE_UNVERIFIED;
}

/** The body of one license section (PA license, RN license or APRN license). */
function licenseSection(sec, { stateName, index, book, heading }) {
  const out = [];
  const canon = canonSection(sec.state, sec.kind);
  const linkOf = c => (c ? book.link(c.cite, c.url) : '');
  const window = linkOf(specCite(index, canon?.ce?.window));
  const p = html => out.push(`<p>${html}</p>`);
  const ul = items => out.push(`<ul class="rule-list">${items.map(i => `<li>${i}</li>`).join('')}</ul>`);
  const board = sec.boardUrl ? `<a href="${esc(sec.boardUrl)}" target="_blank" rel="noopener">${esc(sec.board)}</a>` : esc(sec.board);

  // How often the license renews.
  if (sec.licenseCycle != null) {
    const c = (sec.facts?.licenseCycle || []).map(id => ledgerCite(index, id)).find(Boolean);
    p(`The license renews ${every(sec.licenseCycle)}.${c ? book.link(c.cite, c.url) : ''}`);
  } else {
    p(`How often this license renews is not yet verified. Check with the ${board}.`);
  }

  // Continuing education.
  out.push('<h3>Continuing education</h3>');
  if (sec.ceMode === 'hours') {
    p(`${count(sec.total, sec.unit)} ${every(sec.cycle)}.${book.link(sec.source, sec.sourceUrl)}${sec.cycleUrl && sec.cycleUrl !== sec.sourceUrl ? book.link(sec.cycleCite, sec.cycleUrl) : ''}`);
    if (sec.windowRule === 'calendarYears' && sec.windowPreceding) p(`The hours are counted in the calendar years before the renewal year.${window}`);
    if (sec.windowRule === 'fixed' && sec.windowAnchor) p(`The hours are counted in fixed periods of ${count(sec.cycle, 'years')} that began on ${esc(longDate(sec.windowAnchor))}.${window}`);
    if (sec.windowRule === 'unverified') p('How the counting period is dated is not yet verified.');
  } else if (sec.ceMode === 'certification') {
    p(`The continuing education requirement verified for this license is keeping national certification current.${book.link(sec.source, sec.sourceUrl)}`);
  } else if (sec.ceMode === 'none') {
    p(`No general continuing education hours are required to renew this license.${book.link(sec.source, sec.sourceUrl)}`);
  } else if (sec.ceMode === 'options') {
    p('The board accepts any one of these:');
    ul((sec.options || []).map(o => `${esc(sentence(o.text))}${book.link(o.cite, o.url)}`));
  } else {
    p(`The continuing education requirement for this license is not yet verified. Check with the ${board}.`);
  }
  if (sec.cat1min != null) {
    const accepted = (sec.cat1Accepted || []).length ? ` Counted toward it: ${esc(sec.cat1Accepted.join(', '))}.` : '';
    const open = (sec.cat1Unverified || []).length ? ` Not yet verified toward it: ${esc(sec.cat1Unverified.join(', '))}.` : '';
    p(`At least ${count(sec.cat1min, sec.unit)} must be ${esc(sec.cat1note || 'in the named category')}.${book.link(sec.cat1Cite, sec.cat1Url)}${accepted}${open}`);
  }
  if ((sec.totalAccepted || []).length) p(`Accepted toward the total: ${esc(sec.totalAccepted.join(', '))}.${linkOf((sec.facts?.totalAccepted || []).map(id => ledgerCite(index, id)).find(Boolean))}`);
  if ((sec.totalUnverified || []).length) p(`Not yet verified toward the total: ${esc(sec.totalUnverified.join(', '))}.`);
  if (sec.certificationInLieu?.note) p(`${esc(sentence(sec.certificationInLieu.note))}${book.link(sec.certificationInLieu.cite, sec.certificationInLieu.url)}`);
  if (sec.exemption?.text) p(`${esc(sentence(sec.exemption.text))}${book.link(sec.exemption.cite, sec.exemption.url)}`);
  if (sec.satisfiesRn) p(`The board treats the continuing education for this license as meeting the RN requirement too.${linkOf(specCite(index, canon?.ce?.satisfiesRn))}`);
  if ((sec.notes || []).length) ul(sec.notes.map(n => `${esc(sentence(n.text))}${book.link(n.cite, n.url)}`));

  // Required topics the data marks verified.
  const topics = (sec.topics || []).filter(t => t.status === 'verified');
  if (topics.length) {
    out.push('<h3>Required topics</h3>');
    ul(topics.map(t => {
      const hours = t.hours > 0 ? `: ${count(t.hours, sec.unit)}` : '';
      const note = t.note && t.note !== t.topic ? ` ${esc(sentence(t.note))}` : '';
      // The question the app asks the member, which says who the topic is for.
      const when = t.condition?.question ? ` Depends on: ${esc(t.condition.question)}` : '';
      // Only when the curated note does not already give the date.
      const dated = d => d && !String(t.note || '').includes(longDate(d));
      const from = dated(t.expiringOnOrAfter) ? ` For licenses expiring on or after ${esc(longDate(t.expiringOnOrAfter))}.` : '';
      const until = dated(t.expiringBefore) ? ` For licenses expiring before ${esc(longDate(t.expiringBefore))}.` : '';
      const cert = t.notCoveredByCertification ? ' National certification does not cover this.' : t.coveredByCertification ? ' National certification covers this.' : '';
      return `<strong>${esc(t.topic)}</strong>${hours}.${note}${when}${from}${until}${cert}${book.link(t.cite, t.url)}`;
    }));
  }

  // National certification and practice hours at renewal.
  const extra = [];
  const req = sec.certificationRequired;
  if (req) {
    const when = req.condition?.question ? ` Depends on: ${esc(req.condition.question)}` : '';
    extra.push(req.value === true
      ? `Current national certification is required at renewal.${when}${book.link(req.cite, req.url)}`
      : `National certification is not required to renew this license.${book.link(req.cite, req.url)}`);
  }
  if (sec.practiceHours) {
    const h = sec.practiceHours;
    extra.push(`${esc(sentence(h.label || `At least ${count(h.hours, 'practice hours')} in ${count(h.years, 'years')}`))}${book.link(h.cite, h.url)}`);
  }
  if (sec.nlc) {
    const through = sec.nlc.effectiveThrough ? ` The verified source covers this through ${esc(longDate(sec.nlc.effectiveThrough))}.` : '';
    extra.push(`${esc(stateName)} ${sec.nlc.value ? 'is' : 'is not'} a Nurse Licensure Compact state.${through}${book.link(sec.nlc.cite, sec.nlc.url)}`);
  }
  if (extra.length) { out.push('<h3>Certification and practice</h3>'); ul(extra); }

  return `<section class="container content-section">\n  <h2>${esc(heading)}</h2>\n  ${out.join('\n  ')}\n</section>`;
}

function practiceBlock({ practice, prescribing }, book, noun) {
  const items = [];
  const a = practice?.agreement;
  if (a?.text) items.push(`<strong>${esc(a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : 'Practice agreement')}.</strong> ${esc(sentence(a.text))}${(a.cites || []).map(c => book.link(c.cite, c.url)).join('')}`);
  const cs = prescribing?.stateCsRegistration;
  if (cs) items.push(`${cs.value ? 'A separate state controlled substance registration is required to prescribe controlled substances.' : 'No separate state controlled substance registration is required.'}${book.link(cs.cite, cs.url)}`);
  if (!items.length) return '';
  return `<section class="container content-section">\n  <h2>Practice agreement and prescribing</h2>\n  <p>What the board's rules say a ${esc(noun)} keeps in place while licensed:</p>\n  <ul class="rule-list">${items.map(i => `<li>${i}</li>`).join('')}</ul>\n</section>`;
}

function nationalBlock(profession, book) {
  const mate = APP_GENERAL_SOURCES.find(s => s.cite === 'DEA MATE Act Q&A');
  const dea = `<li><strong>DEA registration.</strong> Every DEA registrant attests once to ${count(DEA_APP_RULES.mateHours, 'hours')} of training on treating and managing patients with opioid or other substance use disorders. ${esc(sentence(DEA_APP_RULES.mateSchoolExemption))}${mate ? book.link(mate.cite, mate.url) : ''}</li>`;
  if (profession === 'pa') {
    const n = CERTIFICATION_RULES.NCCPA;
    const c = k => book.link(n.cites?.[k]?.cite, n.cites?.[k]?.url);
    return `<section class="container content-section">\n  <h2>National certification and federal rules</h2>\n  <ul class="rule-list">`
      + `<li><strong>${esc(n.name)} certification.</strong> ${count(n.total, n.unit)} ${every(n.cycleYears)}, at least ${count(n.cat1Min, n.unit)} Category 1.${c('total')} ${esc(sentence(n.exam))}${c('exam')} The deadline is ${esc(sentence(n.deadline))}${c('deadline')}</li>`
      + `${dea}</ul>\n</section>`;
  }
  const bodies = Object.values(CERTIFICATION_RULES).filter(b => b.profession === 'np' && httpsUrl(b.url));
  return `<section class="container content-section">\n  <h2>National certification and federal rules</h2>\n  <ul class="rule-list">`
    + `<li><strong>National certification.</strong> Each certifying body sets its own renewal rules: ${bodies.map(b => `<a href="${esc(b.url)}" target="_blank" rel="noopener nofollow">${esc(b.name)}</a>`).join(', ')}.</li>`
    + `${dea}</ul>\n</section>`;
}

function unverifiedBlock(items, board, boardUrl) {
  const seen = new Set();
  const list = items.filter(i => i?.item && !seen.has(i.item) && seen.add(i.item));
  if (!list.length) return '';
  return `<section class="container content-section">\n  <h2>Not yet verified</h2>\n  <p>We could not confirm these in the board's own rules, so this guide gives no figure for them. Ask the board.</p>\n  <ul class="rule-list open-list">`
    + list.map(i => { const url = httpsUrl(i.boardUrl) || httpsUrl(boardUrl); return `<li>${esc(sentence(i.item))}${url ? ` <a class="cite" href="${esc(url)}" target="_blank" rel="noopener">${esc(board)}</a>` : ''}</li>`; }).join('')
    + '</ul>\n</section>';
}

const EXTRA_CSS = `
/* PROFESSION GUIDES */
.rule-list { margin: 0 0 18px 20px; color: var(--text-secondary); }
.rule-list li { margin: 0 0 12px; line-height: 1.6; }
.rule-list strong { color: var(--text); }
.content-section h3 { font-size: 17px; font-weight: 700; margin: 22px 0 10px; color: var(--text); }
.cite { font-size: 13px; color: var(--emerald-light); text-decoration: underline; text-underline-offset: 2px; white-space: normal; }
.open-list li { color: var(--text-muted); }
.guide-switch { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
`;

function shell() {
  const t = read('landing/state-template.html');
  const between = (a, b) => { const i = t.indexOf(a), j = t.indexOf(b, i); if (i < 0 || j < 0) throw Error(`state template is missing ${a} or ${b}`); return t.slice(i, j); };
  const style = between('<style>', '</style>') + EXTRA_CSS + '</style>';
  const nav = between('<!-- NAV -->', '<!-- BREADCRUMB -->');
  const footer = between('<!-- FOOTER -->', '<!-- STICKY GUIDE BAR');
  const beacon = between('<!-- First-party visit beacon', '<!--/email_off-->');
  const redirect = /<script id="https-redirect">[\s\S]*?<\/script>/.exec(t)?.[0];
  if (!redirect) throw Error('state template is missing the https redirect');
  // The renewal reminder form and its script, the same ones the physician
  // guides carry (guide_reminder_signup). reminderParts() fits them to a page.
  const reminderForm = between('<!-- RENEWAL REMINDER', '<!-- GUIDE EMAIL CAPTURE (primary) -->');
  const reminderScript = between('<!-- Renewal reminder signup', '<script>\n// FAQ Accordion');
  return { style, nav, footer, beacon, redirect, reminderForm, reminderScript };
}

/** One exact replacement, or the build stops: the physician template changed under us. */
function swap(text, from, to) {
  if (text.split(from).length !== 2) throw Error(`state template reminder block changed: expected one "${from}"`);
  return text.replace(from, to);
}
/** The reminder form and script for one PA or NP page: its license name, state and profession. */
function reminderParts(parts, m) {
  const form = swap(parts.reminderForm, 'before your {{STATE_NAME}} license renews', `before your ${esc(m.state.name)} ${esc(m.P.noun)} license renews`);
  let script = swap(parts.reminderScript, "var ABBR = '{{STATE_ABBREVIATION}}';", `var ABBR = '${m.state.abbreviation}';`);
  script = swap(script, 'p_state: ABBR,', `p_state: ABBR, p_profession: '${m.profession}',`);
  if (/\{\{[A-Z_]+\}\}/.test(form + script)) throw Error('unfilled placeholder in the reminder form');
  return { form, script };
}

/** What the reminder email says about one license: only values the data marks verified. */
function reminderEntry(m) {
  return {
    name: m.state.name, guide: `https://credentialdomd.com${m.path}`, board: m.board, boardUrl: httpsUrl(m.boardUrl),
    checked: monthYear(m.verified),
    lines: m.glance.filter(([label, value]) => label !== 'Board' && label !== 'License' && value !== CE_UNVERIFIED),
  };
}

/** Everything one page says, before it becomes HTML. Exported for the tests. */
export function guideModel(profession, state, { index = ledgerIndex(state.abbreviation) } = {}) {
  const P = PROFESSIONS[profession];
  const st = state.abbreviation;
  const book = sourceBook();
  const ctx = { stateName: state.name, index, book };
  let sections, glance, unverified, board, boardUrl, verified, indexable, practice;
  if (profession === 'pa') {
    const r = PA_STATE_RULES[st];
    if (!r) throw Error(`No PA rules for ${st}`);
    ({ board, boardUrl, verified } = r);
    indexable = r.status !== 'unverified';
    glance = [['Board', r.board], ['License', r.licenseTitle || 'Physician assistant license'],
      ['License renews', r.licenseCycle != null ? every(r.licenseCycle) : CE_UNVERIFIED], ['Continuing education', ceSummary(r)]];
    sections = [licenseSection(r, { ...ctx, heading: `${state.name} physician assistant license` })];
    unverified = r.unverified || [];
    practice = { practice: r.practice, prescribing: r.prescribing };
  } else {
    const r = NP_STATE_RULES[st];
    if (!r) throw Error(`No NP rules for ${st}`);
    ({ board, boardUrl } = r);
    verified = r.aprn.verified || r.rn.verified;
    indexable = r.aprn.status !== 'unverified';
    glance = [['Board', r.board], ['APRN license renews', r.aprn.licenseCycle != null ? every(r.aprn.licenseCycle) : CE_UNVERIFIED],
      ['APRN continuing education', ceSummary(r.aprn)], ['RN license renews', r.rn.licenseCycle != null ? every(r.rn.licenseCycle) : CE_UNVERIFIED],
      ['RN continuing education', ceSummary(r.rn)]];
    sections = [
      licenseSection(r.aprn, { ...ctx, heading: `${state.name} APRN license (nurse practitioner)` }),
      licenseSection(r.rn, { ...ctx, heading: `${state.name} RN license` }),
    ];
    unverified = [...(r.aprn.unverified || []), ...(r.rn.unverified || []), ...(r.unverified || [])];
    practice = { practice: r.practice, prescribing: r.prescribing };
  }
  const practiceHtml = practiceBlock(practice, book, P.noun);
  const nationalHtml = nationalBlock(profession, book);
  const openHtml = unverifiedBlock(unverified, board, boardUrl);
  return { profession, P, state, board, boardUrl, verified, indexable, glance, sections, practiceHtml, nationalHtml, openHtml, sources: book.list,
    path: `/states/${P.dir}/${state.slug}`, file: `landing/states/${P.dir}/${state.slug}.html` };
}

function renderPage(m, parts) {
  const { state, P, profession } = m;
  // No reminder on a page that has no verified rules to remind about.
  const reminder = m.indexable ? reminderParts(parts, m) : { form: '', script: '' };
  const other = profession === 'pa' ? PROFESSIONS.np : PROFESSIONS.pa;
  const when = monthYear(m.verified);
  const url = `https://credentialdomd.com${m.path}`;
  const ce = m.glance.find(g => /continuing education/i.test(g[0]))?.[1] || '';
  // Google shows about 60 characters of a title and about 155 of a description
  // and rewrites or cuts anything longer (SEO audit, 2026-11-19), so each is the
  // fullest wording that fits. No brand in the title: Google prints the site name itself.
  const fits = (candidates, max) => candidates.find(c => c.length <= max) || candidates[candidates.length - 1];
  const license = `${state.name} ${P.noun.replace(/\b[a-z]/g, c => c.toUpperCase())} License Renewal`;
  const title = fits([`${license}: CE Requirements`, `${license}: CE Rules`, license], 60);
  const ceText = ce === CE_UNVERIFIED ? '' : `${ce.charAt(0).toLowerCase() + ce.slice(1)}, `;
  const about = `${state.name} ${P.noun} license renewal: ${ceText}`;
  const description = m.indexable
    ? fits([
      `${about}required topics, certification and practice rules, each with the board's source. Checked ${when}.`,
      `${about}required topics and certification rules, each with the board's source. Checked ${when}.`,
      `${about}required topics and certification rules, with sources. Checked ${when}.`,
      `${about}required topics and certification rules.`,
    ], 155)
    : `${state.name} ${P.noun} license renewal: the rules are not yet verified. Board link and federal requirements.`;
  const boardLink = m.boardUrl ? `<a href="${esc(m.boardUrl)}" target="_blank" rel="noopener">${esc(m.board)}</a>` : esc(m.board);
  const lead = m.indexable
    ? `What the ${esc(m.board)} requires to renew, checked against the board's own rules in ${esc(when)}. Every figure below links to its source.`
    : `We have not yet verified the ${esc(state.name)} rules for this license, so this page gives no figures. Start with the ${boardLink}.`;
  const sources = m.sources.length
    ? `<section class="container content-section">\n  <h2>Sources</h2>\n  <p>Checked ${esc(when)}. Rules change; the board's own page is the authority.</p>\n  <ul class="rule-list">${m.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(s.cite)}</a></li>`).join('')}</ul>\n</section>`
    : '';
  const footer = parts.footer.split('{{BOARD_URL}}').join(esc(m.boardUrl || 'https://credentialdomd.com/states/')).split('{{BOARD_NAME}}').join(esc(m.board))
    // The year the rules were checked, not today's: the page must not change on its own.
    .split('{{YEAR}}').join(esc(String(m.verified || '').slice(0, 4)));
  if (/\{\{[A-Z_]+\}\}/.test(footer + parts.nav)) throw Error('unfilled placeholder in the shared header or footer');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${parts.redirect}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${m.indexable ? '' : '<meta name="robots" content="noindex">\n'}<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="https://credentialdomd.com/og-image.png">
<meta property="og:type" content="article">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="CredentialDOMD">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/favicon.ico?v=20261116" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=20261116">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
${parts.style}
<link rel="stylesheet" href="/support-nav.css">
<script src="/support-nav.js" defer></script>
</head>
<body><!--email_off-->

${parts.nav}<!-- BREADCRUMB -->
<div class="breadcrumb">
  <div class="container">
    <nav>
      <ol class="breadcrumb-list">
        <li><a href="https://credentialdomd.com">Home</a></li>
        <li><a href="/states/">License Renewal by State</a></li>
        <li><a href="/states/${esc(state.slug)}">${esc(state.name)}</a></li>
        <li>${esc(P.noun.charAt(0).toUpperCase() + P.noun.slice(1))}</li>
      </ol>
    </nav>
  </div>
</div>

<!-- HERO -->
<section class="hero">
  <div class="container">
    <h1>${esc(state.name)} ${esc(P.noun)} license renewal</h1>
    <p class="hero-subtitle hero-subtitle--lead">${lead}</p>
${profession === 'np' ? '    <p class="hero-subtitle hero-subtitle--detail">A nurse practitioner renews two licenses: the RN license and the APRN license, which some states call a certificate or a registration. The rules for each are below.</p>\n' : ''}    <!-- public-launch:guide-offer --><!-- /public-launch:guide-offer -->
    <div class="guide-switch">
      <a href="/states/${esc(other.dir)}/${esc(state.slug)}" class="hero-portal-link">${esc(state.name)} ${esc(other.noun)} guide &rarr;</a>
      <a href="/states/${esc(state.slug)}" class="hero-portal-link">${esc(state.name)} physician guide &rarr;</a>
      ${m.boardUrl ? `<a href="${esc(m.boardUrl)}" target="_blank" rel="noopener" class="hero-portal-link">${esc(m.board)} &rarr;</a>` : ''}
    </div>
  </div>
</section>

<!-- QUICK FACTS -->
<section class="container">
  <div class="quick-facts">
    <div class="quick-facts-title">At a glance: ${esc(state.name)} ${esc(P.noun)} renewal</div>
    <div class="facts-grid">
${m.glance.map(([k, v]) => `      <div class="fact-item">\n        <span class="fact-label">${esc(k)}</span>\n        <span class="fact-value">${esc(v)}</span>\n      </div>`).join('\n')}
    </div>
  </div>
</section>

${reminder.form}
${m.sections.join('\n\n')}

${m.practiceHtml}

${m.nationalHtml}

${m.openHtml}

<section class="container content-section">
  <h2>What this guide does not cover</h2>
  <p>The renewal fee and the date your own license expires are not in this guide. Get both from the ${boardLink}.</p>
</section>

<!-- CTA -->
<section class="container">
  <div class="cta-section">
    <h2>Keep your ${esc(state.name)} license, certification and CE in one place</h2>
    <p><!-- public-launch:guide-product -->Use CredentialDOMD to organize your saved licenses, renewal dates and CME alongside your professional documents. Review your records and confirm requirements with the licensing board.<!-- /public-launch:guide-product --></p>
    <!-- public-launch:cta --><a class="cta-button" href="/app/">Sign up today</a><!-- /public-launch:cta -->
    <p><!-- public-launch:early-release -->CredentialDOMD is an early release. Some workflows are less polished, and the app will continue to evolve.<!-- /public-launch:early-release --></p>
    <p><!-- public-launch:participation -->Founding members help shape what comes next. In the app, ask VERA for help and use support tickets to report problems or suggest improvements.<!-- /public-launch:participation --></p>
    <p class="cta-subtext"><!-- public-launch:signup-trust -->Early release · Card required at checkout<!-- /public-launch:signup-trust --></p>
  </div>
</section>

${sources}

${footer}
${reminder.script}${parts.beacon}<!--/email_off--></body>
</html>
`;
}

/** Every page: [{ file, path, html, indexable, updatedAt }]. */
export function buildProfessionGuides() {
  const states = JSON.parse(read('landing/states/states-data.json')).states;
  const parts = shell();
  const pages = [];
  for (const profession of Object.keys(PROFESSIONS)) {
    for (const state of states) {
      const m = guideModel(profession, state);
      pages.push({ file: m.file, path: m.path, html: renderPage(m, parts), indexable: m.indexable, updatedAt: `${m.verified}-01`, profession, state: state.abbreviation, reminder: reminderEntry(m) });
    }
  }
  return pages;
}

/** The facts the reminder sender needs, by profession and state. */
export const REMINDER_GUIDES_FILE = 'supabase/functions/send-guide-reminders/professionGuides.json';
export function reminderGuidesJson(pages) {
  const out = { pa: {}, np: {} };
  for (const page of pages) out[page.profession][page.state] = page.reminder;
  return JSON.stringify(out, null, 1) + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildProfessionGuides();
  const pages = [...built, { file: REMINDER_GUIDES_FILE, html: reminderGuidesJson(built), indexable: true }];
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const page of pages) {
    const full = path.join(ROOT, page.file);
    const current = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (current === page.html) continue;
    stale++;
    if (!check) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, page.html); }
  }
  if (check && stale) { console.error(`${stale} profession guide pages are stale; run node scripts/build-profession-guides.mjs`); process.exit(1); }
  console.log(`${built.length} profession guides, ${built.filter(p => !p.indexable).length} kept out of search, ${check ? 'all current' : `${stale} written`}`);
}
