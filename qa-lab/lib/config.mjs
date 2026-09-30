// Values read from the lab's stack config template (qa-lab/supabase-config.template.toml).
import { readFileSync } from 'node:fs';
import { STACK_CONFIG_TEMPLATE } from './paths.mjs';

export function projectId() {
  const m = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(STACK_CONFIG_TEMPLATE, 'utf8'));
  if (!m) throw new Error('project_id missing from qa-lab/supabase-config.template.toml');
  return m[1];
}

/**
 * How the LOCAL database reaches the LOCAL API gateway (Kong) over the stack's
 * Docker network. Production URLs inside function bodies are rewritten to this,
 * so pg_net calls made by a local trigger or cron job can only land locally.
 */
export const localGatewayOrigin = () => `http://supabase_kong_${projectId()}:8000`;
export const localDbContainer = () => `supabase_db_${projectId()}`;
