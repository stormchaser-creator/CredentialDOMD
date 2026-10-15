// Called only by the ownership-checked startup helper, outside a QA run.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { streamPlan, TRANSFER_MAIN_SHA } from './edge-request-stream.mjs';
import { replaceOwnedEdge } from './edge-request-stream-transaction.mjs';
const {edge, project, root} = JSON.parse(readFileSync(0, 'utf8'));
streamPlan(edge, {project, root});
const context = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {encoding:'utf8', timeout:10000});
const host = context.stdout?.trim();
if (context.status !== 0 || !host?.startsWith('unix:///')) throw Error('Local Docker socket required');
const socketPath = host.slice(7);
async function api(method, path, data) {
  const body = data === undefined ? null : JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath, method, path, headers:body ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} : {}}, res => {
      let text=''; res.on('data', b => {text+=b;}); res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Error('Owned Docker operation failed'));
        try {resolve(text ? JSON.parse(text) : null);} catch {reject(Error('Invalid local Docker response'));}
      });
    });
    req.setTimeout(20000, () => req.destroy(Error('Local Docker deadline'))); req.on('error', reject); req.end(body);
  });
}
async function ready(created) {
  for (let i=0;i<60;i++) {
    const r=spawnSync('docker',['exec',created,'cat','/root/index.ts'],{encoding:'utf8',timeout:2000});
    const candidate=await api('GET',`/containers/${created}/json`);
    if (r.status===0 && createHash('sha256').update(r.stdout).digest('hex')===TRANSFER_MAIN_SHA && candidate.State.Running && streamPlan(candidate,{project,root}).before===TRANSFER_MAIN_SHA) return true;
    await new Promise(r=>setTimeout(r,250));
  }
  return false;
}
try { console.log(JSON.stringify(await replaceOwnedEdge({edge,project,root,api,ready}))); }
catch(e) { console.error(e.message); process.exitCode=1; }
