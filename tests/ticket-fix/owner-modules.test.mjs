// The owner checkout's node_modules is cloned into a ticket worktree only
// when it is the install of base's lockfile (review of 2026-09-30: a merge
// pulled into the owner checkout without `npm ci` leaves base's lockfile on
// disk over the old tree, which lacks the packages base added, and every run's
// gates then fail). Synthetic packages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createWorktree, moduleSource, ownerModulesCurrent, removeWorktree } from '../../scripts/ticket-fix/worktree.mjs';
import { project, RUN_ID, TICKET } from './stage2-helpers.mjs';

const entry = (version, extra = {}) => ({ version, resolved: `https://registry.example.invalid/synthetic/-/synthetic-${version}.tgz`,
  integrity: `sha512-synthetic${version.replace(/\./g, '')}`, ...extra });
const lockfile = packages => `${JSON.stringify({ name: 'synthetic-ticket-project', version: '0.0.0', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'synthetic-ticket-project', version: '0.0.0' }, ...packages } }, null, 2)}\n`;
// What npm records in node_modules/.package-lock.json: the lockfile less its
// root entry and less the packages it skipped.
const installed = (repo, packages) => {
  mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', '.package-lock.json'), `${JSON.stringify({ name: 'synthetic-ticket-project', version: '0.0.0',
    lockfileVersion: 3, requires: true, packages }, null, 2)}\n`);
};
const OLD = { 'node_modules/synthetic-a': entry('1.0.0') };
// What the merge adds: a new dev dependency, and an optional package for a
// platform that is never this one.
const NEW = { ...OLD, 'node_modules/synthetic-b': entry('2.0.0', { dev: true }),
  'node_modules/@synthetic/other-platform': entry('3.0.0', { dev: true, optional: true, os: ['synthetic-os'], cpu: ['synthetic-cpu'] }) };

test('a checkout pulled forward without npm ci: base\'s lockfile over the old tree installs into the cache, never clones the stale tree', async () => {
  const p = project({ 'package-lock.json': lockfile(OLD) });
  try {
    // The owner installed the old lockfile, then pulled the merge (new lockfile) and ran nothing.
    installed(p.repo, OLD);
    writeFileSync(path.join(p.repo, 'package-lock.json'), lockfile(NEW));
    const base = p.moveMain({ 'package-lock.json': lockfile(NEW) });
    const installs = [];
    const install = async dir => { installs.push(dir); };
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID, installNodeModules: install });
    assert.equal(wt.base, base);
    assert.equal(installs.length, 1, 'the stale tree is not cloned; base\'s lockfile is installed');
    assert.ok(installs[0].startsWith(path.join(p.work, 'modules')), 'into the host-owned cache');
    assert.equal(wt.node_modules, 'installed');
    assert.notEqual(wt.modules_source, path.join(p.repo, 'node_modules'));
    removeWorktree({ repo: p.repo, dir: wt.dir, branch: wt.branch, deleteBranch: true });
    // Once the owner runs npm ci, the owner's tree is cloned again (no install).
    installed(p.repo, { 'node_modules/synthetic-a': NEW['node_modules/synthetic-a'], 'node_modules/synthetic-b': NEW['node_modules/synthetic-b'] });
    const current = await moduleSource({ repo: p.repo, work: p.work, base, installNodeModules: install });
    assert.deepEqual(current, { kind: 'cloned', dir: path.join(p.repo, 'node_modules') });
    assert.equal(installs.length, 1);
  } finally { p.cleanup(); }
});

test('the owner checkout with base\'s lockfile and no node_modules installs into the cache rather than leaving the worktree without modules', async () => {
  const p = project({ 'package-lock.json': lockfile(OLD) });
  try {
    const installs = [];
    const found = await moduleSource({ repo: p.repo, work: p.work, base: p.originHead(), installNodeModules: async dir => { installs.push(dir); } });
    assert.equal(found.kind, 'installed');
    assert.equal(installs.length, 1);
  } finally { p.cleanup(); }
});

test('ownerModulesCurrent: npm\'s record of the tree must be the lockfile, less only packages this platform skips', () => {
  const p = project();
  try {
    const lock = lockfile(NEW);
    const platform = { platform: 'darwin', arch: 'arm64' };
    const same = { 'node_modules/synthetic-a': NEW['node_modules/synthetic-a'], 'node_modules/synthetic-b': NEW['node_modules/synthetic-b'] };
    assert.equal(ownerModulesCurrent(p.repo, lock, platform), false, 'no node_modules at all');
    installed(p.repo, same);
    assert.equal(ownerModulesCurrent(p.repo, lock, platform), true, 'the other platform\'s optional package is skipped');
    assert.equal(ownerModulesCurrent(p.repo, Buffer.from(lock), platform), true, 'bytes as read from disk');
    assert.equal(ownerModulesCurrent(p.repo, lock, { platform: 'synthetic-os', arch: 'synthetic-cpu' }), false, 'on its own platform its absence is a stale tree');
    installed(p.repo, OLD);
    assert.equal(ownerModulesCurrent(p.repo, lock, platform), false, 'a package the lockfile added is missing');
    installed(p.repo, { ...same, 'node_modules/synthetic-a': entry('0.9.0') });
    assert.equal(ownerModulesCurrent(p.repo, lock, platform), false, 'a package at another version');
    installed(p.repo, { ...same, 'node_modules/synthetic-a': entry('1.0.0', { integrity: 'sha512-other' }) });
    assert.equal(ownerModulesCurrent(p.repo, lock, platform), false, 'a package from other bytes');
    installed(p.repo, { ...same, 'node_modules/synthetic-extra': entry('1.0.0') });
    assert.equal(ownerModulesCurrent(p.repo, lock, platform), false, 'a package the lockfile does not name');
    // An optional package this platform can install is expected to be there.
    const compatible = lockfile({ ...OLD, 'node_modules/@synthetic/here': entry('1.0.0', { optional: true, os: ['!synthetic-os'] }) });
    installed(p.repo, OLD);
    assert.equal(ownerModulesCurrent(p.repo, compatible, platform), false, 'a negated os list allows this platform');
    const linuxOnly = lockfile({ ...OLD, 'node_modules/@synthetic/musl': entry('1.0.0', { optional: true, libc: ['musl'] }) });
    assert.equal(ownerModulesCurrent(p.repo, linuxOnly, platform), true, 'a libc package is never installed off Linux');
    const required = lockfile({ ...OLD, 'node_modules/@synthetic/required': entry('1.0.0', { os: ['synthetic-os'] }) });
    assert.equal(ownerModulesCurrent(p.repo, required, platform), false, 'only an optional package may be absent');
    writeFileSync(path.join(p.repo, 'node_modules', '.package-lock.json'), '{ not json');
    assert.equal(ownerModulesCurrent(p.repo, lock, platform), false, 'an unreadable record');
    installed(p.repo, same);
    assert.equal(ownerModulesCurrent(p.repo, '{ not json', platform), false, 'an unreadable lockfile');
  } finally { p.cleanup(); }
});
