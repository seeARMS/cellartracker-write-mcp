import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {providerScriptChallenge,responseDiagnostics} from '../worker/diagnostics.js';
import {ProviderErrorDetails,redactErrorText} from '../worker/error-details.js';
import {CloudCookieTransport} from '../worker/transport.js';
import {ProviderCooldown} from '../worker/provider-gate.js';
import {SqliteD1} from './helpers.js';

const headers={'content-type':'text/html; charset=utf-8','x-kpsdk-r':'1-AA','x-kpsdk-ct':'SYNTHETIC_CHALLENGE_TOKEN'};
test('observed script challenge stops after one GET, retaining cooldown and a durable review pause',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());let now=Date.now(),calls=0;const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};
 const env={CELLARTRACKER_ACCESS_MODE:'ongoing',CELLARTRACKER_SESSION_JSON:JSON.stringify({cookie:'fixture=synthetic',userAgent:'Synthetic'})};
 const gate=new ProviderCooldown(db,'owner','123',clock),details=new ProviderErrorDetails(db,'owner','123',clock);
 const fetcher=(async()=>{calls++;return new Response('<script>window.KPSDK={}</script><script src="/synthetic/ips.js?x-kpsdk-im=SYNTHETIC_VERIFICATION_TOKEN"></script>',{status:429,headers});})as typeof fetch;
 const transport=await new CloudCookieTransport(env,fetcher,clock,gate,details).init();
 await assert.rejects(()=>transport.request({kind:'inventory',page:1}),/CELLARTRACKER_BROWSER_CHALLENGE/);
 const status=await gate.status();assert.equal(status.blocked_code,'CELLARTRACKER_BROWSER_CHALLENGE');assert.equal(Date.parse(status.retry_at!)-now,900000);assert.equal(calls,1);
 const captured=await details.get();assert.equal(captured.response_metadata.challenge_signal,'provider_script_challenge');assert.ok(!JSON.stringify(captured).includes('SYNTHETIC_CHALLENGE_TOKEN'));assert.ok(!JSON.stringify(captured).includes('SYNTHETIC_VERIFICATION_TOKEN'));
 now+=900001;await assert.rejects(()=>new ProviderCooldown(db,'owner','123',clock).assertAvailable(),/BROWSER_CHALLENGE/);assert.equal(calls,1);
 for(const status of [200,403,503])assert.equal(providerScriptChallenge(new Headers(headers),status),false);
 assert.equal(providerScriptChallenge(new Headers({...headers,'x-kpsdk-r':'other'}),429),false);assert.equal(responseDiagnostics(new Headers(headers),undefined,429).challenge_signal,'provider_script_challenge');
});

test('current redaction also protects legacy retained script-verification tokens',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const now=Date.now(),id=crypto.randomUUID();
 const body={headers:{'x-kpsdk-im':'SYNTHETIC_HEADER_TOKEN','x-kpsdk-r':'1-AA'},body:'<script src="/ips.js?KP_UIDz=[REDACTED]&amp;x-kpsdk-im=SYNTHETIC_QUERY_TOKEN"></script>'};
 db.sqlite.prepare('INSERT INTO provider_error_details(id,owner,account_id,created_at,expires_at,body) VALUES(?,?,?,?,?,?)').run(id,'owner','123',now,now+3600000,JSON.stringify(body));
 const result=await new ProviderErrorDetails(db,'owner','123').get(id);assert.equal(result.headers['x-kpsdk-r'],'1-AA');assert.ok(!JSON.stringify(result).includes('SYNTHETIC_HEADER_TOKEN'));assert.ok(!JSON.stringify(result).includes('SYNTHETIC_QUERY_TOKEN'));
 assert.ok(!redactErrorText('x-kpsdk-ct=UNKNOWN_TOKEN',[]).includes('UNKNOWN_TOKEN'));
});

test('challenge migration only pauses unblocked owners with exact fresh retained evidence',t=>{
 const db=new SqliteD1();t.after(()=>db.close());const now=Date.now();
 const evidence={status:429,headers:{'x-kpsdk-r':'1-AA','x-kpsdk-ct':'[REDACTED]'},body:'window.KPSDK={}; /synthetic/ips.js?x-kpsdk-im=[REDACTED]'};
 db.sqlite.exec("INSERT INTO operations(id,owner,request_key,fingerprint,account_id,body,status,created_at,expires_at,submitted_at) VALUES('submitted','match','request','synthetic','123','{}','submitted',1,2,1); INSERT INTO account_locks(owner,operation_id) VALUES('match','submitted'); INSERT INTO bottle_claims(owner,account_id,bottle_id,operation_id) VALUES('match','123','1','submitted'); INSERT INTO pending_requests(owner,request_key,operation_id,fingerprint,body,created_at) VALUES('match','queued','reservation','synthetic','{}',1); INSERT INTO provider_cooldowns(owner,account_id,retry_at,source) VALUES('match','123',9999999999999,'provider_retry_after');");
 const tables=['operations','account_locks','bottle_claims','pending_requests','provider_cooldowns'];const before=tables.map(table=>JSON.stringify(db.sqlite.prepare('SELECT * FROM '+table).all()));
 for(const [owner,code,body,expires]of [['match',null,evidence,now+3600000],['ordinary',null,{...evidence,headers:{}},now+3600000],['expired',null,evidence,now-1000],['blocked','CELLARTRACKER_ACCESS_DENIED',evidence,now+3600000],['malformed',null,'not-json',now+3600000]]as const){
  db.sqlite.prepare('INSERT INTO provider_state(owner,blocked_code) VALUES(?,?)').run(owner,code);
  db.sqlite.prepare('INSERT INTO provider_error_details(id,owner,account_id,created_at,expires_at,body) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),owner,'123',now,expires,typeof body==='string'?body:JSON.stringify(body));
 }
 const migration=readFileSync('drizzle/0009_mark_script_challenges.sql','utf8');db.sqlite.exec(migration);db.sqlite.exec(migration);
 const state=(owner:string)=>db.sqlite.prepare('SELECT blocked_code FROM provider_state WHERE owner=?').get(owner)!.blocked_code;
 assert.equal(state('match'),'CELLARTRACKER_BROWSER_CHALLENGE');assert.equal(state('ordinary'),null);assert.equal(state('expired'),null);assert.equal(state('blocked'),'CELLARTRACKER_ACCESS_DENIED');assert.equal(state('malformed'),null);
 assert.deepEqual(tables.map(table=>JSON.stringify(db.sqlite.prepare('SELECT * FROM '+table).all())),before);
});
