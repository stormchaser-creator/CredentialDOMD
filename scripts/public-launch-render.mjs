import { PUBLIC_LAUNCH_MODE, publicLaunchPresentation } from '../src/content/publicLaunch.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const publicLaunchCostAnswer = view => [view.availability, view.foundingRate, view.rateComparison, view.earlyBirdRateLock,
  view.fullPackage, view.promisedBeta, view.practiceTrial, view.lifetimeException].join(' ');

export function publicLaunchHelp(help, mode = PUBLIC_LAUNCH_MODE) {
  if (!mode.enabled) return help;
  const view = publicLaunchPresentation(mode);
  const copy = structuredClone(help);
  const practice = copy.articles.find(article => article.id === 'locum-contract');
  if (!practice) throw Error('Missing Practice availability in public help');
  practice.availability = [view.practiceTrial, view.promisedBeta, view.lifetimeException].join(' ');
  return copy;
}

function navigation(fallback, view) {
  const anchor = fallback.match(/^(\s*)<a\b([^>]*)>([\s\S]*?)<\/a>(\s*)$/);
  if (!anchor) throw Error('A launch CTA slot must contain exactly one anchor');
  const attrs = anchor[2].replace(/\s+href="[^"]*"/, '').replace(/\s+aria-label="[^"]*"/, '');
  const icon = anchor[3].match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
  return `${anchor[1]}<a${attrs} href="${escapeHtml(view.primaryAction.href)}">${escapeHtml(view.primaryAction.shortLabel)}${icon ? ` ${icon}` : ''}</a>${anchor[4]}`;
}

function signupInsteadOfForm(fallback, view) {
  const form = fallback.match(/^\s*<form\b([^>]*)>[\s\S]*<\/form>\s*$/);
  if (!form || !/class="[^"]*\bwl-form\b/.test(form[1])) throw Error('A signup slot must contain a waitlist form');
  const id = form[1].match(/\bid="([^"]*)"/)?.[1];
  const style = form[1].match(/\bstyle="([^"]*)"/)?.[1];
  return `<div${id ? ` id="${escapeHtml(id)}"` : ''}${style ? ` style="${escapeHtml(style)}"` : ''}><a class="btn-primary" href="${escapeHtml(view.primaryAction.href)}" style="padding:15px 24px;font-size:16px;text-align:center;">${escapeHtml(view.primaryAction.label)}</a></div>`;
}

const minimumSlots = {
  home: { cta: 4, form: 2, 'early-release': 1, participation: 1 },
  locums: { cta: 2, form: 2, 'early-release': 1, participation: 1, 'faq-cost': 1, 'faq-json': 1 },
  help: { cta: 1, 'early-release': 1, participation: 1 },
  cme: { cta: 1, 'early-release': 1, participation: 1 },
  'state-guides': { cta: 4, 'guide-consent': 4, 'early-release': 1, participation: 1 },
  'state-index': { cta: 4, 'early-release': 1, participation: 1 },
  'watch-pages': { cta: 1, 'early-release': 1, participation: 1 },
  'legal-navigation': { cta: 1 },
};

