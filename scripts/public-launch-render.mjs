import { PUBLIC_LAUNCH_MODE, publicLaunchPresentation } from '../src/content/publicLaunch.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export function publicMembershipEndpoint(supabaseUrl) {
  if (!supabaseUrl) return null;
  const url = new URL(supabaseUrl);
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Public offer status requires the reviewed Supabase origin');
  }
  return `${url.origin}/functions/v1/public-membership-offer`;
}
export const publicLaunchCostAnswer = view => [view.availability, view.foundingRate, view.rateComparison, view.earlyBirdRateLock,
  view.fullPackage, view.promisedBeta, view.practiceTrial, view.lifetimeException, view.refundGuarantee].join(' ');

export function publicLaunchHelp(help, mode = PUBLIC_LAUNCH_MODE) {
  if (!mode.enabled) return help;
  const view = publicLaunchPresentation(mode);
  const copy = structuredClone(help);
  const setup = copy.articles.find(article => article.id === 'first-license');
  if (!setup) throw Error('Missing signup availability in public help');
  setup.audience = ['physicians with active Credential access'];
  setup.availability = 'A signed-in account with active Credential access. NPI lookup needs a connection.';
  setup.notes.push(view.availability, view.rateComparison);
  const practice = copy.articles.find(article => article.id === 'locum-contract');
  if (!practice) throw Error('Missing Practice availability in public help');
  practice.availability = [view.practiceTrial, view.promisedBeta, view.lifetimeException].join(' ');
  const support = copy.articles.find(article => article.id === 'get-help');
  if (!support || !Array.isArray(support.notes)) throw Error('Missing refund request location in public help');
  support.notes.push(view.refundGuarantee);
  return copy;
}

function navigation(fallback, view) {
  const anchor = fallback.match(/^(\s*)<a\b([^>]*)>([\s\S]*?)<\/a>(\s*)$/);
  if (!anchor) throw Error('A launch CTA slot must contain exactly one anchor');
  const attrs = anchor[2].replace(/\s+href="[^"]*"/, '').replace(/\s+aria-label="[^"]*"/, '');
  const icon = anchor[3].match(/<svg\b[\s\S]*?<\/svg>/)?.[0] || '';
  if (/\bdata-public-offer-link\b/.test(attrs)) return `${anchor[1]}<a${attrs} href="#planned-pricing"><span data-membership-review-action>See membership plans</span>${icon ? ` ${icon}` : ''}</a>${anchor[4]}`;
  return `${anchor[1]}<a${attrs} href="${escapeHtml(view.primaryAction.href)}"><span data-membership-action>${escapeHtml(view.primaryAction.shortLabel)}</span>${icon ? ` ${icon}` : ''}</a>${anchor[4]}`;
}

function signupInsteadOfForm(fallback, view) {
  const form = fallback.match(/^\s*<form\b([^>]*)>[\s\S]*<\/form>\s*$/);
  if (!form || !/class="[^"]*\bwl-form\b/.test(form[1])) throw Error('A signup slot must contain a waitlist form');
  const id = form[1].match(/\bid="([^"]*)"/)?.[1];
  const style = form[1].match(/\bstyle="([^"]*)"/)?.[1];
  if (/\bdata-public-offer-link\b/.test(form[1])) return `<div${id ? ` id="${escapeHtml(id)}"` : ''}${style ? ` style="${escapeHtml(style)}"` : ''}><a class="btn-primary" href="#planned-pricing" style="padding:15px 24px;font-size:16px;text-align:center;"><span data-membership-review-action>See membership plans</span></a></div>`;
  return `<div${id ? ` id="${escapeHtml(id)}"` : ''}${style ? ` style="${escapeHtml(style)}"` : ''}><a class="btn-primary" href="${escapeHtml(view.primaryAction.href)}" style="padding:15px 24px;font-size:16px;text-align:center;"><span data-membership-action>${escapeHtml(view.primaryAction.label)}</span></a></div>`;
}

