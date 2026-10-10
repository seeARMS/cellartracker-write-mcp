import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProviderErrorDetails,errorDetailsPolicy,redactErrorText} from '../worker/error-details.js';
import {CloudCookieTransport} from '../worker/transport.js';
import {ProviderCooldown} from '../worker/provider-gate.js';
import {ProviderResponseError,RetryError} from '../worker/types.js';
import {callTool} from '../worker/index.js';
import {CloudStore} from '../worker/store.js';
import {SqliteD1,bottle,inventoryHtml} from './helpers.js';

const request=(owner='owner')=>new Request('https://synthetic.invalid/mcp',{headers:{'oai-authenticated-user-id':owner}});
const original='synthetic-original-cookie-value',rotated='synthetic-rotated-cookie-value';
function fixture(t:any){
 const db=new SqliteD1();t.after(()=>db.close());let now=Date.now();const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
 const env={DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_WRITES_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(now+3600000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:`PWHash=${original}`,userAgent:'Synthetic Test Agent'})};
 const details=new ProviderErrorDetails(db,'owner','123',clock),gate=new ProviderCooldown(db,'owner','123',clock);
 return {db,clock,env,details,gate,advance:(ms:number)=>{now+=ms;}};
}
test('429 retains actual noncredential headers and useful body, redacts original/rotated secrets, never retries',async t=>{
 const f=fixture(t);let calls=0;
 const fetcher=(async()=>{calls++;return new Response(`Rule: request-rate; request-id: abc-123; original=${original}; refresh=${rotated}; {"access_token":"different-secret"}`,{status:429,headers:{'content-type':'text/html; charset=utf-8',server:'Provider Edge','cf-ray':'abc-123-LAX','retry-after':'123','set-cookie':`PWHash=${rotated}; Path=/; Secure`,location:`/login?token=different-secret&reason=limited`,'x-provider-rule':'request-rate'}});})as typeof fetch;
 const transport=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate,f.details).init();let id='';
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>{assert.ok(e instanceof RetryError);assert.equal(e.metadata.attempts,1);assert.equal(e.metadata.automatic_retry_allowed,false);assert.equal(e.metadata.response_metadata?.body_retained,true);id=e.metadata.response_metadata!.error_details_id!;return true;});
 const detail=await f.details.get(id);assert.equal(detail.headers.server,'Provider Edge');assert.equal(detail.headers['cf-ray'],'abc-123-LAX');assert.equal(detail.headers['retry-after'],'123');assert.equal(detail.headers['x-provider-rule'],'request-rate');assert.equal(detail.headers['set-cookie'],'[REDACTED]');assert.ok(detail.body.includes('Rule: request-rate'));assert.ok(detail.body.includes('request-id: abc-123'));
 const serialized=JSON.stringify(detail);for(const secret of [original,rotated,'different-secret'])assert.ok(!serialized.includes(secret));
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>e instanceof RetryError&&e.metadata.attempts===0);assert.equal(calls,1);
});
test('redaction keeps diagnostic IDs, ordinary prose, wine labels and UA while removing credential fields and encodings',()=>{
 const secret='fixture-secret/a?b=c';const text=`Request abc-123; Neely 2018; Chrome/154; ${secret}; ${encodeURIComponent(secret)}; {"password":"unknown-password","session_id":123456,"message":"Too many requests"} <input value="unknown-csrf" name="csrf_token"> Bearer unknown-bearer`;
 const out=redactErrorText(text,[secret]);for(const v of [secret,encodeURIComponent(secret),'unknown-password','123456','unknown-csrf','unknown-bearer'])assert.ok(!out.includes(v));for(const v of ['abc-123','Neely 2018','Chrome/154','Too many requests'])assert.ok(out.includes(v));
 assert.ok(!redactErrorText('token=unknown-token',[]).includes('unknown-token'));
 assert.ok(!redactErrorText('prefix '+secret.slice(0,-3),[secret]).includes(secret.slice(0,-3)));
 assert.ok(!redactErrorText('{"access_token":"truncated-credential',[]).includes('truncated-credential'));
 assert.equal(redactErrorText('{"token_status":"expired","token_type":"browser","password_error":"required"} Bearer realm="CellarTracker"',[]),'{"token_status":"expired","token_type":"browser","password_error":"required"} Bearer realm="CellarTracker"');
});
test('body/header capture is bounded and marks truncation without retaining partial echoed credentials',async t=>{
 const f=fixture(t),prefix='x'.repeat(errorDetailsPolicy.bodyBytes-8),secret='fixture-long-secret-value';
 const id=await f.details.capture(new Response(prefix+secret,{status:503,headers:{'x-large':'z'.repeat(errorDetailsPolicy.headerBytes+1),'x-request-id':'keep-me'}}),{kind:'consumed',page:2},[secret],new AbortController().signal);
 const detail=await f.details.get(id);assert.equal(detail.body_truncated,true);assert.equal(detail.headers_truncated,true);assert.equal(detail.headers['x-request-id'],'keep-me');assert.equal(detail.headers['x-large'],undefined);assert.ok(new TextEncoder().encode(detail.body).length<=errorDetailsPolicy.bodyBytes);assert.ok(!detail.body.includes(secret.slice(0,8)));
});
test('capture stops at the fetch abort deadline and stores a read-failure diagnostic',async t=>{
 const f=fixture(t);const controller=new AbortController();const stream=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});}});
 const pending=f.details.capture(new Response(stream,{status:503}),{kind:'inventory',page:1},[],controller.signal);controller.abort();
 const id=await pending;assert.equal((await f.details.get(id)).body_read_failed,true);
});
test('retained errors expire after one hour, are capped at ten, and are owner/account scoped across restarts',async t=>{
 const f=fixture(t);let first='';for(let i=0;i<12;i++){f.advance(1);const id=await f.details.capture(new Response('error '+i,{status:429}),{kind:'inventory',page:1},[],new AbortController().signal);first||=id;}
 assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM provider_error_details').get()!.n,10);await assert.rejects(()=>f.details.get(first),/No retained/);
 assert.equal((await new ProviderErrorDetails(f.db,'owner','123',f.clock).get()).body,'error 11');
 await assert.rejects(()=>new ProviderErrorDetails(f.db,'other','123',f.clock).get(),/No retained/);await assert.rejects(()=>new ProviderErrorDetails(f.db,'owner','999',f.clock).get(),/No retained/);
 f.advance(3600000);await assert.rejects(()=>f.details.get(),/No retained/);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM provider_error_details').get()!.n,0);
});
test('local diagnostic tool works after expiry but rejects another owner/disabled access and never fetches',async t=>{
 const f=fixture(t);const id=await f.details.capture(new Response('ordinary provider error',{status:429}),{kind:'inventory',page:1},[],new AbortController().signal);
 const expired={...f.env,CELLARTRACKER_SESSION_EXPIRES_AT:new Date(f.clock.now()-1).toISOString()};let calls=0;const fetcher=(async()=>{calls++;throw Error('not permitted');})as typeof fetch;
 const result=await callTool(request(),expired,'get_provider_error_details',{error_id:id},fetcher,f.clock);assert.equal(result.error_id,id);
 await assert.rejects(()=>callTool(request('other'),expired,'get_provider_error_details',{},fetcher,f.clock),/does not match/);
 await assert.rejects(()=>callTool(request(),{...expired,CELLARTRACKER_READS_ENABLED:'false'},'get_provider_error_details',{},fetcher,f.clock),/disabled/);assert.equal(calls,0);
});
for(const [status,headers,code]of [[403,{},'ACCESS_DENIED'],[401,{},'AUTHENTICATION_REQUIRED'],[429,{'x-amzn-waf-action':'challenge'},'BROWSER_CHALLENGE'],[200,{'x-amzn-waf-action':'captcha'},'BROWSER_CHALLENGE']]as const){
 test(`${status} ${code} retains useful error details and preserves an access block without retry`,async t=>{
  const f=fixture(t);let calls=0;const fetcher=(async()=>{calls++;return new Response('provider explains '+code,{status,headers});})as typeof fetch;
  const transport=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate,f.details).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>e instanceof ProviderResponseError&&e.message.includes(code)&&!!e.errorDetailsId);
  assert.equal((await f.details.get()).body,'provider explains '+code);assert.equal((await f.gate.status()).blocked_code,'CELLARTRACKER_'+code);await assert.rejects(()=>transport.request({kind:'inventory',page:1}),/owner review/);assert.equal(calls,1);
 });
}
test('successful inventory responses do not populate error storage',async t=>{
 const f=fixture(t);const fetcher=(async()=>new Response(inventoryHtml([bottle('1')]),{headers:{'set-cookie':`PWHash=${rotated}; Path=/; Secure`}}))as typeof fetch;
 await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate,f.details).init().then(transport=>transport.request({kind:'inventory',page:1}));
 assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM provider_error_details').get()!.n,0);
});
test('error capture redacts superseded configured and within-call rotated credentials',async t=>{
 const f=fixture(t),older='synthetic-superseded-value';let calls=0;
 const env={...f.env,CELLARTRACKER_COOKIE:`PWHash=${original}`,CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:`PWHash=${older}`,userAgent:'Synthetic Test Agent'})};
 const fetcher=(async()=>{calls++;return calls===1?new Response(inventoryHtml([bottle('1')]),{headers:{'set-cookie':`PWHash=${rotated}; Path=/; Secure`}}):new Response(`Values ${older} ${original} ${rotated}; rule=request-rate`,{status:429});})as typeof fetch;
 const transport=await new CloudCookieTransport(env,fetcher,f.clock,f.gate,f.details).init();await transport.request({kind:'inventory',page:1});await assert.rejects(()=>transport.request({kind:'inventory',page:2}),RetryError);
 const detail=await f.details.get();for(const value of [older,original,rotated])assert.ok(!JSON.stringify(detail).includes(value));assert.ok(detail.body.includes('rule=request-rate'));assert.equal(calls,2);
});
test('diagnostic storage failure cannot erase a 429 or permit another provider attempt',async t=>{
 const f=fixture(t),prepare=f.db.prepare.bind(f.db);let calls=0;
 f.db.prepare=(sql:string)=>sql.startsWith('INSERT INTO provider_error_details')?{bind(){return this;},first:async()=>null,run:async()=>{throw Error('synthetic storage failure');}}:prepare(sql);
 const fetcher=(async()=>{calls++;return new Response('useful provider error',{status:429});})as typeof fetch;
 const transport=await new CloudCookieTransport(f.env,fetcher,f.clock,f.gate,f.details).init();
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>e instanceof RetryError&&e.metadata.response_metadata?.error_details_unavailable===true);
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>e instanceof RetryError&&e.metadata.attempts===0);assert.equal(calls,1);assert.equal((await f.gate.status()).rate_limit_streak,1);
});
test('completed status returns the saved verdict without expired credentials or provider traffic',async t=>{
 const f=fixture(t),store=new CloudStore(f.db,'owner',f.clock),id=crypto.randomUUID();
 await store.create({id,owner:'owner',requestKey:crypto.randomUUID(),fingerprint:'synthetic',accountId:'123',bottles:[bottle('1')],details:{date:'2026-10-07',type:1,note:''},status:'planned',createdAt:f.clock.now(),expiresAt:f.clock.now()+900000});
 const token=await store.begin(id);await store.submit(id,token);await store.outcome(id,'complete',{consumedIds:['1'],remainingIds:[],conflictIds:[]});await store.unlock(id);
 let calls=0;const fetcher=(async()=>{calls++;throw Error('not permitted');})as typeof fetch;const env={...f.env,CELLARTRACKER_SESSION_EXPIRES_AT:new Date(f.clock.now()-1).toISOString(),CELLARTRACKER_SESSION_JSON:undefined};
 const result:any=await callTool(request(),env,'get_consumption_status',{operation_id:id},fetcher,f.clock);assert.equal(result.status,'complete');assert.equal(result.current_inventory_checked,false);assert.equal(result.verification_source,'saved_complete_operation');assert.deepEqual(result.verification.consumedIds,['1']);assert.equal(calls,0);
});
