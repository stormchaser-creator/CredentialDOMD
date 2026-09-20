import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_LAUNCH_MODE, REQUIRED_LAUNCH_SURFACES, WIRED_LAUNCH_SURFACES, assertPublicLaunchReady, publicLaunchPresentation } from '../src/content/publicLaunch.mjs';

test('production mode opens protected app signup without collecting a waitlist request', () => {
  assert.equal(PUBLIC_LAUNCH_MODE.enabled, true);
  assert.equal(PUBLIC_LAUNCH_MODE.signupHref, '/app/');
  assert.deepEqual(WIRED_LAUNCH_SURFACES, REQUIRED_LAUNCH_SURFACES);
  assert.doesNotThrow(() => assertPublicLaunchReady());
  const view = publicLaunchPresentation();
  assert.equal(view.mode, 'founding-signup');
  assert.deepEqual(view.primaryAction, {
    kind: 'navigation', label: 'Sign up: Credential $149/year', shortLabel: 'Sign up · $149/year', href: '/app/', collectEmail: false,
  });
  assert.equal(view.guideCapture.forceGuideOnly, true);
  assert.equal(view.guideCapture.showWaitlistChoice, false);
  assert.match(view.availability, /signup is open/);
  assert.match(view.availability, /card at checkout/);
  assert.doesNotMatch(view.availability, /Checkout is not open/);
});

test('explicit OFF fixture preserves the waitlist action and optional guide choice', () => {
  const off = { enabled: false, signupHref: null };
  assert.doesNotThrow(() => assertPublicLaunchReady(off));
  const view = publicLaunchPresentation(off);
  assert.equal(view.mode, 'waitlist');
  assert.equal(view.primaryAction.kind, 'waitlist-request');
  assert.equal(view.primaryAction.href, '/#join');
  assert.equal(view.primaryAction.collectEmail, true);
  assert.equal(view.guideCapture.showWaitlistChoice, true);
  assert.equal(view.guideCapture.forceGuideOnly, false);
  assert.equal(view.guideCapture.signupHref, null);
  assert.match(view.availability, /Checkout is not open/);
});

test('an accidental flag flip cannot package a partial paid launch', () => {
  assert.throws(() => assertPublicLaunchReady({ enabled: true, signupHref: null }), /reviewed signup destination/);
  assert.throws(() => assertPublicLaunchReady({ enabled: true, signupHref: '/signup/' }, []), /not wired across/);
  for (const missing of REQUIRED_LAUNCH_SURFACES) {
    assert.throws(() => assertPublicLaunchReady({ enabled: true, signupHref: '/signup/' }, REQUIRED_LAUNCH_SURFACES.filter(id => id !== missing)), new RegExp(missing));
  }
  assert.doesNotThrow(() => assertPublicLaunchReady({ enabled: true, signupHref: '/signup/' }, REQUIRED_LAUNCH_SURFACES));
});

test('paid preview is navigation, and guide delivery cannot imply paid or waitlist signup', () => {
  const view = publicLaunchPresentation({ enabled: true, signupHref: '/signup/' });
  assert.equal(view.primaryAction.kind, 'navigation');
  assert.equal(view.primaryAction.collectEmail, false);
  assert.equal(view.primaryAction.href, '/signup/');
  assert.equal(view.guideCapture.forceGuideOnly, true);
  assert.equal(view.guideCapture.showWaitlistChoice, false);
  assert.equal(view.guideCapture.signupIsSeparateNavigation, true);
  assert.equal(view.guideCapture.submitLabel, 'Email me the guide');
  assert.match(view.guideCapture.note, /does not create an account/);
  assert.match(view.primaryAction.label, /Credential \$149\/year/);
  assert.match(view.availability, /New members can choose Credential for \$149\/year/);
  assert.match(view.foundingRate, /reserved for eligible earlier waitlist members/);
  assert.match(view.promisedBeta, /first activate their account with a verified email address/);
  assert.match(view.promisedBeta, /does not restart those 30 days/);
  assert.doesNotMatch(view.promisedBeta, /invitation will confirm/);
});

test('unreviewed, external and data-bearing signup destinations are rejected', () => {
  for (const href of ['', null, 'javascript:alert(1)', '//external.invalid/signup/', 'https://credentialdomd.com.external.invalid/signup/',
    'https://owner@credentialdomd.com/signup/', '/api/waitlist', '/credential-access/', '/signup/?email=example', ' /signup/']) {
    assert.throws(() => publicLaunchPresentation({ enabled: true, signupHref: href }), undefined, String(href));
  }
  for (const enabled of ['true', 1, null]) assert.throws(() => publicLaunchPresentation({ enabled, signupHref: '/signup/' }), /boolean/);
});

test('both views retain the active-membership rate condition and distinct earlier promises', () => {
  for (const enabled of [false, true]) {
    const view = publicLaunchPresentation({ enabled, signupHref: '/signup/' });
    assert.equal(view.brand, 'CredentialDOMD');
    assert.match(view.earlyRelease, /less polished/);
    assert.match(view.founderParticipation, /In the app, ask VERA for help/);
    assert.match(view.founderParticipation, /support tickets/);
    assert.match(view.foundingRate, /\$99\/year/);
    assert.match(view.foundingRate, /while (?:their )?membership remains active/);
    assert.match(view.fullPackage, /\$245\/year/);
    assert.match(view.fullPackage, /no founding or early-bird discount/);
    assert.match(view.promisedBeta, /earlier free-beta wording/);
    assert.match(view.promisedBeta, /30 days free with no card/);
    assert.match(view.promisedBeta, /no automatic charge/);
    assert.match(view.lifetimeException, /keep Credential and Practice free for life/);
    assert.match(view.practiceTrial, /separate 30-day Practice trial/);
    assert.match(view.practiceTrial, /explicit purchase/);
  }
});

test('public signup cannot embed an invitation bearer token or any nonempty fragment', () => {
  for (const href of ['/signup/#launch_invite=synthetic-bearer-token', '/app/#launch_invite=synthetic-bearer-token',
    'https://credentialdomd.com/join/#token=synthetic-secret', '/signup/#section', '/signup/#%20']) {
    const mode = { enabled: true, signupHref: href };
    assert.throws(() => assertPublicLaunchReady(mode), /without query data or fragments/);
    assert.throws(() => publicLaunchPresentation(mode), /without query data or fragments/);
  }
  assert.equal(publicLaunchPresentation({ enabled: true, signupHref: '/signup/' }).primaryAction.href, '/signup/');
});
