import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReconciliationReads,reconciliationPolicy} from '../worker/reconciliation.js';
import {CloudCookieTransport} from '../worker/transport.js';
import {CloudStore} from '../worker/store.js';
import {ProviderCooldown} from '../worker/provider-gate.js';
import {RetryError} from '../worker/types.js';
import {callTool} from '../worker/index.js';
import {SqliteD1,bottle,inventoryHtml} from './helpers.js';

const initial=Date.parse('2026-10-01T00:00:00Z'),credential='SYNTHETIC_RECONCILIATION_CREDENTIAL',htmlMarker='SYNTHETIC_PRIVATE_HTML';
const header='<div id="header"><a href="user.asp?iUserOverride=123">Synthetic</a></div>';
function fixture(t:any,pages=8,historyPages=4,latency=0){
 const db=new SqliteD1();t.after(()=>db.close());let now=initial;const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
 const env={DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(initial+3600000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture='+credential,userAgent:'Synthetic browser'})};
 const store=new CloudStore(db,'owner',clock),id=crypto.randomUUID(),request=crypto.randomUUID();
 const initialize=async()=>{
  await store.create({id,owner:'owner',requestKey:request,fingerprint:'synthetic-fingerprint',accountId:'123',bottles:[bottle('1')],details:{date:'2026-09-30',type:1,note:''},status:'planned',createdAt:initial-2000,expiresAt:initial+900000});
  db.sqlite.prepare("UPDATE operations SET status='unknown',submitted_at=? WHERE id=?").run(initial-1000,id);db.sqlite.prepare('INSERT INTO account_locks(owner,operation_id) VALUES(?,?)').run('owner',id);
 };
 const calls:{kind:string;page:number;start:number}[]=[];
 const f={db,clock,env,store,id,request,initialize,calls,pages,historyPages,latency,rateLimitPage:0,mutate:(html:string,_kind:string,_page:number)=>html,advance:(ms:number)=>{now+=ms;}};
 const fetcher=(async(input:unknown,options:RequestInit)=>{
  assert.equal(options.method,'GET');assert.equal(new Headers(options.headers).get('cookie'),'fixture='+credential);
  const u=new URL(String(input)),kind=u.pathname==='/editconsumed.asp'?'detail':u.searchParams.get('table')==='Inventory'?'inventory':'history',page=Number(u.searchParams.get('Page')??1);calls.push({kind,page,start:now});now+=f.latency;
  if(kind==='inventory'&&page===f.rateLimitPage)return new Response(htmlMarker,{status:429,headers:{'set-cookie':'fixture='+htmlMarker}});
  let html=kind==='inventory'?inventoryHtml([bottle(String(1000+page))],page,f.pages,f.pages):kind==='history'?`${header}<a>Consumed (${f.historyPages} bottles)</a><a id="top_gotolink">page ${page} of ${f.historyPages}</a><table id="main_table"><tr><td><input name="iConsumed" value="${page===1?'91':900+page}"><a href="wine.asp?iWine=100">Wine</a><a href="popup/bottlehistory.asp?iBottle=${page===1?'1':300+page}">Bottle</a></td></tr></table>`:`${header}<form id="wine_form"><input name="iWine" value="100"><input name="iConsumed" value="${u.searchParams.get('iConsumed')}"><select name="ConsumptionType"><option value="1" selected>Drank</option></select><input name="ConsumptionDate" value="9/30/2026"><input name="ConsumptionNote" value=""></form>`;
  html=f.mutate(html,kind,page);return new Response(html+'<!--'+htmlMarker+'-->',{headers:{'content-type':'text/html'}});
 })as typeof fetch;
 return {...f,fetcher,advance:f.advance,service:async(customFetcher=fetcher,account='123',cutoff=Date.parse(env.CELLARTRACKER_SESSION_EXPIRES_AT))=>new ReconciliationReads(db,'owner',account,cutoff,await new CloudCookieTransport({...env,CELLARTRACKER_SESSION_EXPIRES_AT:new Date(cutoff).toISOString()},customFetcher,clock,new ProviderCooldown(db,'owner',account,clock)).init(),new ProviderCooldown(db,'owner',account,clock),clock),settings:f};
}
async function finish(f:ReturnType<typeof fixture>){let result:any;for(let i=0;i<20;i++){result=await(await f.service()).status(f.id);if(result.reconciliation.complete)return result;}throw Error('did not finish bounded fixture');}

test('slow multipage reconciliation survives restarts, returns no partial verdict, and preserves pacing',async t=>{
 const f=fixture(t,15,9,20000);await f.initialize();let result:any,stages=0;
 do{
  const started=f.clock.now();result=await(await f.service()).status(f.id);stages++;
  assert.ok(f.clock.now()-started<=reconciliationPolicy.callMs);
  if(!result.reconciliation.complete){
   assert.equal(result.status,'unknown');assert.equal(result.observed_now,undefined);assert.equal(result.reconciliation.automatic_retry_allowed,false);
   assert.equal((await f.store.get(f.id)).status,'unknown');assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);
   const row=f.db.sqlite.prepare('SELECT body FROM reconciliation_reads').get()!;
   assert.ok(!String(row.body).includes(credential));assert.ok(!String(row.body).includes(htmlMarker));assert.ok(!String(row.body).includes('<table'));
  }
 }while(!result.reconciliation.complete&&stages<20);
 assert.ok(stages>1);assert.equal(result.status,'complete');assert.deepEqual(result.observed_now.consumedIds,['1']);assert.equal(f.calls.length,25);
 assert.ok(f.calls.every((c,i)=>i===0||c.start-f.calls[i-1].start>=10000));assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,0);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM reconciliation_reads').get()!.n,0);
});

