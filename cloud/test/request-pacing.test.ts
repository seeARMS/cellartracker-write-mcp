import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProviderCooldown,providerRequestSpacingMs} from '../worker/provider-gate.js';
import {CloudCookieTransport} from '../worker/transport.js';
import {CellarTracker} from '../worker/cellar.js';
import {RetryError} from '../worker/types.js';
import {SqliteD1,bottle,inventoryHtml} from './helpers.js';
const initial=Date.parse('2026-10-01T00:00:00Z');
const marker='SYNTHETIC_PRIVATE_RATE_MARKER';
function fixture(db:SqliteD1){let now=initial;const waits:number[]=[];const clock={now:()=>now,random:()=>0,sleep:async(ms:number)=>{waits.push(ms);now+=ms;}};const env={CELLARTRACKER_SESSION_EXPIRES_AT:new Date(initial+3600000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture='+marker,userAgent:'Synthetic Agent'})};return {clock,waits,env,advance:(ms:number)=>{now+=ms;},gate:()=>new ProviderCooldown(db,'owner','123',clock)};}
test('separate Worker instances atomically pace request starts across inventory, history and POST',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);const starts:number[]=[];
 const fetcher=(async()=>{starts.push(f.clock.now());return new Response('ok');})as typeof fetch;
 for(const kind of [{kind:'inventory',page:1},{kind:'consumed',page:1},{kind:'consumptionForm'},{kind:'consume',ids:['1'],currency:'USD',details:{date:'2026-09-30',type:1,note:''}}]as const){
  const transport=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init();await transport.request(kind as any);
 }
 assert.deepEqual(starts,[initial,initial+10000,initial+20000,initial+30000]);assert.deepEqual(f.waits,[10000,10000,10000]);
});
test('concurrent slot reservations preserve minimum spacing without a read-then-write race',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db),starts:number[]=[];
 await Promise.all(Array.from({length:4},async()=>{await f.gate().pace(initial+60000);starts.push(f.clock.now());}));
 const row=await db.prepare('SELECT next_at FROM provider_request_slots').first()as any;
 assert.ok(row.next_at>=initial+4*providerRequestSpacingMs);assert.equal(starts.length,4);
 // Each granted reservation updates the monotonic next slot atomically, even if callbacks interleave.
});
test('pacing waits stay inside the read deadline and make no HTTP request when no slot fits',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);await f.gate().pace(initial+30000);
 await assert.rejects(()=>f.gate().pace(initial+1000),e=>e instanceof RetryError&&e.metadata.error_origin==='request_pacing'&&e.metadata.attempts===0&&e.metadata.upstream_status===undefined);
 assert.deepEqual(f.waits,[]);
});
test('a cooldown recorded by another Worker while pacing stops the pending request before fetch',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);await f.gate().pace(initial+30000);let calls=0;
 const clock={...f.clock,sleep:async(ms:number)=>{await f.gate().record(initial+120000,'provider_retry_after');await f.clock.sleep(ms);}};
 const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response('unexpected');})as typeof fetch,clock,new ProviderCooldown(db,'owner','123',clock)).init();
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>e instanceof RetryError&&e.metadata.error_origin==='saved_provider_cooldown');assert.equal(calls,0);
});
test('approved session cutoff is checked again after a pacing wait',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);await f.gate().pace(initial+30000);f.env.CELLARTRACKER_SESSION_EXPIRES_AT=new Date(initial+1000).toISOString();let calls=0;
 const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response('unexpected');})as typeof fetch,f.clock,f.gate()).init();
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),/cutoff passed/);assert.equal(calls,0);
});
test('a later-page 429 reports fresh HTTP origin and cumulative counts without retrying that page',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);const calls:number[]=[];
 const fetcher=(async(input:string)=>{const page=Number(new URL(input).searchParams.get('Page'));calls.push(page);return page===3?new Response(marker,{status:429}):new Response(inventoryHtml([bottle(String(page))],page,3,3));})as typeof fetch;
 const cellar=new CellarTracker(await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init());
 await assert.rejects(()=>cellar.inventory(),e=>{assert.ok(e instanceof RetryError);assert.equal(e.metadata.error_origin,'upstream_http');assert.equal(e.metadata.upstream_page,3);assert.equal(e.metadata.request_kind,'inventory');assert.equal(e.metadata.attempts,1);assert.equal(e.metadata.total_upstream_attempts,3);assert.equal(e.metadata.successful_upstream_reads,2);assert.ok(!JSON.stringify(e.metadata).includes(marker));return true;});
 assert.deepEqual(calls,[1,2,3]);assert.deepEqual(f.waits,[10000,10000]);
 await assert.rejects(()=>f.gate().assertAvailable(),e=>e instanceof RetryError&&e.metadata.error_origin==='saved_provider_cooldown'&&e.metadata.upstream_status===undefined);
});

test('a 25-page inventory walk fits the longer paced workflow without partial cache data',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);let calls=0;
 const fetcher=(async(input:string)=>{calls++;const page=Number(new URL(input).searchParams.get('Page'));return new Response(inventoryHtml([bottle(String(page))],page,25,25));})as typeof fetch;
 const cellar=new CellarTracker(await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate()).init());
 assert.equal((await cellar.inventory()).bottles.length,25);assert.equal(calls,25);
 assert.equal(f.clock.now()-initial,240000);assert.ok(f.waits.every(ms=>ms===10000));
});
test('plan expiration while waiting for a POST slot prevents the actual provider submission',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const f=fixture(db);await f.gate().pace(initial+45000);let calls=0;
 const transport=await new CloudCookieTransport(f.env,(async()=>{calls++;return new Response('unexpected');})as typeof fetch,f.clock,f.gate()).init();
 await assert.rejects(()=>transport.request({kind:'consume',ids:['1'],currency:'USD',details:{date:'2026-09-30',type:1,note:''},expiresAt:initial+5000}),/CELLARTRACKER_PLAN_EXPIRED/);
 assert.equal(calls,0);
});
