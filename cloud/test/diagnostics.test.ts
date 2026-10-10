import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionDiagnostics,responseDiagnostics} from '../worker/diagnostics.js';
import {CloudCookieTransport} from '../worker/transport.js';
import {callTool} from '../worker/index.js';
import {RetryError} from '../worker/types.js';
import {ProviderCooldown} from '../worker/provider-gate.js';
import {SqliteD1} from './helpers.js';

const marker='SYNTHETIC_PRIVATE_SENTINEL';
const ua='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const secret=JSON.stringify({cookie:`PWHash=${marker}; User=${marker}; KP_UIDz=${marker}; KP_UIDz=${marker}; ${marker}=private`,userAgent:ua,[marker]:marker});
const env={CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_SESSION_JSON:secret,CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600_000).toISOString()};
const request=(owner:string)=>new Request('https://synthetic.invalid/mcp',{headers:{'oai-authenticated-user-id':owner}});

test('owner-only configuration diagnostics expose recognized UA and known names, never values or unknown names',async()=>{
 let calls=0;const fetcher=(async()=>{calls++;throw Error(marker);})as typeof fetch;
 const result:any=await callTool(request('owner'),env,'connection_status',{},fetcher);
 assert.equal(result.request_headers.configured_user_agent,ua);
 assert.deepEqual(result.request_headers.cookie_names,['KP_UIDz','PWHash','User']);
 assert.equal(result.request_headers.other_cookie_names_redacted,1);
 assert.equal(result.request_headers.capture_time_known,false);
 assert.equal(result.request_headers.session_source,'hosted_secret_snapshot');
 assert.ok(!JSON.stringify(result).includes(marker));assert.equal(calls,0);
 await assert.rejects(()=>callTool(request('other'),env,'connection_status',{},fetcher),/does not match/);
 const unbound:any=await callTool(request('owner'),{...env,CELLARTRACKER_OWNER_USER_ID:undefined},'connection_status',{},fetcher);
 assert.equal(unbound.request_headers,undefined);
});

test('nonstandard UA, unknown keys, invalid and oversized configuration cannot leak free text',()=>{
 for(const value of [marker, 'null', '[]', JSON.stringify({cookie:marker+'=value',userAgent:ua+' '+marker}),JSON.stringify({cookie:'x'.repeat(32769),userAgent:'x'.repeat(513)})]){
  const result=sessionDiagnostics(value);assert.equal(result.configured_user_agent,null);assert.ok(!JSON.stringify(result).includes(marker));
 }
 const bounded=sessionDiagnostics(JSON.stringify({cookie:Array.from({length:200},(_,i)=>`unknown${i}=value`).join('; '),userAgent:marker}));
 assert.deepEqual(bounded.cookie_names,[]);assert.equal(bounded.other_cookie_names_redacted,128);
 assert.equal(bounded.user_agent_class,'redacted_nonstandard');
});

test('response classification uses only explicit bounded categories and presence flags',()=>{
 const result=responseDiagnostics(new Headers({'content-type':'private/'+marker,'x-amzn-waf-action':marker,'cf-ray':marker,'set-cookie':'User='+marker,location:'https://synthetic.invalid/'+marker,'retry-after':marker,server:marker}),undefined);
 assert.deepEqual(result,{content_type:'other',challenge_signal:'none',cloudflare_header_present:true,retry_after_present:true,set_cookie_present:true,location_present:true,body_retained:false});
 assert.ok(!JSON.stringify(result).includes(marker));
 for(const [headers,signal]of [[{'cf-mitigated':'challenge'},'cloudflare_challenge'],[{'x-amzn-waf-action':'challenge'},'aws_waf_challenge'],[{'x-amzn-waf-action':'captcha'},'aws_waf_captcha']]as const){
  assert.equal(responseDiagnostics(new Headers(headers),undefined).challenge_signal,signal);
 }
 assert.equal(responseDiagnostics(new Headers(),undefined).content_type,'absent');
});

test('429 and 5xx diagnostics discard private bodies and raw headers, stop once, and retain Retry-After',async()=>{
 for(const status of [429,503]){
  let now=Date.now(),calls=0,bodyReads=0,cancelled=0;
  const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
  const db=new SqliteD1();const gate=new ProviderCooldown(db,'owner','123',clock);
  try{
   const fetcher=(async()=>{calls++;return {status,url:'',redirected:false,headers:new Headers({'content-type':'text/html; private='+marker,'set-cookie':'User='+marker,location:'https://synthetic.invalid/'+marker,'retry-after':'1800'}),body:{cancel:async()=>{cancelled++;},getReader(){bodyReads++;throw Error(marker);}}};})as typeof fetch;
   const transport=await new CloudCookieTransport(env,fetcher,clock,gate).init();
   await assert.rejects(()=>transport.request({kind:'inventory',page:1}),failure=>{
    assert.ok(failure instanceof RetryError);
    assert.equal(failure.metadata.attempts,1);assert.equal(failure.metadata.automatic_retry_allowed,false);
    assert.ok(failure.metadata.retry_after_seconds>=1800);
    assert.deepEqual(failure.metadata.response_metadata,{content_type:'html',challenge_signal:'none',cloudflare_header_present:false,retry_after_present:true,provider_retry_after_seconds:1800,set_cookie_present:true,location_present:true,body_retained:false});
    assert.ok(!JSON.stringify(failure).includes(marker));return true;
   });
   assert.equal(calls,1);assert.equal(bodyReads,0);assert.ok(cancelled>0);
   // A new Worker sees the durable cooldown, without pretending to have received a new response.
   const restarted=await new CloudCookieTransport(env,fetcher,clock,new ProviderCooldown(db,'owner','123',clock)).init();
   await assert.rejects(()=>restarted.request({kind:'inventory',page:1}),failure=>{
    assert.ok(failure instanceof RetryError);assert.equal(failure.metadata.attempts,0);assert.equal(failure.metadata.response_metadata,undefined);return true;
   });
   assert.equal(calls,1);assert.ok(!JSON.stringify(await gate.status()).includes(marker));
  }finally{db.close();}
 }
});

test('successful refresh cookies apply to the next page only within the invocation',async()=>{
 const seed=JSON.stringify({cookie:'User=synthetic-seed',userAgent:ua});let calls=0;
 const fetcher=(async(_url:unknown,options:RequestInit)=>{
  const cookie=new Headers(options.headers).get('cookie');calls++;
  assert.equal(cookie,calls===2?'User=synthetic-refresh':'User=synthetic-seed');
  return new Response('synthetic',{headers:{'set-cookie':'User=synthetic-refresh; Path=/; Secure; HttpOnly'}});
 })as typeof fetch;
 const config={...env,CELLARTRACKER_SESSION_JSON:seed};
 const first=await new CloudCookieTransport(config,fetcher).init();await first.request({kind:'inventory',page:1});await first.request({kind:'inventory',page:2});
 const second=await new CloudCookieTransport(config,fetcher).init();await second.request({kind:'inventory',page:1});assert.equal(calls,3);
});
