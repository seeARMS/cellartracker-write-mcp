import {test} from 'node:test';import assert from 'node:assert/strict';
import {selectBottles} from '../src/selection.js';import {bottle} from './helpers.js';
const inventory=(bottles= [bottle('3'),bottle('1'),bottle('2')])=>({accountId:'123',bottles});
test('quantity uses exact wine ID and deterministic numeric bottle order',()=>{assert.deepEqual(selectBottles(inventory(),{wine_id:'100',quantity:2}).map(b=>b.id),['1','2']);});
test('explicit barcodes normalize leading zeros and reject normalized duplicates',()=>{assert.deepEqual(selectBottles(inventory(),{bottle_ids:['003','1']}).map(b=>b.id),['3','1']);assert.throws(()=>selectBottles(inventory(),{bottle_ids:['01','1']}),/Duplicate/);});
test('quantity never mixes sizes, locations, bins, or wine IDs',()=>{
 const inv=inventory([bottle('1'),bottle('2','Other','23'),{...bottle('3'),size:'1.5L'},{...bottle('4'),wineId:'101'}]);
 assert.throws(()=>selectBottles(inv,{wine_id:'100',quantity:1}),/multiple/);
 assert.deepEqual(selectBottles(inv,{wine_id:'100',quantity:1,location:'Example cellar',size:'750ml'}).map(b=>b.id),['1']);
 assert.throws(()=>selectBottles(inv,{wine_id:'101',quantity:2}),/Only 1/);
});
test('incomplete and mixed selectors fail rather than silently broadening scope',()=>{
 for(const s of [{},{wine_id:'100'},{quantity:1},{bottle_ids:['1'],wine_id:'100',quantity:1},{bottle_ids:['999']},{wine_id:'100',quantity:0}])assert.throws(()=>selectBottles(inventory(),s));
});
