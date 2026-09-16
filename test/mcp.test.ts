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
 assert.equal((await client.listTools()).tools.length,6);
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
 assert.equal((await client.listTools()).tools.length,6);
 assert.equal(decode(await client.callTool({name:'connection_status',arguments:{}})).connected,false);
});
