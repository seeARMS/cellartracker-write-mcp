import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeStep} from '../worker/runtime-diagnostics.js';
import {SafeError,RetryError} from '../worker/types.js';
import {retryFailure} from '../worker/backoff.js';
import {callTool} from '../worker/index.js';
import {SqliteD1} from './helpers.js';

test('unexpected local failures reveal only a fixed step and category',async()=>{
 const secret='SYNTHETIC_SECRET_AND_PRIVATE_SQL';
 for(const [error,kind]of [[new SyntaxError(secret),'SYNTAX'],[new RangeError(secret),'RANGE'],[new TypeError(secret),'TYPE'],[new Error('D1_ERROR '+secret),'DATABASE'],[new Error(secret),'UNKNOWN']]as const){
  await assert.rejects(()=>runtimeStep('pending_lookup',async()=>{throw error;}),e=>{
   assert.ok(e instanceof SafeError);assert.match(e.message,new RegExp('CELLARTRACKER_RUNTIME_PENDING_LOOKUP_'+kind));assert.ok(!e.message.includes(secret));return true;
  });
 }
 const safe=new SafeError('review required');await assert.rejects(()=>runtimeStep('operation_status',async()=>{throw safe;}),e=>e===safe);
 const retry=retryFailure('CELLARTRACKER_RATE_LIMITED',429,1,Date.now()+60000,Date.now());await assert.rejects(()=>runtimeStep('reconciliation',async()=>{throw retry;}),e=>e===retry&&e instanceof RetryError);
});

test('database failures disclose fixed categories without private error text',async()=>{
 for(const [text,kind]of [['too many API requests by single Worker invocation','REQUEST_LIMIT'],['too many SQL variables','PARAMETER_LIMIT'],['string or blob too big: SQLITE_TOOBIG','SIZE_LIMIT'],['no such column: SYNTHETIC_PRIVATE_NAME','SCHEMA'],['bind parameter type is not supported','BINDING'],['near SYNTHETIC_PRIVATE_SQL: syntax error','SYNTAX'],['SQLITE_CONSTRAINT: SYNTHETIC_PRIVATE_NAME','CONSTRAINT'],['database is overloaded','AVAILABILITY'],['not authorized','ACCESS']]as const){
  await assert.rejects(()=>runtimeStep('reconciliation_checkpoint_save',async()=>{throw new Error('D1_ERROR: '+text);}),e=>e instanceof SafeError&&e.message.includes('DATABASE_'+kind)&&!e.message.includes('SYNTHETIC_PRIVATE'));
 }
 await assert.rejects(()=>runtimeStep('reconciliation_checkpoint_read',async()=>{throw new Error('D1_ERROR',{cause:new Error('no such table: SYNTHETIC_PRIVATE')});}),e=>e instanceof SafeError&&e.message.includes('DATABASE_SCHEMA')&&!e.message.includes('SYNTHETIC_PRIVATE'));
});

test('legacy submitted rows and queued intents stay read-only with their original IDs',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());let calls=0;const never=(async()=>{calls++;throw Error('must not fetch');})as typeof fetch;
 const op={id:crypto.randomUUID(),owner:'owner',requestKey:crypto.randomUUID(),fingerprint:'synthetic',accountId:'123',bottles:[{id:'1',wineId:'100',wine:'Synthetic Pinot',size:'750ml',location:'Home',bin:''}],details:{date:'2026-10-07',type:1,note:''},status:'planned',createdAt:1791430683628,expiresAt:1791431583628};
 db.sqlite.prepare('INSERT INTO operations(id,owner,request_key,fingerprint,account_id,body,status,created_at,expires_at,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(op.id,op.owner,op.requestKey,op.fingerprint,op.accountId,JSON.stringify(op),'submitted',op.createdAt,op.expiresAt,1791430767578);
 db.sqlite.prepare('INSERT INTO account_locks(owner,operation_id) VALUES(?,?)').run(op.owner,op.id);
 const env={DB:db,CELLARTRACKER_OWNER_USER_ID:'owner',CELLARTRACKER_EXPECTED_ACCOUNT_ID:'123',CELLARTRACKER_READS_ENABLED:'true'};
 const request=new Request('https://synthetic.invalid/mcp',{headers:{'oai-authenticated-user-id':'owner'}});
 const result:any=await callTool(request,env,'get_consumption_request',{request_id:op.requestKey},never);assert.equal(result.operation.status,'submitted');assert.equal(result.operation.dry_run,false);
 const intent={request_id:crypto.randomUUID(),wine:'Synthetic Cuvée NV13',quantity:1,date:'2026-11-03'};
 const queued:any=await callTool(request,env,'queue_consumption_request',intent,never);
 const saved:any=await callTool(request,env,'get_consumption_request',{request_id:intent.request_id},never);assert.equal(saved.operation_id,queued.operation_id);assert.equal(saved.pending.phase,'lookup');assert.equal(saved.attempts,0);assert.equal(calls,0);
 assert.equal(db.sqlite.prepare('SELECT status FROM operations WHERE id=?').get(op.id)!.status,'submitted');assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);
});
