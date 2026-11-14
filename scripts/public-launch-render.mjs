import { PUBLIC_LAUNCH_MODE, publicLaunchPresentation } from '../src/content/publicLaunch.mjs';

// Owner decisions, 2026-11-13. While founder places remain the public site
// presents ONE plan, the Founder plan: $99/year with everything included
// (credential tracking and the Practice tools). Once the 100 founders are
// sold out it presents TWO: Credential at $149/year, with one 30 day Practice
// trial, and Credential + Practice at $245/year. There is no other price
// (supabase/functions/_shared/accessPolicy.mjs). Every page is printed in
// the Founder state and carries the two-plan cards hidden;
// public/membership-offer.js repaints these same sentences (pinned equal by
// tests/site-founder-plan.test.mjs) and switches the cards when the server
// reports the founders are sold out.
export const FOUNDER_PLAN = Object.freeze({
  name: 'Founder plan',
  headline: 'Founder plan: $99/year, everything included',
  price: '$99',
  priceLabel: ' / year',
  offer: 'The Founder plan is $99/year and includes everything: credential tracking and the Practice tools.',
  rateLock: 'That annual rate stays locked for life while membership remains continuously active.',
  rate: 'One plan with everything included, for the first 100 paid members. That annual rate stays locked for life while membership remains continuously active. The app confirms your offer before you choose to pay.',
  heroNote: 'The annual rate stays locked for life while membership remains active.',
  reviewAction: 'See the Founder plan',
  phase: 'Founder plan',
  practice: 'The Practice tools (contracts, work logs, invoices and payment tracking) are included in the Founder plan.',
  team: 'Group-management features are on the roadmap and are not currently available. A membership covers one clinician and does not provide team-wide account management. Contact support@credentialdomd.com to discuss your group’s needs; no release date or priority onboarding is promised.',
  meta: 'Founder plan: $99/year, everything included. Check availability in the app. Early release; card required at checkout.',
});
// Owner decision, 2026-11-13: every signup button and link on the site says
// "Sign up today" (the header: "Sign up" and "Log in"), and site copy talks
// about signing up, not creating an account. The destinations are unchanged.
// src/content/publicLaunch.mjs, which the app also reads, keeps its own label.
export const SIGNUP_LABEL = 'Sign up today';
// What the site says once the founders are sold out (membership-offer.js AFTER).
export const AFTER_FOUNDERS = Object.freeze({
  headline: 'Credential: $149/year. Credential + Practice: $245/year',
  heroNote: 'The 100 Founder places are taken. Credential includes a 30 day Practice trial.',
  offer: 'Credential is $149/year with a 30 day Practice trial, and Credential + Practice is $245/year.',
  rateLock: 'The $149 Credential rate stays locked for life while membership remains continuously active.',
  rate: 'Credential is $149/year with one 30 day Practice trial when your first annual payment is confirmed. Credential + Practice is $245/year. The app confirms your offer before you choose to pay.',
  plans: Object.freeze([
    Object.freeze({ name: 'Credential', price: '$149', featured: true,
      lines: ['Licenses, DEA, certifications, CME tracking, renewal reminders, documents, CV and credential packets.',
        'Includes one 30 day Practice trial when your first annual payment is confirmed. It ends without an added charge.'] }),
    Object.freeze({ name: 'Credential + Practice', price: '$245', featured: false,
      lines: ['Everything in Credential, plus the Practice tools: contracts, work logs, invoices and payment tracking.',
        '30 day Practice trial: join Credential first and try Practice for 30 days before you decide.'] }),
  ]),
});
export const FOUNDER_AVAILABILITY = `Sign up to join. ${FOUNDER_PLAN.offer} Availability is confirmed before payment; signing up does not reserve a place. Paid membership requires a card at checkout and your explicit agreement.`;

