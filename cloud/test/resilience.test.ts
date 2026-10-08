import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudCookieTransport} from '../worker/transport.js';
import {ProviderCooldown} from '../worker/provider-gate.js';
import {CloudConsumption} from '../worker/consumption.js';
import {CloudStore} from '../worker/store.js';
import {PendingRequests,pendingPolicy} from '../worker/pending.js';
import {RetryError,SafeError} from '../worker/types.js';
import {retryFailure} from '../worker/backoff.js';
import {callTool} from '../worker/index.js';
import {SqliteD1,FakeCellar,bottle,upstream} from './helpers.js';
function fixture(t:any){
 const db=new SqliteD1();t.after(()=>db.close());let now=Date.now();
 const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
 const env={DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_WRITES_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(now+7*86400000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture=synthetic',userAgent:'Synthetic'})};
 const gate=()=>new ProviderCooldown(db,'owner','123',clock);
 const store=()=>new CloudStore(db,'owner',clock);
 const cellar=new FakeCellar();
 return {db,clock,env,gate,store,cellar,advance:(ms:number)=>{now+=ms;},service:()=>new CloudConsumption(cellar,store(),'123',clock)};
}
const req=()=>({request_id:crypto.randomUUID(),bottle_ids:['1'],date:'2026-10-02',note:''});
const ownerRequest=(owner='owner')=>new Request('https://fixture.invalid/mcp',{method:'POST',headers:{'oai-authenticated-user-id':owner}});
const limited=(now:number)=>retryFailure('CELLARTRACKER_RATE_LIMITED',429,1,now+60000,now,'fallback',{error_origin:'upstream_http'});
test('429 circuit preserves a fixed manual fallback across restarts; streak remains diagnostic until 24 quiet hours',async t=>{
 const f=fixture(t);let calls=0;
 const fetcher=(async()=>{calls++;return new Response('SYNTHETIC_PRIVATE_BODY',{status:429});})as typeof fetch;
 for(let i=0;i<8;i++){
  const before=f.clock.now();const transport=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init();
  let retryAt=0;await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>{assert.ok(e instanceof RetryError);assert.equal(e.metadata.rate_limit_streak,i+1);assert.equal(e.metadata.automatic_retry_allowed,false);assert.equal(e.metadata.response_classification,'http_rate_limit');retryAt=Date.parse(e.metadata.retry_at);assert.equal(retryAt-before,900000);return true;});
  const restarted=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init();await assert.rejects(()=>restarted.request({kind:'consumed',page:1}),RetryError);assert.equal(calls,i+1);
  f.advance(retryAt-f.clock.now());
 }
 f.advance(24*3600000+1);assert.equal((await f.gate().rateLimited(undefined)).streak,1);
});
test('provider HTTP-date wait survives restart and cannot be shortened by fallback backoff',async t=>{
 const f=fixture(t);const cutoff=f.clock.now()+2*86400000;
 const transport=await new CloudCookieTransport(f.env,(async()=>new Response('',{status:429,headers:{'retry-after':new Date(cutoff).toUTCString()}}))as typeof fetch,f.clock,f.gate()).init();
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>e instanceof RetryError&&Date.parse(e.metadata.retry_at)>=Math.floor(cutoff/1000)*1000&&e.metadata.cooldown_source==='provider_retry_after');
 await f.gate().record(f.clock.now()+60000,'fallback');await assert.rejects(()=>f.gate().assertAvailable(),e=>e instanceof RetryError&&e.metadata.retry_after_seconds>86400);
});
test('request lease serializes actual fetch lifetimes and old release cannot clear a new lease',async t=>{
 const f=fixture(t);let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),paused=new Promise<void>(r=>release=r);let active=0,peak=0;
 const fetcher=(async()=>{active++;peak=Math.max(peak,active);entered();await paused;active--;return new Response('ok');})as typeof fetch;
 const a=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init();const run=a.request({kind:'inventory',page:1});await started;
 const b=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init();await assert.rejects(()=>b.request({kind:'consumed',page:1}),RetryError);assert.equal(peak,1);release();await run;
 const old=await f.gate().acquire(f.clock.now()+1000);f.advance(6001);const fresh=await f.gate().acquire(f.clock.now()+1000);await f.gate().release(old);
 const row=await f.db.prepare('SELECT lease_id FROM provider_state').first()as any;assert.equal(row.lease_id,fresh);await f.gate().release(fresh);
});
for(const [status,headers,code]of [[403,{},'CELLARTRACKER_ACCESS_DENIED'],[401,{},'CELLARTRACKER_AUTHENTICATION_REQUIRED'],[429,{'cf-mitigated':'challenge'},'CELLARTRACKER_BROWSER_CHALLENGE']]as const)test(`provider ${code} stays paused across restart and owner review preserves cooldown`,async t=>{
 const f=fixture(t);let calls=0;const fetcher=(async()=>{calls++;return new Response('SECRET',{status,headers});})as typeof fetch;
 const first=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init();await assert.rejects(()=>first.request({kind:'inventory',page:1}),new RegExp(code));
 f.advance(120000);const second=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init();await assert.rejects(()=>second.request({kind:'inventory',page:1}),new RegExp(code));assert.equal(calls,1);
 await f.gate().record(f.clock.now()+300000,'provider_retry_after');
 await assert.rejects(()=>callTool(ownerRequest('other'),f.env,'resume_provider_reads',{confirmed:true,reviewed_error_code:code},fetcher,f.clock),/owner binding/);
 await assert.rejects(()=>callTool(ownerRequest(),f.env,'resume_provider_reads',{confirmed:false,reviewed_error_code:code},fetcher,f.clock),/confirmed=true/);
 await callTool(ownerRequest(),f.env,'resume_provider_reads',{confirmed:true,reviewed_error_code:code},fetcher,f.clock);await assert.rejects(()=>f.gate().assertAvailable(),RetryError);assert.equal(calls,1);
});
test('intake saves before lookup, deduplicates after restart, and remains readable with an expired session',async t=>{
 const f=fixture(t);let calls=0;const never=(async()=>{calls++;throw Error('must not fetch');})as typeof fetch;
 const input={request_id:crypto.randomUUID(),wine:'2018 Synthetic Pinot Noir Upper Block',quantity:1,date:'2026-10-02'};
 const one=await callTool(ownerRequest(),f.env,'queue_consumption_request',input,never,f.clock)as any;
 const two=await callTool(ownerRequest(),{...f.env,CELLARTRACKER_SESSION_JSON:'',CELLARTRACKER_SESSION_EXPIRES_AT:'2000-01-01'},'get_consumption_request',{request_id:input.request_id},never,f.clock)as any;
 assert.equal(one.operation_id,two.operation_id);assert.equal(two.pending.phase,'lookup');assert.equal(two.background_worker_scheduled,false);
 const again=await callTool(ownerRequest(),f.env,'queue_consumption_request',input,never,f.clock)as any;assert.equal(again.operation_id,one.operation_id);
 await assert.rejects(()=>callTool(ownerRequest(),f.env,'queue_consumption_request',{...input,date:'2026-10-01'},never,f.clock),/different consumption/);assert.equal(calls,0);
});
test('separate dates have independent request IDs and cannot be rebound to different details',async t=>{
 const f=fixture(t),pending=f.store().pending;
 const input={request_id:crypto.randomUUID(),wine:'2018 Synthetic Pinot Noir Upper Block',quantity:1,date:'2026-10-02'};
 const today=await pending.saveIntent(input),older=await pending.saveIntent({...input,request_id:crypto.randomUUID(),date:'2026-10-01'});
 assert.notEqual(today.operation_id,older.operation_id);
 await assert.rejects(()=>f.service().plan({...req(),request_id:input.request_id,date:'2026-10-01'}),/differs from the saved/);
 const plan=await f.service().plan({...req(),request_id:input.request_id});assert.equal(plan.operation_id,today.operation_id);assert.equal(f.cellar.writes,0);
});
test('failed planning survives restart with a stable operation ID and retries only after its saved wait',async t=>{
 const f=fixture(t),input=req();const inventory=f.cellar.inventory.bind(f.cellar);let reads=0;
 f.cellar.inventory=async()=>{reads++;throw limited(f.clock.now());};let id='';
 await assert.rejects(()=>f.service().plan(input),e=>{assert.ok(e instanceof RetryError);assert.equal(e.metadata.request_id,input.request_id);id=e.metadata.operation_id!;return true;});
 const saved=await f.store().pending.get(input.request_id);assert.equal(saved.operation_id,id);assert.equal(saved.attempts,1);
 await assert.rejects(()=>f.service().plan(input),RetryError);assert.equal(reads,1);
 f.advance(60000);f.cellar.inventory=inventory;const plan=await f.service().plan(input);assert.equal(plan.operation_id,id);assert.equal((await f.service().execute(id)).status,'complete');assert.equal(f.cellar.writes,1);
});
test('planning attempt budget and request age stop repeated retries without dropping the request',async t=>{
 const f=fixture(t),input=req();f.cellar.inventory=async()=>{throw limited(f.clock.now());};
 for(let i=0;i<pendingPolicy.maxAttempts;i++){await assert.rejects(()=>f.service().plan(input),RetryError);f.advance(60001);}
 await assert.rejects(()=>f.service().plan(input),e=>e instanceof RetryError&&e.metadata.error_code==='CELLARTRACKER_PENDING_BUDGET'&&!e.metadata.automatic_retry_allowed);
 assert.equal((await f.store().pending.get(input.request_id)).attempts,12);
 const fresh={...req(),request_id:crypto.randomUUID()};await f.store().pending.saveIntent({request_id:fresh.request_id,wine:'Synthetic',quantity:1,date:fresh.date});f.advance(86400001);
 await assert.rejects(()=>f.service().plan(fresh),e=>e instanceof RetryError&&e.metadata.error_code==='CELLARTRACKER_PENDING_BUDGET');assert.equal(f.cellar.writes,0);
});
test('concurrent plan callers share one upstream preflight and recover with the same IDs',async t=>{
 const f=fixture(t),input=req();let resume!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),pause=new Promise<void>(r=>resume=r);let reads=0;
 f.cellar.pauseInventory=async()=>{reads++;entered();await pause;};const first=f.service().plan(input);await started;
 await assert.rejects(()=>f.service().plan(input),e=>e instanceof RetryError&&e.metadata.error_origin==='pending_request');assert.equal(reads,1);resume();const plan=await first;
 assert.equal((await f.service().plan(input)).operation_id,plan.operation_id);assert.equal(reads,1);
});
test('retryable execution preflight and form reads preserve the reviewed plan without a POST',async t=>{
 const f=fixture(t),plan=await f.service().plan(req());const original=f.cellar.inventory.bind(f.cellar);
 f.cellar.inventory=async()=>{throw limited(f.clock.now());};let outcome=await f.service().execute(plan.operation_id);assert.equal(outcome.status,'planned');assert.equal(outcome.dry_run,true);assert.equal(f.cellar.writes,0);
 f.advance(60000);f.cellar.inventory=original;(f.cellar as any).prepareConsumption=async()=>{throw limited(f.clock.now());};outcome=await f.service().execute(plan.operation_id);assert.equal(outcome.status,'planned');assert.equal(f.cellar.writes,0);
 f.advance(60000);(f.cellar as any).prepareConsumption=async()=> 'USD';assert.equal((await f.service().execute(plan.operation_id)).status,'complete');assert.equal(f.cellar.writes,1);
});
test('expired checking lease fences a stale worker before a restarted worker can submit',async t=>{
 const f=fixture(t),plan=await f.service().plan(req());let resume!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),pause=new Promise<void>(r=>resume=r);let once=true;
 f.cellar.pauseInventory=async()=>{if(once){once=false;entered();await pause;}};const stale=f.service().execute(plan.operation_id);await started;
 f.advance(630001);const restarted=await f.service().execute(plan.operation_id);assert.equal(restarted.status,'complete');resume();await stale;assert.equal(f.cellar.writes,1);assert.equal((await f.store().get(plan.operation_id)).status,'complete');
});
test('legacy checking locks without a known lease and every ambiguous POST remain non-replayable',async t=>{
 const f=fixture(t),p=await f.service().plan(req());await f.store().begin(p.operation_id);f.db.sqlite.prepare('UPDATE operations SET checking_until=NULL,checking_token=NULL WHERE id=?').run(p.operation_id);f.advance(150000);
 assert.equal((await f.service().execute(p.operation_id)).status,'checking');assert.equal(f.cellar.writes,0);
});
test('partial POST remains unknown and locked after restart; status never submits the missing bottles',async t=>{
 const f=fixture(t),p=await f.service().plan({...req(),bottle_ids:['1','2']});const consume=f.cellar.consume.bind(f.cellar);
 f.cellar.consume=async(ids,details)=>{await consume(ids.slice(0,1),details);throw Error('lost partial response');};
 assert.equal((await f.service().execute(p.operation_id)).status,'unknown');assert.equal((await f.service().execute(p.operation_id)).status,'unknown');const status=await f.service().status(p.operation_id);
 assert.deepEqual(status.observed_now.consumedIds,['1']);assert.deepEqual(status.observed_now.remainingIds,['2']);assert.equal(f.cellar.writes,1);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);
});
test('lost POST plus rate-limited reconciliation completes by read-back without replay',async t=>{
 const f=fixture(t),p=await f.service().plan(req());const inventory=f.cellar.inventory.bind(f.cellar);f.cellar.loseResponse=true;
 f.cellar.inventory=async()=>{if(f.cellar.writes)throw limited(f.clock.now());return inventory();};
 const result=await f.service().execute(p.operation_id);assert.equal(result.status,'unknown');assert.equal(result.verification?.retry?.automatic_retry_allowed,false);assert.equal(result.verification?.retry?.submission_retry_allowed,false);
 f.advance(60001);f.cellar.inventory=inventory;assert.equal((await f.service().status(p.operation_id)).status,'complete');assert.equal((await f.service().execute(p.operation_id)).status,'complete');assert.equal(f.cellar.writes,1);
});
test('the real tool path queues, binds exact IDs, prepares form before the durable POST boundary and verifies',async t=>{
 const f=fixture(t),api=upstream(),id=crypto.randomUUID();let formStatus='';
 const fetcher=(async(input:any,options:any)=>{if(new URL(input).pathname==='/popup/consume_form.asp')formStatus=(f.db.sqlite.prepare('SELECT status FROM operations').get()as any).status;return api.fetcher(input,options);})as typeof fetch;
 const queued=await callTool(ownerRequest(),f.env,'queue_consumption_request',{request_id:id,wine:'2020 Synthetic Cabernet',quantity:1,date:'2026-10-02'},fetcher,f.clock)as any;
 const plan=await callTool(ownerRequest(),f.env,'plan_consumption',{request_id:id,bottle_ids:['1'],date:'2026-10-02'},fetcher,f.clock)as any;assert.equal(plan.operation_id,queued.operation_id);
 const result=await callTool(ownerRequest(),f.env,'execute_consumption',{operation_id:plan.operation_id,confirmed:true},fetcher,f.clock)as any;assert.equal(result.status,'complete');assert.equal(formStatus,'checking');assert.equal(api.posts,1);
 const saved=await callTool(ownerRequest(),f.env,'get_consumption_request',{request_id:id},fetcher,f.clock)as any;assert.equal(saved.operation.status,'complete');assert.equal(api.posts,1);
});
test('exhausted 5xx cooldown is classified separately from an HTTP 429',async t=>{
 const f=fixture(t);let calls=0;const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response('',{status:503});})as typeof fetch,f.clock,f.gate()).init();
 await assert.rejects(()=>transport.request({kind:'consumed',page:1}),e=>e instanceof RetryError&&e.metadata.response_classification==='service_error'&&e.metadata.attempts===1);
 await assert.rejects(()=>f.gate().assertAvailable(),e=>e instanceof RetryError&&e.metadata.error_code==='CELLARTRACKER_READ_COOLDOWN'&&e.metadata.upstream_status===undefined);assert.equal(calls,1);
});
test('connection diagnostics report only saved fixed metadata and never contact the provider',async t=>{
 const f=fixture(t);await f.gate().rateLimited(1800000);let calls=0;
 const result=await callTool(ownerRequest(),f.env,'connection_status',{},(async()=>{calls++;throw Error('unexpected');})as typeof fetch,f.clock)as any;
 assert.equal(result.adapter_version,'0.2.0');assert.equal(result.provider.rate_limit_streak,1);assert.equal(result.provider.cooldown_source,'provider_retry_after');assert.equal(calls,0);assert.ok(!JSON.stringify(result).includes('fixture='));
});
test('a completed operation cannot be downgraded by a late unresolved worker',async t=>{
 const f=fixture(t),p=await f.service().plan(req());assert.equal((await f.service().execute(p.operation_id)).status,'complete');
 await f.store().outcome(p.operation_id,'unknown',{consumedIds:[],remainingIds:[],conflictIds:[]});assert.equal((await f.store().get(p.operation_id)).status,'complete');assert.equal(f.cellar.writes,1);
});
test('a restarted planning worker fences the old lease and preserves the same operation ID',async t=>{
 const f=fixture(t),input=req();let resume!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),pause=new Promise<void>(r=>resume=r);let once=true;
 f.cellar.pauseInventory=async()=>{if(once){once=false;entered();await pause;}};const old=f.service().plan(input);await started;const pending=await f.store().pending.get(input.request_id);
 f.advance(pendingPolicy.leaseMs+1);const fresh=await f.service().plan(input);assert.equal(fresh.operation_id,pending.operation_id);resume();await assert.rejects(()=>old,/lease expired/);
 assert.equal((await f.store().get(fresh.operation_id)).status,'planned');assert.equal(f.cellar.writes,0);
});
test('a pending request rejects changes to exact IDs or notes after a retryable lookup failure',async t=>{
 const f=fixture(t),input=req();f.cellar.inventory=async()=>{throw limited(f.clock.now());};await assert.rejects(()=>f.service().plan(input),RetryError);
 await assert.rejects(()=>f.service().plan({...input,bottle_ids:['2']}),/different consumption details/);await assert.rejects(()=>f.service().plan({...input,note:'Changed'}),/different consumption details/);assert.equal(f.cellar.writes,0);
});
test('unknown POST retains a sanitized submission diagnostic while reconciliation is unavailable',async t=>{
 const f=fixture(t),p=await f.service().plan(req());f.cellar.consume=async()=>{throw new SafeError('[CELLARTRACKER_REQUEST_TIMEOUT] fixed timeout');};
 const result=await f.service().execute(p.operation_id);assert.equal(result.status,'unknown');assert.equal(result.verification?.submission_error?.error_code,'CELLARTRACKER_REQUEST_TIMEOUT');
});
