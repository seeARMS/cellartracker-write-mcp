import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CookieTransport,saveSession,sessionFromHar,buildRequest} from '../src/http.js';
import {runInNewContext} from 'node:vm';
async function file(t:any){const dir=await mkdtemp(join(tmpdir(),'ct-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'session.json');await saveSession(path,{cookie:'ExampleSession=synthetic',userAgent:'Example Browser'});return path;}
test('direct transport fixes origin, disallows redirects, and saves refresh cookies privately',async t=>{
 const path=await file(t);const calls:any[]=[];
 const transport=await new CookieTransport(path,(async(url:any,init:any)=>{calls.push({url,init});return new Response('ok',{headers:{'content-type':'text/plain; charset=utf-8','set-cookie':'ExampleSession=refreshed; Path=/; Secure; HttpOnly'}});}) as typeof fetch).init();
 await transport.request({kind:'inventory',page:1});await transport.request({kind:'relocationForm'});
 assert.equal(calls[0].url,'https://www.cellartracker.com/list.asp?table=Inventory&Page=1');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[1].init.headers.Cookie,'ExampleSession=refreshed');
 const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.cookie,undefined);assert.ok(saved.jar);
});
test('import selects only exact CellarTracker origin and path',()=>{
 const entry=(url:string,value:string)=>({request:{url,headers:[{name:'Cookie',value},{name:'User-Agent',value:'Example'}]}});
 const s=sessionFromHar({log:{entries:[entry('https://www.cellartracker.com/list.asp','good=x'),entry('https://www.cellartracker.com.evil.test/list.asp','bad=y'),entry('https://other.example/list.asp','bad=z')]}});assert.equal(s.cookie,'good=x');
 assert.throws(()=>sessionFromHar({log:{entries:[entry('http://www.cellartracker.com/list.asp','bad=x')]}}),/no authenticated/);
});
test('overbroad file permissions are rejected',async t=>{const path=await file(t);await chmod(path,0o644);await assert.rejects(()=>new CookieTransport(path).init(),/permissions/);});
test('request exceptions do not echo credentials',async t=>{const path=await file(t);const transport=await new CookieTransport(path,(async()=>{throw Error('ExampleSession=synthetic');}) as typeof fetch).init();await assert.rejects(()=>transport.request({kind:'inventory',page:1}),e=>e instanceof Error&&!e.message.includes('synthetic'));});
test('cookie and browser builders produce identical request contracts',async()=>{
 const context:any={};runInNewContext(await readFile(new URL('../extension/protocol.js',import.meta.url),'utf8'),context);
 for(const request of [{kind:'inventory' as const,page:3},{kind:'consumed' as const,page:1},{kind:'consumptionForm' as const},{kind:'consumptionDetails' as const,wineId:'100',consumedId:'9'},{kind:'consume' as const,ids:['1','2'],details:{date:'2026-09-15',type:1,note:'Dinner & wine'},currency:'USD'},{kind:'relocationForm' as const},{kind:'relocate' as const,ids:['1','2'],location:'Cave à vin',bin:'24 & A'},{kind:'relocate' as const,ids:['1'],location:'酒',bin:''}])assert.equal(JSON.stringify(buildRequest(request)),JSON.stringify(context.CellarTrackerProtocol.build(request)));
});
