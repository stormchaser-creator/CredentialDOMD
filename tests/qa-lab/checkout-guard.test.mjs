// One lab stack per machine, many checkouts: a checkout never starts, restarts
// or stops a lab stack another checkout is running, and never reuses a
// database another checkout built (qa-lab/lib/checkout-guard.mjs). Offline: no
// Docker, no stack; the Docker answers and the database's hashes are
// synthetic, shaped as `docker inspect` and the vault query return them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LAB_FUNCTIONS_MOUNT, VAULT_HASHES_SQL, assertDatabaseIsOurs, assertStackIsOurs, checkoutFromMounts,
  runningStackCheckout, sameCheckout, vaultDifferences,
} from '../../qa-lab/lib/checkout-guard.mjs';
import { startStack, stopStack } from '../../qa-lab/lib/stack.mjs';
import { REPO_ROOT } from '../../qa-lab/lib/paths.mjs';

const A = '/Users/qa/Projects/CredentialDOMD-wt/lab-a';
const B = '/Users/qa/Projects/CredentialDOMD';
const labMount = (root) => ({ Type: 'bind', Source: `${root}${LAB_FUNCTIONS_MOUNT}`, Destination: `${root}${LAB_FUNCTIONS_MOUNT}`, Mode: 'ro', RW: false });
const cacheVolume = { Type: 'volume', Name: 'supabase_edge_runtime_credentialdomd-qa-lab', Source: '/var/lib/docker/volumes/x/_data', Destination: '/root/.cache/deno' };

test('the running edge runtime names its checkout through the functions mount', () => {
  assert.equal(checkoutFromMounts([cacheVolume, labMount(A)]), A);
  assert.equal(checkoutFromMounts([{ ...labMount(A), Source: `${A}${LAB_FUNCTIONS_MOUNT}/` }]), A, 'a trailing slash');
  // A CLI that resolved the link would mount the checkout's own supabase/functions.
  assert.equal(checkoutFromMounts([{ Type: 'bind', Source: `${B}/supabase/functions`, Destination: '/x' }]), B);
  assert.equal(checkoutFromMounts([cacheVolume]), null, 'no functions mount: nothing to say');
  assert.equal(checkoutFromMounts([]), null);
  assert.equal(checkoutFromMounts(null), null);
  assert.equal(checkoutFromMounts([{ Type: 'volume', Source: `${A}${LAB_FUNCTIONS_MOUNT}` }]), null, 'only bind mounts name a checkout');
});

test('the running stack is read with docker inspect of the edge runtime, and only while it runs', () => {
  const calls = [];
  const answer = (status, stdout) => (cmd, args) => { calls.push([cmd, ...args]); return { status, stdout }; };
  assert.equal(runningStackCheckout(answer(0, `true\t${JSON.stringify([cacheVolume, labMount(A)])}\n`)), A);
  assert.deepEqual(calls[0].slice(0, 2), ['docker', 'inspect']);
  assert.equal(calls[0].at(-1), 'supabase_edge_runtime_credentialdomd-qa-lab');
  assert.equal(runningStackCheckout(answer(0, `false\t${JSON.stringify([labMount(A)])}`)), null, 'a stopped container is not a running lab');
  assert.equal(runningStackCheckout(answer(1, '')), null, 'no such container');
  assert.equal(runningStackCheckout(answer(0, 'true\tnot json')), null);
});

test('same checkout: the same path, through a symbolic link, or under a Docker mount prefix; a sibling is not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-lab-guard-'));
  try {
    const real = path.join(dir, 'CredentialDOMD');
    mkdirSync(real);
    const link = path.join(dir, 'linked');
    symlinkSync(real, link);
    assert.ok(sameCheckout(real, real));
    assert.ok(sameCheckout(`${real}/`, real));
    assert.ok(sameCheckout(link, real), 'a symbolic link to the checkout');
    assert.ok(sameCheckout(real, link));
    assert.ok(sameCheckout(`/host_mnt${real}`, real), 'Docker Desktop names host paths under /host_mnt');
    assert.ok(!sameCheckout(`${real}-wt/lab-a`, real), 'a checkout beside it');
    assert.ok(!sameCheckout(path.join(dir, 'CredentialDOMD-2'), real));
    assert.ok(!sameCheckout(real.slice(0, -1), real), 'a prefix of the path is another folder');
    assert.ok(!sameCheckout(null, real));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stack running from another checkout is refused, unless it is gone or QA_LAB_TAKE_OVER=1', () => {
  const logs = [];
  const opts = (over) => ({ root: B, env: {}, exists: () => true, log: (m) => logs.push(m), ...over });
  assert.doesNotThrow(() => assertStackIsOurs('start', opts({ owner: null })), 'no lab stack running');
  assert.doesNotThrow(() => assertStackIsOurs('start', opts({ owner: B })), 'this checkout\'s own stack');
  for (const action of ['start', 'stop']) {
    assert.throws(() => assertStackIsOurs(action, opts({ owner: A })), (e) => {
      assert.match(e.message, new RegExp(`running from another checkout \\(${A.replace(/[/-]/g, '\\$&')}\\)`));
      assert.match(e.message, new RegExp(`will not ${action} it`));
      assert.match(e.message, /Ctrl-C in its qa:lab terminal, then npm run qa:down/);
      assert.match(e.message, /QA_LAB_TAKE_OVER=1/);
      return true;
    });
  }
  assert.doesNotThrow(() => assertStackIsOurs('start', opts({ owner: A, env: { QA_LAB_TAKE_OVER: '1' } })));
  assert.match(logs.at(-1), /QA_LAB_TAKE_OVER=1: taking over the lab stack started from/);
  assert.throws(() => assertStackIsOurs('start', opts({ owner: A, env: { QA_LAB_TAKE_OVER: 'yes' } })), /another checkout/, 'only the exact value takes over');
  assert.doesNotThrow(() => assertStackIsOurs('stop', opts({ owner: A, exists: () => false })), 'the other checkout was deleted');
  assert.match(logs.at(-1), /no longer exists/);
});

