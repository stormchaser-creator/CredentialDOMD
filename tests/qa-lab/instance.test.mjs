import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { applyInstance, configValue, instanceSettings, PORT_FIELDS, readInstance, validateInstance } from '../../qa-lab/lib/instance.mjs';
import { stackConfigText, assertSelectedStackConfig, runStackCli } from '../../qa-lab/lib/stack.mjs';
import { assertInstanceDatabase } from '../../qa-lab/lib/local-db.mjs';
import { assertSchemaTargetsInstance } from '../../qa-lab/apply-schema.mjs';

const source = readFileSync(new URL('../../qa-lab/supabase-config.template.toml', import.meta.url), 'utf8');
const choice = { name: 'operational', ports: { api: 55421, database: 55422, shadow: 55420, studio: 55423, mail: 55424, inspector: 8183 } };

test('an absent instance preserves the complete default config; explicit instance changes only its id and six ports', () => {
  assert.equal(applyInstance(source, null), source);
  assert.equal(instanceSettings(source, null).projectId, 'credentialdomd-qa-lab');
  const next = applyInstance(source, choice);
  assert.equal(configValue(next, '', 'project_id'), '"credentialdomd-qa-lab-operational"');
  for (const [name, [section, key]] of Object.entries(PORT_FIELDS)) assert.equal(configValue(next, section, key), String(choice.ports[name]));
  const changed = next.split('\n').filter((line, i) => line !== source.split('\n')[i]);
  assert.equal(changed.length, 7);
  assert.match(next, /\[db\.pooler\]\nenabled = false/);
  assert.match(next, /\[analytics\]\n[^[]*enabled = false/);
  const rendered = stackConfigText({ QA_SYNTHETIC: 'placeholder' }, source, choice);
  assert.ok(rendered.includes(next));
  assert.match(rendered, /\[edge_runtime\.secrets\]\nQA_SYNTHETIC = "placeholder"/);
});

test('selection rejects arbitrary hosts, container syntax, missing/extra fields, unsafe and conflicting ports', () => {
  for (const name of ['', 'UPPER', '-starts-hyphen', 'a--b', 'x/y', 'x$()', 'x\nother', 'a'.repeat(33)]) {
    assert.throws(() => validateInstance({ ...choice, name }), /name/);
  }
  for (const value of [null, [], {}, { ...choice, host: 'example.com' }, { name: choice.name, ports: { api: 55421 } }, { ...choice, ports: { ...choice.ports, target: 'http://example.com' } }]) {
    assert.throws(() => validateInstance(value), /instance/);
  }
  for (const port of [0, 80, 1023, 65536, 55421.5, '55421', NaN]) assert.throws(() => validateInstance({ ...choice, ports: { ...choice.ports, api: port } }), /integer/);
  assert.throws(() => validateInstance({ ...choice, ports: { ...choice.ports, api: choice.ports.database } }), /distinct/);
  assert.throws(() => applyInstance(source.replace('[api]\n', '[api]\nport = 59999\n'), choice), /exactly one/);
  assert.throws(() => applyInstance(source.replace('inspector_port = 8083', '# missing inspector'), choice), /exactly one/);
});

test('missing persisted selection means default; malformed selection fails closed', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qa-instance-file-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'instance.json');
  assert.equal(readInstance(file), null);
  writeFileSync(file, 'oops');
  assert.throws(() => readInstance(file), /valid JSON/);
  writeFileSync(file, JSON.stringify(choice));
  assert.deepEqual(readInstance(file), choice);
});

test('separate process consumers consistently derive gateway, database, storage, runtime and loopback URLs from persisted selection', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qa-instance-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lab = path.join(root, 'qa-lab');
  mkdirSync(path.join(lab, 'lib'), { recursive: true });
  mkdirSync(path.join(lab, '.generated'), { recursive: true });
  for (const file of ['paths.mjs', 'instance.mjs', 'config.mjs', 'lab-config.mjs']) copyFileSync(new URL(`../../qa-lab/lib/${file}`, import.meta.url), path.join(lab, 'lib', file));
  writeFileSync(path.join(lab, 'supabase-config.template.toml'), source);
  writeFileSync(path.join(lab, '.generated', 'instance.json'), JSON.stringify(choice));
  const script = `import * as c from ${JSON.stringify(pathToFileURL(path.join(lab, 'lib/config.mjs')).href)};
    import { SUPABASE_API_URL } from ${JSON.stringify(pathToFileURL(path.join(lab, 'lib/lab-config.mjs')).href)};
    console.log(JSON.stringify({ id:c.projectId(), name:c.instanceName(), ports:c.stackPorts(), api:SUPABASE_API_URL,
      gateway:c.localGatewayOrigin(), db:c.localDbContainer(), storage:c.localContainer('storage'), edge:c.localContainer('edge_runtime'), rest:c.localContainer('rest'),
      studio:c.localStudioOrigin(), mail:c.localMailOrigin() }));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.deepEqual(result, { id: 'credentialdomd-qa-lab-operational', name: 'operational', ports: choice.ports,
    api: 'http://127.0.0.1:55421', gateway: 'http://supabase_kong_credentialdomd-qa-lab-operational:8000', db: 'supabase_db_credentialdomd-qa-lab-operational',
    storage: 'supabase_storage_credentialdomd-qa-lab-operational', edge: 'supabase_edge_runtime_credentialdomd-qa-lab-operational', rest: 'supabase_rest_credentialdomd-qa-lab-operational',
    studio: 'http://127.0.0.1:55423', mail: 'http://127.0.0.1:55424' });
});

test('generated configuration cannot silently switch to another stack id or port', () => {
  const current = stackConfigText();
  assert.doesNotThrow(() => assertSelectedStackConfig(null));
  assert.doesNotThrow(() => assertSelectedStackConfig(current));
  assert.throws(() => assertSelectedStackConfig(current.replace(/^project_id = .*$/m, 'project_id = "other-lab"')), /Refusing/);
  assert.throws(() => assertSelectedStackConfig(current.replace(/inspector_port = \d+/, 'inspector_port = 65001')), /Refusing/);
});

test('operational helpers contain no hardcoded default stack mutation targets', () => {
  for (const file of ['e2e/run.mjs', 'e2e/support/ops-helpers.mjs', 'e2e/ops-jobs.spec.mjs', 'lab.mjs', 'up.sh']) {
    const text = readFileSync(new URL(`../../qa-lab/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /supabase_(?:rest|edge_runtime|kong|storage)_credentialdomd-qa-lab/, file);
    assert.doesNotMatch(text, /http:\/\/127\.0\.0\.1:5432[1-4]/, file);
  }
});

