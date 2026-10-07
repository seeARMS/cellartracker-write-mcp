import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudCookieTransport} from '../worker/transport.js';
import {callTool} from '../worker/index.js';
import worker from '../worker/index.js';

const marker='SYNTHETIC_RAW_COOKIE_PRIVATE';
const userAgent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const base={CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'PWHash=synthetic-legacy',userAgent})};
const request=()=>new Request('https://synthetic.invalid/mcp',{headers:{'oai-authenticated-user-id':'owner'}});

test('raw-cookie secret wins without merging the older cookie, and reuses stored UA',async()=>{
 for(const session of [base.CELLARTRACKER_SESSION_JSON,JSON.stringify({userAgent}),JSON.stringify({cookie:null,userAgent})]){
  let calls=0;
  const transport=await new CloudCookieTransport({...base,CELLARTRACKER_SESSION_JSON:session,CELLARTRACKER_COOKIE:'User='+marker},(async(_url:unknown,options:RequestInit)=>{
   calls++;const headers=new Headers(options.headers);assert.equal(headers.get('cookie'),'User='+marker);assert.equal(headers.get('user-agent'),userAgent);return new Response('synthetic');
  })as typeof fetch).init();
  await transport.request({kind:'inventory',page:1});assert.equal(calls,1);
 }
});

test('absent raw-cookie setting preserves legacy behavior',async()=>{
 const transport=await new CloudCookieTransport(base,(async(_url:unknown,options:RequestInit)=>{
  assert.equal(new Headers(options.headers).get('cookie'),'PWHash=synthetic-legacy');assert.equal(new Headers(options.headers).get('user-agent'),userAgent);return new Response('synthetic');
 })as typeof fetch).init();await transport.request({kind:'inventory',page:1});
});

test('empty or malformed explicit raw-cookie settings fail closed with no fallback and no network',async()=>{
 let calls=0;const fetcher=(async()=>{calls++;throw Error(marker);})as typeof fetch;
 for(const cookie of ['', '   ',marker,'Cookie: User='+marker,'"User='+marker+'"',JSON.stringify({cookie:'User='+marker}),'User='+marker+'\n','User='+marker+'\0','User='+marker+';', 'User='+marker+'; Secure','User='+marker+'; Path=/','User='+marker+'; SameSite=None','User='+'x'.repeat(32769),null as any]){
  await assert.rejects(()=>new CloudCookieTransport({...base,CELLARTRACKER_COOKIE:cookie},fetcher).init(),failure=>{
   assert.match(String(failure),/SESSION_RAW_COOKIE_INVALID/);assert.ok(!String(failure).includes(marker));return true;
  });
 }
 assert.equal(calls,0);
});

test('raw cookie cannot replace missing UA configuration or extend the approved cutoff',async()=>{
 const env={...base,CELLARTRACKER_COOKIE:'User='+marker};
 await assert.rejects(()=>new CloudCookieTransport({...env,CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'User=old'})}).init(),/SESSION_USER_AGENT_MISSING/);
 await assert.rejects(()=>new CloudCookieTransport({...env,CELLARTRACKER_SESSION_JSON:marker}).init(),/SESSION_INVALID_JSON/);
 await assert.rejects(()=>new CloudCookieTransport({...env,CELLARTRACKER_SESSION_EXPIRES_AT:'2000-01-01'}).init(),/expiry has passed/);
});

test('owner status shows only active cookie names/source; MCP errors never serialize either secret',async()=>{
 const env={...base,CELLARTRACKER_COOKIE:'User='+marker+'; '+marker+'=private'};
 const status:any=await callTool(request(),env,'connection_status',{},(async()=>{throw Error('no network');})as typeof fetch);
 assert.equal(status.request_headers.cookie_source,'raw_cookie_secret');assert.deepEqual(status.request_headers.cookie_names,['User']);
 assert.equal(status.request_headers.configured_user_agent,userAgent);assert.ok(!JSON.stringify(status).includes(marker));assert.ok(!JSON.stringify(status).includes('synthetic-legacy'));
 const rpc=new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'verify_connection',arguments:{}}})});
 const body=await (await worker.fetch(rpc,{...env,CELLARTRACKER_COOKIE:'Cookie: User='+marker})).text();
 assert.ok(body.includes('SESSION_RAW_COOKIE_INVALID'));assert.ok(!body.includes(marker));assert.ok(!body.includes('synthetic-legacy'));
});
