import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const context:any={};runInNewContext(await readFile(new URL('../extension/protocol.js',import.meta.url),'utf8'),context);
const build=context.CellarTrackerProtocol.build;
test('matches observed query/body separation and repeated bottle IDs',()=>{const r=build({kind:'relocate',ids:['11','12'],location:'Cave à vin',bin:'24 & A'});assert.equal(r.path,'/relocate.asp?searchId=&UISource=&SetLocation=Cave+%E0+vin&SetBin=24+%26+A');assert.equal(r.body,'BulkAction=&iInventory=11&iInventory=12');assert.equal(r.method,'POST');});
test('clearing a bin is explicit; Unicode follows site encoding',()=>{assert.match(build({kind:'relocate',ids:['1'],location:'酒',bin:''}).path,/SetLocation=%26%2337202%3B&SetBin=&Bin_delete=on/);});
test('blocks arbitrary endpoints, duplicate IDs and malformed input',()=>{for(const r of [{kind:'fetch',url:'https://example.com'},{kind:'inventory',page:0},{kind:'relocate',ids:['1','1'],location:'A',bin:'B'},{kind:'relocate',ids:['1&x=2'],location:'A',bin:'B'}])assert.throws(()=>build(r));});
