import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureGatewayKeepalive, readGatewayKeepalive, gatewayKeepaliveSettings, withGatewayPoolDisabled } from '../../qa-lab/lib/gateway-keepalive.mjs';

const project = 'credentialdomd-qa-lab-isolated', root = '/own/checkout', apiPort = 55421;
const network = `supabase_network_${project}`;
const configuration = (n, pool = 60) => `unrelated = untouched\nupstream_keepalive_pool_size = ${pool}\nupstream_keepalive_max_requests = 100\nupstream_keepalive_idle_timeout = ${n}\nsecret = must-not-be-printed\n`;
function fixture({ idle = 60, activeIdle = idle, pool = 60, activePool = pool } = {}) {
  let stored = configuration(idle, pool), active = gatewayKeepaliveSettings(configuration(activeIdle, activePool));
  const calls = [], mutations = [];
  const kong = { Name: `/supabase_kong_${project}`, Id: 'a'.repeat(64), Config: { Image: 'public.ecr.aws/supabase/kong:2.8.1', Env: [] }, State: { Running: true }, NetworkSettings: { Networks: { [network]: {} }, Ports: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(apiPort) }] } } };
  const edge = { Name: `/supabase_edge_runtime_${project}`, Id: 'b'.repeat(64), State: { Running: true }, NetworkSettings: { Networks: { [network]: {} } }, Mounts: [{ Type: 'bind', Source: `${root}/qa-lab/.generated/stack/supabase/functions` }] };
  const f = { kong, edge, calls, mutations, before: null, admin: null,
    options: { project, root, apiPort, pause() {} }, get: () => stored,
    run(command, args, options) {
      calls.push([command, args]);
      const fault = f.before?.(args, options); if (fault) return fault;
      if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify(args.at(-1).includes('_edge_runtime_') ? edge : kong) };
      if (args[1] === '-i') { mutations.push({ args, input: options.input }); stored = options.input; active = gatewayKeepaliveSettings(stored); return { status: 0, stdout: '' }; }
      if (args[2] === 'cat') return { status: 0, stdout: stored };
      if (args[2] === 'wget') return { status: 0, stdout: f.admin?.(active) ?? JSON.stringify({ configuration: active, secret: 'never retain admin details' }) };
      throw Error('Unexpected command');
    } };
  f.options.run = f.run;
  return f;
}

test('exact installed-format policy changes one line and keeps all other values', () => {
  const old = configuration(60), next = withGatewayPoolDisabled(old);
  assert.equal(next, configuration(60, 0));
  assert.equal(withGatewayPoolDisabled(next), next);
  for (const bad of [old.replace(' = 60\nsecret', ' = 0\nsecret'), old.replace(' = 60\nsecret', ' = 75\nsecret'), old + 'upstream_keepalive_idle_timeout = 60\n', old.replace('upstream_keepalive_idle_timeout = 60', 'upstream_keepalive_idle_timeout = nope'), old.replace('upstream_keepalive_pool_size = 60', 'upstream_keepalive_pool_size = -1')]) assert.throws(() => withGatewayPoolDisabled(bad), /QA gateway keepalive/);
});

test('owned startup reloads only its immutable container ID and produces a safe active receipt', () => {
  const f = fixture(), receipt = ensureGatewayKeepalive(f.options);
  assert.equal(f.mutations.length, 1); assert.equal(f.get(), configuration(60, 0));
  assert.equal(f.mutations[0].args[2], f.kong.Id);
  assert.match(f.mutations[0].args.at(-1), /sha256sum/); assert.match(f.mutations[0].args.at(-1), /mkdir "\$lock"/);
  assert.deepEqual({ ...receipt, checkedAt: null }, { projectId: project, containerId: f.kong.Id, image: f.kong.Config.Image, idleSeconds: 60, poolSize: 0, maxRequests: 100, reloaded: true, checkedAt: null });
  assert.ok(!JSON.stringify(receipt).includes('secret'));
});

test('already-correct or reused runtimes are verified without reload', () => {
  for (const operation of [ensureGatewayKeepalive, readGatewayKeepalive]) {
    const f = fixture({ pool: 0 }); const receipt = operation(f.options);
    assert.equal(receipt.reloaded, false); assert.equal(f.mutations.length, 0);
  }
});

test('reused runtime with unsafe settings is refused without a repair', () => {
  const f = fixture(); assert.throws(() => readGatewayKeepalive(f.options), /restart the owned lab/);
  assert.equal(f.mutations.length, 0);
});

