// The pinned local Kong opens a fresh upstream connection for each request.
// A shorter idle timeout did not eliminate observed stale-connection failures.
// Disable only this lab's pool, preserving ownership checks, active readback
// and the rule that a running verification window never repairs its runtime.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectId, stackPorts } from './config.mjs';
import { REPO_ROOT } from './paths.mjs';
import { checkoutFromMounts, sameCheckout } from './checkout-guard.mjs';

export const GATEWAY_POOL_SIZE = 0;
const ENV_FILE = '/usr/local/kong/.kong_env';
const SETTINGS = ['upstream_keepalive_pool_size', 'upstream_keepalive_max_requests', 'upstream_keepalive_idle_timeout'];
const error = detail => new Error(`QA gateway keepalive: ${detail}`);
const sha = text => createHash('sha256').update(text).digest('hex');
// Kong 2.8.1 rewrites the generated file with a different line order on reload.
// Every nonempty line must still match exactly, including duplicate lines and
// whitespace within a value; only order and blank line layout are immaterial.
const generatedLines = text => text.split('\n').filter(line => line !== '').sort();

/** Read only the three known numeric settings; never include raw config in errors. */
export function gatewayKeepaliveSettings(source) {
  if (typeof source !== 'string' || source.length > 1024 * 1024) throw error('invalid configuration text');
  const result = {};
  for (const name of SETTINGS) {
    const found = source.split('\n').filter(line => new RegExp(`^\\s*${name}\\s*=`).test(line));
    if (found.length !== 1) throw error(`expected exactly one ${name}`);
    const value = new RegExp(`^${name} = ([0-9]+)\\r?$`).exec(found[0])?.[1];
    if (!value || !Number.isSafeInteger(Number(value)) || Number(value) > 1000000) throw error(`invalid ${name}`);
    result[name] = Number(value);
  }
  if (result.upstream_keepalive_max_requests < 1) throw error('unexpected upstream request limit');
  if (![20, 60].includes(result.upstream_keepalive_idle_timeout)) throw error('unsupported existing idle timeout');
  return result;
}

export function withGatewayPoolDisabled(source) {
  const settings = gatewayKeepaliveSettings(source);
  return settings.upstream_keepalive_pool_size === GATEWAY_POOL_SIZE ? source
    : source.replace(/^upstream_keepalive_pool_size = [0-9]+(\r?)$/m, `upstream_keepalive_pool_size = ${GATEWAY_POOL_SIZE}$1`);
}

const INSPECT = '{{json .}}';
function command(run, args, options = {}) {
  const r = run('docker', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000, ...options });
  // Docker/Kong failures can quote the config or environment; do not echo them.
  if (!r || r.status !== 0 || typeof r.stdout !== 'string') throw error(`command failed (${args[0]})`);
  return r.stdout;
}
function inspect(run, name) {
  const raw = command(run, ['inspect', '--format', INSPECT, name]);
  try { return JSON.parse(raw); } catch { throw error('unreadable container identity'); }
}

