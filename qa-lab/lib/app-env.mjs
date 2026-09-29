// The VITE_* environment a QA-lab app build gets.
//
// Feature flags are read from the production deploy workflow's build step
// (.github/workflows/deploy-gh-pages.yml), so the lab app is built with the
// same switches as the live app; only the connection settings differ: the
// local stack through the lab app server, the local anon key, and the
// QA-lab marker that swaps Clerk for the QA sign-in.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { APP_PROXY } from './lab-config.mjs';

export const DEPLOY_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-gh-pages.yml');

/** Literal "true"/"false" VITE_* switches in the workflow's app build step. */
export function productionAppFlags(text = readFileSync(DEPLOY_WORKFLOW, 'utf8')) {
  const start = text.indexOf('- name: Build the app and public site');
  if (start < 0) throw new Error('deploy-gh-pages.yml has no "Build the app and public site" step');
  const next = text.indexOf('\n      - name:', start + 10);
  const step = text.slice(start, next < 0 ? undefined : next);
  const flags = {};
  for (const m of step.matchAll(/^\s+(VITE_[A-Z0-9_]+):\s*"(true|false)"\s*$/gm)) flags[m[1]] = m[2];
  if (!Object.keys(flags).length) throw new Error('no VITE_* switches found in the deploy build step');
  return flags;
}

/** The environment for `vite build/preview/dev --config qa-lab/app/vite.config.mjs`. */
export function qaAppEnv({ appPort, anonKey, base = process.env }) {
  if (!Number.isInteger(appPort) || !anonKey) throw new Error('qaAppEnv needs the app port and the local anon key');
  const env = {};
  // Keep only what node, npm and vite need from the caller; drop every VITE_* the caller had.
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('VITE_')) env[k] = v;
  return {
    ...env,
    ...productionAppFlags(),
    VITE_QA_LAB: '1',
    VITE_SUPABASE_URL: `http://127.0.0.1:${appPort}${APP_PROXY.supabase}`,
    VITE_SUPABASE_ANON_KEY: anonKey,
    // Clerk's key format (pk_live_ + base64 of the frontend API host + "$"), naming the lab's
    // mock issuer. Nothing reads it but the app's startup check; the QA sign-in ignores it.
    VITE_CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from('clerk.qa.credentialdomd.test$').toString('base64')}`,
    QA_LAB_APP_PORT: String(appPort),
  };
}
