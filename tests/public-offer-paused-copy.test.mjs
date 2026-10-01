// PUBLIC-001: while the owner pauses checkout, a new account is held at the
// pay first gate ("Complete your payment to open your account") until checkout
// reopens. The paused hero line said "No payment will be taken; your account
// opens when payment completes", which contradicts itself, beside a "Create
// your account" button with no hint that the account would not open. The line
// and the button now say the account opens when checkout reopens. Offer,
// price and guarantee wording are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { offerPresentation } from '../public/membership-offer.js';

const offer = (phase, availability) => ({ schemaVersion: 1, phase, annualCents: { founding: 9900, earlybird: 14900, standard: 19900 }[phase],
  checkoutEnabled: availability !== 'paused', availability });

for (const phase of ['founding', 'earlybird', 'standard']) {
  test(`${phase}, paused: the status and the button say the account opens when checkout reopens`, () => {
    const view = offerPresentation(offer(phase, 'paused'));
    assert.match(view.status, /opens when checkout reopens/);
    assert.doesNotMatch(view.status, /No payment will be taken; your account opens when payment completes/);
    assert.equal(view.action, 'Create your account for later');
    for (const text of [view.status, view.action]) assert.doesNotMatch(text, /[-–—]/, 'public copy has no hyphens or dashes');
  });

  test(`${phase}, open: the button and the guarantee line are unchanged`, () => {
    const view = offerPresentation(offer(phase, 'available'));
    assert.equal(view.action, 'Create your account');
    assert.equal(view.status, 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.');
  });
}
