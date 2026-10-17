import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { original, replacement, patchWorkerGuard } from '../../qa-lab/e2e/support/playwright-worker-guard.mjs';
function fixture(t, version='1.63.0', source=original) {
 const root=mkdtempSync(path.join(os.tmpdir(),'qa-worker-guard-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const core=path.join(root,'node_modules/playwright-core');mkdirSync(path.join(core,'lib'),{recursive:true});
 writeFileSync(path.join(core,'package.json'),JSON.stringify({version}));writeFileSync(path.join(core,'lib/coreBundle.js'),source);return {root,core};
}
test('patch is pinned, exact and idempotent',t=>{const {root,core}=fixture(t);assert.equal(patchWorkerGuard(root).changed,true);assert.equal(readFileSync(path.join(core,'lib/coreBundle.js'),'utf8'),replacement);assert.equal(patchWorkerGuard(root).changed,false);});
test('unknown version or initializer is refused',t=>{assert.throws(()=>patchWorkerGuard(fixture(t,'1.64.0').root),/Review/);assert.throws(()=>patchWorkerGuard(fixture(t,'1.63.0','different').root),/Unexpected/);});
test('shared dependencies outside checkout are refused',t=>{const outside=fixture(t);const root=mkdtempSync(path.join(os.tmpdir(),'qa-shared-refusal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));symlinkSync(path.join(outside.root,'node_modules'),path.join(root,'node_modules'));assert.throws(()=>patchWorkerGuard(root),/refusing shared/);});
test('opaque SecurityError is handled, unrelated errors still fail',()=>{const navigator={};Object.defineProperty(navigator,'serviceWorker',{get(){throw Object.assign(new Error('opaque'),{name:'SecurityError'});},configurable:true});vm.runInNewContext(replacement,{navigator});Object.defineProperty(navigator,'serviceWorker',{get(){throw new TypeError('unrelated');}});assert.throws(()=>vm.runInNewContext(replacement,{navigator}),/unrelated/);});
test('ordinary frame registration stays blocked',async()=>{let registered=false;const worker={register:async()=>{registered=true;}};vm.runInNewContext(replacement,{navigator:{serviceWorker:worker},console:{warn(){}}});assert.equal(await worker.register('/sw.js'),undefined);assert.equal(registered,false);});

test('a registration override failure is not mistaken for an opaque getter refusal',()=>{const worker={};Object.defineProperty(worker,'register',{set(){throw Object.assign(new Error('blocking failed'),{name:'SecurityError'});}});assert.throws(()=>vm.runInNewContext(replacement,{navigator:{serviceWorker:worker}}),/blocking failed/);});
