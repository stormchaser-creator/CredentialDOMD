import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BILLING_CATALOG } from '../supabase/functions/_shared/billingCatalog.mjs';
import { FREE_BETA } from '../src/constants/beta.js';
import { TIERS, getPublicTiers, priceFor, PUBLIC_BILLING_ENABLED } from '../src/utils/pricingEngine.js';

test('only two canonical annual founding offers are ever public', () => {
  for (const count of [0, 9, 10, 100, 1000]) {
    const offers = getPublicTiers(count, { includeResident: true });
    assert.deepEqual(offers.map(o => o.id), ['core', 'core_locum']);
    assert.deepEqual(offers.map(o => o.tier), ['founding', 'locum']);
    for (const offer of offers) {
      assert.equal(offer.annualCents, BILLING_CATALOG.offers[offer.id].unitAmount);
      assert.equal(offer.membership, 'founding');
      assert.equal(offer.trialDays, 0);
      assert.equal(offer.billingCadence, 'annual_only');
      assert.equal(offer.features, TIERS[offer.tier].features);
    }
  }
  assert.deepEqual(getPublicTiers().map(o => o.annualCents), [14900, 24500]);
});
test('canonical prices never become rounded monthly equivalents', () => {
  for (const cadence of ['annual', 'monthly']) {
    assert.equal(priceFor('core', cadence).display, '$149');
    assert.equal(priceFor('core_locum', cadence).display, '$245');
    assert.equal(priceFor('core', cadence).perInterval, '/year');
    assert.equal(priceFor('core_locum', cadence).perInterval, '/year');
  }
});
test('legacy entitlement IDs and feature bundles remain intact; launch stays off', () => {
  assert.deepEqual(Object.keys(TIERS), ['free', 'resident', 'founding', 'solo', 'locum', 'practice', 'group', 'enterprise']);
  assert.deepEqual(TIERS.free.features, ['license_tracker', 'dea_tracker', 'email_alerts']);
  for (const id of ['resident', 'founding', 'solo']) assert.equal(TIERS[id].features, 'all_individual');
  assert.equal(TIERS.locum.features, 'all_locum');
  assert.equal(TIERS.practice.features, 'all_practice');
  assert.equal(TIERS.group.features, 'all_group');
  assert.equal(TIERS.enterprise.features, 'all_enterprise');
  assert.equal(PUBLIC_BILLING_ENABLED, false);
  assert.deepEqual(FREE_BETA, { active: true, endsOn: null });
});

const component = fileURLToPath(new URL('../src/components/pages/PricingModal.jsx', import.meta.url));
const temp = new URL(`.founding-pricing-${randomUUID()}.tmp.mjs`, import.meta.url);
const built = await build({
  entryPoints: [component], bundle: true, write: false, format: 'esm', platform: 'node',
  jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'test-context', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'app-context', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const useApp = () => globalThis.__foundingPricingContext;', loader: 'js' }));
  } }],
});
await writeFile(temp, built.outputFiles[0].text);
const { default: PricingModal } = await import(temp.href);
try {
  test('rendered modal shows planned catalog prices and no purchase buttons in all off states', () => {
    for (const isFreeBeta of [false, true]) for (const isDevMode of [false, true]) {
      globalThis.__foundingPricingContext = { theme: {}, plan: 'locum', isFreeBeta, isDevMode, isDesktop: true,
        checkout: () => { throw Error('Must not call checkout'); } };
      const html = renderToStaticMarkup(React.createElement(PricingModal, { open: true, onClose() {} }));
      assert.match(html, /\$149/);
      assert.match(html, /\$245/);
      assert.equal((html.match(/\/year/g) || []).length, 2);
      assert.match(html, /planned annual prices/);
      assert.match(html, /Billing is off/);
      assert.equal((html.match(/<button/g) || []).length, 1, 'only the Close button remains');
      assert.match(html, /aria-label="Close"/);
      assert.match(html, /href="https:\/\/credentialdomd.com\/security.html"/);
      assert.doesNotMatch(html, /\$12\b|14-day|\/mo\b|US-region|tax-deductible|Start free|Resident|Monthly|Current plan|Recommended/);
      assert.equal((html.match(/<section/g) || []).length, 2);
    }
  });
  test('closed pricing modal renders nothing', () => {
    globalThis.__foundingPricingContext = { theme: {}, isFreeBeta: true };
    assert.equal(renderToStaticMarkup(React.createElement(PricingModal, { open: false, onClose() {} })), '');
  });
} finally {
  await unlink(temp);
  // node:test callbacks run after the current module finishes; context is reset by each test.
}
