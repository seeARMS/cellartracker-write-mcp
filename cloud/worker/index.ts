import {sessionDiagnostics} from './diagnostics.js';
import {ReconciliationReads} from './reconciliation.js';
import {CellarTracker} from './cellar.js';
import {CloudCookieTransport} from './transport.js';
import {CloudStore} from './store.js';
import {summarize,CloudConsumption} from './consumption.js';
import {SafeError,AccessError,RetryError,type Environment} from './types.js';
import {InventorySnapshots} from './snapshots.js';
import {ProviderCooldown} from './provider-gate.js';
import {realClock,type RetryClock} from './backoff.js';
import {tools,instructions} from './tools.js';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
function validate(s:any,value:any){
 if(s.type==='object'){
  if(!value||Array.isArray(value)||typeof value!=='object')throw new SafeError('Tool arguments must be an object.');
  if(Object.keys(value).some(k=>!Object.hasOwn(s.properties,k)))throw new SafeError('Unknown tool argument.');
  if((s.required??[]).some((k:string)=>!Object.hasOwn(value,k)))throw new SafeError('A required tool argument is missing.');
  for(const [k,v]of Object.entries(value))validate(s.properties[k],v);
 }else if(s.type==='string'){
  if(typeof value!=='string'||value.length>(s.maxLength??2048)||(s.pattern&&!new RegExp(s.pattern).test(value)))throw new SafeError('Invalid string tool argument.');
 }else if(s.type==='integer'){
  if(!Number.isInteger(value)||value<s.minimum||value>s.maximum)throw new SafeError('Invalid quantity or pagination argument.');
 }else if(s.type==='array'){
  if(!Array.isArray(value)||value.length<s.minItems||value.length>s.maxItems||(s.uniqueItems&&new Set(value).size!==value.length))throw new SafeError('Invalid bottle selection.');
  value.forEach(v=>validate(s.items,v));
 }else if(s.type==='boolean'&&(typeof value!=='boolean'||('const'in s&&value!==s.const)))throw new SafeError('Consumption requires confirmed=true for this specific user-authorized action.');
}
function identity(request:Request,env:Environment,requireOwner=true){
 const user=request.headers.get('oai-authenticated-user-id');
 if(!user)throw new AccessError('Sign in to the owner-private Site before using this tool.',401);
 if(requireOwner&&(!env.CELLARTRACKER_OWNER_USER_ID||user!==env.CELLARTRACKER_OWNER_USER_ID))throw new AccessError('Cloud owner binding is missing or does not match this signed-in user.',403);
 return user;
}
function setupStatus(env:Environment){return {reads_enabled:env.CELLARTRACKER_READS_ENABLED==='true',writes_enabled:env.CELLARTRACKER_WRITES_ENABLED==='true',owner_bound:!!env.CELLARTRACKER_OWNER_USER_ID,account_bound:/^\d+$/.test(env.CELLARTRACKER_EXPECTED_ACCOUNT_ID??''),session_configured:!!env.CELLARTRACKER_SESSION_JSON,approved_session_expiry_valid:Number.isFinite(Date.parse(env.CELLARTRACKER_SESSION_EXPIRES_AT??''))&&Date.parse(env.CELLARTRACKER_SESSION_EXPIRES_AT!)>Date.now(),storage_ready:!!env.DB,transport:'direct-https',adapter_version:'0.2.0',retry_policy:'conservative-manual-v4',authenticated_inventory_verified:false};}
export async function callTool(request:Request,env:Environment,name:string,args:Record<string,any>,fetcher:typeof fetch=fetch,clock:RetryClock=realClock){
 const tool=tools.find(t=>t.name===name);if(!tool)throw new SafeError('Unknown CellarTracker tool.');validate(tool.inputSchema,args);
 if(name==='connection_status'){
  const owner=identity(request,env,!!env.CELLARTRACKER_OWNER_USER_ID);return {...setupStatus(env),...(env.CELLARTRACKER_OWNER_USER_ID?{request_headers:sessionDiagnostics(env.CELLARTRACKER_SESSION_JSON,env.CELLARTRACKER_COOKIE)}:{}),...(!env.CELLARTRACKER_OWNER_USER_ID?{caller_site_user_id:owner}:env.DB?{provider:await new ProviderCooldown(env.DB,owner,env.CELLARTRACKER_EXPECTED_ACCOUNT_ID??'unbound',clock).status()}:{})};
 }
 const owner=identity(request,env);
 if(env.CELLARTRACKER_READS_ENABLED!=='true')throw new SafeError('Cloud CellarTracker access is disabled pending specific activation approval and secure session setup.');
 if(name==='execute_consumption'&&env.CELLARTRACKER_WRITES_ENABLED!=='true')throw new SafeError('Cloud consumption is disabled. It requires separate activation approval and a specific bottle-consumption instruction.');
 const account=env.CELLARTRACKER_EXPECTED_ACCOUNT_ID;
 if(name!=='verify_connection'&&!/^\d+$/.test(account??''))throw new SafeError('Bind the approved CellarTracker account before reading cellar data or planning consumption.');
 if(name==='shorten_app_rate_limit_wait'){
  if(!env.DB)throw new SafeError('Cloud provider storage is unavailable.');
  return new ProviderCooldown(env.DB,owner,account!,clock).shortenFallback(args.last_rate_limit_at,args.retry_at,args.reviewed_no_retry_after);
 }
 if(['queue_consumption_request','get_consumption_request'].includes(name)){
  if(!env.DB)throw new SafeError('Cloud operation storage is unavailable.');
  const store=new CloudStore(env.DB,owner,clock);
  if(name==='queue_consumption_request'){
   const existing=await store.byRequest(args.request_id);
   if(existing){
    if(existing.details.date!==args.date||existing.details.note!==(args.note??'')||existing.bottles.length!==args.quantity)throw new SafeError('This request ID already identifies different consumption details.');
    return {operation:summarize(existing),background_worker_scheduled:false};
   }
   return store.pending.saveIntent(args as any);
  }
  const op=await store.byRequest(args.request_id);
  if(op)return {operation:summarize(op),background_worker_scheduled:false};
  return store.pending.get(args.request_id);
 }
 const gate=env.DB?new ProviderCooldown(env.DB,owner,/^\d+$/.test(account??'')?account!:'unbound',clock):undefined;
 if(name==='resume_provider_reads'){
  if(!env.DB)throw new SafeError('Cloud provider storage is unavailable.');
  // Explicit owner acknowledgement does not clear any rate-limit cooldown or change auth.
  const r=await env.DB.prepare('UPDATE provider_state SET blocked_code=NULL WHERE owner=? AND blocked_code=?').bind(owner,args.reviewed_error_code).run();
  return {review_acknowledged:r.meta.changes===1,cooldown_preserved:true,authenticated:false};
 }
 const transport=await new CloudCookieTransport(env,fetcher,clock,gate).init();
 const cellar=new CellarTracker(transport);
 if(!gate)throw new SafeError('Cloud provider cooldown storage is unavailable. No upstream request is permitted.');
 const snapshots=env.DB&&account?new InventorySnapshots(env.DB,owner,account,Date.parse(env.CELLARTRACKER_SESSION_EXPIRES_AT!),clock,gate):undefined;
 if(['verify_connection','list_bins','list_bottles'].includes(name)){
  if(name==='verify_connection')await gate.assertAvailable();
  if(name!=='verify_connection'&&!snapshots)throw new SafeError('Inventory snapshot storage is unavailable. No upstream discovery refresh was started.');
  const snapshot=name==='verify_connection'?undefined:await snapshots!.get(()=>cellar.inventory(),args.snapshot_id);
  const inventory=snapshot?.inventory??await cellar.inventory();
  if(account&&inventory.accountId!==account)throw new SafeError('CellarTracker account differs from the approved account binding.');
  if(name==='verify_connection')return {authenticated:true,account_id:inventory.accountId,total_bottles:inventory.bottles.length,transport:'direct-https'};
  if(name==='list_bins'){
   const groups=new Map<string,{location:string;bin:string;count:number}>();for(const b of inventory.bottles){const key=JSON.stringify([b.location,b.bin]);const group=groups.get(key)??{location:b.location,bin:b.bin,count:0};group.count++;groups.set(key,group);}
   return {total:inventory.bottles.length,bins:[...groups.values()],snapshot:snapshot!.metadata};
  }
  const bottles=inventory.bottles.filter(b=>(args.wine===undefined||b.wine.toLowerCase().includes(args.wine.toLowerCase()))&&(args.wine_id===undefined||b.wineId===BigInt(args.wine_id).toString())&&['location','bin','size'].every(k=>args[k]===undefined||(b as any)[k]===args[k]));
  const offset=args.offset??0,limit=args.limit??50;return {total:bottles.length,offset,limit,bottles:bottles.slice(offset,offset+limit),snapshot:snapshot!.metadata};
 }
 if(!env.DB)throw new SafeError('Cloud operation storage is unavailable. No consumption can be submitted.');
 if(name==='get_consumption_status')return new ReconciliationReads(env.DB,owner,account!,Date.parse(env.CELLARTRACKER_SESSION_EXPIRES_AT!),transport,gate,clock).status(args.operation_id,args.restart_reconciliation??false);
 const consumption=new CloudConsumption(cellar,new CloudStore(env.DB,owner,clock),account!,clock);
 if(name==='plan_consumption')return consumption.plan(args as any);
 if(name==='execute_consumption'){
  await snapshots!.invalidate();
  try{return await consumption.execute(args.operation_id);}finally{await snapshots!.invalidate();}
 }
 if(name==='cancel_consumption_plan')return consumption.cancel(args.operation_id);
 throw new SafeError('Unknown CellarTracker operation.');
}
const page=(env:Environment)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CellarTracker cloud MCP</title><meta name="description" content="Private inventory matching and verified bottle consumption in ChatGPT."><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='12' fill='%238c2336'/%3E%3Ctext x='24' y='34' text-anchor='middle' font-family='serif' font-size='34' fill='white'%3EC%3C/text%3E%3C/svg%3E"><style>:root{font:18px/1.55 system-ui,sans-serif;color:#eceaf0;background:#12121a;color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(38rem,calc(100% - 3rem));padding:3rem 0}small{font-size:.85rem;color:#b5adbc}h1{font:normal clamp(2rem,8vw,3.6rem)/1.1 Georgia,serif;margin:.7rem 0 2rem}p{max-width:34rem}article{border:1px solid #453440;background:#201722;border-radius:12px;padding:1.5rem;margin:1.5rem 0}article strong{color:#ffb4c2}a{color:#ffb4c2;text-underline-offset:4px}:focus-visible{outline:2px solid #ffb4c2;outline-offset:5px}</style></head><body><main><small>PRIVATE CONNECTION</small><h1>CellarTracker cloud MCP</h1><article><strong>${env.CELLARTRACKER_READS_ENABLED==='true'?'Ready for connection verification':'Connection not activated'}</strong><p>${env.CELLARTRACKER_READS_ENABLED==='true'?'Ask the plugin to verify your connection before using your cellar.':'Your cellar is untouched. Finish the approved secure setup before using this connection.'}</p></article><p>In ChatGPT, identify the wine and date you drank it. The plugin matches your bottles, prepares the exact change, and verifies the result.</p><p>${env.CELLARTRACKER_WRITES_ENABLED==='true'?'Each consumption starts with a fresh dry run.':'Consumption is currently disabled.'}</p><small>No credentials are collected on this page.</small></main></body></html>`;
export default {async fetch(request:Request,env:Environment){
 const url=new URL(request.url);
 if(url.pathname==='/'&&request.method==='GET')return new Response(page(env),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors https://chatgpt.com https://*.chatgpt.com",'x-content-type-options':'nosniff'}});
 if(url.pathname!=='/mcp')return new Response('Not found',{status:404});
 if(request.method!=='POST')return new Response('Use POST for this stateless MCP endpoint',{status:405,headers:{Allow:'POST'}});
 let rpc:any;
 try{
  const reader=request.body?.getReader();let raw='',bytes=0;const decoder=new TextDecoder();
  if(reader)while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536){await reader.cancel();return json({error:'Request too large'},413);}raw+=decoder.decode(part.value,{stream:true});}
  raw+=decoder.decode();rpc=JSON.parse(raw);
 }catch{return json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}},400);}
 if(!rpc||Array.isArray(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||(rpc.id!==undefined&&rpc.id!==null&&typeof rpc.id!=='string'&&typeof rpc.id!=='number'))return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}},400);
 if(rpc.id===undefined){if(rpc.method==='notifications/initialized')return new Response(null,{status:202});return new Response(null,{status:202});}
 const reply=(result:unknown)=>json({jsonrpc:'2.0',id:rpc.id,result});
 if(rpc.method==='initialize'){
  const offered=rpc.params?.protocolVersion;const accepted=['2024-11-05','2025-03-26','2025-06-18','2025-11-25','2026-07-28'];
  return reply({protocolVersion:accepted.includes(offered)?offered:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'cellartracker-cloud',version:'0.2.0'},instructions});
 }
 if(rpc.method==='ping')return reply({});
 if(rpc.method==='tools/list')return reply({tools});
 if(rpc.method!=='tools/call')return json({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Method not found'}});
 const name=rpc.params?.name;
 try{const result=await callTool(request,env,name,rpc.params?.arguments??{});return reply({content:[{type:'text',text:JSON.stringify(result)}]});}
 catch(e){if(e instanceof AccessError)return json({jsonrpc:'2.0',id:rpc.id,error:{code:-32001,message:e.message}},e.status);return reply({isError:true,...(e instanceof RetryError?{structuredContent:e.metadata}:{}),content:[{type:'text',text:e instanceof RetryError?JSON.stringify({message:e.message,...e.metadata}):e instanceof SafeError?e.message:'Operation could not complete. No automatic retries are allowed; inspect the saved consumption status if submission may have started.'}]});}
}};
