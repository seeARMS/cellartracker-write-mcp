import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {CloudCookieTransport} from '../worker/transport.js';

const marker='SYNTHETIC_CREDENTIAL_SENTINEL';
const unknownKey='SYNTHETIC_PRIVATE_KEY_SENTINEL';
const cookie='fixture='+marker;
const userAgent='Synthetic '+marker;
const env=(secret:string)=>({CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_READS_ENABLED:'true',CELLARTRACKER_WRITES_ENABLED:'false',CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600_000).toISOString(),CELLARTRACKER_SESSION_JSON:secret});

test('session diagnostics classify setup mistakes without exposing credential data or supplied keys',async()=>{
 const cases:Array<[string,string]>=[
  [marker,'SESSION_INVALID_JSON'],
  ['```json\n'+JSON.stringify({cookie,userAgent})+'\n```','SESSION_INVALID_JSON'],
  ['null','SESSION_WRONG_ROOT_SHAPE'],
  ['42','SESSION_WRONG_ROOT_SHAPE'],
  [JSON.stringify([{cookie,userAgent}]),'SESSION_WRONG_ROOT_SHAPE'],
  [JSON.stringify(JSON.stringify({cookie,userAgent})),'SESSION_WRONG_ROOT_SHAPE'],
  [JSON.stringify({[unknownKey]:marker,userAgent}),'SESSION_COOKIE_MISSING'],
  [JSON.stringify({cookie,useragent:userAgent,[unknownKey]:marker}),'SESSION_USER_AGENT_MISSING'],
  [JSON.stringify({cookie:null,userAgent}),'SESSION_COOKIE_FORMAT'],
  [JSON.stringify({cookie,userAgent:{[unknownKey]:marker}}),'SESSION_USER_AGENT_FORMAT'],
  [JSON.stringify({cookie:'',userAgent}),'SESSION_COOKIE_BLANK'],
  [JSON.stringify({cookie:'   ',userAgent}),'SESSION_COOKIE_BLANK'],
  [JSON.stringify({cookie,userAgent:''}),'SESSION_USER_AGENT_BLANK'],
  [JSON.stringify({cookie,userAgent:'   '}),'SESSION_USER_AGENT_BLANK'],
  [JSON.stringify({cookie:cookie+'\r\nother='+marker,userAgent}),'SESSION_COOKIE_FORBIDDEN_CHARACTERS'],
  [JSON.stringify({cookie:cookie+'\0',userAgent}),'SESSION_COOKIE_FORBIDDEN_CHARACTERS'],
  [JSON.stringify({cookie,userAgent:userAgent+'\n'+marker}),'SESSION_USER_AGENT_FORBIDDEN_CHARACTERS'],
  [JSON.stringify({cookie,userAgent:userAgent+'\0'}),'SESSION_USER_AGENT_FORBIDDEN_CHARACTERS'],
  [JSON.stringify({cookie:marker,userAgent}),'SESSION_COOKIE_FORMAT'],
  [JSON.stringify({cookie:cookie+';',userAgent}),'SESSION_COOKIE_FORMAT'],
  [JSON.stringify({cookie:'x'.repeat(32769),userAgent}),'SESSION_COOKIE_FORMAT'],
  [JSON.stringify({cookie,userAgent:'x'.repeat(513)}),'SESSION_USER_AGENT_FORMAT']
 ];
 let networkCalls=0;
 const fetcher=(async()=>{networkCalls++;throw Error(marker);})as typeof fetch;
 for(const [secret,code]of cases){
  await assert.rejects(()=>new CloudCookieTransport(env(secret),fetcher).init(),(error:unknown)=>{
   assert.ok(error instanceof Error);assert.ok(error.message.startsWith('['+code+']'));
   assert.ok(!error.message.includes(marker));assert.ok(!error.message.includes(unknownKey));
   assert.ok(!/32769|513/.test(error.message));return true;
  });
 }
 assert.equal(networkCalls,0);
});

test('MCP serialization keeps setup diagnostics fixed and behind the owner boundary',async()=>{
 const secret=JSON.stringify({cookie,useragent:userAgent,[unknownKey]:marker});
 const request=(owner:string)=>new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'verify_connection',arguments:{}}})});
 const response=await worker.fetch(request('owner'),env(secret));const body=await response.text();
 assert.equal(response.status,200);assert.ok(body.includes('[SESSION_USER_AGENT_MISSING]'));
 assert.ok(!body.includes(marker));assert.ok(!body.includes(unknownKey));
 const rejected=await worker.fetch(request('other-owner'),env(secret));
 assert.equal(rejected.status,403);assert.ok(!(await rejected.text()).includes('SESSION_USER_AGENT_MISSING'));
});

test('valid session shape remains supported and setup diagnostics do not bypass the approved cutoff',async()=>{
 const secret=JSON.stringify({cookie,userAgent});
 await new CloudCookieTransport(env(secret)).init();
 await assert.rejects(()=>new CloudCookieTransport({...env(secret),CELLARTRACKER_SESSION_EXPIRES_AT:'2000-01-01T00:00:00.000Z'}).init(),/expiry has passed/);
});
