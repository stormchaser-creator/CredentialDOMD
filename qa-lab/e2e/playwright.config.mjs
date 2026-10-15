// Playwright configuration for the QA-lab journeys (npm run qa:e2e).
//
// The journeys drive the QA-lab build of the app (qa-lab/.generated/lab.json
// says where it is) as physicians would: Chromium, desk viewport, one fresh
// test physician per journey. Reports and screenshots go under
// qa-lab/.generated/ (gitignored); the checklist results go to
// qa-lab/.generated/results.json. With QA_E2E_RESULTS (parallel-safe mode,
// support/run-options.mjs) the results, traces and HTML report are this run's
// own, beside that file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { browserSettings, runOutputs } from './support/run-options.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = runOutputs();
const ENGINE = browserSettings();
const DEVICE = { chromium: 'Desktop Chrome', webkit: 'Desktop Safari', firefox: 'Desktop Firefox' }[ENGINE.browserName];

// QA_ENGINE is an alias for QA_BROWSER_ENGINE. The runner and reporter use
// the same selection; incompatible aliases fail before a journey starts.
const IPHONE = /^iphone$/i.test(String(process.env.QA_DEVICE || '').trim());
if (IPHONE && ENGINE.browserName === 'firefox') throw new Error('QA_DEVICE=iphone requires Chromium or WebKit');
const IPHONE_15 = { ...devices['iPhone 15'], userAgent: devices['iPhone 15'].userAgent.replace('17_5', '18_7').replace(/Version\/[\d.]+/, 'Version/18.7'), viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
delete IPHONE_15.defaultBrowserType;
const engineUse = {
  ...(IPHONE ? IPHONE_15 : { ...devices[DEVICE], viewport: { width: 1280, height: 900 } }),
  ...ENGINE,
};

export default defineConfig({
  testDir: HERE,
  testMatch: /.*\.spec\.mjs$/,
  outputDir: OUT.artifacts,
  // WebKit-only Practice scenarios run in the default complete suite too;
  // they must never be silently skipped under the Chromium default.
  projects: [
    { name: ENGINE.browserName, testIgnore: '**/ios-practice.spec.mjs' },
    { name: 'ios-practice-webkit', testMatch: '**/ios-practice.spec.mjs', use: {
      ...IPHONE_15, browserName: 'webkit', channel: undefined, serviceWorkers: 'block',
    } },
  ],
  timeout: 6 * 60 * 1000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: Number(process.env.QA_E2E_WORKERS || 3),
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: OUT.html, open: 'never' }],
    [path.join(HERE, 'support', 'results-reporter.mjs'), { outputFile: OUT.results }],
  ],
  use: {
    ...engineUse,
    headless: !process.env.QA_HEADED,
    actionTimeout: 30000,
    navigationTimeout: 60000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: ENGINE.browserName === 'webkit' ? 'block' : 'allow',
  },
});
