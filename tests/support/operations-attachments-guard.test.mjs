// Guard for ticket 5f9b744d. The support-operations pilot is text only: with
// VITE_SUPPORT_OPERATIONS_ENABLED on, the attach control disappears from the
// physician's New ticket form and reply box, and create/reply send no files.
// Turning the flag on today would silently undo the ticket-upload feature.
//
// This fails the build the moment any deploy or environment file turns the
// flag on while the pilot still lacks attachments. Port attachments to the
// pilot first (both forms render the attach control, and the operations
// client carries the files); this test then passes with the flag on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSupportOperationsClient } from '../../src/utils/supportOperationsClient.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FLAG = 'VITE_SUPPORT_OPERATIONS_ENABLED';

/** Every file that can set a Vite build variable for a deployed build. */
async function configFiles() {
  const files = [];
  const workflows = `${root}.github/workflows/`;
  if (existsSync(workflows)) for (const f of await readdir(workflows)) if (/\.ya?ml$/.test(f)) files.push(`${workflows}${f}`);
  for (const f of await readdir(root)) if (/^\.env/.test(f) && !/\.example$/.test(f)) files.push(`${root}${f}`);
  for (const f of ['netlify.toml', 'vercel.json', 'vite.config.js']) if (existsSync(`${root}${f}`)) files.push(`${root}${f}`);
  return files;
}

/** [file, value] for every place the flag is given a value. */
async function flagSettings() {
  const out = [];
  const setting = new RegExp(`${FLAG}["']?\\s*[:=]\\s*["']?([A-Za-z0-9_]+)`, 'g');
  for (const file of await configFiles()) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(setting)) out.push([file.slice(root.length), m[1]]);
  }
  return out;
}

async function rendersAttachControl(flag) {
  const folder = await mkdtemp(`${root}tests/support/.guard-`);
  try {
    const output = await build({
      entryPoints: [`${root}src/components/pages/SupportModal.jsx`], bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', write: false,
      external: ['react', 'react/jsx-runtime'], define: { [`import.meta.env.${FLAG}`]: JSON.stringify(flag ? 'true' : 'false') },
      plugins: [{ name: 'synthetic-ui-dependencies', setup(b) {
        b.onResolve({ filter: /context\/AppContext|lib\/supabase|\.\.\/shared$|shared\/TicketAttachments$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path.includes('AppContext')
          ? "export const useApp=()=>({theme:{},user:{id:'user_synthetic',email:'fixture@example.invalid'},isDesktop:true});"
          : args.path.includes('supabase') ? 'export const supabase=null;'
            : args.path.endsWith('TicketAttachments') ? 'export default function TicketAttachments(){return null;}'
              : "import React from 'react';export function ScreenshotAttach(){return React.createElement('button',{'data-fixture':'attachment'},'Attach control');}" }));
      } }],
    });
    const path = `${folder}/${flag ? 'pilot' : 'legacy'}.mjs`;
    await writeFile(path, output.outputFiles[0].text);
    const { default: SupportModal } = await import(pathToFileURL(path));
    return /Attach control/.test(renderToStaticMarkup(React.createElement(SupportModal, { open: true, onClose() {} })));
  } finally { await rm(folder, { recursive: true, force: true }); }
}
const pilotRendersAttachControl = () => rendersAttachControl(true);

async function pilotClientCarriesFiles() {
  const UUID = '33333333-3333-4333-8333-333333333333';
  const bodies = [];
  const session = { user: { id: 'user_synthetic' }, getToken: async () => 'synthetic-token' };
  const client = createSupportOperationsClient({
    accountId: 'user_synthetic', enabled: true, url: 'https://synthetic.invalid', anonKey: 'synthetic',
    getSession: () => session, uuid: () => UUID,
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return Response.json({ state: 'queued', ticket_id: UUID }); },
  });
  const attachments = [{ data: 'data:image/png;base64,AAAA' }];
  await client.create({ subject: 'Synthetic', body: 'Synthetic body text', category: 'bug', priority: 'normal', attachments });
  return Array.isArray(bodies[0]?.attachments) && bodies[0].attachments.length === 1;
}

test('the support-operations pilot is not switched on while it drops attachments', async () => {
  const settings = await flagSettings();
  // Anchor: the deploy workflow names the flag. If it moves, this test must
  // be pointed at its new home rather than pass by finding nothing.
  assert.ok(settings.length > 0, `${FLAG} is not set in any deploy or env file; update this guard to read wherever it moved`);
  const on = settings.filter(([, value]) => value.toLowerCase() === 'true');
  if (!on.length) return;
  const [renders, carries] = await Promise.all([pilotRendersAttachControl(), pilotClientCarriesFiles()]);
  assert.ok(renders && carries,
    `${FLAG} is true in ${on.map(([f]) => f).join(', ')}, but the pilot ${renders ? '' : 'hides the attach control'}${!renders && !carries ? ' and ' : ''}${carries ? '' : 'sends no attachments'}. Port ticket attachments to support-operations before enabling it (ticket 5f9b744d).`);
});

test('the guard can see an attach control when one is rendered', async () => {
  // Positive control, so the check above cannot pass by never finding one:
  // the live (flag off) form renders the same attach control.
  assert.equal(await rendersAttachControl(false), true);
});