// Who the product is for. The app asks each member's profession (MD, DO, PA
// or NP: src/constants/professions.js) and tracks that profession's licence
// types and national certifications.
export const AUDIENCE = 'MDs, DOs, NPs and PAs';
export const NP_PA_QUESTION = 'Is CredentialDOMD for NPs and PAs?';
export const NP_PA_ANSWER = 'Yes. CredentialDOMD is for physicians (MD and DO), nurse practitioners and physician assistants. You choose your profession when you set up your account, and the app tracks the licenses and certifications that go with it: PA licenses and NCCPA certification for PAs, and APRN and RN licenses and national certification (such as AANPCB or ANCC) for NPs. The free state renewal guides on this site cover physician licenses; NP and PA requirements differ by board.';

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
/**
 * The page with every founding offer sentence in its visible text wrapped in
 * the span public/membership-offer.js repaints for the live phase (BILL-004):
 * the availability sentence (plans subtitle, home FAQ, membership cards,
 * footers, help notes), the home FAQ's rate lock (its leading space inside,
 * so a phase with no lock leaves no double space) and the founding rate
 * paragraph. Only text between tags in the body changes, never a tag, an
 * attribute or a script, and text already inside its span is left alone. The
 * static words are unchanged; the markers are all that is added.
 */
export function markLiveOffer(html, view) {
  const marks = [[escapeHtml(FOUNDER_PLAN.offer), 'data-membership-availability'],
    [escapeHtml(` ${FOUNDER_PLAN.rateLock}`), 'data-membership-rate-lock']];
  // The rate paragraph contains the rate lock sentence. It is marked whole and
  // nothing inside it is marked again: membership-offer.js replaces the
  // paragraph's text in one piece, and a span inside it would be lost.
  const rate = escapeHtml(FOUNDER_PLAN.rate);
  const mark = (text, sentence, attribute) => text.split(sentence).join(`<span ${attribute}>${sentence}</span>`);
  const body = html.search(/<body\b/);
  if (body < 0) return html;
  const tokens = html.slice(body).split(/(<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->|<[^>]+>)/);
  for (let i = 0; i < tokens.length; i += 2) {
    const opened = i > 0 ? tokens[i - 1] : '';
    if (opened === '<span data-membership-rate>') continue;
    tokens[i] = tokens[i].split(rate).map(part => {
      for (const [sentence, attribute] of marks) {
        if (part.includes(sentence) && opened !== `<span ${attribute}>`) part = mark(part, sentence, attribute);
      }
      return part;
    }).join(`<span data-membership-rate>${rate}</span>`);
  }
  return html.slice(0, body) + tokens.join('');
}
export function publicMembershipEndpoint(supabaseUrl) {
  if (!supabaseUrl) return null;
  const url = new URL(supabaseUrl);
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Public offer status requires the reviewed Supabase origin');
  }
  return `${url.origin}/functions/v1/public-membership-offer`;
}
export const publicLaunchCostAnswer = view => [FOUNDER_AVAILABILITY, FOUNDER_PLAN.rate,
  view.promisedBeta, view.lifetimeException, view.refundGuarantee].join(' ');

export function publicLaunchHelp(help, mode = PUBLIC_LAUNCH_MODE) {
  if (!mode.enabled) return help;
  const view = publicLaunchPresentation(mode);
  const copy = structuredClone(help);
  const setup = copy.articles.find(article => article.id === 'first-license');
  if (!setup) throw Error('Missing signup availability in public help');
  setup.audience = ['physicians, NPs and PAs with an active membership'];
  setup.availability = 'A signed-in account with an active membership. NPI lookup needs a connection.';
  setup.notes.push(FOUNDER_AVAILABILITY);
  const practice = copy.articles.find(article => article.id === 'locum-contract');
  if (!practice) throw Error('Missing Practice availability in public help');
  practice.availability = [FOUNDER_PLAN.practice, view.promisedBeta, view.lifetimeException].join(' ');
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
  if (/\bdata-public-offer-link\b/.test(attrs)) return `${anchor[1]}<a${attrs} href="#planned-pricing"><span data-membership-review-action>${FOUNDER_PLAN.reviewAction}</span>${icon ? ` ${icon}` : ''}</a>${anchor[4]}`;
  return `${anchor[1]}<a${attrs} href="${escapeHtml(view.primaryAction.href)}"><span data-membership-action>${escapeHtml(SIGNUP_LABEL)}</span>${icon ? ` ${icon}` : ''}</a>${anchor[4]}`;
}

