import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const context:any={};runInNewContext(await readFile(new URL('../extension/protocol.js',import.meta.url),'utf8'),context);
const build=context.CellarTrackerProtocol.build;
test('matches observed query/body separation and repeated bottle IDs',()=>{const r=build({kind:'relocate',ids:['11','12'],location:'Cave à vin',bin:'24 & A'});assert.equal(r.path,'/relocate.asp?searchId=&UISource=&SetLocation=Cave+%E0+vin&SetBin=24+%26+A');assert.equal(r.body,'BulkAction=&iInventory=11&iInventory=12');assert.equal(r.method,'POST');});
test('clearing a bin is explicit; Unicode follows site encoding',()=>{assert.match(build({kind:'relocate',ids:['1'],location:'酒',bin:''}).path,/SetLocation=%26%2337202%3B&SetBin=&Bin_delete=on/);});
test('blocks arbitrary endpoints, duplicate IDs and malformed input',()=>{for(const r of [{kind:'fetch',url:'https://example.com'},{kind:'inventory',page:0},{kind:'relocate',ids:['1','1'],location:'A',bin:'B'},{kind:'relocate',ids:['1&x=2'],location:'A',bin:'B'}])assert.throws(()=>build(r));});
test('consumption serializes exact fields and rejects deletion',()=>{
 const r=build({kind:'consume',ids:['1','2'],details:{date:'2026-09-15',type:1,note:'Dinner & wine'},currency:'USD'});
 assert.equal(r.path,'/bulkconsume.asp?Consumed=9%2F15%2F2026&iConsumptionType=1&ConsumptionNote=Dinner+%26+wine&Revenue=&RevenueCurrency=USD');assert.equal(r.body,'BulkAction=&iInventory=1&iInventory=2');
 assert.throws(()=>build({kind:'consume',ids:['1'],details:{date:'2026-09-15',type:0,note:''},currency:'USD'}));
 assert.throws(()=>build({kind:'consumptionDetails',wineId:'100',consumedId:'9&Action=undrink'}));
});