test('public get_consumption_status uses read stages while execution remains untouched',async t=>{
 const f=fixture(t,8,4);await f.initialize();const req=new Request('https://synthetic.invalid/mcp',{headers:{'oai-authenticated-user-id':'owner'}});
 const result:any=await callTool(req,f.env,'get_consumption_status',{operation_id:f.id},f.fetcher,f.clock);
 assert.equal(result.status,'unknown');assert.equal(result.reconciliation.continuation_required,true);assert.equal(result.observed_now,undefined);
 const unchanged=await f.store.get(f.id);assert.equal(unchanged.submittedAt,initial-1000);assert.equal(unchanged.status,'unknown');
});

test('first 429 saves prior pages, stops immediately, and does not bypass cooldown or expired evidence',async t=>{
 const f=fixture(t,3,1);await f.initialize();f.settings.rateLimitPage=2;
 await assert.rejects(()=>(async()=>await(await f.service()).status(f.id))(),error=>error instanceof RetryError&&error.metadata.attempts===1&&error.metadata.operation_id===f.id&&error.metadata.automatic_retry_allowed===false);
 assert.deepEqual(f.calls.map(c=>c.page),[1,2]);const row=f.db.sqlite.prepare('SELECT body FROM reconciliation_reads').get()!;assert.equal(JSON.parse(String(row.body)).nextPage,2);assert.ok(!String(row.body).includes(htmlMarker));
 await assert.rejects(()=>(async()=>await(await f.service()).status(f.id))(),error=>error instanceof RetryError&&error.metadata.attempts===0);assert.equal(f.calls.length,2);
 f.advance(900001);f.settings.rateLimitPage=0;
 await assert.rejects(()=>(async()=>await(await f.service()).status(f.id))(),/RECONCILIATION_EXPIRED/);assert.equal(f.calls.length,2);
 const result:any=await(await f.service()).status(f.id,true);assert.equal(result.status,'complete');assert.equal(result.reconciliation.complete,true);
});

test('another reader cannot overlap or restart an active lease; a stale reader cannot overwrite a takeover',async t=>{
 const f=fixture(t,1,1);await f.initialize();let entered!:()=>void,resume!:()=>void;
 const started=new Promise<void>(r=>entered=r),paused=new Promise<void>(r=>resume=r);
 const slow={request:async()=>{entered();await paused;return {status:200,url:'https://www.cellartracker.com/list.asp?table=Inventory&Page=1',text:inventoryHtml([bottle('1001')])};}};
 const old=new ReconciliationReads(f.db,'owner','123',initial+3600000,slow,new ProviderCooldown(f.db,'owner','123',f.clock),f.clock).status(f.id);await started;
 await assert.rejects(()=>(async()=>await(await f.service()).status(f.id,true))(),error=>error instanceof RetryError&&error.metadata.error_code==='CELLARTRACKER_RECONCILIATION_IN_PROGRESS');assert.equal(f.calls.length,0);
 f.advance(reconciliationPolicy.leaseMs+1);assert.equal((await(await f.service()).status(f.id)).status,'complete');
 resume();await assert.rejects(()=>old,/RECONCILIATION_FENCED/);assert.equal((await f.store.get(f.id)).status,'complete');
});

test('expired generation, changed session scope and another owner cannot silently reuse evidence',async t=>{
 const f=fixture(t,8,1);await f.initialize();await(await f.service()).status(f.id);const count=f.calls.length;
 await assert.rejects(()=>(async()=>await(await f.service(f.fetcher,'123',initial+7200000)).status(f.id))(),/RECONCILIATION_EXPIRED/);assert.equal(f.calls.length,count);
 await assert.rejects(()=>new ReconciliationReads(f.db,'other','123',initial+3600000,{}as any,{}as any,f.clock).status(f.id),/not found/);
 await assert.rejects(()=>(async()=>await(await f.service(f.fetcher,'999')).status(f.id))(),/approved account/);assert.equal(f.calls.length,count);
 f.advance(600000);await assert.rejects(()=>(async()=>await(await f.service()).status(f.id))(),/RECONCILIATION_EXPIRED/);assert.equal(f.calls.length,count);assert.equal((await f.store.get(f.id)).status,'unknown');
});

