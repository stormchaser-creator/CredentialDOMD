// Separate acceptance surface: never discovered by the normal parallel suite.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import standard from '../e2e/playwright.config.mjs';
if (process.env.QA_EXCLUSIVE_AI_BUDGET !== '1' || process.env.QA_E2E_NO_RESTART !== '1' || process.env.QA_E2E_NO_TOPUP !== '1' || !process.env.QA_E2E_RESULTS) {
  throw new Error('AI-budget acceptance needs an exclusive coordinator-released window, QA_EXCLUSIVE_AI_BUDGET=1, NO_RESTART=1, NO_TOPUP=1 and its own QA_E2E_RESULTS.');
}
export default defineConfig({ ...standard, testDir: path.dirname(fileURLToPath(import.meta.url)), testMatch: 'ai-budget.spec.mjs', workers: 1, fullyParallel: false, retries: 0 });
