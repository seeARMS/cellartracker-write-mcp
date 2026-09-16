import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MoveStore } from '../src/store.js';
import { MoveService } from '../src/moves.js';
import { bottle, FakeCellar } from './helpers.js';
async function setup(t:any,items=[bottle('1'),bottle('2')]){const dir=await mkdtemp(join(tmpdir(),'ct-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const cellar=new FakeCellar(items);const store=new MoveStore(dir);return {cellar,store,service:new MoveService(cellar,store)};}
test('plans exact IDs, preserves location, verifies move, and never replays operation',async t=>{const {service,cellar,store}=await setup(t);const p=await service.plan('23','24');assert.equal(cellar.calls.length,0);const result=await service.execute(p.id);assert.equal(result.status,'complete');assert.deepEqual(result.movedIds,['1','2']);assert.equal(cellar.bottles[0].location,'Example cellar');const restarted=new MoveService(cellar,store);assert.equal((await restarted.execute(p.id)).status,'complete');assert.equal(cellar.calls.length,1);});
test('ambiguous bins require a location; exact labels preserve leading zeros',async t=>{const {service}=await setup(t,[bottle('1','A','23'),bottle('2','B','23'),bottle('3','A','023')]);await assert.rejects(()=>service.plan('23','24'),/multiple locations/);const p=await service.plan('23','24','A');assert.deepEqual(p.bottles.map(b=>b.id),['1']);});
test('source additions after planning fail closed without writes',async t=>{const {service,cellar}=await setup(t);const p=await service.plan('23','24');cellar.bottles.push(bottle('3'));assert.equal((await service.execute(p.id)).status,'conflict');assert.equal(cellar.calls.length,0);});
test('changed source or missing bottles cannot be moved',async t=>{const {service,cellar}=await setup(t);const p=await service.plan('23','24');cellar.bottles[0].bin='99';assert.equal((await service.execute(p.id)).status,'conflict');assert.equal(cellar.calls.length,0);});
test('account switching blocks execute',async t=>{const {service,cellar}=await setup(t);const p=await service.plan('23','24');cellar.accountId='456';await assert.rejects(()=>service.execute(p.id),/account changed/);assert.equal(cellar.calls.length,0);});
test('expired plans fail without writes',async t=>{const {service,store,cellar}=await setup(t);const p=await service.plan('23','24');p.expiresAt=new Date(0).toISOString();await store.save(p);await assert.rejects(()=>service.execute(p.id),/expired/);assert.equal(cellar.calls.length,0);});
test('lost write response is reconciled by read-back',async t=>{const {service,cellar}=await setup(t);const p=await service.plan('23','24');cellar.failAfterWrite=true;assert.equal((await service.execute(p.id)).status,'complete');assert.equal(cellar.calls.length,1);});
test('partial write stops and never replays',async t=>{const {service,cellar}=await setup(t);const p=await service.plan('23','24');cellar.partial=true;const r=await service.execute(p.id);assert.equal(r.status,'partial');assert.deepEqual(r.remainingIds,['2']);await service.execute(p.id);assert.equal(cellar.calls.length,1);});
test('interrupted running operation cannot replay after restart',async t=>{const {service,store,cellar}=await setup(t);const p=await service.plan('23','24');p.status='running';await store.save(p);assert.equal((await service.execute(p.id)).status,'running');assert.equal(cellar.calls.length,0);});
test('verification outage leaves unknown state and does not replay',async t=>{const {service,cellar}=await setup(t);const p=await service.plan('23','24');const original=cellar.inventory.bind(cellar);cellar.inventory=async()=>{if(cellar.calls.length)throw Error();return original();};assert.equal((await service.execute(p.id)).status,'unknown');await service.execute(p.id);assert.equal(cellar.calls.length,1);});
test('large moves use bounded batches',async t=>{const {service,cellar}=await setup(t,Array.from({length:101},(_,i)=>bottle(String(i+1))));const p=await service.plan('23','24');assert.equal((await service.execute(p.id)).status,'complete');assert.deepEqual(cellar.calls.map(c=>c.length),[50,50,1]);});
test('rejects reserved labels and traversal IDs',async t=>{const {service,store}=await setup(t);await assert.rejects(()=>service.plan('23','(use current)'),/reserved/);await assert.rejects(()=>service.plan('23',' 24'),/whitespace/);await assert.rejects(()=>store.get('../../pairing'),/Invalid operation/);});
test('selected move ignores unrelated bottles added to the source bin',async t=>{
 const {service,cellar}=await setup(t);const p=await service.planBottles({bottle_ids:['1']},'24');cellar.bottles.push(bottle('3'));
 assert.equal((await service.execute(p.id)).status,'complete');assert.deepEqual(cellar.calls,[['1']]);assert.equal(cellar.bottles.find(b=>b.id==='2')!.bin,'23');
});
test('selected move preserves each source location unless destination overrides it',async t=>{
 const {service,cellar}=await setup(t,[bottle('1','A'),bottle('2','B')]);const p=await service.planBottles({bottle_ids:['1','2']},'24');assert.equal((await service.execute(p.id)).status,'complete');assert.deepEqual(cellar.bottles.map(b=>b.location),['A','B']);assert.equal(cellar.calls.length,2);
 const p2=await service.planBottles({bottle_ids:['1','2']},'Fridge','Home');assert.equal((await service.execute(p2.id)).status,'complete');assert.ok(cellar.bottles.every(b=>b.location==='Home'&&b.bin==='Fridge'));
});
test('LLM can compose bin swaps and undo from frozen bottle IDs',async t=>{
 const {service,cellar}=await setup(t,[bottle('1','A','23'),bottle('2','A','24')]);
 const left=await service.planBottles({bottle_ids:['1']},'24');const right=await service.planBottles({bottle_ids:['2']},'23');
 assert.equal((await service.execute(left.id)).status,'complete');assert.equal((await service.execute(right.id)).status,'complete');assert.deepEqual(cellar.bottles.map(b=>b.bin),['24','23']);
 const undo=await service.planBottles({bottle_ids:left.bottles.map(b=>b.id)},left.bottles[0].bin,left.bottles[0].location);assert.equal((await service.execute(undo.id)).status,'complete');assert.equal(cellar.bottles[0].bin,'23');assert.equal(cellar.calls[2].length,1);
});
test('quantity-based move freezes precisely the requested number of bottles',async t=>{const {service,cellar}=await setup(t);const p=await service.planBottles({wine_id:'100',quantity:1},'24');await service.execute(p.id);assert.deepEqual(cellar.calls,[['1']]);});
