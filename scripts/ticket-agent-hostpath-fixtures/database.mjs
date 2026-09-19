// Test-only transport replacement: no native fetch or network fallback exists.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const directory = process.env.SUPPORT_FIXTURE_RUN;
const scenario = process.env.SUPPORT_FIXTURE_SCENARIO;
const target = '20000000-0000-4000-8000-000000000001';
const related = '20000000-0000-4000-8000-000000000002';
const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
if (!directory?.startsWith('/')) throw Error('Synthetic fixture directory required');

export function sql(statement) {
  const result = spawnSync(process.env.SUPPORT_FIXTURE_PSQL, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', process.env.SUPPORT_FIXTURE_SOCKET, '-p', '56432', '-U', 'postgres', '-d', 'postgres'], {
    input: `set time zone 'UTC';${statement}`, encoding: 'utf8', timeout: 10000,
    env: { PATH: '/usr/bin:/bin' },
  });
  if (result.error || result.status !== 0) throw Error(`Synthetic database failed: ${result.stderr}`);
  return result.stdout.trim();
}
export function newInput() {
  sql(`INSERT INTO support_messages VALUES ('30000000-0000-4000-8000-000000000099','${target}','${owner}','Synthetic new input',false,now(),null,null)`);
}
globalThis.fetch = async (url, options) => {
  if (url !== 'https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query' ||
      options?.method !== 'POST' || options.headers.Authorization !== 'Bearer synthetic-database-token') {
    throw Error('Unexpected request: synthetic fixture refuses all network');
  }
  const { query } = JSON.parse(options.body);
  if (typeof query !== 'string') throw Error('Synthetic query missing');
  appendFileSync(path.join(directory, 'queries.jsonl'), JSON.stringify({ query }) + '\n', { mode: 0o600 });
  if (scenario === 'queue_failure') return new Response('Synthetic database outage', { status: 503 });
  if (scenario === 'owner_race' && query.includes('AS context_owner_id') && query.includes(`t.id='${related}'`)) {
    sql(`UPDATE support_tickets SET user_id='${other}' WHERE id='${related}'`);
  }
  const arrival = path.join(directory, 'arrival-applied');
  if (scenario === 'arrival_on_load' && process.argv.includes('--load') &&
      existsSync(path.join(directory, 'arrival-enabled')) && !existsSync(arrival)) {
    newInput(); writeFileSync(arrival, 'done', { mode: 0o600 });
  }
  let rows;
  if (query.startsWith('begin read only; ') && query.endsWith('; rollback;')) {
    const inner = query.slice('begin read only; '.length, -'; rollback;'.length);
    rows = JSON.parse(sql(`begin read only; select coalesce(json_agg(row),'[]'::json) from (${inner}) row; rollback;`));
  } else if (query.startsWith('DO $ticket_broker$')) {
    // Execute the exact generated writer and its concluding SELECT. psql emits
    // only the inserted UUID (or no row); convert the API envelope, not the SQL.
    const output = sql(query);
    rows = output ? output.split('\n').map(id => ({ id })) : [];
  } else throw Error('Unexpected SQL shape');
  return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
