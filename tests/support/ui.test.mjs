import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root=fileURLToPath(new URL('../../',import.meta.url));
const theme={text:'#111',textMuted:'#555',textDim:'#777',accent:'#096',card:'#fff',input:'#eee',border:'#ddd'};
async function compiled(enabled,folder) {
  const output=await build({entryPoints:[`${root}src/components/pages/SupportModal.jsx`],bundle:true,format:'esm',platform:'node',jsx:'automatic',write:false,external:['react','react/jsx-runtime'],define:{'import.meta.env.VITE_SUPPORT_OPERATIONS_ENABLED':JSON.stringify(enabled?'true':'false')},plugins:[{
    name:'synthetic-ui-dependencies',setup(build){
      build.onResolve({filter:/context\/AppContext|lib\/supabase|\.\.\/shared$|shared\/TicketAttachments$/},args=>({path:args.path,namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path.includes('AppContext')?`export const useApp=()=>({theme:${JSON.stringify(theme)},user:{id:'user_synthetic',email:'fixture@example.invalid'},isDesktop:true});`:args.path.includes('supabase')?'export const supabase=null;':args.path.endsWith('TicketAttachments')?'export default function TicketAttachments(){return null;}':`import React from 'react';export function ScreenshotAttach(){return React.createElement('button',{'data-fixture':'attachment'},'Add screenshot');}`}));
    },
  }]});
  const path=`${folder}/${enabled?'enabled':'legacy'}.mjs`;await writeFile(path,output.outputFiles[0].text);return import(pathToFileURL(path));
}
test('rendered support UI keeps legacy screenshots, has truthful copy and labels server automation',async t=>{
  const folder=await mkdtemp(`${root}tests/support/.render-`);t.after(()=>rm(folder,{recursive:true,force:true}));
  const legacy=await compiled(false,folder),enabled=await compiled(true,folder);
  const before=renderToStaticMarkup(React.createElement(legacy.default,{open:true,onClose(){}}));
  const pilot=renderToStaticMarkup(React.createElement(enabled.default,{open:true,onClose(){}}));
  assert.match(before,/Add screenshot/);assert.doesNotMatch(pilot,/Add screenshot/);
  assert.match(pilot,/Attachments are not available here yet/);
  for(const html of [before,pilot]) {
    assert.match(html,/Follow the conversation under Your tickets/);
    assert.doesNotMatch(html,/answers personally|Replies arrive by email|Eric Whitney/);
    assert.match(html,/Feature request/);assert.match(html,/Urgent/);assert.match(html,/Cancel/);
  }
  for(const [actor,label] of [['automated','CredentialDO Support · Automated'],['support','Support team'],['you','You'],['account','Reply on your ticket']]) {
    const html=renderToStaticMarkup(React.createElement(enabled.SupportMessage,{theme,message:{identity_source:'support-operations',actor_kind:actor,created_at:'2026-09-18T12:00:00Z',body:'<script>private fixture</script>'}}));
    assert.ok(html.includes(label));assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
  }
  const old=renderToStaticMarkup(React.createElement(legacy.SupportMessage,{theme,message:{is_admin_reply:true,author_email:'eric@example.invalid',created_at:'2026-09-18T12:00:00Z',body:'Legacy reply'}}));
  assert.doesNotMatch(old,/Eric|Automated|eric@example/);assert.match(old,/Reply/);
});
