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
import { runOutputs } from './support/run-options.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = runOutputs();

export default defineConfig({
  testDir: HERE,
  testMatch: /.*\.spec\.mjs$/,
  outputDir: OUT.artifacts,
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
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    // Playwright's own Chromium; QA_BROWSER_CHANNEL=chrome uses the installed Google Chrome instead.
    ...(process.env.QA_BROWSER_CHANNEL ? { channel: process.env.QA_BROWSER_CHANNEL } : {}),
    headless: !process.env.QA_HEADED,
    actionTimeout: 30000,
    navigationTimeout: 60000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
});
