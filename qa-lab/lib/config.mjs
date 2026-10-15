// Values read from the lab's stack config template (qa-lab/supabase-config.template.toml).
import { readFileSync } from 'node:fs';
import { STACK_CONFIG_TEMPLATE } from './paths.mjs';
import { instanceSettings } from './instance.mjs';

const settings = instanceSettings(readFileSync(STACK_CONFIG_TEMPLATE, 'utf8'));
export const projectId = () => settings.projectId;
export const stackPorts = () => settings.ports;
export const instanceName = () => settings.name;
export const localApiOrigin = () => `http://127.0.0.1:${settings.ports.api}`;
export const localStudioOrigin = () => `http://127.0.0.1:${settings.ports.studio}`;
export const localMailOrigin = () => `http://127.0.0.1:${settings.ports.mail}`;
export function localContainer(service) {
  if (!/^[a-z][a-z0-9_]*$/.test(service)) throw new Error('invalid QA lab container service');
  return `supabase_${service}_${projectId()}`;
}

/**
 * How the LOCAL database reaches the LOCAL API gateway (Kong) over the stack's
 * Docker network. Production URLs inside function bodies are rewritten to this,
 * so pg_net calls made by a local trigger or cron job can only land locally.
 */
export const localGatewayOrigin = () => `http://${localContainer('kong')}:8000`;
export const localDbContainer = () => localContainer('db');
