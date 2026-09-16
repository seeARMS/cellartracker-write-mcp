import {randomUUID} from 'node:crypto';
import {OperationStore} from './store.js';
import {selectBottles,type BottleSelection} from './selection.js';
import {SafeError,type Bottle,type ConsumptionCellar,type ConsumptionDetails,type Inventory,type ConsumptionHistory} from './types.js';
export const consumptionTypes={drank:1,gift:2,restaurant:3,sold_or_traded:4,spoiled_returned:5,tasted:6,broken:7,spoiled:8,missing:9,donated:10,family:11,friends_cellar:12,cooking:13,tasting_event:14} as const;
export function validateConsumption(details:ConsumptionDetails){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(details.date)||Number.isNaN(Date.parse(details.date))||new Date(details.date).toISOString().slice(0,10)!==details.date)throw new SafeError('Use a valid absolute consumption date in YYYY-MM-DD format.');
  if(!Number.isInteger(details.type)||details.type<1||details.type>14)throw new SafeError('Unsupported consumption reason. Deletion is not supported.');
  if(typeof details.note!=='string'||details.note.length>512||/[\x00-\x1f\x7f]/.test(details.note))throw new SafeError('Consumption note must be a single line of at most 512 characters.');
}
export interface Consumption {
 id:string;createdAt:string;expiresAt:string;accountId:string;bottles:Bottle[];details:ConsumptionDetails;
 status:'planned'|'running'|'complete'|'partial'|'unknown'|'conflict';updatedAt?:string;
 consumedIds?:string[];remainingIds?:string[];conflictIds?:string[];message?:string;
}
export class ConsumptionStore extends OperationStore<Consumption>{}
export class ConsumptionService{
 constructor(private cellar:ConsumptionCellar,private store:ConsumptionStore){}
 async plan(selection:BottleSelection,details:ConsumptionDetails){
  validateConsumption(details);
  const inventory=await this.cellar.inventory();const bottles=selectBottles(inventory,selection);
  const history=await this.cellar.consumed(bottles.map(b=>b.id));
  if(history.accountId!==inventory.accountId)throw new SafeError('Signed-in account changed.');
  if(history.records.length)throw new SafeError('A selected bottle already has consumption history. Inspect its state before consuming.');
  const now=Date.now();const operation:Consumption={id:randomUUID(),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+15*60_000).toISOString(),accountId:inventory.accountId,bottles,details,status:'planned'};
  await this.store.save(operation);return operation;
 }
 private classify(op:Consumption,inventory:Inventory,history:ConsumptionHistory){
  if(inventory.accountId!==op.accountId||history.accountId!==op.accountId)throw new SafeError('Signed-in account changed.');
  const current=new Map(inventory.bottles.map(b=>[b.id,b]));const consumedIds:string[]=[],remainingIds:string[]=[],conflictIds:string[]=[];
  for(const original of op.bottles){
   const b=current.get(original.id);const records=history.records.filter(r=>r.id===original.id);
   const r=records[0];
   if(!b&&records.length===1&&r.date===op.details.date&&r.type===op.details.type&&r.note===op.details.note)consumedIds.push(original.id);
   else if(!records.length&&b?.location===original.location&&b.bin===original.bin)remainingIds.push(original.id);
   else conflictIds.push(original.id);
  }
  return {consumedIds,remainingIds,conflictIds};
 }
 async status(id:string){const op=await this.store.get(id);return {...op,observedNow:this.classify(op,await this.cellar.inventory(),await this.cellar.consumed(op.bottles.map(b=>b.id)))};}
 async execute(id:string){
  const op=await this.store.get(id);if(op.status!=='planned')return op;
  if(Date.parse(op.expiresAt)<Date.now())throw new SafeError('Plan expired. Create a fresh plan.');
  const ids=op.bottles.map(b=>b.id);
  let inventory=await this.cellar.inventory();let history=await this.cellar.consumed(ids);
  const before=this.classify(op,inventory,history);
  if(before.remainingIds.length!==ids.length){Object.assign(op,before,{status:'conflict',message:'A selected bottle changed since planning. No consumption submitted.'});await this.store.save(op);return op;}
  op.status='running';await this.store.save(op);
  for(let i=0;i<ids.length;i+=50){
   const batch=ids.slice(i,i+50);let failed=false;
   try{
    if(i>0){inventory=await this.cellar.inventory();history=await this.cellar.consumed(ids);}
    const now=this.classify(op,inventory,history);
    if(now.conflictIds.length||batch.some(id=>!now.remainingIds.includes(id)))throw new SafeError('A selected bottle changed during execution.');
    await this.cellar.consume(batch,op.details);
   }catch{failed=true;}
   try{inventory=await this.cellar.inventory();history=await this.cellar.consumed(ids);Object.assign(op,this.classify(op,inventory,history));}
   catch{op.status='unknown';op.message='Consumption outcome could not be verified. Use get_consumption_status; do not automatically retry.';op.updatedAt=new Date().toISOString();await this.store.save(op);return op;}
   op.updatedAt=new Date().toISOString();await this.store.save(op);
   if(failed||op.conflictIds!.length||batch.some(id=>!op.consumedIds!.includes(id)))break;
  }
  op.status=op.consumedIds?.length===ids.length?'complete':'partial';
  op.message=op.status==='complete'?'Every selected bottle is absent from inventory and has matching consumption history (date, reason, and note).':'Stopped after an error, conflict, or incomplete batch. Inspect get_consumption_status before deliberate recovery. This operation will not replay writes.';
  await this.store.save(op);return op;
 }
}