test('a named instance refuses a sibling database override and a copied schema that dispatches to its gateway', () => {
  assert.doesNotThrow(() => assertInstanceDatabase({ port: '55422' }, { name: 'operational', port: 55422 }));
  assert.throws(() => assertInstanceDatabase({ port: '54322' }, { name: 'operational', port: 55422 }), /QA_LAB_DB_URL/);
  assert.doesNotThrow(() => assertInstanceDatabase({ port: '55555' }, { name: null, port: 54322 }), 'default retains existing override behavior');
  const gateway = 'http://supabase_kong_credentialdomd-qa-lab-operational:8000';
  const marker = `-- QA local gateway: ${gateway}\n`;
  assert.doesNotThrow(() => assertSchemaTargetsInstance(`${marker}select '${gateway}/functions/v1/send-reminders';`, { gateway, named: true }));
  assert.throws(() => assertSchemaTargetsInstance('select 1;', { gateway, named: true }), /regenerate/);
  assert.throws(() => assertSchemaTargetsInstance(`${marker}select 'http://supabase_kong_credentialdomd-qa-lab:8000/functions/v1/send-reminders';`, { gateway, named: true }), /regenerate/);
  assert.throws(() => assertSchemaTargetsInstance('-- QA local gateway: http://other:8000\nselect 1;', { gateway, named: true }), /regenerate/);
});

test('stack start/stop output never discloses CLI credentials, on success or failure', () => {
  const secret = 'synthetic-service-role-jwt-secret-that-must-not-be-logged';
  const output = `SERVICE_ROLE_KEY=${secret}\nS3_SECRET_ACCESS_KEY=${secret}\nJWT_SECRET=${secret}`;
  const logs = [];
  const run = (_command, _args, options) => {
    assert.notEqual(options.stdio, 'inherit');
    assert.equal(options.encoding, 'utf8');
    return { status: 0, stdout: output, stderr: output };
  };
  runStackCli(['start'], { run, log: line => logs.push(line) });
  runStackCli(['stop'], { run, log: line => logs.push(line) });
  assert.equal(logs.length, 3);
  assert.match(logs.join('\n'), /API http:\/\/127\.0\.0\.1:/);
  assert.doesNotMatch(logs.join('\n'), /synthetic-service|SERVICE_ROLE|JWT_SECRET|S3_SECRET/);
  assert.throws(() => runStackCli(['start'], { run: () => ({ status: 1, stdout: output, stderr: output }), log: line => logs.push(line) }), { message: 'supabase start failed (exit 1)' });
  assert.equal(logs.length, 3, 'failure forwards neither stream');
});

test('complete project ids cannot be silently shortened by the CLI into another container/network name', () => {
  const fits = { ...choice, name: 'a'.repeat(18) };
  const tooLong = { ...choice, name: 'a'.repeat(19) };
  assert.equal(instanceSettings(source, fits).projectId.length, 40);
  assert.equal(configValue(applyInstance(source, fits), '', 'project_id'), JSON.stringify(instanceSettings(source, fits).projectId));
  assert.throws(() => instanceSettings(source, tooLong), /project id exceeds 40/);
  assert.throws(() => applyInstance(source, tooLong), /project id exceeds 40/);
  assert.throws(() => stackConfigText({ QA_SYNTHETIC: 'placeholder' }, source, tooLong), /project id exceeds 40/);
  const longBase = source.replace('project_id = "credentialdomd-qa-lab"', `project_id = "${'b'.repeat(41)}"`);
  assert.throws(() => instanceSettings(longBase, null), /project id exceeds 40/);
});
