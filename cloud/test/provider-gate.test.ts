import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudCookieTransport} from '../worker/transport.js';
import {ProviderCooldown} from '../worker/provider-gate.js';
import {InventorySnapshots} from '../worker/snapshots.js';
import {RetryError,type BrowserRequest} from '../worker/types.js';
import {callTool} from '../worker/index.js';
import {SqliteD1,upstream} from './helpers.js';
const marker='SYNTHETIC_PRIVATE_MARKER';
const initial=Date.parse('2026-10-01T00:00:00Z');
const request=()=>new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'owner'}});
const configured=(db:SqliteD1)=>({DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_WRITES_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture='+marker,userAgent:'Synthetic Agent'})});
function fixture(db:SqliteD1){let now=initial;const sleeps:number[]=[];const clock={now:()=>now,random:()=>.5,sleep:async(ms:number)=>{sleeps.push(ms);now+=ms;}};const env={...configured(db),CELLARTRACKER_SESSION_EXPIRES_AT:new Date(initial+3600000).toISOString()};return {clock,env,sleeps,advance:(ms:number)=>{now+=ms;},gate:()=>new ProviderCooldown(db,'owner','123',clock)};}
const consume:BrowserRequest={kind:'consume',ids:['1'],currency:'USD',details:{date:'2026-09-30',type:1,note:''}};
test('every read request kind and consumption POST consult the same persisted provider cooldown',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);let calls=0;
 await f.gate().record(initial+120000,'provider_retry_after');
 const kinds:BrowserRequest[]=[{kind:'inventory',page:1},{kind:'consumed',page:1},{kind:'consumptionDetails',wineId:'100',consumedId:'901'},{kind:'consumptionForm'},consume];
 for(const kind of kinds){const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response('unexpected');})as typeof fetch,f.clock,f.gate()).init();
  await assert.rejects(()=>transport.request(kind),e=>e instanceof RetryError&&e.metadata.attempts===0&&e.metadata.cooldown_source==='provider_retry_after'&&e.metadata.automatic_retry_allowed===false);
 }
 assert.equal(calls,0);assert.deepEqual(f.sleeps,[]);
 f.advance(120001);const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response('ok');})as typeof fetch,f.clock,f.gate()).init();assert.equal((await transport.request({kind:'inventory',page:1})).text,'ok');assert.equal(calls,1);
});
test('verification 429 persists a provider cooldown used by cached discovery, fresh planning and reconciliation',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const env=configured(db),api=upstream();
 const cached=await callTool(request(),env,'list_bottles',{},api.fetcher)as any;
 const plan=await callTool(request(),env,'plan_consumption',{request_id:crypto.randomUUID(),bottle_ids:['1'],date:'2026-09-30'},api.fetcher)as any;
 let calls=0;const limited=(async()=>{calls++;return new Response(marker,{status:429,headers:{'retry-after':'120','set-cookie':'private='+marker}});})as typeof fetch;
 await assert.rejects(()=>callTool(request(),env,'verify_connection',{},limited),e=>e instanceof RetryError&&e.metadata.attempts===1&&e.metadata.cooldown_source==='provider_retry_after');assert.equal(calls,1);
 const args:Array<[string,Record<string,any>]>=[['verify_connection',{}],['list_bins',{}],['list_bottles',{snapshot_id:cached.snapshot.snapshot_id}],['plan_consumption',{request_id:crypto.randomUUID(),bottle_ids:['2'],date:'2026-09-30'}],['get_consumption_status',{operation_id:plan.operation_id}]];
 for(const [name,toolArgs]of args)await assert.rejects(()=>callTool(request(),env,name,toolArgs,limited),e=>e instanceof RetryError&&e.metadata.attempts===0);
 assert.equal(calls,1);
 const outcome=await callTool(request(),env,'execute_consumption',{operation_id:plan.operation_id,confirmed:true},limited)as any;
 assert.equal(outcome.status,'conflict');assert.equal(outcome.dry_run,true);assert.equal(outcome.verification.retry.cooldown_source,'provider_retry_after');assert.equal(outcome.verification.retry.submission_retry_allowed,false);assert.equal(calls,1);
 // Execution invalidates the snapshot but must not clear the provider cooldown.
 await assert.rejects(()=>new ProviderCooldown(db,'owner','123').assertAvailable(),RetryError);
 assert.ok(!JSON.stringify(outcome).includes(marker));assert.equal(api.posts,0);
});
test('429 from every endpoint persists a gate, including a single rejected POST',async t=>{
 const kinds:BrowserRequest[]=[{kind:'inventory',page:1},{kind:'consumed',page:1},{kind:'consumptionDetails',wineId:'100',consumedId:'901'},{kind:'consumptionForm'},consume];
 for(const kind of kinds){const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);let calls=0;
  const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response(marker,{status:429,headers:{'retry-after':'120'}});})as typeof fetch,f.clock,f.gate()).init();
  await assert.rejects(()=>transport.request(kind));assert.equal(calls,1);assert.deepEqual(f.sleeps,[]);
  await assert.rejects(()=>f.gate().assertAvailable(),e=>e instanceof RetryError&&e.metadata.cooldown_source==='provider_retry_after');
 }
});
test('fallback versus provider source describes the effective cooldown without storing raw headers',async t=>{
 for(const [header,source,attempts]of [[undefined,'fallback',3],['invalid '+marker,'fallback',3],['2','fallback',3],['120','provider_retry_after',1],[new Date(initial+120000).toUTCString(),'provider_retry_after',1]]as const){
  const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);let calls=0;
  const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response(marker,{status:429,headers:header?{'retry-after':header}:undefined});})as typeof fetch,f.clock,f.gate()).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>{assert.ok(e instanceof RetryError);assert.equal(e.metadata.cooldown_source,source);assert.equal(e.metadata.attempts,attempts);assert.ok(!JSON.stringify(e.metadata).includes(marker));return true;});assert.equal(calls,attempts);
  const row=await db.prepare('SELECT * FROM provider_cooldowns').first()as any;assert.equal(row.source,source);assert.ok(!JSON.stringify(row).includes(marker));
  await new InventorySnapshots(db,'owner','123',initial+3600000,f.clock).invalidate();await assert.rejects(()=>f.gate().assertAvailable(),RetryError);
 }
});
test('intermediate 429 establishes a gate before waiting; own bounded safe retry can succeed',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);let calls=0,checked=false;
 const clock={...f.clock,sleep:async(ms:number)=>{await assert.rejects(()=>f.gate().assertAvailable(),RetryError);checked=true;await f.clock.sleep(ms);}};
 const transport=await new CloudCookieTransport(f.env,(async()=>new Response(++calls===1?marker:'ok',{status:calls===1?429:200,headers:{'retry-after':'2'}}))as typeof fetch,clock,f.gate()).init();
 assert.equal((await transport.request({kind:'inventory',page:1})).text,'ok');assert.equal(calls,2);assert.equal(checked,true);assert.deepEqual(f.sleeps,[2125]);
});
test('atomic upsert preserves the longest cooldown across concurrent Workers and snapshot deletion',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);
 await Promise.all([f.gate().record(initial+120000,'provider_retry_after'),f.gate().record(initial+60000,'fallback')]);
 await f.gate().record(initial+30000,'fallback');
 const row=await db.prepare('SELECT retry_at,source FROM provider_cooldowns').first()as any;assert.equal(row.retry_at,initial+120000);assert.equal(row.source,'provider_retry_after');
 await new InventorySnapshots(db,'owner','123',initial+3600000,f.clock).invalidate();await assert.rejects(()=>f.gate().assertAvailable(),e=>e instanceof RetryError&&e.metadata.retry_after_seconds===120);
});
test('provider gates are owner/account bound and cannot be bypassed by binding after setup verification',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);await new ProviderCooldown(db,'owner','unbound',f.clock).record(initial+120000,'fallback');
 await assert.rejects(()=>f.gate().assertAvailable(),RetryError);await new ProviderCooldown(db,'other-owner','123',f.clock).assertAvailable();
 f.advance(120001);await f.gate().record(f.clock.now()+60000,'fallback');await new ProviderCooldown(db,'owner','999',f.clock).assertAvailable();
});
test('missing or failed provider gate storage prevents network access',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const env=configured(db);let calls=0;const fetcher=(async()=>{calls++;return new Response('unexpected');})as typeof fetch;
 await assert.rejects(()=>callTool(request(),{...env,DB:undefined},'verify_connection',{},fetcher),/cooldown storage is unavailable/);
 const broken={prepare(){throw Error(marker);},batch:db.batch.bind(db)};
 await assert.rejects(()=>callTool(request(),{...env,DB:broken},'verify_connection',{},fetcher));assert.equal(calls,0);
});
test('waiting pagination callers receive the shared provider cooldown source rather than a local fallback',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());let loads=0;const expiry=Date.now()+3600000;
 const gate=new ProviderCooldown(db,'owner','123');
 const load=async()=>{loads++;await new Promise(resolve=>setTimeout(resolve,10));const now=Date.now();await gate.record(now+120000,'provider_retry_after');throw new RetryError('fixed synthetic failure',{error_code:'CELLARTRACKER_RATE_LIMITED',upstream_status:429,attempts:1,retry_at:new Date(now+120000).toISOString(),retry_after_seconds:120,cooldown_source:'provider_retry_after',automatic_retry_allowed:false,submission_retry_allowed:false});};
 const results=await Promise.allSettled(Array.from({length:2},()=>new InventorySnapshots(db,'owner','123',expiry,undefined,new ProviderCooldown(db,'owner','123')).get(load)));
 assert.equal(loads,1);for(const result of results){assert.equal(result.status,'rejected');if(result.status==='rejected'){assert.ok(result.reason instanceof RetryError);assert.equal(result.reason.metadata.cooldown_source,'provider_retry_after');}}
});
test('a 429 browser challenge is never retried or bypassed but still establishes the provider gate',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);let calls=0;
 const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response(marker,{status:429,headers:{'cf-mitigated':'challenge','retry-after':'120'}});})as typeof fetch,f.clock,f.gate()).init();
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),/CELLARTRACKER_BROWSER_CHALLENGE/);assert.equal(calls,1);assert.deepEqual(f.sleeps,[]);
 await assert.rejects(()=>f.gate().assertAvailable(),e=>e instanceof RetryError&&e.metadata.cooldown_source==='provider_retry_after');
});
