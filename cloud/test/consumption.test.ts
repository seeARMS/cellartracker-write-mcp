import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudConsumption} from '../worker/consumption.js';
import {CloudStore} from '../worker/store.js';
import {FakeCellar,SqliteD1,bottle} from './helpers.js';
const request=()=>({request_id:crypto.randomUUID(),wine_id:'100',quantity:1,date:'2026-09-30',note:'Synthetic dinner'});
function setup(t:any,cellar=new FakeCellar()){
 const db=new SqliteD1();t.after(()=>db.close());const store=new CloudStore(db,'owner');return {db,store,cellar,service:new CloudConsumption(cellar,store,'123')};
}
test('stable request and operation IDs survive restart without another POST',async t=>{
 const {cellar,store,service}=setup(t);const input=request();const a=await service.plan(input),b=await service.plan(input);assert.equal(a.operation_id,b.operation_id);assert.equal(cellar.writes,0);
 assert.equal((await service.execute(a.operation_id)).status,'complete');
 const restarted=new CloudConsumption(cellar,store,'123');assert.equal((await restarted.execute(a.operation_id)).status,'complete');assert.equal((await restarted.plan(input)).operation_id,a.operation_id);assert.equal(cellar.writes,1);
 await assert.rejects(()=>service.plan({...input,note:'Different'}),/request ID/);
});
test('ambiguous source groups, invalid dates, and duplicate bottle IDs fail the dry run',async t=>{
 const {service,cellar}=setup(t,new FakeCellar([bottle('1'),bottle('2','24')]));
 await assert.rejects(()=>service.plan(request()),/multiple locations/);
 await assert.rejects(()=>service.plan({...request(),date:'2026-02-30'}),/valid absolute date/);
 await assert.rejects(()=>service.plan({...request(),wine_id:undefined,quantity:undefined,bottle_ids:['1','01']}),/Duplicate bottle IDs/);assert.equal(cellar.writes,0);
});
test('two plans cannot reserve the same bottle; a failed transaction leaves no orphan plan',async t=>{
 const {service,db}=setup(t);await service.plan(request());await assert.rejects(()=>service.plan(request()),/already reserved/);
 assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM operations').get()!.n,1);
});
test('concurrent duplicate plans produce one operation',async t=>{
 const {service,db}=setup(t);const r=request();const plans=await Promise.all([service.plan(r),service.plan(r)]);
 assert.equal(plans[0].operation_id,plans[1].operation_id);assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM operations').get()!.n,1);
});
test('concurrent execution across instances never submits twice',async t=>{
 const {service,cellar,store}=setup(t);const p=await service.plan(request());const other=new CloudConsumption(cellar,store,'123');
 await Promise.allSettled([service.execute(p.operation_id),other.execute(p.operation_id)]);assert.equal(cellar.writes,1);
});
test('lost POST response is resolved by exact inventory and history read-back',async t=>{
 const {service,cellar}=setup(t);cellar.loseResponse=true;const p=await service.plan(request());assert.equal((await service.execute(p.operation_id)).status,'complete');assert.equal(cellar.writes,1);
});
test('unverified POST remains locked and never retries, including after restart',async t=>{
 const {service,cellar,store}=setup(t);const a=await service.plan({...request(),wine_id:undefined,quantity:undefined,bottle_ids:['1']}),b=await service.plan({...request(),wine_id:undefined,quantity:undefined,bottle_ids:['2']});
 cellar.failReadAfterWrite=true;assert.equal((await service.execute(a.operation_id)).status,'unknown');
 assert.equal((await new CloudConsumption(cellar,store,'123').execute(a.operation_id)).status,'unknown');
 await assert.rejects(()=>service.execute(b.operation_id),/running or unresolved/);await assert.rejects(()=>service.cancel(a.operation_id),/cannot be canceled/);assert.equal(cellar.writes,1);
 cellar.failReadAfterWrite=false;assert.equal((await service.status(a.operation_id)).status,'complete');assert.equal((await service.execute(b.operation_id)).status,'complete');assert.equal(cellar.writes,2);
});
for(const field of ['omitHistory','wrongNote']as const)test(`absence alone or mismatched history never establishes success: ${field}`,async t=>{
 const {service,cellar}=setup(t);cellar[field]=true;const p=await service.plan(request());assert.equal((await service.execute(p.operation_id)).status,'unknown');assert.equal(cellar.writes,1);
});
test('account and wine identity changes prevent submission',async t=>{
 const {service,cellar}=setup(t);const p=await service.plan(request());cellar.bottles[0].wineId='999';assert.equal((await service.execute(p.operation_id)).status,'conflict');assert.equal(cellar.writes,0);
 cellar.accountId='999';await assert.rejects(()=>service.plan(request()),/account differs/);
});
test('expiry frees only unsubmitted reservations and the old operation cannot execute',async t=>{
 const {service,db,cellar}=setup(t);const p=await service.plan(request());
 const old=JSON.parse(db.sqlite.prepare('SELECT body FROM operations WHERE id=?').get(p.operation_id)!.body as string);old.expiresAt=0;db.sqlite.prepare('UPDATE operations SET expires_at=0,body=? WHERE id=?').run(JSON.stringify(old),p.operation_id);
 await assert.rejects(()=>service.execute(p.operation_id),/expired/);const fresh=await service.plan(request());assert.notEqual(p.operation_id,fresh.operation_id);assert.equal(cellar.writes,0);
});
test('cancellation during preflight blocks a late submission',async t=>{
 const {service,cellar}=setup(t);const p=await service.plan(request());let entered!:()=>void,resume!:()=>void;const started=new Promise<void>(r=>entered=r),paused=new Promise<void>(r=>resume=r);
 cellar.pauseInventory=async()=>{entered();await paused;};const executing=service.execute(p.operation_id);await started;
 assert.equal((await service.cancel(p.operation_id)).status,'canceled');resume();assert.equal((await executing).status,'canceled');assert.equal(cellar.writes,0);
});