/** No takeover bypass: a runtime edit needs positive evidence of this checkout. */
export function assertGatewayOwnership(kong, edge, { project, root, apiPort }) {
  if (!/^credentialdomd-qa-lab(?:-[a-z][a-z0-9-]{0,63})?$/.test(project || '')
    || !Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw error('invalid selected instance');
  const network = `supabase_network_${project}`;
  for (const [kind, data] of [['kong', kong], ['edge_runtime', edge]]) {
    if (data?.Name !== `/supabase_${kind}_${project}` || !/^[a-f0-9]{64}$/.test(data?.Id || '')
      || data?.State?.Running !== true || !data?.NetworkSettings?.Networks?.[network]) throw error('container identity or network does not match the selected instance');
  }
  if (!sameCheckout(checkoutFromMounts(edge.Mounts), root)) throw error('edge runtime checkout is not this checkout');
  if (!['public.ecr.aws/supabase/kong:2.8.1', 'supabase/kong:2.8.1'].includes(kong?.Config?.Image)) throw error('unsupported gateway image');
  const ports = kong.NetworkSettings.Ports;
  const api = ports?.['8000/tcp'];
  if (!Array.isArray(api) || api.length !== 1 || api[0].HostIp !== '127.0.0.1' || api[0].HostPort !== String(apiPort)
    || Object.values(ports).some(bindings => bindings != null && (!Array.isArray(bindings) || bindings.some(p => p.HostIp !== '127.0.0.1')))) throw error('gateway ports are not the selected loopback bindings');
  if (!Array.isArray(kong.Config.Env)) throw error('gateway environment is unavailable');
  const overrides = kong.Config.Env.filter(v => typeof v === 'string' && v.startsWith('KONG_UPSTREAM_KEEPALIVE_IDLE_TIMEOUT='));
  if (overrides.length > 1 || overrides.some(v => v !== 'KONG_UPSTREAM_KEEPALIVE_IDLE_TIMEOUT=20')) throw error('conflicting container idle-timeout override');
  const pools = kong.Config.Env.filter(v => typeof v === 'string' && v.startsWith('KONG_UPSTREAM_KEEPALIVE_POOL_SIZE='));
  if (pools.length > 1 || pools.some(v => v !== 'KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0')) throw error('conflicting container pool-size override');
  return kong.Id;
}

function activeSettings(run, id) {
  const raw = command(run, ['exec', id, 'wget', '-q', '-T', '3', '-t', '1', '-O', '-', 'http://127.0.0.1:8001/'], { timeout: 5000 });
  let config;
  try { config = JSON.parse(raw)?.configuration; } catch { throw error('unreadable active gateway settings'); }
  if (!config || SETTINGS.some(k => !Number.isSafeInteger(config[k]))) throw error('active gateway settings are unavailable');
  return Object.fromEntries(SETTINGS.map(k => [k, config[k]]));
}

/** Run before any QA health window, never as a repair during a browser run. */
export function ensureGatewayKeepalive({ run = spawnSync, project = projectId(), root = REPO_ROOT,
  apiPort = stackPorts().api, pause = () => spawnSync('sleep', ['0.1']), readOnly = false } = {}) {
  const names = [`supabase_kong_${project}`, `supabase_edge_runtime_${project}`];
  const identify = () => {
    const [kong, edge] = names.map(name => inspect(run, name));
    const id = assertGatewayOwnership(kong, edge, { project, root, apiPort });
    return { kong, edge, id };
  };
  const first = identify();
  const source = command(run, ['exec', first.id, 'cat', ENV_FILE]);
  const before = gatewayKeepaliveSettings(source), next = withGatewayPoolDisabled(source);
  const activeBefore = activeSettings(run, first.id);
  let reloaded = false;
  if (next !== source || SETTINGS.some(k => activeBefore[k] !== before[k])) {
    if (readOnly) throw error('restart the owned lab before accepting results; disabled upstream pool is not active');
    const latest = identify();
    if (latest.id !== first.id || latest.edge.Id !== first.edge.Id) throw error('runtime identity changed before reload');
    // Lock and compare under the container before replacing the file. Exact ID
    // targeting prevents a same-name replacement from receiving this write.
    const script = `set -eu
lock=/usr/local/kong/.qa-keepalive-lock
mkdir "$lock"
tmp=/usr/local/kong/.kong_env.qa-keepalive.$$
trap 'rm -f "$tmp"; rmdir "$lock"' EXIT
test "$(sha256sum ${ENV_FILE} | cut -d ' ' -f 1)" = '${sha(source)}'
umask 077
cat > "$tmp"
mv "$tmp" ${ENV_FILE}
kong reload`;
    command(run, ['exec', '-i', first.id, 'sh', '-c', script], { input: next, timeout: 30000 });
    reloaded = true;
  }
  const stored = command(run, ['exec', first.id, 'cat', ENV_FILE]);
  if (JSON.stringify(generatedLines(stored)) !== JSON.stringify(generatedLines(next))) throw error('stored settings changed unexpectedly after reload');
  let active;
  for (let i = 0; i < 30; i++) {
    active = activeSettings(run, first.id);
    if (SETTINGS.every(k => active[k] === (k === 'upstream_keepalive_pool_size' ? GATEWAY_POOL_SIZE : before[k]))) break;
    if (i === 29) throw error('active settings did not match after reload');
    pause();
  }
  return { projectId: project, containerId: first.id, image: first.kong.Config.Image,
    idleSeconds: active.upstream_keepalive_idle_timeout, poolSize: active.upstream_keepalive_pool_size,
    maxRequests: active.upstream_keepalive_max_requests, reloaded, checkedAt: new Date().toISOString() };
}

/** Reused labs are verified without changing their runtime during a run. */
export const readGatewayKeepalive = options => ensureGatewayKeepalive({ ...options, readOnly: true });
