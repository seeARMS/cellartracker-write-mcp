import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {InventorySnapshots,snapshotPolicy} from '../worker/snapshots.js';
import {retryFailure} from '../worker/backoff.js';
import {RetryError} from '../worker/types.js';
import {callTool,SqliteD1,bottle,inventoryHtml,upstream} from './helpers.js';
const request=()=>new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'owner'}});
const configured=(db:SqliteD1)=>({DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_WRITES_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture=synthetic-only',userAgent:'Synthetic Agent'})});
test('all pagination calls reuse one complete inventory walk, with or without the snapshot ID',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const env=configured(db);let calls=0;
 const bottles=Array.from({length:505},(_,i)=>bottle(String(i+1)));
 const fetcher=(async(input:string)=>{calls++;const page=Number(new URL(input).searchParams.get('Page'));return new Response(inventoryHtml(bottles.slice((page-1)*100,page*100),page,6,505));})as typeof fetch;
 const first=await callTool(request(),env,'list_bottles',{limit:100},fetcher)as any;assert.equal(calls,6);assert.equal(first.total,505);
 const pages=await Promise.all([100,200,300,400,500].map(offset=>callTool(request(),env,'list_bottles',{offset,limit:100,...(offset===100?{snapshot_id:first.snapshot.snapshot_id}:{})},fetcher)))as any[];
 assert.equal(calls,6);assert.equal(new Set([first,...pages].flatMap(p=>p.bottles.map((b:any)=>b.id))).size,505);
 assert.ok(pages.every(p=>p.snapshot.cached&&p.snapshot.snapshot_id===first.snapshot.snapshot_id));
 const bins=await callTool(request(),env,'list_bins',{},fetcher)as any;assert.equal(bins.total,505);assert.equal(calls,6);
 // Explicit verification bypasses discovery cache.
 await callTool(request(),env,'verify_connection',{},fetcher);assert.equal(calls,12);
});
test('independent Worker instances coalesce concurrent cold refreshes through a D1 lease',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());let loads=0;
 const load=async()=>{loads++;await new Promise(resolve=>setTimeout(resolve,10));return {accountId:'123',bottles:[bottle('1')]};};
 const snapshots=await Promise.all(Array.from({length:4},()=>new InventorySnapshots(db,'owner','123',Date.now()+3600000).get(load)));
 assert.equal(loads,1);assert.equal(new Set(snapshots.map(s=>s.metadata.snapshot_id)).size,1);assert.equal(snapshots.filter(s=>!s.metadata.cached).length,1);
});
test('expired pinned snapshots never silently load a different generation',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());let now=Date.now(),loads=0;const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
 const cache=new InventorySnapshots(db,'owner','123',now+3600000,clock);const load=async()=>{loads++;return {accountId:'123',bottles:[bottle(String(loads))]};};
 const first=await cache.get(load);now+=snapshotPolicy.ttlMs+1;
 await assert.rejects(()=>cache.get(load,first.metadata.snapshot_id),error=>error instanceof RetryError&&error.metadata.error_code==='CELLARTRACKER_SNAPSHOT_EXPIRED');assert.equal(loads,1);
 const next=await cache.get(load);assert.notEqual(next.metadata.snapshot_id,first.metadata.snapshot_id);assert.equal(loads,2);
 await cache.invalidate();await assert.rejects(()=>cache.get(load,next.metadata.snapshot_id));assert.equal(loads,2);
});
test('rate-limit exhaustion establishes a shared cooldown rather than a new refresh per caller',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());let now=Date.now(),loads=0;const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
 const load=async()=>{loads++;throw retryFailure('CELLARTRACKER_RATE_LIMITED',429,3,now+60000,now);};
 await assert.rejects(()=>new InventorySnapshots(db,'owner','123',now+3600000,clock).get(load),RetryError);
 for(let i=0;i<4;i++)await assert.rejects(()=>new InventorySnapshots(db,'owner','123',now+3600000,clock).get(load),error=>error instanceof RetryError&&error.metadata.attempts===0);
 assert.equal(loads,1);now+=60001;await assert.rejects(()=>new InventorySnapshots(db,'owner','123',now+3600000,clock).get(load));assert.equal(loads,2);
});
test('invalidated in-flight refreshes cannot repopulate the cache with stale inventory',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),paused=new Promise<void>(resolve=>release=resolve);
 const old=new InventorySnapshots(db,'owner','123',Date.now()+3600000);
 const pending=old.get(async()=>{entered();await paused;return {accountId:'123',bottles:[bottle('1')]};});await started;
 await old.invalidate();const fresh=new InventorySnapshots(db,'owner','123',Date.now()+3600000);const next=await fresh.get(async()=>({accountId:'123',bottles:[bottle('2')]}));release();
 await assert.rejects(()=>pending,/changed during refresh/);assert.equal((await fresh.get(async()=>{throw Error('must stay cached');},next.metadata.snapshot_id)).inventory.bottles[0].id,'2');
});
test('snapshot access remains owner/account/expiry bound and unavailable during an unresolved submission',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const now=Date.now();let loads=0;
 const load=async()=>{loads++;return {accountId:'123',bottles:[bottle('1')]};};
 const original=new InventorySnapshots(db,'owner','123',now+3600000);await original.get(load);
 await assert.rejects(()=>new InventorySnapshots(db,'owner','999',now+3600000).get(load),/account differs/);
 await assert.rejects(()=>new InventorySnapshots(db,'owner','123',now-1).get(load),/cutoff passed/);
 assert.equal(loads,2);
 const api=upstream(),env=configured(db);const plan=await callTool(request(),env,'plan_consumption',{request_id:crypto.randomUUID(),bottle_ids:['1'],date:'2026-09-30'},api.fetcher)as any;
 await db.prepare('INSERT INTO account_locks(owner,operation_id) VALUES(?,?)').bind('owner',plan.operation_id).run();
 await assert.rejects(()=>new InventorySnapshots(db,'owner','123',now+3600000).get(load),/CONSUMPTION_IN_PROGRESS/);assert.equal(loads,2);
});
test('consumption bypasses discovery cache and invalidates all snapshot generations',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const api=upstream(),env=configured(db);
 const initial=await callTool(request(),env,'list_bottles',{},api.fetcher)as any;const calls=api.urls.length;
 const plan=await callTool(request(),env,'plan_consumption',{request_id:crypto.randomUUID(),bottle_ids:['1'],date:'2026-09-30'},api.fetcher)as any;assert.ok(api.urls.length>calls);
 const done=await callTool(request(),env,'execute_consumption',{operation_id:plan.operation_id,confirmed:true},api.fetcher)as any;assert.equal(done.status,'complete');assert.equal(api.posts,1);
 await assert.rejects(()=>callTool(request(),env,'list_bottles',{snapshot_id:initial.snapshot.snapshot_id},api.fetcher),/SNAPSHOT_EXPIRED/);
 const fresh=await callTool(request(),env,'list_bottles',{},api.fetcher)as any;assert.equal(fresh.total,1);assert.notEqual(fresh.snapshot.snapshot_id,initial.snapshot.snapshot_id);
});
test('retry diagnostics are returned as structured MCP metadata without upstream data',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const env=configured(db);const now=Date.now();
 const cache=new InventorySnapshots(db,'owner','123',Date.parse(env.CELLARTRACKER_SESSION_EXPIRES_AT));
 await assert.rejects(()=>cache.get(async()=>{throw retryFailure('CELLARTRACKER_RATE_LIMITED',429,3,now+60000,now);}));
 const req=new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_bottles',arguments:{}}})});
 const reply=await(await worker.fetch(req,env)).json()as any;
 assert.equal(reply.result.isError,true);assert.equal(reply.result.structuredContent.error_code,'CELLARTRACKER_RATE_LIMITED');assert.equal(reply.result.structuredContent.automatic_retry_allowed,true);
 assert.ok(!JSON.stringify(reply).includes('synthetic-only'));
});
