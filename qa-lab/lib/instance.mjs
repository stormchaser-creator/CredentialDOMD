// Optional per-checkout instance selection. This file contains no credentials.
// Persist it before starting the lab so every child/CLI invocation chooses the
// same containers and ports. Never inherit an ephemeral environment override.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GENERATED_DIR } from './paths.mjs';

export const INSTANCE_FILE = path.join(GENERATED_DIR, 'instance.json');
export const PORT_FIELDS = Object.freeze({
  api: ['api', 'port'], database: ['db', 'port'], shadow: ['db', 'shadow_port'],
  studio: ['studio', 'port'], mail: ['local_smtp', 'port'], inspector: ['edge_runtime', 'inspector_port'],
});

export function validateInstance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'name,ports') throw new Error('QA lab instance must contain only name and ports');
  if (typeof value.name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.name) || value.name.length > 32) {
    throw new Error('QA lab instance name must be 1-32 lowercase letters, digits or single hyphens, starting with a letter');
  }
  if (!value.ports || typeof value.ports !== 'object' || Array.isArray(value.ports)
      || Object.keys(value.ports).sort().join(',') !== Object.keys(PORT_FIELDS).sort().join(',')) {
    throw new Error(`QA lab instance ports must contain exactly ${Object.keys(PORT_FIELDS).join(', ')}`);
  }
  const ports = {};
  for (const key of Object.keys(PORT_FIELDS)) {
    const port = value.ports[key];
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`QA lab ${key} port must be an integer from 1024 to 65535`);
    ports[key] = port;
  }
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('QA lab instance ports must all be distinct');
  return Object.freeze({ name: value.name, ports: Object.freeze(ports) });
}

export function readInstance(file = INSTANCE_FILE) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`QA lab instance file is not valid JSON: ${file}`); }
  return validateInstance(parsed);
}

// One immutable choice per process, also used by imported URL constants.
export const selectedInstance = readInstance();

export function configValue(source, section, key) {
  let current = '';
  const values = [];
  for (const line of source.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) { current = header[1]; continue; }
    const entry = /^\s*([a-z_]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (current === section && entry?.[1] === key) values.push(entry[2]);
  }
  if (values.length !== 1) throw new Error(`QA lab template must contain exactly one ${section ? `[${section}] ` : ''}${key}`);
  return values[0];
}

export function instanceSettings(source, instance = selectedInstance) {
  const rawId = configValue(source, '', 'project_id');
  if (!/^"[a-z][a-z0-9-]*"$/.test(rawId)) throw new Error('QA lab template project_id must be a plain lowercase identifier');
  const baseId = JSON.parse(rawId);
  const selected = instance === null ? null : validateInstance(instance);
  const projectId = selected ? `${baseId}-${selected.name}` : baseId;
  // The installed CLI auto-fixes longer ids to 40 characters. That would
  // start containers on a different network from the loopback-only network
  // we prepared, and defeat exact-name ownership/environment checks.
  if (projectId.length > 40) throw new Error('QA lab project id exceeds 40 characters; shorten the instance name before starting the CLI');
  const ports = Object.fromEntries(Object.entries(PORT_FIELDS).map(([name, [section, key]]) => {
    const raw = configValue(source, section, key);
    if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) throw new Error(`QA lab template ${name} port is invalid`);
    return [name, selected?.ports[name] ?? Number(raw)];
  }));
  return Object.freeze({ name: selected?.name ?? null, projectId, ports: Object.freeze(ports) });
}

export function applyInstance(source, instance = selectedInstance) {
  const settings = instanceSettings(source, instance);
  if (instance === null) return source;
  let section = '';
  return source.split('\n').map(line => {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) section = header[1];
    if (!section && /^project_id\s*=/.test(line)) return `project_id = "${settings.projectId}"`;
    for (const [name, [target, key]] of Object.entries(PORT_FIELDS)) {
      if (section === target && new RegExp(`^${key}\\s*=`).test(line)) return `${key} = ${settings.ports[name]}`;
    }
    return line;
  }).join('\n');
}
