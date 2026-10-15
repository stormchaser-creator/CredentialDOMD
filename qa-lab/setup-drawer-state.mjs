// Actual React components, synthetic records and writers, all network blocked.
// node qa-lab/setup-drawer-state.mjs [--source-root <counterfactual checkout>] [--out <directory>]
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const args = process.argv.slice(2);
const option = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
const root = path.resolve(option('--source-root') || fileURLToPath(new URL('..', import.meta.url)));
const out = path.resolve(option('--out') || path.join(root, 'qa-lab/.generated/setup-drawer-state'));
await mkdir(out, { recursive: true });
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState,useCallback} from 'react';
    import {createRoot} from 'react-dom/client';
    import SetupPage from './src/components/features/SetupPage.jsx';
    import {Context} from './src/context/AppContext';
    const data={settings:{name:'Synthetic Physician',degreeType:'MD',primaryState:'OR',npi:'1999999999'},
      licenses:[{id:'license-a',state:'OR',type:'State Medical License (MD)',licenseNumber:'synthetic',expirationDate:'2028-01-01'}],
      documents:[],education:[{id:'education-b',name:'Education B',type:'Doctor of Medicine',institution:'Synthetic School'}],workHistory:[]};
    function Fixture(){
      const [d,set]=useState(data);
      const updateSettings=useCallback(p=>set(v=>({...v,settings:{...v.settings,...p}})),[]);
      window.rerenderSettings=()=>updateSettings({specialties:['Synthetic specialty']});
      const write=(section,item)=>window.writes.push({section,linkedTo:item.linkedTo});
      return <Context.Provider value={{data:d,updateSettings,user:{id:'synthetic'},theme:{},isDesktop:true,
        isPro:true,hasSubscription:true,loaded:true,loadedFrom:'cloud',editItem:write,addItem:write}}>
        <SetupPage initialTask='education'/></Context.Provider>;
    }
    window.writes=[];
    window.envelope={version:1,npi:'1999999999',searchedAt:new Date().toISOString(),sources:[],errors:[],findings:[]};
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'synthetic-io', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'app', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/publicRecordApi$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/credentialExport$/ }, () => ({ path: 'zip', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/(documentScanner|aiClient)$/ }, () => ({ path: 'scanner', namespace: 'fixture' }));
    b.onResolve({ filter: /\/(HeadshotCropModal|CvImportReview|CMEImport|EmailPacketModal|NpiPanel|DateFixList)$/ }, () => ({ path: 'child', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ loader: 'jsx', resolveDir: root, contents:
      name === 'app' ? `import React from 'react';export const Context=React.createContext(null);export const useApp=()=>React.useContext(Context);`
      : name === 'api' ? `export const fetchPublicRecord=async()=>({ok:true,envelope:window.envelope});`
      : name === 'scanner' ? `export const analyzeDocument=()=>{},analyzePDF=()=>{},useAiAvailable=()=>false,describeAiStatus=()=>'';`
      : name === 'zip' ? `export const generateCredentialZip=()=>{},downloadBlob=()=>{},packetDocuments=()=>[],packetSummary=()=>null,packetSummaryLine=()=>'',packetPendingLine=()=>'';`
      : `export const DateRow=()=>null,SHARED_KEY_NOTE='';export default()=>null;`,
    }));
  } }],
});
const results = { scope: 'Actual SetupPage, PacketDrawer, PublicRecordReview and CaptureRun; synthetic I/O; network blocked', sourceRoot: root, cases: [] };
const browser = await chromium.launch({ headless: true });
const save = page => page.getByRole('button', { name: /^Save(?: and next)?$/ });
async function stage(page, name) {
  await page.locator('input[type=file]').nth(1).setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nSynthetic fixture only\n%%EOF') });
  await expect(save(page)).toBeVisible();
}
async function startLicense(page) {
  await page.getByRole('button', { name: /^Copies of your license and DEA/ }).click();
  await page.getByRole('button', { name: 'Start the run', exact: true }).click();
  await page.getByRole('button', { name: 'Start with OR', exact: true }).click();
  await stage(page, 'synthetic-license.pdf');
}
try {
  const cases = {
    async 'task-switch-review'(page) {
      await page.getByRole('button', { name: 'Fill this from public records', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Search the public registers', exact: true })).toBeVisible();
      await page.evaluate(() => window.rerenderSettings());
      await expect(page.getByRole('button', { name: 'Search the public registers', exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Your current position/ }).click();
      await expect(page.getByRole('heading', { name: 'Your current position', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Fill this from public records', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Search the public registers', exact: true })).toHaveCount(0);
    },
    async 'task-switch-staged-save'(page, evidence) {
      await startLicense(page);
      await page.getByRole('button', { name: /^Medical school and postgraduate training/ }).click();
      // Counterfactual actually invokes the stale Save to prove the wrong link.
      if (await save(page).isVisible()) await save(page).click();
      evidence.writesAfterSwitch = await page.evaluate(() => window.writes);
      assert.deepEqual(evidence.writesAfterSwitch, [], 'a different task must not expose a Save for the old record');
      await expect(page.getByRole('button', { name: 'Start the run', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Start the run', exact: true }).click();
      await page.getByRole('button', { name: 'Start with Education B', exact: true }).click();
      await stage(page, 'synthetic-education.pdf');
      await save(page).click();
      evidence.newTaskWrites = await page.evaluate(() => window.writes);
      assert.deepEqual(evidence.newTaskWrites, [{ section: 'documents', linkedTo: 'education:education-b' }]);
    },
    async 'same-task-settings-save'(page, evidence) {
      await startLicense(page);
      await page.evaluate(() => window.rerenderSettings());
      await expect(save(page)).toBeVisible();
      await save(page).click();
      evidence.writes = await page.evaluate(() => window.writes);
      assert.deepEqual(evidence.writes, [{ section: 'documents', linkedTo: 'licenses:license-a' }]);
    },
  };
  for (const [name, action] of Object.entries(cases)) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const external = [], errors = [];
    await context.route('**/*', route => { external.push(new URL(route.request().url()).origin); return route.abort(); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const evidence = { name };
    try {
      await page.setContent('<!doctype html><div id="root"></div>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await action(page, evidence);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      evidence.status = 'passed';
    } catch (e) { evidence.status = 'failed'; evidence.error = e.message; process.exitCode = 1; }
    finally {
      evidence.errors = errors; evidence.external = external;
      await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
      results.cases.push(evidence); await context.close();
    }
  }
} finally { await browser.close(); await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n'); }
console.log(JSON.stringify({ cases: results.cases.map(({ name, status }) => ({ name, status })), out }));
