#!/usr/bin/env node
// The host owns attachment roots. A checkout may reclaim only its own roots
// whose process is proven gone; another tool's folders are never stale by name.
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain } from './is-main.mjs';

// Deliberately outside the old shell's credentialdomd-attachments.* glob.
export const ATTACH_ROOT_PREFIX = 'credentialdomd-attachments-v2.';
export const LEGACY_ATTACH_ROOT_PREFIX = 'credentialdomd-attachments.';
const pidValid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;
export function attachmentScope({ repo, work }) {
  return createHash('sha256').update(JSON.stringify([realpathSync(repo), realpathSync(work)])).digest('hex');
}
function ownerGone(pid, signal = process.kill) {
  try { signal(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; } // EPERM and unknown failures stay live.
}
export function sweepAttachmentRoots({ repo, work, tmp = os.tmpdir(), signal = process.kill }) {
  const root = realpathSync(tmp), prefix = `${ATTACH_ROOT_PREFIX}${attachmentScope({ repo, work })}.`;
  const removed = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    const match = /^([1-9]\d*)\.([A-Za-z0-9]{6})$/.exec(name.slice(prefix.length));
    if (!match || !pidValid(Number(match[1]))) continue;
    const target = path.join(root, name);
    let st;
    try { st = lstatSync(target); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink() || typeof process.getuid !== 'function' || st.uid !== process.getuid()) continue;
    if (!ownerGone(Number(match[1]), signal)) continue;
    // Never resolve a symlink for deletion. PID reuse conservatively keeps a
    // dead run's folder until a later sweep can prove that PID is gone again.
    try { rmSync(target, { recursive: true, force: true }); removed.push(target); } catch { /* retry next own run */ }
  }
  return removed;
}
export function createAttachmentRoot({ repo, work, tmp = os.tmpdir(), ownerPid = process.pid }) {
  if (!pidValid(ownerPid) || ownerGone(ownerPid)) throw Error('The attachment owner must be a live positive PID');
  const root = realpathSync(tmp), scope = attachmentScope({ repo, work });
  sweepAttachmentRoots({ repo, work, tmp: root });
  return mkdtempSync(path.join(root, `${ATTACH_ROOT_PREFIX}${scope}.${ownerPid}.`), { encoding: 'utf8' });
}
if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string' }, work: { type: 'string' }, tmp: { type: 'string' }, 'owner-pid': { type: 'string' } }, strict: true });
    if (!values.repo || !values.work || !/^[1-9]\d*$/.test(values['owner-pid'] || '')) throw Error('Expected --repo DIR --work DIR --owner-pid PID');
    console.log(createAttachmentRoot({ repo: values.repo, work: values.work, tmp: values.tmp, ownerPid: Number(values['owner-pid']) }));
  } catch { console.error('Cannot create the owned attachment directory'); process.exitCode = 1; }
}