for(const mode of ['duplicate','pagination','account','missing_inventory','missing_history','missing_detail']as const)test('inconsistent '+mode+' evidence never completes or unlocks an operation',async t=>{
 const f=fixture(t,2,2);await f.initialize();
 f.settings.mutate=(html,kind,page)=>{
  if(mode==='duplicate'&&kind==='inventory'&&page===2)return html.replaceAll('1002','1001');
  if(mode==='pagination'&&kind==='inventory'&&page===2)return html.replace('page 2 of 2','page 2 of 3');
  if(mode==='account'&&kind==='history')return html.replace('iUserOverride=123','iUserOverride=999');
  if(mode==='missing_inventory'&&kind==='inventory'&&page===2)return html.replace('name="iInventory"','name="ignored"');
  if(mode==='missing_history'&&kind==='history'&&page===2)return html.replace('name="iConsumed"','name="ignored"');
  if(mode==='missing_detail'&&kind==='detail')return html.replace('name="ConsumptionDate"','name="ignored"');
  return html;
 };
 await assert.rejects(()=>finish(f));assert.equal((await f.store.get(f.id)).status,'unknown');assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);
 const count=f.calls.length;await assert.rejects(()=>(async()=>await(await f.service()).status(f.id))(),/RECONCILIATION_EXPIRED/);assert.equal(f.calls.length,count);
});

for(const mode of ['wine','date','type','note','remaining','duplicate_history']as const)test('complete '+mode+' evidence retains exact-match rules and never replays',async t=>{
 const f=fixture(t,1,mode==='duplicate_history'?2:1);await f.initialize();
 f.settings.mutate=(html,kind,page)=>{
  if(mode==='wine')return html.replaceAll('iWine=100','iWine=999').replace('name="iWine" value="100"','name="iWine" value="999"');
  if(mode==='date'&&kind==='detail')return html.replace('9/30/2026','9/29/2026');
  if(mode==='type'&&kind==='detail')return html.replace('value="1" selected','value="2" selected');
  if(mode==='note'&&kind==='detail')return html.replace('name="ConsumptionNote" value=""','name="ConsumptionNote" value="Different"');
  if(mode==='remaining'&&kind==='inventory')return inventoryHtml([bottle('1')]);
  if(mode==='duplicate_history'&&kind==='history'&&page===2)return html.replace('iBottle=302','iBottle=1');
  return html;
 };
 const result=await finish(f);assert.equal(result.status,'unknown');assert.deepEqual(result.observed_now.consumedIds,[]);assert.deepEqual(result.observed_now.conflictIds,['1']);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);
});

test('absence alone cannot complete; an unchanged bottle with no history remains unresolved',async t=>{
 for(const stillPresent of [false,true]){
  const f=fixture(t,1,1);await f.initialize();f.settings.mutate=(html,kind)=>kind==='history'?`${header}<a>Consumed (0 bottles)</a><table id="main_table"></table>`:stillPresent&&kind==='inventory'?inventoryHtml([bottle('1')]):html;
  const result=await finish(f);assert.equal(result.status,'unknown');assert.deepEqual(result.observed_now.consumedIds,[]);
  assert.deepEqual(stillPresent?result.observed_now.remainingIds:result.observed_now.conflictIds,['1']);assert.ok(f.calls.every(c=>c.kind!=='detail'));
 }
});

test('parsed progress has a size bound and oversized evidence cannot change operation state',async t=>{
 const f=fixture(t,1,1);await f.initialize();f.settings.mutate=(html,kind)=>kind==='inventory'?html.replace('2020 Synthetic Cabernet','x'.repeat(reconciliationPolicy.maxBytes)):html;
 await assert.rejects(()=>(async()=>await(await f.service()).status(f.id))(),/RECONCILIATION_SIZE/);
 assert.equal((await f.store.get(f.id)).status,'unknown');assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);
});

test('a submission boundary changing during a read generation invalidates its evidence',async t=>{
 const f=fixture(t,1,1);await f.initialize();f.db.sqlite.prepare("UPDATE operations SET status='planned',submitted_at=NULL WHERE id=?").run(f.id);
 f.settings.mutate=(html,kind)=>{if(kind==='detail')f.db.sqlite.prepare("UPDATE operations SET status='submitted',submitted_at=? WHERE id=?").run(f.clock.now(),f.id);return html;};
 await assert.rejects(()=>(async()=>await(await f.service()).status(f.id))(),/RECONCILIATION_EXPIRED/);assert.equal((await f.store.get(f.id)).status,'submitted');assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);
});

test('later status checks obtain fresh evidence and completion stays absorbing',async t=>{
 const f=fixture(t,1,1);await f.initialize();const first=await finish(f),count=f.calls.length;
 f.settings.mutate=(html,kind)=>kind==='detail'?html.replace('9/30/2026','9/29/2026'):html;
 const next=await finish(f);assert.ok(f.calls.length>count);assert.notEqual(next.reconciliation.generation_id,first.reconciliation.generation_id);
 assert.equal(next.status,'complete');assert.deepEqual(next.observed_now.conflictIds,['1']);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,0);
});
