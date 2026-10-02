// The owner's 2026-10-02 01:57 storage refusal, in a real WebKit (Playwright's,
// the engine of his iPhone's installed app), against this tree's REAL storage
// modules bundled for the browser. Skipped, with a message, where Playwright's
// WebKit is not installed (CI installs no browsers); the same sequence runs
// over WebKitLocalStorage in webkit-quota-dead-copy.test.mjs everywhere.
//
// IndexedDB is made to fail as WebKit fails it when iOS reclaims the process
// serving it while the installed app is suspended: every open connection gets
// a close event, db.transaction() throws, and every indexedDB.open() in the
// page fails with UnknownError until it reloads (WebKit bug 273827).
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

let webkit = null;
try { ({ webkit } = await import('playwright-core')); } catch { webkit = null; }
const browserPath = (() => { try { return webkit?.executablePath(); } catch { return null; } })();
const skip = !browserPath || !existsSync(browserPath) ? 'Playwright WebKit is not installed (npx playwright install webkit)' : false;

const ENTRY = `
import * as scope from ${JSON.stringify(resolve(root, 'src/utils/storageScope.js'))};
import * as storage from ${JSON.stringify(resolve(root, 'src/utils/storage.js'))};
import * as supabase from ${JSON.stringify(resolve(root, 'src/lib/supabase.js'))};
window.__s = { scope, storage, supabase };
`;

// Runs in the page before anything else: the IndexedDB process the test can lose, and a clock it can move.
function iosModel() {
  const realOpen = IDBFactory.prototype.open;
  const realTx = IDBDatabase.prototype.transaction;
  const conns = new Set();
  const state = { down: false };
  IDBFactory.prototype.open = function (...args) {
    if (state.down) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => { req.error = new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError'); req.onerror?.({ target: req }); }, 3);
      return req;
    }
    const req = realOpen.apply(this, args);
    req.addEventListener('success', () => conns.add(req.result));
    return req;
  };
  IDBDatabase.prototype.transaction = function (...args) {
    if (state.down) throw new DOMException('The database connection is closing.', 'InvalidStateError');
    return realTx.apply(this, args);
  };
  window.__idb = {
    lose() { state.down = true; for (const db of conns) db.dispatchEvent(new Event('close')); conns.clear(); },
    restore() { state.down = false; },
  };
  const realNow = Date.now.bind(Date);
  let offset = 0;
  Date.now = () => realNow() + offset;
  window.__clock = { forward(ms) { offset += ms; } };
}

async function bundle() {
  const { build } = await import('esbuild');
  const dir = resolve(root, 'node_modules/.cache/credentialdomd-webkit-browser-test');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `bundle-${process.pid}.js`);
  await build({ stdin: { contents: ENTRY, resolveDir: root, loader: 'js' }, bundle: true, outfile: out, format: 'iife', platform: 'browser',
    target: 'safari16', define: { 'import.meta.env': '{}', __APP_BUILD_ID__: '"test"' }, loader: { '.js': 'jsx' }, jsx: 'automatic', logLevel: 'error' });
  return out;
}

