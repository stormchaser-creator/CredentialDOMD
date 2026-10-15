// Isolated browser regression for the actual entry component and status hook.
// No lab, account, API, or policy is used. Run with installed Playwright engines:
// PLAYWRIGHT_BROWSERS_PATH=... node qa-lab/administrator-access-pointer.mjs --engine firefox --out /path/to/evidence
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox, webkit, expect } from '@playwright/test';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const engine = value('--engine') || 'firefox';
const browserType = { chromium, firefox, webkit }[engine];
assert.ok(browserType, 'Choose chromium, firefox, or webkit');
const out = path.resolve(value('--out') || 'qa-lab/.generated/administrator-access-pointer');
const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {AdministratorAccessEntry} from './src/components/features/AdministratorAccess.jsx';
    window.__activation = {signout:0,cancel:0};
    createRoot(document.getElementById('root')).render(<div style={{width:500,display:'flex',flexDirection:'column',gap:8}}>
      <AdministratorAccessEntry onOpen={()=>{}} />
      <div style={{height:450}}>Synthetic More controls</div>
      <button style={{height:49}} onClick={()=>window.__activation.cancel++}>Cancel Subscription</button>
      <button style={{height:49}} onClick={()=>window.__activation.signout++}>Sign Out</button>
    </div>);
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'synthetic-status-only', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/credentialPortalClient\.js$/ }, () => ({ path: 'transport', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ loader: 'js', contents: name === 'context'
      ? 'export const useApp=()=>({user:{id:"synthetic-owner"},theme:{}});'
      : `export const CREDENTIAL_PORTAL_ENABLED=true;
        export const credentialPortalRequest=()=>new Promise((resolve,reject)=>{window.__status={resolve,reject};});
        export const portalDeliveryLabel=()=>''; export const adminAccessErrorMessage=()=>'';
        export const isAdminAccessRejection=()=>false; export const standingGrantRequest=()=>({});` }));
  } }],
});
await mkdir(out, { recursive: true });
const results = { engine, scope: 'Isolated real component/hook, synthetic status response; no live account or backend', cases: [] };
const browser = await browserType.launch({ headless: true });
try {
  for (const answer of ['allowed', 'denied', 'failed']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const evidence = { answer };
    try {
      await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await expect.poll(() => page.evaluate(() => Boolean(window.__status))).toBe(true);
      const target = page.getByRole('button', { name: 'Sign Out', exact: true });
      const before = await target.boundingBox();
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.evaluate(answer => {
        if (answer === 'failed') window.__status.reject(new Error('Synthetic unavailable response'));
        else window.__status.resolve({ available: answer === 'allowed' });
      }, answer);
      // Permit React and the old implementation to render while the mouse is held.
      await page.waitForTimeout(100);
      const held = await target.boundingBox();
      evidence.before = before; evidence.held = held;
      await page.screenshot({ path: path.join(out, `${answer}-pressed.png`) });
      await page.mouse.up();
      await page.waitForTimeout(50);
      evidence.activation = await page.evaluate(() => window.__activation);
      assert.deepEqual(held, before, 'a status response must not move the control during a press');
      assert.deepEqual(evidence.activation, { signout: 1, cancel: 0 }, 'the original control receives exactly one click');
      await expect(page.getByRole('button', { name: /Administrator access/ })).toHaveCount(answer === 'allowed' ? 1 : 0);
      assert.deepEqual(errors, []); evidence.status = 'passed';
    } catch (error) { evidence.status = 'failed'; evidence.error = error.message; process.exitCode = 1; }
    finally { results.cases.push(evidence); await context.close(); }
  }
} finally { await browser.close(); await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n'); }
console.log(JSON.stringify({ engine, cases: results.cases.map(({ answer, status }) => ({ answer, status })), output: out }));