/** Only explicit marketing slots change. Off mode is byte-for-byte unchanged. */
export function renderPublicLaunch(html, surface, mode = PUBLIC_LAUNCH_MODE) {
  const view = publicLaunchPresentation(mode);
  if (!mode.enabled) return html;
  if (!minimumSlots[surface]) throw Error(`Unknown public launch surface: ${surface}`);
  const counts = {};
  const output = html.replace(/<!-- public-launch:([a-z-]+) -->([\s\S]*?)<!-- \/public-launch:\1 -->/g, (_whole, slot, fallback) => {
    counts[slot] = (counts[slot] || 0) + 1;
    if (fallback.includes('<!-- public-launch:')) throw Error('Nested public launch slots are not allowed');
    if (slot === 'cta') return navigation(fallback, view);
    if (slot === 'form') return signupInsteadOfForm(fallback, view);
    if (slot === 'guide-consent') return `<p class="guide-choice-sub">${escapeHtml(view.guideCapture.note)} <a href="${escapeHtml(view.primaryAction.href)}">${escapeHtml(view.primaryAction.shortLabel)}</a></p>`;
    if (slot === 'faq-json') {
      const match = fallback.match(/^(\s*<script type="application\/ld\+json">)([\s\S]*?)(<\/script>\s*)$/);
      if (!match) throw Error('Missing launch FAQ JSON-LD');
      const json = JSON.parse(match[2]);
      const cost = json.mainEntity?.find(q => q.name === 'What does it cost?');
      if (!cost?.acceptedAnswer) throw Error('Missing launch price question');
      cost.acceptedAnswer.text = publicLaunchCostAnswer(view);
      return `${match[1]}\n${JSON.stringify(json, null, 2).replace(/</g, '\\u003c')}\n${match[3]}`;
    }
    if (slot === 'faq-cost') return escapeHtml(publicLaunchCostAnswer(view));
    if (slot === 'meta') return fallback.replace(/Membership opens by invitation\.|Paid membership opens by invitation; card required at checkout\./g, 'Founding signup is open. Early release; card required at checkout.');
    if (slot === 'founding-price') return '$99<span> / year, Credential founding rate</span>';
    if (slot === 'full-price') return '$245<span> / year total</span>';
    if (slot === 'brand') return fallback.replace(/Credential<span>DOMD<\/span>/g, 'credential<span>domd</span>').replace(/\bCredential(?:DOMD|DoMD|DO)\b/g, view.brand);
    const text = {
      'availability': view.availability,
      'invitation-copy': 'Choose a founding membership and review your terms before creating a paid account.',
      'signup-heading': 'Founding signup',
      'signup-label': view.primaryAction.label,
      'signup-trust': 'Early release · Card required at checkout',
      'audience-badge': 'For MDs and DOs · Founding membership',
      'founding-headline': 'Founding Credential: $99/year, locked while membership remains active.',
      'founding-rate': view.foundingRate,
      'rate-comparison': `${view.rateComparison} ${view.earlyBirdRateLock}`,
      'full-package': view.fullPackage,
      'practice-trial': view.practiceTrial,
      'promised-beta': view.promisedBeta,
      'lifetime-exception': view.lifetimeException,
      'early-release': view.earlyRelease,
      'participation': view.founderParticipation,
      'footer-mode': `${view.brand} · Early release. Founding signup is open; paid membership requires a card at checkout.`,
      'guide-product': 'Use credentialdomd to organize your saved licenses, renewal dates and CME alongside your professional documents. Review your records and confirm requirements with the licensing board.',
    }[slot];
    if (text === undefined) throw Error(`Unknown public launch slot: ${slot}`);
    return escapeHtml(text);
  });
  for (const [slot, count] of Object.entries(minimumSlots[surface])) {
    if ((counts[slot] || 0) < count) throw Error(`Incomplete ${surface} migration: ${slot} needs ${count} slots`);
  }
  if (output.includes('<!-- public-launch:')) throw Error(`Unrendered launch slot in ${surface}`);
  const visible = output.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<!--[^]*?-->/g, '').replace(/<[^>]+>/g, ' ');
  const stale = visible.match(/join (?:the )?(?:waitlist|list)|request (?:beta|early) access|get early access|free during beta|free invite.only beta|checkout is not open|billing is off/i);
  if (stale) {
    throw Error(`Unmigrated public launch wording in ${surface}: ${stale[0]}`);
  }
  if (/<form\b[^>]*class="[^"]*\bwl-form\b/.test(output) || /<fieldset\b[^>]*class="[^"]*\bguide-choice\b/.test(output)) {
    throw Error(`Unmigrated waitlist form/consent in ${surface}`);
  }
  return output.replace(/<html\b/, '<html data-public-launch="founding-signup"')
    .replace(/aria-label="Join the waitlist"/g, 'aria-label="Founding signup"');
}