function signupInsteadOfForm(fallback, view) {
  const form = fallback.match(/^\s*<form\b([^>]*)>[\s\S]*<\/form>\s*$/);
  if (!form || !/class="[^"]*\bwl-form\b/.test(form[1])) throw Error('A signup slot must contain a waitlist form');
  const id = form[1].match(/\bid="([^"]*)"/)?.[1];
  const style = form[1].match(/\bstyle="([^"]*)"/)?.[1];
  if (/\bdata-public-offer-link\b/.test(form[1])) return `<div${id ? ` id="${escapeHtml(id)}"` : ''}${style ? ` style="${escapeHtml(style)}"` : ''}><a class="btn-primary" href="#planned-pricing" style="padding:15px 24px;font-size:16px;text-align:center;"><span data-membership-review-action>${FOUNDER_PLAN.reviewAction}</span></a></div>`;
  return `<div${id ? ` id="${escapeHtml(id)}"` : ''}${style ? ` style="${escapeHtml(style)}"` : ''}><a class="btn-primary" href="${escapeHtml(view.primaryAction.href)}" style="padding:15px 24px;font-size:16px;text-align:center;"><span data-membership-action>${escapeHtml(SIGNUP_LABEL)}</span></a></div>`;
}

const SIGNUP_NOTE = 'Card required at checkout. No-hassle 100% money-back guarantee: a full refund of your most recent annual payment, at any time.';

const minimumSlots = {
  home: { cta: 4, form: 2, 'hero-offer': 1, 'early-release': 1, participation: 1, 'faq-availability': 1, 'faq-teams': 1, 'faq-np-pa': 1, 'home-faq-json': 1, 'after-founders-plans': 1, 'refund-guarantee': 1 },
  locums: { cta: 2, form: 2, 'early-release': 1, participation: 1, 'faq-cost': 1, 'faq-json': 1, 'signup-heading': 1, 'signup-eyebrow': 2, 'signup-card-heading': 1, 'refund-guarantee': 1 },
  help: { cta: 1, 'early-release': 1, participation: 1 },
  cme: { cta: 1, 'early-release': 1, participation: 1 },
  'state-guides': { cta: 4, 'guide-consent': 4, 'guide-offer': 1, 'early-release': 1, participation: 1 },
  'state-index': { cta: 4, 'early-release': 1, participation: 1 },
  'watch-pages': { cta: 1, 'early-release': 1, participation: 1 },
  'legal-navigation': { cta: 1 },
  // /pricing shows the same membership cards as the home page's #planned-pricing.
  pricing: { cta: 2, 'founding-headline': 1, availability: 1, 'founding-price': 1, 'founding-rate': 1, 'after-founders-plans': 1, 'refund-guarantee': 1, 'early-release': 1 },
};
// Slots that described other tiers (early bird, standard, the $245 package,
// the Practice trial). No page may carry them again.
const retiredSlots = new Set(['rate-comparison', 'full-price', 'full-package', 'practice-trial']);

