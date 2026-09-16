import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CellarTracker } from './cellar.js';
import { MoveService } from './moves.js';
import { MoveStore } from './store.js';
import { SafeError, type Transport } from './types.js';
const label=z.string().max(40);
export function createMcp(transport:Transport,store:MoveStore,connected:()=>boolean,mode="browser"){
  const server=new McpServer({name:'cellartracker-write-mcp',version:'0.1.0'});
  const cellar=new CellarTracker(transport);const moves=new MoveService(cellar,store);
  // Serialize tools so writes cannot interleave within this server.
  let tail:Promise<unknown>=Promise.resolve();
  const run=(fn:()=>Promise<unknown>)=>{const next=tail.then(async()=>{
    try{const result=await fn();return {content:[{type:'text' as const,text:JSON.stringify(result)}]};}
    catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof SafeError?e.message:'Operation failed. Inspect the local setup and operation status; do not blindly retry a write.'}]};}
  });tail=next.catch(()=>{});return next;};
  const read={readOnlyHint:true,destructiveHint:false,openWorldHint:true};
  server.registerTool('connection_status',{description:'Check transport availability and mode. A configured cookie file or connected browser does not prove login; list_bins verifies authentication.',inputSchema:{},annotations:read},async()=>({content:[{type:'text',text:JSON.stringify({connected:connected(),transport:mode})}]}));
  server.registerTool('list_bins',{description:'Read fresh, complete inventory and summarize exact location/bin labels and bottle counts.',inputSchema:{},annotations:read},()=>run(async()=>{
    const inventory=await cellar.inventory();const bins=new Map<string,{location:string;bin:string;count:number}>();
    for(const b of inventory.bottles){const key=JSON.stringify([b.location,b.bin]);const bin=bins.get(key)??{location:b.location,bin:b.bin,count:0};bin.count++;bins.set(key,bin);}
    return {accountId:inventory.accountId,total:inventory.bottles.length,bins:[...bins.values()]};
  }));
  server.registerTool('list_bottles',{description:'List individual bottles from fresh complete inventory, with optional exact bin/location and substring wine filters. Read every offset if all results are needed.',inputSchema:{location:label.optional(),bin:label.optional(),wine:z.string().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50)},annotations:read},args=>run(async()=>{
    const inventory=await cellar.inventory();const bottles=inventory.bottles.filter(b=>(args.location===undefined||b.location===args.location)&&(args.bin===undefined||b.bin===args.bin)&&(args.wine===undefined||b.wine.toLowerCase().includes(args.wine.toLowerCase())));
    return {accountId:inventory.accountId,total:bottles.length,bottles:bottles.slice(args.offset,args.offset+args.limit)};
  }));
  server.registerTool('plan_bin_move',{description:'Prepare and persist a 15-minute move plan with exact bottle IDs. Does not modify CellarTracker. Use exact source/destination labels; omitted location is resolved only when unambiguous. Preserve location unless destination_location is explicitly requested. For a clear user-authorized move, follow immediately with execute_bin_move; no extra user confirmation is inherently required.',inputSchema:{source_bin:label,destination_bin:label,location:label.optional(),destination_location:label.optional()},annotations:{...read,readOnlyHint:false,openWorldHint:true}},a=>run(()=>moves.plan(a.source_bin,a.destination_bin,a.location,a.destination_location)));
  server.registerTool('execute_bin_move',{description:'Execute an existing user-authorized plan. Changes CellarTracker bottle locations/bins; checks current account and source membership, verifies every batch and records outcomes. Reusing an operation ID never replays writes. A partial/unknown/running result requires get_move_status and deliberate recovery, not automatic creation of a replacement plan.',inputSchema:{operation_id:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},a=>run(()=>moves.execute(a.operation_id)));
  server.registerTool('get_move_status',{description:'Read the persisted operation plus fresh bottle positions. Use to reconcile interrupted or partial operations. Does not submit writes.',inputSchema:{operation_id:z.string().uuid()},annotations:read},a=>run(()=>moves.status(a.operation_id)));
  return server;
}