test('real WebKit: a dead development-era copy and a lost IndexedDB no longer cost the timer, the notes, the hold, the fence or the queue', { skip, timeout: 120_000 }, async () => {
  const file = await bundle();
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(file);
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(js); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>t</title><script src="/bundle.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript(iosModel);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__s);
    const out = await page.evaluate(async () => {
      const { scope, storage, supabase } = window.__s;
      const PROD = 'user_SYNTHPROD000000000000000000', DEV = 'user_SYNTHDEV0000000000000000000';
      const DASH = '\u2014';
      const caseLog = (i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, date: '2026-08-01', category: 'Cranial',
        diagnosis: `Synthetic diagnosis ${DASH} lesion ${i}`, procedure: 'Synthetic craniotomy for resection of a synthetic lesion',
        notes: 'Synthetic note text used only to give the record a realistic size for storage tests.', facility: 'Synthetic Regional Medical Center' });
      const fileOf = (chars) => { const n = Math.round(chars / (JSON.stringify(caseLog(0)).length + 1)); return { settings: { theme: 'dark' }, caseLogs: Array.from({ length: n }, (_, i) => caseLog(i)) }; };
      const cost = (s) => s.length * (/[\u0100-\uffff]/.test(s) ? 2 : 1);
      const used = () => { let n = 0; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); n += cost(k) + cost(localStorage.getItem(k)); } return n; };
      // WebKit's own quota, measured.
      let lo = 0, hi = 16 * 1024 * 1024;
      const fits = (n, ch) => { try { localStorage.setItem('probe', ch.repeat(n)); return true; } catch { return false; } finally { localStorage.removeItem('probe'); } };
      while (hi - lo > 64) { const mid = (lo + hi) >> 1; if (fits(mid, DASH)) lo = mid; else hi = mid; }
      const wideCharsFit = lo;
      localStorage.clear();
      const reports = [];
      scope.setStorageFullReporter((message, extra) => reports.push({ message, extra }));
      scope.setActiveUserId(PROD);
      const file = fileOf(1_900_000);
      const firstSave = await storage.saveData(file, PROD);
      // The 2026-09-20 recovery's dead copy, and the rest of a real device's keys: ~150 bytes left.
      localStorage.setItem(`credentialdomd-data:${DEV}`, JSON.stringify(fileOf(1_600_000)));
      localStorage.setItem(`credentialdomd-continuity-recovery-v1:${PROD}:00000000-0000-4000-8000-00000000c0de`, JSON.stringify({ schemaVersion: 1,
        subject: PROD, sourceSubject: DEV, state: 'complete', entries: [{ base: 'credentialdomd-data', digest: 'a'.repeat(64), state: 'copied' }] }));
      let left = 5 * 1024 * 1024; try { localStorage.setItem('qa-other', 'x'); } catch { /* full already */ }
      for (let step = 1 << 22; step >= 1; step >>= 1) { try { localStorage.setItem('qa-other', 'x'.repeat((localStorage.getItem('qa-other') || '').length + step)); } catch { /* too much */ } }
      localStorage.setItem('qa-other', (localStorage.getItem('qa-other') || '').slice(150));
      left = 5 * 1024 * 1024 - used();
      // What main.jsx does at launch.
      scope.releaseRecoveredContinuitySources?.();
      window.__idb.lose();
      file.caseLogs.push(caseLog(999_999));
      const save = await storage.saveData(file, PROD);
      const timer = scope.lsSetJSON(scope.BASE_KEYS.timer, { startedAt: '2026-10-02T01:58:00.000Z', note: `Called in ${DASH} consult` });
      const note = scope.lsSetJSON(scope.BASE_KEYS.unrecordedInvoices, [{ number: 'INV-20990101-01', sentAt: '2099-01-01', amount: 1 }]);
      const hold = scope.holdDeviceOnlyChanges(PROD, { identityVault: [] }, { identityVault: [{ id: 'synthetic-1', label: 'Synthetic' }] });
      const fence = scope.advanceLocalFence('user_SYNTHFENCEPROBE00000000000') !== null;
      await supabase.insertItem('00000000-0000-4000-8000-00000000f11e', 'workLog', { id: '00000000-0000-4000-8000-00000000e0e1', date: '2026-10-02', description: `Synthetic ${DASH} call` });
      const queued = (localStorage.getItem(`credentialdomd-pending-ops:${PROD}`) || '').includes('00000000-0000-4000-8000-00000000e0e1');
      window.__idb.restore();
      window.__clock.forward(2500);
      const retried = await storage.retryOfflineSave(PROD);
      return { wideCharsFit, firstSave, left, save, report: reports[0] || null, fileInLocal: localStorage.getItem(`credentialdomd-data:${PROD}`) !== null,
        deadCopy: localStorage.getItem(`credentialdomd-data:${DEV}`) !== null, timer, note, hold, fence, queued, retried, stale: storage.cacheStaleReason() };
    });
    assert.ok(out.wideCharsFit > 2_600_000 && out.wideCharsFit < 2_630_000, `WebKit fits ${out.wideCharsFit} wide characters (5 MiB at 2 bytes each)`);
    assert.equal(out.firstSave, true);
    assert.ok(out.left < 1000, `localStorage was full (${out.left} bytes left) before the launch`);
    assert.equal(out.deadCopy, false, 'the dead development-era file was released at launch');
    assert.equal(out.save, false, 'the offline copy waits for IndexedDB');
    assert.equal(out.fileInLocal, false, 'and is never put into localStorage');
    assert.equal(out.report?.extra?.reason, 'indexeddb_unavailable,localstorage_reserved');
    assert.equal(out.report?.extra?.idbError, 'UnknownError');
    assert.equal(out.report?.extra?.approxBytes, 3_800_000);
    assert.deepEqual({ timer: out.timer, note: out.note, hold: out.hold, fence: out.fence, queued: out.queued },
      { timer: true, note: true, hold: true, fence: true, queued: true }, 'everything with nowhere else to go is kept');
    assert.equal(out.retried, true, 'IndexedDB is opened again seconds later, not 30');
    assert.equal(out.stale, null);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
