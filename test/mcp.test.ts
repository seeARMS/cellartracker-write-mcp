import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMcp} from '../src/server.js';
import {MoveStore} from '../src/store.js';
import {bottle,html} from './helpers.js';
const decode=(result:any)=>JSON.parse(result.content[0].text);
test('MCP client can discover, plan, execute, and verify through transport',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ct-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bottles=[bottle('1'),bottle('2')];let writes=0;
 const server=createMcp({request:async request=>{
  let text='';
  if(request.kind==='inventory')text=html(bottles);
  if(request.kind==='relocationForm')text='<form id="bulk_popup_form" action="relocate.asp" method="post"><input name="SetLocation"><input name="SetBin"></form>';
  if(request.kind==='relocate'){writes++;for(const b of bottles)if(request.ids.includes(b.id)){b.location=request.location;b.bin=request.bin;}text='<response />';}
  return {status:200,url:'https://www.cellartracker.com/list.asp',text};
 }},new MoveStore(dir),()=>true);
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);
 const client=new Client({name:'test',version:'1'});await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 assert.equal((await client.listTools()).tools.length,11);
 assert.equal(decode(await client.callTool({name:'list_bins',arguments:{}})).total,2);
 const plan=decode(await client.callTool({name:'plan_bin_move',arguments:{source_bin:'23',destination_bin:'24'}}));
 assert.equal(writes,0);
 const result=decode(await client.callTool({name:'execute_bin_move',arguments:{operation_id:plan.id}}));
 assert.equal(result.status,'complete');assert.equal(writes,1);
 assert.deepEqual(decode(await client.callTool({name:'get_move_status',arguments:{operation_id:plan.id}})).observedNow.movedIds,['1','2']);
});
test('compiled stdio entrypoint initializes without stdout noise',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ct-stdio-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'pairing.json'),JSON.stringify({port:17843,token:'b'.repeat(64)}),{mode:0o600});
 const client=new Client({name:'stdio-test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','serve'],env:{CELLARTRACKER_STATE_DIR:dir},stderr:'pipe'});
 await client.connect(transport);t.after(()=>client.close());
 assert.equal((await client.listTools()).tools.length,11);
 assert.equal(decode(await client.callTool({name:'connection_status',arguments:{}})).connected,false);
});
test('MCP quantity move and consumption primitives preserve exact selected IDs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ct-primitives-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let bottles=[bottle('1'),bottle('2'),bottle('3')];let consumed=false;let consumptionWrites=0;
 const account='<div id="header"><a href="user.asp?iUserOverride=123">Example</a></div>';
 const server=createMcp({request:async r=>{
  let text='';
  switch(r.kind){
   case 'inventory':text=html(bottles);break;
   case 'relocationForm':text='<form id="bulk_popup_form" action="relocate.asp" method="post"><input name="SetLocation"><input name="SetBin"></form>';break;
   case 'relocate':for(const b of bottles)if(r.ids.includes(b.id)){b.location=r.location;b.bin=r.bin;}text='<response/>';break;
   case 'consumed':text=account+`<a>Consumed (${consumed?1:0} bottles)</a><a id="top_gotolink">page 1 of 1</a><table id="main_table">`+(consumed?'<tr><td><input name="iConsumed" value="9"><a href="wine.asp?iWine=100">Example</a><a href="popup/bottlehistory.asp?iBottle=0001">Bottle</a></td></tr>':'')+'</table>';break;
   case 'consumptionForm':text='<form id="bulk_popup_form" action="bulkconsume.asp" method="post"><input name="Consumed"><select name="iConsumptionType"><option value="1">Drank</option></select><input name="ConsumptionNote"><input name="Revenue"><select name="RevenueCurrency"><option value="USD">USD</option></select><input name="WriteTN" type="checkbox"></form>';break;
   case 'consume':assert.deepEqual(r.ids,['1']);assert.deepEqual(r.details,{date:'2026-09-15',type:1,note:'Dinner'});consumptionWrites++;consumed=true;bottles=bottles.filter(b=>!r.ids.includes(b.id));text='<response/>';break;
   case 'consumptionDetails':text=account+'<form id="wine_form"><input name="iWine" value="100"><input name="iConsumed" value="9"><select name="ConsumptionType"><option value="1" selected>Drank</option></select><input name="ConsumptionDate" value="9/15/2026"><input name="ConsumptionNote" value="Dinner"></form>';break;
  }
  return {status:200,url:'https://www.cellartracker.com/list.asp',text};
 }},new MoveStore(dir),()=>true);
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);
 const client=new Client({name:'primitive-test',version:'1'});await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 const call=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return decode(result);};
 const move=await call('plan_bottle_move',{wine_id:'100',quantity:2,bin:'23',destination_bin:'24'});
 assert.deepEqual(move.bottles.map((b:any)=>b.id),['1','2']);
 assert.equal((await call('execute_bottle_move',{operation_id:move.id})).status,'complete');
 assert.deepEqual(bottles.map(b=>b.bin),['24','24','23']);
 const plan=await call('plan_bottle_consumption',{bottle_ids:['1'],date:'2026-09-15',note:'Dinner'});
 assert.equal(consumptionWrites,0);
 assert.equal((await call('execute_bottle_consumption',{operation_id:plan.id})).status,'complete');
 await call('execute_bottle_consumption',{operation_id:plan.id});assert.equal(consumptionWrites,1);
 assert.deepEqual((await call('get_consumption_status',{operation_id:plan.id})).observedNow.consumedIds,['1']);
 assert.equal((await call('list_bottles',{wine_id:'100',size:'750ml'})).total,2);
});