/** Only explicit marketing slots change. Off mode is byte-for-byte unchanged. */
export function renderPublicLaunch(html, surface, mode = PUBLIC_LAUNCH_MODE, { offerEndpoint = null } = {}) {
  const view = publicLaunchPresentation(mode);
  if (!mode.enabled) return html;
  if (!minimumSlots[surface]) throw Error(`Unknown public launch surface: ${surface}`);
  const homeFaq = [
    { name: 'Can I sign up now?', text: `Yes. Membership is open now. ${FOUNDER_AVAILABILITY} ${FOUNDER_PLAN.rateLock}` },
    { name: 'Can my practice manager use this for our whole group?', text: FOUNDER_PLAN.team },
    { name: NP_PA_QUESTION, text: NP_PA_ANSWER },
  ];
  const counts = {};
  const output = html.replace(/<!-- public-launch:([a-z-]+) -->([\s\S]*?)<!-- \/public-launch:\1 -->/g, (_whole, slot, fallback) => {
    counts[slot] = (counts[slot] || 0) + 1;
    if (fallback.includes('<!-- public-launch:')) throw Error('Nested public launch slots are not allowed');
    if (retiredSlots.has(slot)) throw Error(`Retired public launch slot in ${surface}: ${slot}. The site presents one plan.`);
    if (slot === 'cta') return navigation(fallback, view);
    if (slot === 'form') return signupInsteadOfForm(fallback, view);
    if (slot === 'hero-offer') return `<div style="margin:20px 0;padding:18px 20px;border:1px solid var(--emerald);border-radius:14px;background:var(--emerald-glow);"><p data-membership-hero-headline style="font-size:23px;font-weight:750;line-height:1.3;margin:0 0 8px;">${escapeHtml(FOUNDER_PLAN.headline)}</p>`
      + `<p data-membership-hero-note style="font-size:14px;line-height:1.5;margin:0;">${escapeHtml(FOUNDER_PLAN.heroNote)}</p></div>`
      // The signup button right under the offer (signup review 2026-10-07: a
      // phone's first screen of the home page had no way to sign up; the
      // first signup button was 16,000 px down). The same button and
      // guarantee sentence as every other signup button (33363fee).
      + (surface === 'home' ? `<div data-hero-signup style="margin:0 0 20px;"><a class="btn-primary" href="${escapeHtml(view.primaryAction.href)}" style="display:inline-block;padding:15px 24px;font-size:16px;text-align:center;"><span data-membership-action>${escapeHtml(SIGNUP_LABEL)}</span></a>`
        + `<p style="font-size:12.5px;line-height:1.5;margin:10px 0 0;color:var(--text-secondary);">${escapeHtml(SIGNUP_NOTE)}</p></div>` : '');
    // Same approved strings and data attributes as the home hero, so membership-offer.js
    // repaints this block when the live phase changes. No new claims, no new price.
    if (slot === 'guide-offer') return '<div class="guide-offer" style="margin:18px 0 0;padding:18px 20px;border:1px solid var(--emerald);border-radius:14px;background:var(--emerald-glow);max-width:600px;">'
      + `<p data-membership-hero-headline style="font-size:19px;font-weight:750;line-height:1.3;margin:0 0 6px;">${escapeHtml(FOUNDER_PLAN.headline)}</p>`
      + '<p style="font-size:14.5px;line-height:1.55;margin:0 0 6px;color:var(--text-secondary);">Use CredentialDOMD to organize your saved licenses, renewal dates and CME alongside your professional documents.</p>'
      + `<p data-membership-hero-note style="font-size:13.5px;line-height:1.5;margin:0 0 14px;color:var(--text-secondary);">${escapeHtml(FOUNDER_PLAN.heroNote)}</p>`
      + `<a href="${escapeHtml(view.primaryAction.href)}" style="display:inline-block;background:var(--emerald);color:#0d0d1a;border-radius:10px;padding:12px 22px;font-weight:700;font-size:15px;text-decoration:none;"><span data-membership-action>${escapeHtml(SIGNUP_LABEL)}</span></a>`
      // Every signup button states the guarantee (33363fee). Same sentence, one source.
      + `<p style="font-size:12.5px;line-height:1.5;margin:10px 0 0;color:var(--text-secondary);">${escapeHtml(SIGNUP_NOTE)}</p>`
      + '</div>';
    if (slot === 'guide-consent') return `<p class="guide-choice-sub">${escapeHtml(view.guideCapture.note.replace('It does not create an account,', 'It does not sign you up,'))} <a href="${escapeHtml(view.primaryAction.href)}"><span data-membership-action>${escapeHtml(SIGNUP_LABEL)}</span></a></p>`;
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
    if (slot === 'meta') return fallback.replace(/Membership opens by invitation\.|Paid membership opens by invitation; card required at checkout\./g, FOUNDER_PLAN.meta);
    if (slot === 'founding-price') return `<b data-membership-price>${escapeHtml(FOUNDER_PLAN.price)}</b><span data-membership-price-label>${escapeHtml(FOUNDER_PLAN.priceLabel)}</span>`;
    // membership-offer.js replaces this paragraph if checkout is no longer
    // selling the founding offer, so a full plan never keeps its rate line.
    if (slot === 'founding-rate') return `<span data-membership-rate>${escapeHtml(FOUNDER_PLAN.rate)}</span>`;
    // The two plan cards for after the founders: printed hidden, shown by
    // membership-offer.js when the server reports the founders are sold out.
    // Their prices are the only two that exist after founding, so they are
    // written here once and nowhere else.
    if (slot === 'after-founders-plans') return '<div class="prices" data-after-founders hidden>'
      + AFTER_FOUNDERS.plans.map(plan => `<article class="price${plan.featured ? ' featured' : ''}"><h3 class="feature-title">${escapeHtml(plan.name)}</h3>`
        + `<p class="amount"><b>${escapeHtml(plan.price)}</b><span> / year</span></p>`
        + plan.lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')
        + `<p><a class="btn-primary" href="${escapeHtml(view.primaryAction.href)}"><span data-membership-action>${escapeHtml(SIGNUP_LABEL)}</span></a></p></article>`).join('')
      + '</div>';
    // The guarantee covers every membership, so it stands on its own line
    // instead of inside the Credential + Practice card.
    if (slot === 'refund-guarantee') return surface === 'home'
      ? `<p style="text-align: center; margin-top: 24px; color: var(--text-secondary);">${escapeHtml(view.refundGuarantee)}</p>`
      : `<p style="margin-bottom: 16px;">${escapeHtml(view.refundGuarantee)}</p>`;
    if (slot === 'brand') return fallback.replace(/Credential<span>(?:DoMD|DOMD)<\/span>/g, 'Credential<span>DOMD</span>').replace(/\bCredential(?:DOMD|DoMD|DO)\b/g, view.brand);
    const text = {
      'availability': FOUNDER_AVAILABILITY,
      'faq-availability': homeFaq[0].text,
      'faq-teams': homeFaq[1].text,
      'invitation-copy': FOUNDER_AVAILABILITY,
      'signup-heading': SIGNUP_LABEL,
      'signup-eyebrow': 'Membership',
      'signup-card-heading': 'Membership is open',
      'signup-note': SIGNUP_NOTE,
      'signup-label': SIGNUP_LABEL,
      'signup-trust': 'Early release · Card required at checkout',
      'audience-badge': `For ${AUDIENCE} · ${FOUNDER_PLAN.phase}`,
      'founding-headline': FOUNDER_PLAN.headline,
      'faq-np-pa': NP_PA_ANSWER,
      'promised-beta': view.promisedBeta,
      'lifetime-exception': view.lifetimeException,
      'early-release': view.earlyRelease,
      'participation': view.founderParticipation,
      'footer-mode': `${view.brand} · Early release. ${FOUNDER_AVAILABILITY}`,
      'guide-product': 'Use CredentialDOMD to organize your saved licenses, renewal dates and CME alongside your professional documents. Review your records and confirm requirements with the licensing board.',
    }[slot];
    if (text === undefined) throw Error(`Unknown public launch slot: ${slot}`);
    if (slot === 'signup-heading') return `<span data-membership-heading>${escapeHtml(text)}</span>`;
    if (slot === 'founding-headline') return `<span data-membership-headline>${escapeHtml(text)}</span>`;
    if (slot === 'audience-badge') return `For ${AUDIENCE} · <span data-membership-phase>${FOUNDER_PLAN.phase}</span>`;
    return escapeHtml(text) + (slot === 'early-release' ? ' <span data-membership-status role="status" aria-live="polite">Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.</span>' : '');
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
  return markLiveOffer(output, view).replace(/<html\b/, '<html data-public-launch="founding-signup"')
    .replace(/aria-label="Join the waitlist"/g, 'aria-label="Membership signup"')
    // A page whose policy already allows its own origin (the CME page, for
    // the visit beacon, scripts/visit-beacon.mjs) keeps it beside the offer endpoint.
    .replace(/connect-src '(none|self)'/, (whole, kept) => offerEndpoint ? `connect-src ${kept === 'self' ? "'self' " : ''}${escapeHtml(offerEndpoint)}` : whole)
    .replace('</body>', `<script type="module" src="/membership-offer.js"${offerEndpoint ? ` data-membership-endpoint="${escapeHtml(offerEndpoint)}"` : ''}></script>\n</body>`);
}
