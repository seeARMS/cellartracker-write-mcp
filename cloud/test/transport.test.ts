import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudCookieTransport} from '../worker/transport.js';
const marker='SYNTHETIC_CREDENTIAL_SENTINEL';
const config=()=>({CELLARTRACKER_SESSION_EXPIRES_AT:new Date(Date.now()+3600_000).toISOString(),CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture='+marker,userAgent:'Synthetic Agent'})});
const clock=()=>{let now=Date.now();return {now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};};

test('transport uses manual redirects on the fixed HTTPS inventory endpoint',async()=>{
 let calls=0;
 const fetcher=(async(url:string,options:RequestInit)=>{
  calls++;assert.equal(url,'https://www.cellartracker.com/list.asp?table=Inventory&Page=1');
  if(options.redirect==='error')throw Error('Unsupported redirect mode');
  assert.equal(options.redirect,'manual');assert.equal(options.method,'GET');
  return new Response('synthetic inventory',{status:200});
 })as typeof fetch;
 const transport=await new CloudCookieTransport(config(),fetcher).init();
 const response=await transport.request({kind:'inventory',page:1});
 assert.equal(response.status,200);assert.equal(response.text,'synthetic inventory');assert.equal(calls,1);
});

test('redirects and changed endpoints never forward credentials or read response bodies',async()=>{
 for(const response of [
  {status:302,url:'',redirected:false},
  {status:200,url:'https://synthetic.invalid/'+marker,redirected:false},
  {status:200,url:'',redirected:true}
 ]){
  let calls=0,bodyReads=0;
  const fetcher=(async()=>{calls++;return {...response,headers:new Headers({location:'https://synthetic.invalid/'+marker,'set-cookie':'private='+marker}),body:{getReader(){bodyReads++;throw Error(marker);}}};})as typeof fetch;
  const transport=await new CloudCookieTransport(config(),fetcher).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),error=>{
   const text=String(error);assert.match(text,/CELLARTRACKER_(UNEXPECTED_REDIRECT|ENDPOINT_CHANGED)/);
   assert.ok(!text.includes(marker));assert.ok(!text.includes('https://'));return true;
  });
  assert.equal(calls,1);assert.equal(bodyReads,0);
 }
});

test('HTTP rejection and challenge diagnostics disclose fixed categories only',async()=>{
 const cases:Array<[number,Record<string,string>,string]>=[
  [401,{},'CELLARTRACKER_AUTHENTICATION_REQUIRED'],[403,{},'CELLARTRACKER_ACCESS_DENIED'],
  [429,{},'CELLARTRACKER_RATE_LIMITED'],[503,{},'CELLARTRACKER_SERVICE_ERROR'],[404,{},'CELLARTRACKER_HTTP_ERROR'],
  [403,{'cf-mitigated':'challenge'},'CELLARTRACKER_BROWSER_CHALLENGE'],
  [200,{'cf-mitigated':'challenge'},'CELLARTRACKER_BROWSER_CHALLENGE']
 ];
 for(const [status,headers,code]of cases){
  const transport=await new CloudCookieTransport(config(),(async()=>new Response(marker,{status,headers:{...headers,'set-cookie':'private='+marker}}))as typeof fetch,clock()).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),error=>{
   const text=String(error);assert.ok(text.includes('['+code+']'));assert.ok(!text.includes(marker));assert.ok(!text.includes('cf-mitigated'));return true;
  });
 }
});

test('only a fixed-origin sign-in redirect gets an authentication category without revealing its URL',async()=>{
 for(const [location,code]of [['https://www.cellartracker.com/login.asp?private='+marker,'CELLARTRACKER_AUTHENTICATION_REQUIRED'],['https://synthetic.invalid/login.asp?private='+marker,'CELLARTRACKER_UNEXPECTED_REDIRECT']]as const){
  let calls=0;
  const transport=await new CloudCookieTransport(config(),(async()=>{calls++;return new Response(marker,{status:302,headers:{location}});})as typeof fetch).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),error=>{const text=String(error);assert.ok(text.includes('['+code+']'));assert.ok(!text.includes(marker));assert.ok(!text.includes('https://'));return true;});
  assert.equal(calls,1);
 }
});

test('network and timeout diagnostics never expose native exception messages',async()=>{
 for(const [error,code]of [[new Error('https://synthetic.invalid/'+marker),'CELLARTRACKER_FETCH_FAILED'],[new DOMException(marker,'TimeoutError'),'CELLARTRACKER_REQUEST_TIMEOUT']]as const){
  const transport=await new CloudCookieTransport(config(),(async()=>{throw error;})as typeof fetch,clock()).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),failure=>{
   const text=String(failure);assert.ok(text.includes('['+code+']'));assert.ok(!text.includes(marker));assert.ok(!text.includes('https://'));return true;
  });
 }
});

test('native fetch retains its global receiver and works without the timeout convenience API',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout')!;
 Object.defineProperty(AbortSignal,'timeout',{...descriptor,value:undefined});
 try{
  const fetcher=(async function(this:unknown,_url:unknown,options:RequestInit){
   if(this!==globalThis)throw TypeError('Illegal invocation');
   assert.ok(options.signal instanceof AbortSignal);return new Response('synthetic inventory',{status:200});
  })as typeof fetch;
  const transport=await new CloudCookieTransport(config(),fetcher).init();
  assert.equal((await transport.request({kind:'inventory',page:1})).status,200);
 }finally{Object.defineProperty(AbortSignal,'timeout',descriptor);}
});

test('recognized native integration failures disclose only fixed diagnostic categories',async()=>{
 for(const [message,code]of [['Illegal invocation: '+marker,'CELLARTRACKER_RUNTIME_INVOCATION'],['Cannot convert to ByteString: '+marker,'CELLARTRACKER_HEADER_FORMAT'],['Unsupported redirect mode: '+marker,'CELLARTRACKER_RUNTIME_REDIRECT'],['Cannot perform I/O: '+marker,'CELLARTRACKER_RUNTIME_CONTEXT']]as const){
  const transport=await new CloudCookieTransport(config(),(async()=>{throw TypeError(message);})as typeof fetch).init();
  await assert.rejects(()=>transport.request({kind:'inventory',page:1}),error=>{const text=String(error);assert.ok(text.includes('['+code+']'));assert.ok(!text.includes(marker));return true;});
 }
});