const minimumSlots = {
  home: { cta: 4, form: 2, 'hero-offer': 1, 'early-release': 1, participation: 1, 'faq-availability': 1, 'faq-teams': 1, 'home-faq-json': 1 },
  locums: { cta: 2, form: 2, 'early-release': 1, participation: 1, 'faq-cost': 1, 'faq-json': 1, 'signup-heading': 1, 'signup-eyebrow': 2, 'signup-card-heading': 1 },
  help: { cta: 1, 'early-release': 1, participation: 1 },
  cme: { cta: 1, 'early-release': 1, participation: 1 },
  'state-guides': { cta: 4, 'guide-consent': 4, 'early-release': 1, participation: 1 },
  'state-index': { cta: 4, 'early-release': 1, participation: 1 },
  'watch-pages': { cta: 1, 'early-release': 1, participation: 1 },
  'legal-navigation': { cta: 1 },
};

/** Only explicit marketing slots change. Off mode is byte-for-byte unchanged. */
export function renderPublicLaunch(html, surface, mode = PUBLIC_LAUNCH_MODE, { offerEndpoint = null } = {}) {
  const view = publicLaunchPresentation(mode);
  if (!mode.enabled) return html;
  if (!minimumSlots[surface]) throw Error(`Unknown public launch surface: ${surface}`);
  const homeFaq = [
    { name: 'Can I sign up now?', text: `Yes. Membership is open now. ${view.availability} That founding annual rate stays locked for life while membership remains continuously active.` },
    { name: 'Can my practice manager use this for our whole group?', text: view.teamAvailability },
  ];
  const counts = {};
  const output = html.replace(/<!-- public-launch:([a-z-]+) -->([\s\S]*?)<!-- \/public-launch:\1 -->/g, (_whole, slot, fallback) => {
    counts[slot] = (counts[slot] || 0) + 1;
    if (fallback.includes('<!-- public-launch:')) throw Error('Nested public launch slots are not allowed');
    if (slot === 'cta') return navigation(fallback, view);
    if (slot === 'form') return signupInsteadOfForm(fallback, view);
    if (slot === 'hero-offer') return '<div style="margin:20px 0;padding:18px 20px;border:1px solid var(--emerald);border-radius:14px;background:var(--emerald-glow);"><p data-membership-hero-headline style="font-size:23px;font-weight:750;line-height:1.3;margin:0 0 8px;">Founding offer: $99/year for the first 100 paid members</p><p data-membership-hero-note style="font-size:14px;line-height:1.5;margin:0;">The founding annual rate stays locked for life while membership remains active.</p></div>';
    if (slot === 'guide-consent') return `<p class="guide-choice-sub">${escapeHtml(view.guideCapture.note)} <a href="${escapeHtml(view.primaryAction.href)}"><span data-membership-action>${escapeHtml(view.primaryAction.shortLabel)}</span></a></p>`;
    if (slot === 'home-faq-json') {
      const schema = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: homeFaq.map(answer => ({
        '@type': 'Question', name: answer.name, acceptedAnswer: { '@type': 'Answer', text: answer.text },
      })) };
      return `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`;
    }
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
    if (slot === 'meta') return fallback.replace(/Membership opens by invitation\.|Paid membership opens by invitation; card required at checkout\./g, 'Credential: $99/year for the first 100 paid founding members, then $149 early-bird and $199 standard. Check availability in the app. Early release; card required at checkout.');
    if (slot === 'founding-price') return `<b data-membership-price>${escapeHtml(view.publicPrice)}</b><span data-membership-price-label>${escapeHtml(view.publicPriceLabel)}</span>`;
    if (slot === 'full-price') return '$245<span> / year total</span>';
    if (slot === 'brand') return fallback.replace(/Credential<span>(?:DoMD|DOMD)<\/span>/g, 'Credential<span>DOMD</span>').replace(/\bCredential(?:DOMD|DoMD|DO)\b/g, view.brand);
    const text = {
      'availability': view.availability,
      'faq-availability': homeFaq[0].text,
      'faq-teams': homeFaq[1].text,
      'invitation-copy': `${view.availability} ${view.fullPackage}`,
      'signup-heading': view.signupHeading,
      'signup-eyebrow': 'Membership',
      'signup-card-heading': 'Membership is open',
      'signup-note': 'Card required at checkout. Full refund of your most recent annual payment at any time.',
      'signup-label': view.primaryAction.label,
      'signup-trust': 'Early release · Card required at checkout',
      'audience-badge': 'For MDs and DOs · Membership options',
      'founding-headline': view.publicRateHeadline,
      'founding-rate': view.foundingRate,
      'rate-comparison': `${view.rateComparison} ${view.earlyBirdRateLock}`,
      'full-package': `${view.fullPackage} ${view.refundGuarantee}`,
      'practice-trial': view.practiceTrial,
      'promised-beta': view.promisedBeta,
      'lifetime-exception': view.lifetimeException,
      'early-release': view.earlyRelease,
      'participation': view.founderParticipation,
      'footer-mode': `${view.brand} · Early release. ${view.availability}`,
      'guide-product': 'Use CredentialDOMD to organize your saved licenses, renewal dates and CME alongside your professional documents. Review your records and confirm requirements with the licensing board.',
    }[slot];
    if (text === undefined) throw Error(`Unknown public launch slot: ${slot}`);
    if (slot === 'signup-heading') return `<span data-membership-heading>${escapeHtml(text)}</span>`;
    if (slot === 'founding-headline') return `<span data-membership-headline>${escapeHtml(text)}</span>`;
    if (slot === 'audience-badge') return 'For MDs and DOs · <span data-membership-phase>Membership options</span>';
    return escapeHtml(text) + (slot === 'early-release' ? ' <span data-membership-status role="status" aria-live="polite">Your offer is confirmed before payment. Creating an account does not reserve a founding place.</span>' : '');
  });
  for (const [slot, count] of Object.entries(minimumSlots[surface])) {
    if ((counts[slot] || 0) < count) throw Error(`Incomplete ${surface} migration: ${slot} needs ${count} slots`);
  }
  if (output.includes('<!-- public-launch:')) throw Error(`Unrendered launch slot in ${surface}`);
  const visible = output.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<!--[^]*?-->/g, '').replace(/<[^>]+>/g, ' ');
  // Inspect structured answers too: stripping scripts alone misses stale FAQ offers.
  const structured = [...output.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => JSON.stringify(JSON.parse(match[1]))).join(' ');
  const stale = `${visible} ${structured}`.match(/join (?:the )?(?:waitlist|list)|request (?:beta|early) access|get early access|free during beta|invite.only beta|checkout is not open|billing is off|field testing right now|early access opens to (?:the )?waitlist|waitlist first,? in order|leave your email above|when your spot is ready|earliest names on the list|join the early.access list and mention your group size|practices get priority onboarding|after individual early access opens|founding invitations|invited, signed.in account|new invited physicians/i);
  if (stale) {
    throw Error(`Unmigrated public launch wording in ${surface}: ${stale[0]}`);
  }
  if (/<form\b[^>]*class="[^"]*\bwl-form\b/.test(output) || /<fieldset\b[^>]*class="[^"]*\bguide-choice\b/.test(output)) {
    throw Error(`Unmigrated waitlist form/consent in ${surface}`);
  }
  return output.replace(/<html\b/, '<html data-public-launch="founding-signup"')
    .replace(/aria-label="Join the waitlist"/g, 'aria-label="Membership signup"')
    .replace("connect-src 'none'", offerEndpoint ? `connect-src ${escapeHtml(offerEndpoint)}` : "connect-src 'none'")
    .replace('</body>', `<script type="module" src="/membership-offer.js"${offerEndpoint ? ` data-membership-endpoint="${escapeHtml(offerEndpoint)}"` : ''}></script>\n</body>`);
}
