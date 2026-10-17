import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSettings } from '../../qa-lab/e2e/support/run-options.mjs';

test('browser engines are explicit and channels cannot silently override another engine', () => {
  assert.deepEqual(browserSettings({}), { browserName: 'chromium' });
  for (const browserName of ['chromium', 'webkit', 'firefox']) assert.deepEqual(browserSettings({ QA_BROWSER_ENGINE: browserName }), { browserName });
  assert.deepEqual(browserSettings({ QA_BROWSER_CHANNEL: 'chrome' }), { browserName: 'chromium', channel: 'chrome' });
  assert.throws(() => browserSettings({ QA_BROWSER_ENGINE: 'safari' }), /Unknown/);
  assert.throws(() => browserSettings({ QA_BROWSER_ENGINE: 'webkit', QA_BROWSER_CHANNEL: 'chrome' }), /requires Chromium/);
});

test('both engine aliases select the same engine and conflicting aliases fail', () => {
  assert.deepEqual(browserSettings({ QA_ENGINE: 'WebKit' }), { browserName: 'webkit' });
  assert.deepEqual(browserSettings({ QA_ENGINE: 'webkit', QA_BROWSER_ENGINE: 'webkit' }), { browserName: 'webkit' });
  assert.throws(() => browserSettings({ QA_ENGINE: 'webkit', QA_BROWSER_ENGINE: 'chromium' }), /must agree/);
  assert.throws(() => browserSettings({ QA_ENGINE: 'webkit', QA_BROWSER_CHANNEL: 'chrome' }), /requires Chromium/);
});

test('the complete config schedules the WebKit-only journeys, and the dedicated WebKit config retains them', async () => {
  const { default: main } = await import('../../qa-lab/e2e/playwright.config.mjs');
  const { default: ios } = await import('../../qa-lab/e2e/webkit.config.mjs');
  const dedicated = main.projects.find(p => p.name === 'ios-practice-webkit');
  assert.equal(dedicated.testMatch, '**/ios-practice.spec.mjs');
  assert.equal(dedicated.use.browserName, 'webkit'); assert.equal(dedicated.use.isMobile, true);
  assert.equal(dedicated.use.serviceWorkers, 'block');
  assert.equal(main.projects[0].testIgnore, dedicated.testMatch);
  const phone = ios.projects.find(p => p.name === 'ios-practice-webkit');
  assert.equal(phone.testMatch, '**/ios-practice.spec.mjs');
  assert.equal(ios.projects[0].testIgnore, phone.testMatch);
  assert.equal(phone.use.browserName, 'webkit');
  assert.equal(phone.use.isMobile, true); assert.equal(phone.use.hasTouch, true);
  assert.equal(phone.use.serviceWorkers, 'block');
  assert.deepEqual(phone.use.viewport, { width: 393, height: 852 });
  assert.equal(ios.use.browserName, 'webkit');
});
