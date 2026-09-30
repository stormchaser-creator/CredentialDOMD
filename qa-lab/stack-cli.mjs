#!/usr/bin/env node
// node qa-lab/stack-cli.mjs start | stop [--wipe]   (used by up.sh / down.sh)
//
// start: the local stack from the lab workdir, trusting the mock Clerk's token
// key, with the edge functions pointed at the mocks (on this machine's saved
// lab ports) once the local vault values exist.
import { existsSync } from 'node:fs';
import { startStack, stopStack } from './lib/stack.mjs';
import { functionsEnv } from './lib/functions-env.mjs';
import { resolveLabPorts } from './lib/procs.mjs';
import { DEFAULT_API_PORT, DEFAULT_APP_PORT, DEFAULT_MOCK_PORT } from './lib/lab-config.mjs';
import { LAB_PORTS_JSON, LOCAL_SECRETS_JSON } from './lib/paths.mjs';

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'start') {
    let env = null;
    if (existsSync(LOCAL_SECRETS_JSON)) env = functionsEnv(await resolveLabPorts({ defaults: { mock: DEFAULT_MOCK_PORT, app: DEFAULT_APP_PORT, api: DEFAULT_API_PORT }, file: LAB_PORTS_JSON }));
    startStack({ functionsEnv: env });
  } else if (command === 'stop') stopStack({ wipe: rest.includes('--wipe') });
  else throw new Error('usage: node qa-lab/stack-cli.mjs start | stop [--wipe]');
} catch (e) { console.error(`qa-lab: ${e.message}`); process.exit(1); }