test('qa:up, qa:lab and qa:e2e start the stack, and qa:down stops it, only after the checkout guard passes', () => {
  // Read first, so a startStack without its guard is never called here (it would start a stack).
  const source = readFileSync(new URL('../../qa-lab/lib/stack.mjs', import.meta.url), 'utf8');
  assert.match(source, /export function startStack\(\{ functionsEnv = null, guard = assertStackIsOurs \} = \{\}\) \{\n {2}guard\('start'\);\n/, 'the guard is startStack\'s first statement');
  assert.match(source, /export function stopStack\(\{ wipe = false, guard = assertStackIsOurs \} = \{\}\) \{\n {2}guard\('stop'\);\n/, 'the guard is stopStack\'s first statement');
  assert.match(source, /import \{ assertStackIsOurs \} from '\.\/checkout-guard\.mjs';/);
  const apply = readFileSync(new URL('../../qa-lab/apply-schema.mjs', import.meta.url), 'utf8');
  assert.match(apply, /if \(schemaApplied\(\)\) \{\n\s*assertBuiltHere\(\);/, 'apply-schema checks a database it did not build before reusing it');
  const seen = [];
  const refuse = (action) => { seen.push(action); throw new Error(`guard refused ${action}`); };
  // The guard throws first, so nothing is written, stopped or started.
  assert.throws(() => startStack({ guard: refuse }), /guard refused start/);
  assert.throws(() => stopStack({ guard: refuse }), /guard refused stop/);
  assert.throws(() => stopStack({ wipe: true, guard: refuse }), /guard refused stop/);
  assert.deepEqual(seen, ['start', 'stop', 'stop']);
});

test('this checkout is the repository the lab code lives in', () => {
  assert.ok(sameCheckout(REPO_ROOT, REPO_ROOT));
  assert.ok(!sameCheckout(`${REPO_ROOT}-other`, REPO_ROOT));
});

const hex = (v) => createHash('sha256').update(v).digest('hex');

test('a database whose vault another checkout wrote is refused; this checkout\'s is accepted', () => {
  const mine = { welcome_hook_secret: 'qa-local-hook-value-one', other_secret: 'qa-local-other-one' };
  assert.deepEqual(vaultDifferences(mine, { welcome_hook_secret: hex(mine.welcome_hook_secret), other_secret: hex(mine.other_secret) }), []);
  assert.deepEqual(vaultDifferences(mine, { welcome_hook_secret: hex('qa-local-hook-value-two'), other_secret: hex(mine.other_secret) }), ['welcome_hook_secret']);
  assert.deepEqual(vaultDifferences(mine, { welcome_hook_secret: hex(mine.welcome_hook_secret) }), [], 'a name only one side holds is not compared');
  assert.deepEqual(vaultDifferences({}, { welcome_hook_secret: hex('x') }), [], 'nothing expected yet');
  assert.deepEqual(vaultDifferences(mine, {}), [], 'an empty vault');
  assert.doesNotThrow(() => assertDatabaseIsOurs({ expected: mine, databaseHashes: { welcome_hook_secret: hex(mine.welcome_hook_secret) } }));
  assert.throws(() => assertDatabaseIsOurs({ expected: mine, databaseHashes: { welcome_hook_secret: hex('qa-local-hook-value-two') } }), (e) => {
    assert.match(e.message, /built by another checkout/);
    assert.match(e.message, /welcome_hook_secret/);
    assert.match(e.message, /npm run qa:down -- --wipe && npm run qa:up/);
    assert.ok(!e.message.includes(mine.welcome_hook_secret) && !e.message.includes('qa-local-hook-value-two'), 'no value in the message');
    return true;
  });
});

test('the vault is compared by hash: the query returns SHA-256 of each value, never the value', () => {
  assert.match(VAULT_HASHES_SQL, /^select /);
  assert.match(VAULT_HASHES_SQL, /from vault\.decrypted_secrets/);
  assert.match(VAULT_HASHES_SQL, /json_object_agg\(name, pg_catalog\.encode\(pg_catalog\.sha256\(pg_catalog\.convert_to\(decrypted_secret, 'UTF8'\)\), 'hex'\)\)/);
  // decrypted_secret appears only inside the hash.
  assert.equal(VAULT_HASHES_SQL.split('decrypted_secret,').length, 2);
  assert.ok(!/;/.test(VAULT_HASHES_SQL), 'one statement');
});
