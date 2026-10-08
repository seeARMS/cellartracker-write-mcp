import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudConsumption} from '../worker/consumption.js';
import {CloudStore} from '../worker/store.js';
import {callTool,SqliteD1,FakeCellar,upstream} from './helpers.js';

class CountedCellar extends FakeCellar {
 inventoryReads=0;historyReads=0;
 async inventory(){this.inventoryReads++;return super.inventory();}
 async consumed(ids:string[]){this.historyReads++;return super.consumed(ids);}
}
function setup(t:any){
 const db=new SqliteD1();t.after(()=>db.close());let now=Date.now();const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
 const cellar=new CountedCellar(),store=new CloudStore(db,'owner',clock),service=new CloudConsumption(cellar,store,'123',clock);
 return {db,clock,cellar,store,service,advance:(ms:number)=>{now+=ms;},input:{request_id:crypto.randomUUID(),bottle_ids:['1'],date:'2026-10-07',note:''}};
}
const history=()=>({id:'1',consumedId:'91',wineId:'100',date:'2026-10-07',type:1,note:''});
test('dry run reserves from fresh inventory without history and persists its disclosure across restart/dedup',async t=>{
 const f=setup(t),plan=await f.service.plan(f.input);assert.equal(f.cellar.inventoryReads,1);assert.equal(f.cellar.historyReads,0);assert.equal(f.cellar.writes,0);assert.equal(plan.plan_history_check,'deferred_to_fresh_execution_preflight');
 const repeat=await new CloudConsumption(f.cellar,new CloudStore(f.db,'owner',f.clock),'123',f.clock).plan(f.input);assert.equal(repeat.operation_id,plan.operation_id);assert.equal(repeat.plan_history_check,plan.plan_history_check);assert.equal(f.cellar.inventoryReads,1);assert.equal(f.cellar.historyReads,0);
});
for(const timing of ['prior','after-plan']as const)test('fresh execution history blocks '+timing+' consumption before submission',async t=>{
 const f=setup(t);if(timing==='prior')f.cellar.history.push(history());const plan=await f.service.plan(f.input);if(timing==='after-plan'){f.advance(1);f.cellar.history.push(history());}
 const result=await f.service.execute(plan.operation_id);assert.equal(result.status,'conflict');assert.equal(f.cellar.historyReads,1);assert.equal(f.cellar.writes,0);assert.equal((await f.store.get(plan.operation_id)).submittedAt,undefined);
});
test('fresh execution checks history account identity independently of inventory',async t=>{
 const f=setup(t),plan=await f.service.plan(f.input);f.cellar.consumed=async()=>({accountId:'999',records:[]});assert.equal((await f.service.execute(plan.operation_id)).status,'conflict');assert.equal(f.cellar.writes,0);
});
test('history failure in fresh preflight cannot authorize a POST',async t=>{
 const f=setup(t),plan=await f.service.plan(f.input);f.cellar.consumed=async()=>{throw Error('synthetic history unavailable');};assert.equal((await f.service.execute(plan.operation_id)).status,'conflict');assert.equal(f.cellar.writes,0);assert.equal((await f.store.get(plan.operation_id)).submittedAt,undefined);
});
test('successful execution still performs fresh preflight and post-write history reads',async t=>{
 const f=setup(t),plan=await f.service.plan(f.input),result=await f.service.execute(plan.operation_id);assert.equal(result.status,'complete');assert.equal(f.cellar.inventoryReads,3);assert.equal(f.cellar.historyReads,2);assert.equal(f.cellar.writes,1);assert.deepEqual(result.verification?.consumedIds,['1']);
});
test('actual one-page synthetic HTTP workflow uses eight requests, including one POST',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const api=upstream();const request=new Request('https://synthetic.invalid/mcp',{headers:{'oai-authenticated-user-id':'owner'}});
 const env={DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_WRITES_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture=synthetic-only',userAgent:'Synthetic Agent'})};
 const plan:any=await callTool(request,env,'plan_consumption',{request_id:crypto.randomUUID(),bottle_ids:['1'],date:'2026-10-07'},api.fetcher);assert.equal(api.urls.length,1);assert.equal(plan.plan_history_check,'deferred_to_fresh_execution_preflight');
 const result:any=await callTool(request,env,'execute_consumption',{operation_id:plan.operation_id,confirmed:true},api.fetcher);assert.equal(result.status,'complete');assert.equal(api.urls.length,8);assert.equal(api.posts,1);
 const urls=api.urls.map(url=>new URL(url));assert.equal(urls.filter(url=>url.searchParams.get('table')==='Inventory').length,3);assert.equal(urls.filter(url=>url.searchParams.get('table')==='Consumed').length,2);assert.equal(urls.filter(url=>url.pathname==='/editconsumed.asp').length,1);
});
test('deferred plan preserves expiration and concurrent execution deduplication',async t=>{
 const expired=setup(t),plan=await expired.service.plan(expired.input);expired.advance(900001);await assert.rejects(()=>expired.service.execute(plan.operation_id),/expired/);assert.equal(expired.cellar.writes,0);assert.equal(expired.cellar.historyReads,0);
 const f=setup(t),p=await f.service.plan(f.input);await Promise.allSettled([f.service.execute(p.operation_id),new CloudConsumption(f.cellar,f.store,'123',f.clock).execute(p.operation_id)]);assert.equal(f.cellar.writes,1);
});
test('uncertain submitted operation cannot replay after restart with deferred planning history',async t=>{
 const f=setup(t),plan=await f.service.plan(f.input);f.cellar.failReadAfterWrite=true;assert.equal((await f.service.execute(plan.operation_id)).status,'unknown');assert.equal((await new CloudConsumption(f.cellar,f.store,'123',f.clock).execute(plan.operation_id)).status,'unknown');assert.equal(f.cellar.writes,1);
});
