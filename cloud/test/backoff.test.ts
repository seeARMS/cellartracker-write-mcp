import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudCookieTransport} from '../worker/transport.js';
import {backoffMs,retryAfterMs,readRetryPolicy} from '../worker/backoff.js';
import {RetryError} from '../worker/types.js';
const marker='SYNTHETIC_SECRET_DO_NOT_DISCLOSE';
const initial=Date.parse('2026-10-01T00:00:00Z');
function fixture(statuses:number[],retryAfter?:string){
 let now=initial,calls=0;const sleeps:number[]=[];
 const clock={now:()=>now,random:()=>.5,sleep:async(ms:number)=>{sleeps.push(ms);now+=ms;}};
 const env={CELLARTRACKER_SESSION_EXPIRES_AT:new Date(initial+3600_000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture='+marker,userAgent:'Synthetic Agent'})};
 const fetcher=(async()=>{const status=statuses[Math.min(calls++,statuses.length-1)];return new Response(status===200?'ok':marker,{status,headers:retryAfter?{'retry-after':retryAfter}:undefined});})as typeof fetch;
 return {clock,env,fetcher,sleeps,get calls(){return calls;}};
}
test('429 reads stop on the first response and respect delta-seconds and HTTP-date cooldowns',async()=>{
 for(const header of ['2',new Date(initial+2000).toUTCString()]){
  const f=fixture([429,200],header);const t=await new CloudCookieTransport(f.env,f.fetcher,f.clock).init();
  await assert.rejects(()=>t.request({kind:'inventory',page:1}),e=>e instanceof RetryError&&e.metadata.retry_after_seconds>=2&&e.metadata.attempts===1);assert.equal(f.calls,1);assert.deepEqual(f.sleeps,[]);
 }
});
test('jitter is bounded, exponential, and never shortens Retry-After',()=>{
 for(let attempt=1;attempt<=3;attempt++)for(const random of [0,.5,1]){
  const base=1000*2**(attempt-1),delay=backoffMs(attempt,undefined,random);
  assert.ok(delay>=base&&delay<=base+250);
  assert.ok(backoffMs(attempt,10000,random)>=10000&&backoffMs(attempt,10000,random)<=10250);
 }
 assert.equal(retryAfterMs('invalid '+marker,initial),undefined);assert.equal(retryAfterMs('-1',initial),undefined);
 assert.equal(retryAfterMs(new Date(initial-1000).toUTCString(),initial),0);
 assert.equal(retryAfterMs('172800',initial),172800000);
});
test('exhaustion is bounded and returns sanitized retry metadata with a cooldown',async()=>{
 const f=fixture([429]);const t=await new CloudCookieTransport(f.env,f.fetcher,f.clock).init();
 await assert.rejects(()=>t.request({kind:'inventory',page:1}),error=>{
  assert.ok(error instanceof RetryError);assert.equal(error.metadata.error_code,'CELLARTRACKER_RATE_LIMITED');assert.equal(error.metadata.upstream_status,429);
  assert.equal(error.metadata.attempts,1);assert.equal(error.metadata.retry_after_seconds,60);assert.equal(error.metadata.automatic_retry_allowed,true);assert.equal(error.metadata.error_origin,'upstream_http');assert.equal(error.metadata.total_upstream_attempts,1);
  assert.ok(!JSON.stringify(error.metadata).includes(marker));assert.ok(!error.message.includes(marker));return true;
 });
 assert.equal(f.calls,1);assert.deepEqual(f.sleeps,[]);
});
test('a long Retry-After returns without waiting or retrying before the requested time',async()=>{
 const f=fixture([429],'120');const t=await new CloudCookieTransport(f.env,f.fetcher,f.clock).init();
 await assert.rejects(()=>t.request({kind:'inventory',page:1}),error=>{assert.ok(error instanceof RetryError);assert.ok(Date.parse(error.metadata.retry_at)>=initial+120000);assert.equal(error.metadata.attempts,1);return true;});
 assert.equal(f.calls,1);assert.deepEqual(f.sleeps,[]);
});
test('slow upstream attempts count against elapsed deadline',async()=>{
 const f=fixture([503]);let calls=0;
 const fetcher=(async()=>{calls++;await f.clock.sleep(20000);return new Response(marker,{status:503});})as typeof fetch;
 const t=await new CloudCookieTransport(f.env,fetcher,f.clock).init();
 await assert.rejects(()=>t.request({kind:'inventory',page:1}),RetryError);assert.equal(calls,2);
 // Real fetch respects the capped AbortController deadline; simulated fetch deliberately ignores it.
 assert.ok(f.sleeps[1]<10000);
});
test('transient 5xx and network failures retry safe reads, authentication and challenges do not',async()=>{
 const f=fixture([503,502,200]);const t=await new CloudCookieTransport(f.env,f.fetcher,f.clock).init();assert.equal((await t.request({kind:'inventory',page:1})).text,'ok');assert.equal(f.calls,3);
 for(const status of [401,403,302,404]){const c=fixture([status]);const t=await new CloudCookieTransport(c.env,c.fetcher,c.clock).init();await assert.rejects(()=>t.request({kind:'inventory',page:1}));assert.equal(c.calls,1);assert.deepEqual(c.sleeps,[]);}
 const c=fixture([200]);let calls=0;const transport=await new CloudCookieTransport(c.env,(async()=>{if(++calls===1)throw Error(marker);return new Response('ok');})as typeof fetch,c.clock).init();assert.equal((await transport.request({kind:'inventory',page:1})).text,'ok');assert.equal(calls,2);
});
test('consumption POST is never retried for 429, 5xx, network failure or timeout',async()=>{
 for(const status of [429,503,0,-1]){
  const f=fixture([status||200]);let calls=0;
  const fetcher=(async()=>{calls++;if(status===0)throw Error(marker);if(status===-1)throw new DOMException(marker,'TimeoutError');return new Response(marker,{status,headers:{'retry-after':'1'}});})as typeof fetch;
  const t=await new CloudCookieTransport(f.env,fetcher,f.clock).init();
  await assert.rejects(()=>t.request({kind:'consume',ids:['1'],currency:'USD',details:{date:'2026-09-30',type:1,note:''}}),error=>{assert.ok(!String(error).includes(marker));return true;});
  assert.equal(calls,1);assert.deepEqual(f.sleeps,[]);
 }
});
test('approved session cutoff is rechecked before every retry',async()=>{
 const f=fixture([429,200],'2');f.env.CELLARTRACKER_SESSION_EXPIRES_AT=new Date(initial+1000).toISOString();
 let calls=0;const fetcher=(async()=>{calls++;return new Response(marker,{status:503,headers:{'retry-after':'2'}});})as typeof fetch;
 const t=await new CloudCookieTransport(f.env,fetcher,f.clock).init();await assert.rejects(()=>t.request({kind:'inventory',page:1}),/cutoff passed/);assert.equal(calls,1);
});
test('successful responses arriving past the read deadline are rejected',async()=>{
 const f=fixture([200]);const fetcher=(async()=>{await f.clock.sleep(31000);return new Response('too late');})as typeof fetch;
 const t=await new CloudCookieTransport(f.env,fetcher,f.clock).init();await assert.rejects(()=>t.request({kind:'inventory',page:1}),error=>error instanceof RetryError&&error.metadata.error_code==='CELLARTRACKER_READ_DEADLINE');
});
