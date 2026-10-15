import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../qa-lab/e2e/ops-jobs.spec.mjs', import.meta.url), 'utf8');
// Execute the actual journey, with a deliberately enforcing storage boundary
// and pg_catalog-only query resolver. This checks fixture order and keeps the
// journey's retention/deletion assertions live, without contacting a QA stack.
async function runJourney({ text = source, ignoreGrantFor, ignoreRevocation = false, corruptRetainedFile = false, retainDeletedFile = false, cronDeletesRecord = false } = {}) {
  const users = new Map(), profiles = new Map(), publications = new Map(), licenses = new Map(), files = new Map();
  const uploads = [], checks = [], calls = [], events = [];
  let next = 0, journey, payer;
  const create = firstName => {
    const user = { id: `user_${++next}`, email: `${firstName.toLowerCase()}@fixture.invalid`, firstName };
    const profile = { id: `profile-${next}`, auth_user_id: user.id, access_status: 'pending', cancelled_at: null, data_deletion_date: null, deleted_at: null, email: user.email, name: firstName };
    users.set(user.id, user); profiles.set(profile.id, profile); return { user, profile };
  };
  const profileOf = id => [...profiles.values()].find(p => p.auth_user_id === id);
  const writable = p => !p.deleted_at && p.access_status === 'active' && (p.paid || p.granted);
  const owner = sql => profiles.get(sql.match(/(?:profile_id|user_id|id)\s*=\s*'(profile-\d+)'/)?.[1]);
  const qualified = sql => {
    assert.doesNotMatch(sql, /\b(?:from|update|into)\s+(?:profiles|licenses|publications|access_grants)\b/i, 'pg_catalog-only helpers require public table qualification');
  };
  const rows = sql => {
    qualified(sql);
    if (/credentialdo_profile_scope_write_allowed/.test(sql)) {
      const pid = sql.match(/scope_write_allowed\('(profile-\d+)'/)?.[1];
      assert.ok(pid); return [{ enforced: true, allowed: Boolean(writable(profiles.get(pid))) }];
    }
    if (/from public.profiles/.test(sql)) {
      return [...profiles.values()].filter(p => sql.includes(`'${p.id}'`)).map(p => Object.fromEntries(['id', 'access_status', 'cancelled_at', 'data_deletion_date', 'deleted_at', 'email', 'name'].map(k => [k, p[k]]))).sort((a, b) => a.id.localeCompare(b.id));
    }
    const p = owner(sql); assert.ok(p, sql);
    if (/from public.licenses/.test(sql)) return licenses.has(p.id) ? [licenses.get(p.id)] : [];
    if (/from public.publications/.test(sql)) return publications.has(p.id) ? [publications.get(p.id)] : [];
    throw Error(`Unhandled query: ${sql}`);
  };
  const labExec = sql => {
    qualified(sql);
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      if (/^(begin|commit|select set_config)/.test(statement)) continue;
      if (/^insert into public.access_grants/.test(statement)) {
        const pid = statement.match(/values\s*\('(profile-\d+)'/)?.[1];
        const p = profiles.get(pid); assert.ok(p, statement);
        assert.match(sql, /set_config\('credentialdomd.access_grant', '1', true\)/);
        if (p.name !== ignoreGrantFor) p.granted = true;
        events.push(`grant:${p.name}`); continue;
      }
      if (/^update public.access_grants/.test(statement)) {
        const p = owner(statement); assert.ok(p);
        assert.match(statement, /source_key='qa-lab:ops-retention-fixture'/);
        if (!ignoreRevocation) p.granted = false;
        events.push(`revoke:${p.name}`); continue;
      }
      if (/^update public.profiles/.test(statement)) {
        const p = owner(statement); assert.ok(p, statement);
        if (/access_status\s*=\s*'active'/.test(statement)) p.access_status = 'active';
        if (/cancelled_at\s*=\s*now\(\)/.test(statement)) p.cancelled_at = 'past';
        if (/cancelled_at\s*=\s*null/.test(statement)) p.cancelled_at = null;
        if (/data_deletion_date\s*=\s*null/.test(statement)) p.data_deletion_date = null;
        else if (/data_deletion_date/.test(statement)) p.data_deletion_date = /\+/.test(statement) ? 'future' : 'past';
        continue;
      }
      if (/^insert into public.publications/.test(statement)) {
        const pid = statement.match(/gen_random_uuid\(\),'(profile-\d+)'/)?.[1];
        assert.ok(pid); publications.set(pid, { id: `publication-${pid}`, user_id: pid, name: statement.includes('Retained legacy') ? 'Retained legacy publication' : 'Explicit deletion control', citation: 'Synthetic QA record', year: '2026' });
        events.push(`record:${profiles.get(pid).name}`); continue;
      }
      throw Error(`Unhandled statement: ${statement}`);
    }
  };
  const locator = {
    first() { return this; }, async click() {}, async waitFor() {},
    getByRole() { return { ...this, click: async () => { licenses.set(payer.profile.id, { id: 'license-1', user_id: payer.profile.id, license_number: 'QA-KEEP-1', state: 'MT' }); } }; },
    async innerText() { return licenses.has(payer.profile.id) ? 'QA-KEEP-1' : ''; },
  };
  const page = { getByRole: () => locator, locator: () => locator, async reload() {} };
  const key = (bucket, name) => `${bucket}/${name}`;
  const context = {
    Buffer, console,
    test: Object.assign((name, opts, fn) => { assert.deepEqual([...opts.tag], ['@OPS-002']); journey = fn; }, { setTimeout() {} }),
    day: () => '2027-06-01', letters: () => `random${++next}`, lit: value => `'${value}'`,
    field: () => ({ async selectOption() {}, async fill() {} }),
    openCredentials: async () => {}, waitForMemberApp: async () => {},
    newMember: async () => { payer = create('Paige'); payer.profile.access_status = 'active'; payer.profile.paid = true; return payer; },
    createPhysician: async opts => create(opts.firstName).user,
    profileOf, rows, row: sql => rows(sql)[0], labExec,
    waitFor: async (name, read) => { const value = await read(); assert.ok(value, name); return value; },
    countWhere: (table, where) => { const p = owner(where); assert.ok(p); return Number((table === 'licenses' ? licenses : publications).has(p.id)); },
    stackKeys: () => ({ service: 'local-fixture-service' }), lab: () => ({ urls: { api: 'http://127.0.0.1:55521' } }),
    uploadObject: async (bucket, name, bytes) => {
      const p = profileOf(name.split('/')[0]); assert.ok(p);
      if (bucket === 'documents' && !writable(p)) throw Error(`membership read only: ${p.name}`);
      uploads.push({ owner: p.name, bucket, entitled: Boolean(writable(p)) }); events.push(`upload:${p.name}:${bucket}`);
      files.set(key(bucket, name), Buffer.from(bytes));
    },
    fetch: async url => {
      const path = decodeURIComponent(new URL(url).pathname.replace('/storage/v1/object/', ''));
      const bytes = files.get(path);
      return { status: bytes ? 200 : 400, arrayBuffer: async () => bytes ? (corruptRetainedFile && path.includes('qa-retention') ? Buffer.from('corrupt') : bytes) : Buffer.from(JSON.stringify({ statusCode: '404', error: 'not_found' })) };
    },
    objectBytesOnDisk: (bucket, name) => files.has(key(bucket, name)) ? [name] : [],
    runCronJob: job => { assert.equal(job, 'delete-cancelled-accounts'); if (cronDeletesRecord) licenses.clear(); return { ok: true, result: '0', requests: [] }; },
    labHookSecret: () => 'local-fixture-hook', tokenFor: async user => `fixture-owner-${user.id}`,
    callFunction: async (name, options) => {
      assert.equal(name, 'delete-account'); calls.push(options);
      if (options.headers['x-hook-secret']) {
        if (options.body.dry_run === false) return { status: 409, data: { code: 'automatic_deletion_retired' } };
        const p = profiles.get(options.body.profile_id);
        return { status: 200, data: { dry_run: true, tombstoned: false, tables: { publications: Number(publications.has(p.id)) } } };
      }
      const subject = options.headers.Authorization.replace('Bearer fixture-owner-', '');
      const p = profileOf(subject); assert.equal(p.name, 'Erin'); assert.equal(options.body.dry_run, false);
      p.deleted_at = 'now'; publications.delete(p.id);
      if (!retainDeletedFile) for (const path of files.keys()) if (path.includes(`/${subject}/`)) files.delete(path);
      return { status: 200, data: { requested_by: 'self', tombstoned: true, deleted_at: 'now' } };
    },
  };
  const start = text.indexOf("test('cancellation retains records"); const end = text.indexOf("\ntest('hook secret", start);
  assert.ok(start >= 0 && end > start); vm.runInNewContext(text.slice(start, end), context);
  const qa = { check(name, ok) { assert.equal(ok, true, name); checks.push(name); }, async feature(id, name, fn) { assert.equal(id, 'OPS-002'); await fn(); }, async shot() {} };
  await journey({ page, qa });
  return { uploads, checks, calls, events, profiles, files };
}

test('the actual OPS-002 fixture seeds entitled owners, then retains four byte-bearing files after cancellation and deletes only the explicit owner', async () => {
  const run = await runJourney();
  assert.equal(run.uploads.length, 5);
  assert.ok(run.uploads.every(upload => upload.entitled));
  assert.ok(run.events.indexOf('record:Cora') < run.events.indexOf('revoke:Cora'));
  assert.ok(run.events.indexOf('upload:Cora:backups') < run.events.indexOf('revoke:Cora'));
  assert.equal([...run.profiles.values()].find(p => p.name === 'Cora').granted, false);
  assert.equal(run.files.size, 4);
  assert.equal(run.calls.filter(call => call.headers['x-hook-secret'] && call.body.dry_run === false).length, 7);
  assert.equal(run.calls.filter(call => call.headers.Authorization).length, 1);
  assert.ok(run.checks.some(name => name.includes('explicit deletion removes')));
  assert.ok(run.checks.some(name => name.includes('write enforcement still enabled')));
});
for (const firstName of ['Cora', 'Erin']) test(`an unentitled ${firstName} fixture fails before claiming storage or deletion coverage`, async () => {
  await assert.rejects(runJourney({ ignoreGrantFor: firstName }), new RegExp(`${firstName} starts with enforced, entitled`));
});
test('a cancellation fixture whose temporary grant remains active cannot pass', async () => {
  await assert.rejects(runJourney({ ignoreRevocation: true }), /retained legacy account is read-only/);
});
test('pg_catalog-only snapshot reads reject the original unqualified profile query', async () => {
  await assert.rejects(runJourney({ text: source.replace('from public.profiles where id in', 'from profiles where id in') }), /require public table qualification/);
});
test('the retained byte assertions reject changed stored content', async () => {
  await assert.rejects(runJourney({ corruptRetainedFile: true }), /keeps identical bytes/);
});
test('the dispatcher assertion rejects record loss even when it reports zero requests', async () => {
  await assert.rejects(runJourney({ cronDeletesRecord: true }), /dispatch preserves profiles, stamps and records/);
});
test('the explicit deletion assertion still requires stored bytes to disappear', async () => {
  await assert.rejects(runJourney({ retainDeletedFile: true }), /explicit deletion removes that owner record and stored file/);
});
