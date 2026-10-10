import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProviderCooldown} from '../worker/provider-gate.js';
import {CloudCookieTransport} from '../worker/transport.js';
import {RetryError} from '../worker/types.js';
import {callTool} from '../worker/index.js';
import {SqliteD1} from './helpers.js';
const initial=Date.parse('2026-10-01T00:00:00Z');
const iso=(value:number)=>new Date(value).toISOString();
function fixture(t:any){const db=new SqliteD1();t.after(()=>db.close());let now=initial;const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>.5};const gate=new ProviderCooldown(db,'owner','123',clock);return {db,clock,gate,advance:(ms:number)=>{now+=ms;}};}

test('valid short, zero, long and HTTP-date Retry-After values determine the exact minimum',async t=>{
 for(const [header,delay]of [['2',2000],['0',0],['7200',7200000],[new Date(initial+30000).toUTCString(),30000]]as const){
  const f=fixture(t);let calls=0;const env={CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture=synthetic',userAgent:'Synthetic'}),CELLARTRACKER_SESSION_EXPIRES_AT:iso(initial+86400000)};
  const transport=await new CloudCookieTransport(env,(async()=>{calls++;return new Response('private',{status:429,headers:{'retry-after':header}});})as typeof fetch,f.clock,f.gate).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),failure=>{assert.ok(failure instanceof RetryError);assert.equal(Date.parse(failure.metadata.retry_at),initial+delay);assert.equal(failure.metadata.cooldown_source,'provider_retry_after');assert.equal(failure.metadata.automatic_retry_allowed,false);return true;});
  assert.equal(calls,1);const row=await f.db.prepare('SELECT * FROM provider_cooldowns').first()as any;assert.equal(row.retry_after_until,initial+delay);
 }
});

test('owner can shorten only the exact reviewed legacy fallback; the streak and other cooldowns remain',async t=>{
 const f=fixture(t);await f.gate.rateLimited(undefined);await f.gate.record(initial+7200000,'fallback');
 f.db.sqlite.prepare('UPDATE provider_cooldowns SET retry_after_until=NULL').run(); // legacy metadata
 f.db.sqlite.prepare('UPDATE provider_state SET failures=4').run();
 const before=(await f.gate.status()).last_rate_limit_at;
 const result=await f.gate.shortenFallback(iso(initial),iso(initial+7200000),true);assert.equal(result.adjusted,true);assert.equal(result.retry_at,iso(initial+900000));assert.equal(result.automatic_retry_allowed,false);
 const status=await f.gate.status();assert.equal(status.last_rate_limit_at,before);assert.equal(status.rate_limit_streak,4);assert.equal(status.retry_at,iso(initial+900000));
 const row=await f.db.prepare('SELECT * FROM provider_cooldowns').first()as any;assert.equal(row.retry_after_until,0);
 await assert.rejects(()=>f.gate.shortenFallback(iso(initial),iso(initial+7200000),true),/no longer matches/);
 await assert.rejects(()=>f.gate.assertAvailable(),RetryError);f.advance(900001);await f.gate.assertAvailable();
});

test('provider headers, blocks, unreviewed or changed timestamps cannot be shortened',async t=>{
 for(const mode of ['provider','short_provider','invalid_header','blocked','changed_time','changed_retry','not_reviewed','different_account']as const){
  const f=fixture(t);await f.gate.rateLimited(mode==='provider'?7200000:mode==='short_provider'?2000:undefined,mode==='invalid_header'?true:undefined);
  if(mode!=='provider')await f.gate.record(initial+7200000,'fallback','CELLARTRACKER_RATE_LIMITED',mode==='short_provider'?initial+2000:mode==='invalid_header'?-1:0);
  if(mode==='blocked')await f.gate.block('CELLARTRACKER_BROWSER_CHALLENGE');
  const before=JSON.stringify(await f.db.prepare('SELECT * FROM provider_cooldowns').first());
  await assert.rejects(()=>(mode==='different_account'?new ProviderCooldown(f.db,'owner','999',f.clock):f.gate).shortenFallback(iso(mode==='changed_time'?initial+1:initial),iso(mode==='changed_retry'?initial+7200001:initial+7200000),mode!=='not_reviewed'));
  assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM provider_cooldowns').first()),before);
 }
});

test('concurrent changes fence owner review and never clear a longer provider wait',async t=>{
 const f=fixture(t);await f.gate.rateLimited(undefined);await f.gate.record(initial+7200000,'fallback');
 const prepare=f.db.prepare.bind(f.db);f.db.prepare=(sql:string)=>{
  if(sql.startsWith('UPDATE provider_cooldowns SET retry_at='))f.db.sqlite.prepare("UPDATE provider_cooldowns SET retry_at=?,source='provider_retry_after',retry_after_until=?").run(initial+86400000,initial+86400000);
  return prepare(sql);
 };
 await assert.rejects(()=>f.gate.shortenFallback(iso(initial),iso(initial+7200000),true),/changed concurrently/);
 assert.equal((await f.gate.status()).retry_at,iso(initial+86400000));
});

test('local owner retry-setting action does not require a valid session and never contacts the provider',async t=>{
 const f=fixture(t);await f.gate.rateLimited(undefined);await f.gate.record(initial+7200000,'fallback');let calls=0;
 const env={DB:f.db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:'2000-01-01'};
 const req=(owner:string)=>new Request('https://fixture.invalid/mcp',{headers:{'oai-authenticated-user-id':owner}});
 const input={last_rate_limit_at:iso(initial),retry_at:iso(initial+7200000),reviewed_no_retry_after:true};
 const fetcher=(async()=>{calls++;throw Error('must not fetch');})as typeof fetch;
 await assert.rejects(()=>callTool(req('other'),env,'shorten_app_rate_limit_wait',input,fetcher,f.clock),/does not match/);
 const result:any=await callTool(req('owner'),env,'shorten_app_rate_limit_wait',input,fetcher,f.clock);assert.equal(result.adjusted,true);assert.equal(calls,0);
});
