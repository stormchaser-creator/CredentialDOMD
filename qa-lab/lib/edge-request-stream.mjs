// Local CLI v2.109.1 / Edge Runtime v1.74.2 clones an unread request body.
// An early auth rejection can then leave the original tee branch pending.
// The isolated deny/echo counterfactual proves direct transfer settles the
// refusal and preserves every byte/header. This changes only the owned lab
// dispatcher; product authentication and function source remain untouched.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectId } from './config.mjs';
import { REPO_ROOT } from './paths.mjs';
import { checkoutFromMounts, sameCheckout } from './checkout-guard.mjs';

export const ORIGINAL_MAIN_SHA = 'c1ac55ec912be4042542159cb48815acbb2143fb0636219f156bbc97a56fa960';
export const TRANSFER_MAIN_SHA = 'c9e92400abd64a379701dac74949159c7f1467dbcfa61ef5b9a1293746730bbd';
const image = 'public.ecr.aws/supabase/edge-runtime:v1.74.2';
const oldExpression = 'new Request(t,e.clone())', newExpression = 'new Request(t,e)';
const sha = v => createHash('sha256').update(v).digest('hex');
const fail = v => new Error(`QA edge request stream: ${v}`);

export function streamPlan(edge, { project, root }) {
  const network = `supabase_network_${project}`;
  if (!/^credentialdomd-qa-lab(?:-[a-z][a-z0-9-]{0,63})?$/.test(project || '')
    || edge?.Name !== `/supabase_edge_runtime_${project}` || !/^[a-f0-9]{64}$/.test(edge?.Id || '')
    || !edge.State?.Running || edge.Config?.Image !== image
    || !sameCheckout(checkoutFromMounts(edge.Mounts), root)
    || JSON.stringify(Object.keys(edge.NetworkSettings?.Networks || {})) !== JSON.stringify([network])
    || edge.HostConfig?.NetworkMode !== network || edge.HostConfig?.Privileged
    || edge.HostConfig?.AutoRemove || edge.HostConfig?.PublishAllPorts
    || Object.keys(edge.HostConfig?.PortBindings || {}).length
    || !Array.isArray(edge.Config?.Env) || edge.Config.Cmd !== null) throw fail('runtime ownership or configuration mismatch');
  const entry = edge.Config.Entrypoint;
  if (!Array.isArray(entry) || entry.length !== 3 || entry[0] !== 'sh' || entry[1] !== '-c') throw fail('unsupported entrypoint');
  const match = /^(cat <<'EOF' > \/root\/index\.ts && edge-runtime start[^\n]*\n)([\s\S]*)\nEOF\n$/.exec(entry[2]);
  if (!match || !match[1].includes('edge-runtime start --main-service=/root --port=8081 --policy=per_worker')) throw fail('unsupported dispatcher startup');
  // The CLI heredoc adds one trailing newline to the installed source.
  const main = match[2] + '\n', before = sha(main);
  if (![ORIGINAL_MAIN_SHA, TRANSFER_MAIN_SHA].includes(before)) throw fail('unknown dispatcher version; review required');
  const next = before === TRANSFER_MAIN_SHA ? main : main.replace(oldExpression, newExpression);
  if (sha(next) !== TRANSFER_MAIN_SHA) throw fail('dispatcher delta is not the reviewed single expression');
  return { before, after: TRANSFER_MAIN_SHA, entrypoint: [entry[0], entry[1], match[1] + next + 'EOF\n'], network };
}

function docker(run, args) {
  const r = run('docker', args, { encoding:'utf8', timeout:15000, maxBuffer:2*1024*1024 });
  if (r?.status !== 0) throw fail(`command failed (${args[0]})`);
  return r.stdout;
}
export function ensureEdgeRequestStream({ run = spawnSync, project = projectId(), root = REPO_ROOT, readOnly = false } = {}) {
  const name = `supabase_edge_runtime_${project}`;
  const inspect = () => { try { return JSON.parse(docker(run, ['inspect', '--format', '{{json .}}', name])); } catch { throw fail('unreadable runtime identity'); } };
  let edge = inspect(), plan = streamPlan(edge, {project, root});
  let recreated = false;
  if (plan.before !== plan.after) {
    if (readOnly) throw fail('restart the owned lab before testing; reviewed request transfer is not installed');
    // The helper receives private container configuration over stdin, never
    // in arguments, logs, or a durable file. It preserves the original network,
    // mounts, environment and security configuration, with rollback on failure.
    const r = run(process.execPath, [fileURLToPath(new URL('./edge-request-stream-recreate.mjs', import.meta.url))], {
      input:JSON.stringify({edge, project, root}), encoding:'utf8', timeout:120000, maxBuffer:1024*1024,
    });
    if (r?.status !== 0) throw fail('owned runtime replacement failed; check local runtime before continuing');
    recreated = true; edge = inspect(); plan = streamPlan(edge, {project, root});
  }
  const installed = docker(run, ['exec', edge.Id, 'cat', '/root/index.ts']);
  if (plan.before !== TRANSFER_MAIN_SHA || sha(installed) !== TRANSFER_MAIN_SHA) throw fail('active dispatcher does not match the reviewed transfer');
  return {projectId:project, containerId:edge.Id, image, dispatcherSha256:TRANSFER_MAIN_SHA, recreated, checkedAt:new Date().toISOString()};
}
export const readEdgeRequestStream = options => ensureEdgeRequestStream({...options, readOnly:true});
