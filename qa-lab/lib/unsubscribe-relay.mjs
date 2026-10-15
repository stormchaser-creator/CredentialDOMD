// Run the actual production Worker for this local-only route, with its fetch
// confined to the owned local email-unsubscribe edge function.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {REPO_ROOT} from './paths.mjs';
import path from 'node:path';
export function createLocalUnsubscribeRelay({apiOrigin,fetchImpl=fetch,source=readFileSync(path.join(REPO_ROOT,'cloudflare/credentialdomd-api/worker.js'),'utf8')}={}){
 const local=new URL(apiOrigin);if(!['127.0.0.1','localhost','::1','[::1]'].includes(local.hostname)||!['http:','https:'].includes(local.protocol))throw Error('Unsubscribe relay requires a local API origin');
 const prodBase=source.match(/^const SUPA\s*=\s*"([^"]+)"/m)?.[1];if(!prodBase)throw Error('Worker API origin moved; review the relay');const prod=new URL(prodBase).origin;
 const context=vm.createContext({module:{exports:{}},Request,Response,Headers,URL,Map,Date,crypto,console:{log(){},warn(){},error(){}},fetch:async(input,init)=>{const u=new URL(input);if(u.origin!==prod||u.pathname!=='/functions/v1/email-unsubscribe')throw Error('Unsubscribe relay refused a nonlocal or unexpected target');return fetchImpl(`${local.origin}${u.pathname}${u.search}`,init);}});
 vm.runInContext(source.replace('export default','module.exports ='),context,{filename:'owned-local-unsubscribe-worker.mjs'});
 return request=>context.module.exports.fetch(request);
}