test('wrong owner, identity, network, image, port or environment is refused before any write', () => {
  for (const change of [
    f => { f.edge.Mounts[0].Source = '/foreign/checkout/supabase/functions'; },
    f => { f.edge.Mounts = []; }, f => { f.kong.Name += '-other'; },
    f => { f.kong.State.Running = false; }, f => { f.edge.NetworkSettings.Networks = {}; },
    f => { f.kong.Config.Image = 'kong:3'; }, f => { f.kong.Id = 'untrusted'; },
    f => { f.kong.NetworkSettings.Ports['8000/tcp'][0].HostIp = '0.0.0.0'; },
    f => { f.kong.NetworkSettings.Ports['8000/tcp'][0].HostPort = '55521'; },
    f => { f.kong.Config.Env = ['KONG_UPSTREAM_KEEPALIVE_IDLE_TIMEOUT=60']; },
    f => { f.kong.Config.Env = ['KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=60']; },
    f => { f.options.project = 'production'; },
  ]) {
    const f = fixture(); change(f); assert.throws(() => ensureGatewayKeepalive(f.options), /QA gateway keepalive/); assert.equal(f.mutations.length, 0);
  }
});

test('a replaced same-name container is refused at the second ownership boundary', () => {
  const f = fixture(); let reads = 0;
  f.before = args => { if (args[0] === 'inspect' && args.at(-1).includes('_kong_') && ++reads === 2) f.kong.Id = 'c'.repeat(64); };
  assert.throws(() => ensureGatewayKeepalive(f.options), /identity changed/); assert.equal(f.mutations.length, 0);
});

test('configuration read, mutation and reload failures stay red without output leakage', () => {
  for (const stage of ['inspect', 'cat', '-i', 'wget']) {
    const f = fixture(); f.before = args => args.includes(stage) ? { status: 1, stdout: 'secret-provider-value', stderr: 'secret-provider-value' } : null;
    assert.throws(() => ensureGatewayKeepalive(f.options), e => /command failed/.test(e.message) && !e.message.includes('secret-provider-value'));
  }
});

test('successful reload command is insufficient without active configuration readback', () => {
  const f = fixture(); let reads = 0;
  f.admin = active => JSON.stringify({ configuration: { ...active, upstream_keepalive_pool_size: 60 } });
  f.options.pause = () => { reads++; };
  assert.throws(() => ensureGatewayKeepalive(f.options), /active settings did not match/);
  assert.equal(f.mutations.length, 1); assert.equal(reads, 29);
});

test('readback rejects unrelated changes and malformed admin data', () => {
  for (const change of [active => ({ ...active, upstream_keepalive_pool_size: 61 }), () => null]) {
    const f = fixture(); f.admin = active => JSON.stringify({ configuration: change(active) });
    assert.throws(() => ensureGatewayKeepalive(f.options), /active (?:gateway )?settings/);
  }
});

test('a config already changed on disk still requires matching active worker settings', () => {
  const f = fixture({ pool: 0, activePool: 60 });
  assert.equal(ensureGatewayKeepalive(f.options).reloaded, true); assert.equal(f.mutations.length, 1);
});

// Child-process timeout is fatal; the readiness loop never hides a hung command.
test('every command is bounded and an admin timeout fails without output leakage', () => {
  const f = fixture();
  f.before = (args, options) => {
    assert.ok(Number.isInteger(options.timeout) && options.timeout > 0 && options.timeout <= 30000);
    if (args.includes('wget')) {
      assert.equal(options.timeout, 5000); assert.ok(args.includes('-T'));
      return { status: null, error: Object.assign(new Error('secret body'), { code: 'ETIMEDOUT' }), stdout: 'secret body' };
    }
  };
  assert.throws(() => ensureGatewayKeepalive(f.options), e => /command failed/.test(e.message) && !e.message.includes('secret body'));
  assert.equal(f.mutations.length, 0);
});

test('Kong-generated line reordering is accepted but every unrelated value must stay exact', () => {
  const good = fixture(); let reads = 0;
  good.before = args => args[2] === 'cat' && ++reads === 2
    ? { status: 0, stdout: good.get().split('\n').reverse().join('\n') + '\n' } : null;
  assert.equal(ensureGatewayKeepalive(good.options).poolSize, 0);
  for (const transform of [s => s.replace('untouched', 'changed'), s => s + 'secret = must-not-be-printed\n', s => s.replace('secret = must-not-be-printed', 'secret = must-not-be-printed ')]) {
    const bad = fixture(); let reads = 0;
    bad.before = args => args[2] === 'cat' && ++reads === 2 ? { status: 0, stdout: transform(bad.get()) } : null;
    assert.throws(() => ensureGatewayKeepalive(bad.options), /stored settings changed unexpectedly/);
  }
});

// The previous candidate used 20s. Moving to no reuse must preserve that
// unrelated numeric value, and both recorded/active pool values must be zero.
test('an existing 20-second setting is retained while its pool is disabled', () => {
  const f = fixture({ idle: 20 });
  const receipt = ensureGatewayKeepalive(f.options);
  assert.equal(receipt.idleSeconds, 20); assert.equal(receipt.poolSize, 0);
  assert.equal(f.get(), configuration(20, 0));
  assert.equal(readGatewayKeepalive(f.options).reloaded, false);
});
