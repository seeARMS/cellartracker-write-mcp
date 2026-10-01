import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{callTool} from '../worker/index.js';
import {CloudCookieTransport,buildRequest} from '../worker/transport.js';
import {CellarTracker} from '../worker/cellar.js';
import {SqliteD1,upstream,bottle,inventoryHtml} from './helpers.js';
const request=(user:string|null='owner')=>new Request('https://synthetic.invalid/mcp',{method:'POST',headers:user?{'oai-authenticated-user-id':user}:{}});
const configured=(db?:SqliteD1)=>({DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_WRITES_ENABLED:'false',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600_000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture=synthetic-only',userAgent:'Synthetic Test Agent'})});
async function rpc(method:string,params:any={},env:any={},user:string|null='owner'){
 const req=new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',...(user?{'oai-authenticated-user-id':user}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 return worker.fetch(req,env);
}
test('stateless initialization and discovery expose only eight bounded tools',async()=>{
 const init=await(await rpc('initialize',{protocolVersion:'2025-06-18'})).json()as any;assert.equal(init.result.protocolVersion,'2025-06-18');
 const list=await(await rpc('tools/list')).json()as any;assert.equal(list.result.tools.length,8);assert.ok(!JSON.stringify(list).includes('CELLARTRACKER_SESSION_JSON'));
 assert.equal((await worker.fetch(new Request('https://synthetic.invalid/mcp'),{})).status,405);
});
test('private-data tool calls reject missing identity and another user with HTTP 401/403',async()=>{
 assert.equal((await rpc('tools/call',{name:'list_bins'},configured(),null)).status,401);
 assert.equal((await rpc('tools/call',{name:'list_bins'},configured(),'different-owner')).status,403);
});
test('default activation gate makes no upstream request',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('must not reach the network');};
 await assert.rejects(()=>callTool(request(),{CELLARTRACKER_OWNER_USER_ID:'owner'},'list_bins',{},fetcher as any),/disabled pending/);assert.equal(calls,0);
 const status=await callTool(request(),{},'connection_status',{},fetcher as any)as any;assert.equal(status.reads_enabled,false);assert.equal(status.writes_enabled,false);assert.equal(status.caller_site_user_id,'owner');assert.equal(calls,0);
});
test('fresh verification and cached discovery authenticate synthetically and keep session data private',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const api=upstream();const env=configured(db);const profile=await callTool(request(),env,'verify_connection',{},api.fetcher)as any;assert.equal(profile.authenticated,true);assert.equal(profile.total_bottles,2);
 const bins=await callTool(request(),env,'list_bins',{},api.fetcher)as any;assert.equal(bins.total,2);
 const rows=await callTool(request(),env,'list_bottles',{wine:'2020 Synthetic',wine_id:'100',limit:1},api.fetcher)as any;assert.equal(rows.total,2);assert.equal(rows.bottles.length,1);assert.equal(api.posts,0);
 assert.ok(!JSON.stringify([profile,bins,rows]).includes('synthetic-only'));assert.ok(api.urls.every(u=>u.startsWith('https://www.cellartracker.com/')));
});
test('complete tool flow persists a dry run before a single synthetic POST and verifies history',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const env=configured(db);const api=upstream();
 const p=await callTool(request(),env,'plan_consumption',{request_id:crypto.randomUUID(),bottle_ids:['1'],date:'2026-09-30',note:'Synthetic dinner'},api.fetcher)as any;assert.equal(p.dry_run,true);assert.equal(api.posts,0);
 await assert.rejects(()=>callTool(request(),env,'execute_consumption',{operation_id:p.operation_id,confirmed:true},api.fetcher),/consumption is disabled/);assert.equal(api.posts,0);
 const active={...env,CELLARTRACKER_WRITES_ENABLED:'true'};
 await assert.rejects(()=>callTool(request(),active,'execute_consumption',{operation_id:p.operation_id,confirmed:false},api.fetcher),/confirmed=true/);
 const result=await callTool(request(),active,'execute_consumption',{operation_id:p.operation_id,confirmed:true},api.fetcher)as any;assert.equal(result.status,'complete');assert.equal(api.posts,1);
 await callTool(request(),active,'execute_consumption',{operation_id:p.operation_id,confirmed:true},api.fetcher);assert.equal(api.posts,1);
 assert.ok(!JSON.stringify(result).includes('fixture='));
});
test('expired or malformed cloud sessions and wrong account binding prevent data access',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());
 const api=upstream();await assert.rejects(()=>callTool(request(),{...configured(),CELLARTRACKER_SESSION_EXPIRES_AT:'2000-01-01'},'list_bins',{},api.fetcher),/expiry has passed/);assert.equal(api.urls.length,0);
 await assert.rejects(()=>callTool(request(),{...configured(),CELLARTRACKER_SESSION_JSON:'invalid'},'list_bins',{},api.fetcher),/SESSION_INVALID_JSON/);
 await assert.rejects(()=>callTool(request(),{...configured(db),CELLARTRACKER_EXPECTED_ACCOUNT_ID:'999'},'verify_connection',{},api.fetcher),/account differs/);
});
test('invalid inputs, unknown arguments, and oversized bodies are rejected',async()=>{
 const api=upstream();await assert.rejects(()=>callTool(request(),configured(),'list_bottles',{url:'https://attacker.invalid'},api.fetcher),/Unknown tool argument/);assert.equal(api.urls.length,0);
 await assert.rejects(()=>callTool(request(),configured(),'plan_consumption',{request_id:crypto.randomUUID(),quantity:26,wine_id:'100',date:'2026-09-30'},api.fetcher),/Invalid quantity/);
 const oversized=new Request('https://synthetic.invalid/mcp',{method:'POST',body:'x'.repeat(65537)});assert.equal((await worker.fetch(oversized,{})).status,413);
});
test('unimplemented actions cannot expand the fixed upstream capability set',()=>{
 assert.throws(()=>buildRequest({kind:'relocate'}as any),/does not support/);
 assert.throws(()=>buildRequest({kind:'consume',ids:['1'],details:{date:'2026-09-30',type:2,note:''},currency:'USD'}),/drank consumption only/);
});
test('direct transport never follows redirects and never emits raw credential-bearing errors',async()=>{
 let opts:any;const transport=await new CloudCookieTransport(configured(),(async(_url:any,options:any)=>{opts=options;throw Error('raw fixture=synthetic-only');})as any).init();
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>{assert.equal(opts.redirect,'manual');assert.ok(!String(e).includes('fixture='));return true;});
});
test('inventory paging must remain complete and consistent',async()=>{
 const good=new CellarTracker({request:async r=>({status:200,url:'https://www.cellartracker.com/list.asp',text:inventoryHtml([bottle(String((r as any).page))],(r as any).page,2,2)})});assert.equal((await good.inventory()).bottles.length,2);
 const bad=new CellarTracker({request:async r=>({status:200,url:'https://www.cellartracker.com/list.asp',text:inventoryHtml([bottle('1')],(r as any).page,2,2)})});await assert.rejects(()=>bad.inventory(),/duplicate bottle IDs/);
});
