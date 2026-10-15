import { streamPlan } from './edge-request-stream.mjs';

/** Same owned network/configuration, one startup delta, no volume deletion. */
export async function replaceOwnedEdge({edge, project, root, api, ready}) {
  const plan = streamPlan(edge,{project,root}), name=edge.Name.slice(1);
  const backup=`${name}-stream-backup-${edge.Id.slice(0,12)}`;
  const live=await api('GET',`/containers/${edge.Id}/json`);
  if (JSON.stringify(live.Config)!==JSON.stringify(edge.Config) || JSON.stringify(live.HostConfig)!==JSON.stringify(edge.HostConfig)) throw Error('Runtime changed before replacement');
  streamPlan(live,{project,root});
  let renamed=false, stopped=false, created;
  try {
    await api('POST',`/containers/${edge.Id}/stop?t=10`); stopped=true;
    await api('POST',`/containers/${edge.Id}/rename?name=${encodeURIComponent(backup)}`); renamed=true;
    const config={...edge.Config,Entrypoint:plan.entrypoint,HostConfig:edge.HostConfig,
      NetworkingConfig:{EndpointsConfig:{[plan.network]:{Aliases:edge.NetworkSettings.Networks[plan.network].Aliases}}}};
    delete config.Hostname;
    created=(await api('POST',`/containers/create?name=${encodeURIComponent(name)}`,config)).Id;
    await api('POST',`/containers/${created}/start`);
    if (!await ready(created)) throw Error('Replacement did not start');
    await api('DELETE',`/containers/${edge.Id}`);
    return {recreated:true,containerId:created,dispatcherSha256:plan.after};
  } catch {
    let rollbackComplete=true;
    for(const [method,path] of [created && ['DELETE',`/containers/${created}?force=true`],renamed && ['POST',`/containers/${edge.Id}/rename?name=${encodeURIComponent(name)}`],stopped && ['POST',`/containers/${edge.Id}/start`]].filter(Boolean)) {
      try {await api(method,path);} catch {rollbackComplete=false;}
    }
    throw Error(`Owned replacement failed; rollback ${rollbackComplete?'completed':'incomplete—inspect the owned runtime before continuing'}.`);
  }
}
